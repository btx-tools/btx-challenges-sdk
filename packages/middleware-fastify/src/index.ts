/**
 * @btx-tools/middleware-fastify
 *
 * Drop-in Fastify admission gate backed by BTX service challenges.
 * Mirrors the behavior of `@btx-tools/middleware-express` for the Fastify
 * ecosystem.
 *
 * Flow (stateless, echo-the-challenge):
 *
 *   client → POST /v1/generate                          (no proof headers)
 *   server →   402 Payment Required
 *              X-BTX-Challenge: <stringified challenge JSON>
 *              body: { challenge, retry_with: [...] }
 *
 *   client solves locally (or via RPC), retries:
 *   client → POST /v1/generate
 *              X-BTX-Challenge: <echoed challenge JSON>
 *              X-BTX-Challenge-Id: <id>             (optional sanity check)
 *              X-BTX-Proof-Nonce: <hex>
 *              X-BTX-Proof-Digest: <hex>
 *   server →   200 OK  (handler runs; request.btx?.result is the VerifyResult)
 *
 *   Invalid proof → 403 with { valid: false, reason }.
 *   btxd RPC error → Fastify's error pipeline (throw from preHandler).
 *
 * Stateless design notes:
 *  - Server never stores issued challenges; client echoes the challenge back
 *    in `X-BTX-Challenge`. Pros: scales horizontally, no sticky routing.
 *    Cons: the challenge JSON (~3-5 KB) lives in an HTTP header, so check
 *    your reverse proxy's `large_client_header_buffers` / equivalent.
 *  - A stateful variant (server-side `challenge_id` cache) is a future
 *    enhancement queued as `btxAdmission({ store })`.
 *
 * Usage (per-route):
 * ```ts
 * import Fastify from 'fastify';
 * import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
 * import { btxAdmission } from '@btx-tools/middleware-fastify';
 *
 * const client = new BtxChallengeClient({ rpcUrl: '...', rpcAuth: { user, pass } });
 * const fastify = Fastify();
 *
 * fastify.post('/v1/generate', {
 *   preHandler: btxAdmission({
 *     client,
 *     purpose: 'ai_inference_gate',
 *     resource: (req) => `model:${(req.body as any).model}|route:${req.url}`,
 *     subject: (req) => `tenant:${(req.body as any).tenant_id}`,
 *     issueParams: { target_solve_time_s: 1.0, expires_in_s: 60 },
 *   }),
 * }, async (request, reply) => {
 *   // request.btx?.result is populated with the redeem VerifyResult
 *   return { ok: true };
 * });
 * ```
 */

import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import type {
  BtxChallengeClient,
  Challenge,
  IssueParams,
  VerifyResult,
} from '@btx-tools/challenges-sdk';

// ----------------------------------------------------------------------------
// Public constants
// ----------------------------------------------------------------------------

export const HEADER_CHALLENGE = 'x-btx-challenge';
export const HEADER_CHALLENGE_ID = 'x-btx-challenge-id';
export const HEADER_PROOF_NONCE = 'x-btx-proof-nonce';
export const HEADER_PROOF_DIGEST = 'x-btx-proof-digest';
// Note: Fastify normalizes incoming header names to lowercase. Outgoing
// reply.header() accepts any case.

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type StringOrFn = string | ((req: FastifyRequest) => string);

/** Options for {@link btxAdmission}. */
export interface BtxAdmissionOpts {
  /** The BTX RPC client (constructed once at boot). */
  client: BtxChallengeClient;
  /** Logical purpose label, e.g. `'ai_inference_gate'` or `'rate_limit'`. */
  purpose: StringOrFn;
  /** Resource identifier, e.g. `(req) => \`model:${req.body.model}|route:${req.url}\``. */
  resource: StringOrFn;
  /** Subject identifier, e.g. `(req) => \`tenant:${req.user.id}\``. */
  subject: StringOrFn;
  /** Extra issue params forwarded to `client.issue()` (target_solve_time_s, expires_in_s, etc.). */
  issueParams?: Partial<Omit<IssueParams, 'purpose' | 'resource' | 'subject'>>;
  /**
   * Enforce that the redeemed challenge's `binding.{resource,subject,purpose}`
   * matches what *this* request resolves to (audit H-1). Default **`true`**.
   * Without it, a valid proof issued for one binding can be replayed to admit a
   * different route/tenant (btxd's redeem can't see the request). Resolvers must
   * be deterministic per request. Set `false` only for intentional cross-binding reuse.
   */
  enforceBinding?: boolean;
  /** Optional hook fired on successful admission. Receives `req` + the redeem result. */
  onAdmit?: (req: FastifyRequest, result: VerifyResult) => void;
  /**
   * Optional hook fired when `client.issue()` or `client.redeem()` throws.
   * Receives the original error + the request. Fires exactly once before
   * the preHandler re-throws to hand off to Fastify's error pipeline.
   * Use this for logging/observability — don't mutate the error or the
   * reply. Audit ref: D-1.
   */
  onError?: (err: unknown, req: FastifyRequest) => void;
  /**
   * Override the default "is the proof present?" check. By default it returns
   * true iff all of `x-btx-challenge`, `x-btx-proof-nonce`, `x-btx-proof-digest`
   * are set.
   */
  isProofPresent?: (req: FastifyRequest) => boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Namespaced container for BTX middleware state. Populated on successful
     * admission. Mirrors `req.btx` from middleware-express (audit C-3 namespace).
     */
    btx?: {
      /** The `client.redeem()` result that admitted this request. */
      result: VerifyResult;
    };
  }
}

// ----------------------------------------------------------------------------
// Middleware
// ----------------------------------------------------------------------------

