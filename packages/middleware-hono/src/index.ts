/**
 * @btx-tools/middleware-hono
 *
 * Drop-in **Hono** admission gate backed by BTX service challenges.
 * Mirrors the behavior of `@btx-tools/middleware-express` and
 * `@btx-tools/middleware-fastify` for Hono's middleware model — works on
 * Node, Deno, Bun, Cloudflare Workers, and other edge runtimes Hono targets.
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
 *   server →   200 OK  (handler runs; c.get('btx').result is the VerifyResult)
 *
 *   Invalid proof → 403 with { valid: false, reason }.
 *   btxd RPC error → throws — Hono's onError handler catches it.
 *
 * Usage (per-route):
 * ```ts
 * import { Hono } from 'hono';
 * import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
 * import { btxAdmission } from '@btx-tools/middleware-hono';
 *
 * const client = new BtxChallengeClient({ rpcUrl: '...', rpcAuth: { user, pass } });
 * const app = new Hono<{ Variables: { btx: { result: import('@btx-tools/challenges-sdk').VerifyResult } } }>();
 *
 * app.post('/v1/generate',
 *   btxAdmission({
 *     client,
 *     purpose: 'ai_inference_gate',
 *     resource: (c) => `route:${c.req.path}`,
 *     subject: async (c) => `tenant:${(await c.req.json()).tenant_id}`,
 *     issueParams: { target_solve_time_s: 1.0, expires_in_s: 60 },
 *   }),
 *   async (c) => {
 *     const admit = c.get('btx').result;
 *     return c.json({ ok: true, reason: admit.reason });
 *   },
 * );
 * ```
 */

import type { Context, MiddlewareHandler } from 'hono';

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
// Note: Web standard Headers (which Hono uses) are case-insensitive on get but
// typically lowercased internally. Use lowercase names to keep consistent.

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Resolver for purpose/resource/subject. Can be a static string, a sync
 * function over Context, or an async function for cases where the resolver
 * needs to await `c.req.json()` (Hono request body is a stream until consumed).
 */
export type StringOrFn = string | ((c: Context) => string) | ((c: Context) => Promise<string>);

/**
 * Hono `Variables` shape expected on the context. Apps that consume this
 * middleware should type their Hono instance as:
 *
 * ```ts
 * const app = new Hono<{ Variables: BtxAdmissionVariables }>();
 * ```
 *
 * Then `c.get('btx')` is type-narrowed to `{ result: VerifyResult } | undefined`.
 */
export interface BtxAdmissionVariables {
  btx: { result: VerifyResult };
}

/** Options for {@link btxAdmission}. */
export interface BtxAdmissionOpts {
  /** The BTX RPC client (constructed once at boot). */
  client: BtxChallengeClient;
  /** Logical purpose label, e.g. `'ai_inference_gate'` or `'rate_limit'`. */
  purpose: StringOrFn;
  /** Resource identifier, e.g. `(c) => \`model:${(await c.req.json()).model}|route:${c.req.path}\``. */
  resource: StringOrFn;
  /** Subject identifier, e.g. `(c) => \`tenant:${c.req.header('x-tenant-id')}\``. */
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
  /** Optional hook fired on successful admission. Receives `c` + the redeem result. */
  onAdmit?: (c: Context, result: VerifyResult) => void;
  /**
   * Optional hook fired when `client.issue()` or `client.redeem()` throws.
   * Receives the original error + the context. Fires exactly once before
   * the middleware re-throws to hand off to Hono's `onError` handler.
   * Use this for logging/observability. Audit ref: D-1.
   */
  onError?: (err: unknown, c: Context) => void;
  /**
   * Override the default "is the proof present?" check. By default it returns
   * true iff all of `x-btx-challenge`, `x-btx-proof-nonce`, `x-btx-proof-digest`
   * headers are set.
   */
  isProofPresent?: (c: Context) => boolean;
}

// ----------------------------------------------------------------------------
// Middleware
// ----------------------------------------------------------------------------

/**
 * Build a Hono middleware that gates downstream handlers behind
 * a BTX service challenge. Use per-route by attaching it as a route argument.
 */
export function btxAdmission(opts: BtxAdmissionOpts): MiddlewareHandler {
  const proofPresent = opts.isProofPresent ?? defaultIsProofPresent;

  return async function btxAdmissionMiddleware(c, next) {
    if (!proofPresent(c)) {
      return issueAndRespond(c, opts);
    }
    return redeemAndAdmit(c, next, opts);
  };
}