/**
 * Build a Fastify `preHandler` hook that gates downstream handlers behind
 * a BTX service challenge. Use per-route via `{ preHandler: btxAdmission(opts) }`.
 */
export function btxAdmission(opts: BtxAdmissionOpts): preHandlerAsyncHookHandler {
  const proofPresent = opts.isProofPresent ?? defaultIsProofPresent;

  return async function btxAdmissionPreHandler(request, reply) {
    if (!proofPresent(request)) {
      await issueAndRespond(request, reply, opts);
      return;
    }
    await redeemAndAdmit(request, reply, opts);
  };
}

function defaultIsProofPresent(req: FastifyRequest): boolean {
  const h = req.headers;
  return Boolean(h[HEADER_CHALLENGE] && h[HEADER_PROOF_NONCE] && h[HEADER_PROOF_DIGEST]);
}

async function issueAndRespond(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: BtxAdmissionOpts,
): Promise<void> {
  try {
    const purpose = resolve(opts.purpose, req);
    const resource = resolve(opts.resource, req);
    const subject = resolve(opts.subject, req);
    // binding fields LAST so issueParams can't override them at runtime
    // (defense-in-depth) + keeps the issued binding == the H-1 redeem check.
    const challenge = await opts.client.issue({
      ...opts.issueParams,
      purpose,
      resource,
      subject,
    });
    await reply
      .code(402)
      .header(HEADER_CHALLENGE, JSON.stringify(challenge))
      .header('content-type', 'application/json')
      .send({
        challenge,
        retry_with: [HEADER_CHALLENGE, HEADER_PROOF_NONCE, HEADER_PROOF_DIGEST],
      });
  } catch (err) {
    opts.onError?.(err, req);
    throw err;
  }
}

async function redeemAndAdmit(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: BtxAdmissionOpts,
): Promise<void> {
  const challengeRaw = headerValue(req, HEADER_CHALLENGE);
  const nonce = headerValue(req, HEADER_PROOF_NONCE);
  const digest = headerValue(req, HEADER_PROOF_DIGEST);

  if (!challengeRaw) {
    await reply
      .code(400)
      .header('content-type', 'application/json')
      .send({
        error: 'missing_challenge_header',
        message: `Retry must include the original challenge in the ${HEADER_CHALLENGE} header (echo-back).`,
      });
    return;
  }

  // L-7 (audit 2026-05-24): bound the header before JSON.parse.
  if (challengeRaw.length > MAX_CHALLENGE_HEADER_BYTES) {
    await reply
      .code(400)
      .header('content-type', 'application/json')
      .send({
        error: 'challenge_header_too_large',
        message: `${HEADER_CHALLENGE} exceeds ${MAX_CHALLENGE_HEADER_BYTES} bytes.`,
      });
    return;
  }

  let challenge: Challenge;
  try {
    challenge = JSON.parse(challengeRaw) as Challenge;
  } catch {
    await reply
      .code(400)
      .header('content-type', 'application/json')
      .send({
        error: 'malformed_challenge_header',
        message: `${HEADER_CHALLENGE} must be a JSON-encoded Challenge envelope.`,
      });
    return;
  }

  // Optional sanity check: if the client also sent the challenge_id header,
  // make sure it matches the embedded id.
  const idHeader = headerValue(req, HEADER_CHALLENGE_ID);
  if (idHeader && idHeader !== challenge.challenge_id) {
    await reply
      .code(400)
      .header('content-type', 'application/json')
      .send({
        error: 'challenge_id_mismatch',
        message: `${HEADER_CHALLENGE_ID} does not match challenge_id in ${HEADER_CHALLENGE}.`,
      });
    return;
  }

  // H-1 (audit 2026-05-24): enforce challenge binding matches THIS request
  // (btxd's redeem can't see the request). Default-on; opt out via enforceBinding:false.
  if (opts.enforceBinding !== false) {
    const b = challenge.binding;
    if (
      b?.resource !== resolve(opts.resource, req) ||
      b?.subject !== resolve(opts.subject, req) ||
      b?.purpose !== resolve(opts.purpose, req)
    ) {
      await reply
        .code(403)
        .header('content-type', 'application/json')
        .send({
          error: 'challenge_binding_mismatch',
          message:
            'Challenge binding does not match this request (resource/subject/purpose). ' +
            'The proof was issued for a different binding.',
        });
      return;
    }
  }

  try {
    const result = await opts.client.redeem(challenge, nonce!, digest!);
    // M-3 (audit 2026-05-24): strict success whitelist.
    if (result.valid !== true || result.redeemed === false) {
      await reply.code(403).header('content-type', 'application/json').send({
        valid: false,
        reason: result.reason,
        expired: result.expired,
      });
      return;
    }
    req.btx = { result };
    opts.onAdmit?.(req, result);
    // Fall through to the route handler — no explicit reply.send here.
  } catch (err) {
    opts.onError?.(err, req);
    throw err;
  }
}

const MAX_CHALLENGE_HEADER_BYTES = 64 * 1024;

function resolve(value: StringOrFn, req: FastifyRequest): string {
  return typeof value === 'function' ? value(req) : value;
}

/**
 * Fastify header values can be string | string[] | undefined; normalize to
 * string by returning the first occurrence.
 *
 * Note (audit M-7 2026-05-23): when a duplicate header is sent (HTTP permits
 * duplicates), we intentionally pick the FIRST value. This matches standard
 * proxy behavior and avoids ambiguity. If a reverse proxy in front reorders
 * duplicate headers, the SDK's behavior follows that proxy's order. None of
 * the BTX headers should legitimately arrive duplicated under normal use.
 */
function headerValue(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}