function defaultIsProofPresent(c: Context): boolean {
  return Boolean(
    c.req.header(HEADER_CHALLENGE) &&
    c.req.header(HEADER_PROOF_NONCE) &&
    c.req.header(HEADER_PROOF_DIGEST),
  );
}

async function issueAndRespond(c: Context, opts: BtxAdmissionOpts): Promise<Response> {
  try {
    const purpose = await resolve(opts.purpose, c);
    const resource = await resolve(opts.resource, c);
    const subject = await resolve(opts.subject, c);
    // binding fields LAST so issueParams can't override them at runtime
    // (defense-in-depth) + keeps the issued binding == the H-1 redeem check.
    const challenge = await opts.client.issue({
      ...opts.issueParams,
      purpose,
      resource,
      subject,
    });
    c.header(HEADER_CHALLENGE, JSON.stringify(challenge));
    return c.json(
      {
        challenge,
        retry_with: [HEADER_CHALLENGE, HEADER_PROOF_NONCE, HEADER_PROOF_DIGEST],
      },
      402,
    );
  } catch (err) {
    opts.onError?.(err, c);
    throw err;
  }
}

async function redeemAndAdmit(
  c: Context,
  next: () => Promise<void>,
  opts: BtxAdmissionOpts,
): Promise<Response | void> {
  const challengeRaw = c.req.header(HEADER_CHALLENGE);
  const nonce = c.req.header(HEADER_PROOF_NONCE);
  const digest = c.req.header(HEADER_PROOF_DIGEST);

  if (!challengeRaw) {
    return c.json(
      {
        error: 'missing_challenge_header',
        message: `Retry must include the original challenge in the ${HEADER_CHALLENGE} header (echo-back).`,
      },
      400,
    );
  }

  // L-7 (audit 2026-05-24): bound the header before JSON.parse (edge CPU budgets).
  if (challengeRaw.length > MAX_CHALLENGE_HEADER_BYTES) {
    return c.json(
      {
        error: 'challenge_header_too_large',
        message: `${HEADER_CHALLENGE} exceeds ${MAX_CHALLENGE_HEADER_BYTES} bytes.`,
      },
      400,
    );
  }

  let challenge: Challenge;
  try {
    challenge = JSON.parse(challengeRaw) as Challenge;
  } catch {
    return c.json(
      {
        error: 'malformed_challenge_header',
        message: `${HEADER_CHALLENGE} must be a JSON-encoded Challenge envelope.`,
      },
      400,
    );
  }

  // Optional sanity check: if the client also sent the challenge_id header,
  // make sure it matches the embedded id.
  const idHeader = c.req.header(HEADER_CHALLENGE_ID);
  if (idHeader && idHeader !== challenge.challenge_id) {
    return c.json(
      {
        error: 'challenge_id_mismatch',
        message: `${HEADER_CHALLENGE_ID} does not match challenge_id in ${HEADER_CHALLENGE}.`,
      },
      400,
    );
  }

  // H-1 (audit 2026-05-24): enforce challenge binding matches THIS request
  // (btxd's redeem can't see the request). Default-on; opt out via enforceBinding:false.
  if (opts.enforceBinding !== false) {
    const b = challenge.binding;
    if (
      b?.resource !== (await resolve(opts.resource, c)) ||
      b?.subject !== (await resolve(opts.subject, c)) ||
      b?.purpose !== (await resolve(opts.purpose, c))
    ) {
      return c.json(
        {
          error: 'challenge_binding_mismatch',
          message:
            'Challenge binding does not match this request (resource/subject/purpose). ' +
            'The proof was issued for a different binding.',
        },
        403,
      );
    }
  }

  let result;
  try {
    result = await opts.client.redeem(challenge, nonce!, digest!);
  } catch (err) {
    // Only the redeem RPC is wrapped (audit M-2): a downstream handler throw in
    // `next()` must NOT be routed through onError as if it were an RPC failure.
    opts.onError?.(err, c);
    throw err;
  }

  // M-3 (audit 2026-05-24): strict success whitelist.
  if (result.valid !== true || result.redeemed === false) {
    return c.json(
      {
        valid: false,
        reason: result.reason,
        expired: result.expired,
      },
      403,
    );
  }
  c.set('btx', { result });
  opts.onAdmit?.(c, result);
  // next() is OUTSIDE the try (M-2) — post-admission handler errors propagate
  // to Hono's own error handling, not this middleware's onError.
  await next();
  return;
}

const MAX_CHALLENGE_HEADER_BYTES = 64 * 1024;

async function resolve(value: StringOrFn, c: Context): Promise<string> {
  if (typeof value === 'function') {
    return await value(c);
  }
  return value;
}
