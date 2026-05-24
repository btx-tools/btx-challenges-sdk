/**
 * @btx-tools/middleware-express
 *
 * Drop-in Express admission gate backed by BTX service challenges.
 * Wraps `@btx-tools/challenges-sdk`'s `BtxChallengeClient.issue()` and
 * `.redeem()` into a single `RequestHandler` you can drop in front of any
 * Express route.
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
 *   server →   200 OK  (next() runs the actual handler;
 *                       req.btx?.result is the VerifyResult)
 *
 *   Invalid proof → 403 with { valid: false, reason }.
 *   btxd RPC error → next(err) so Express's error handler can manage it.
 *
 * Stateless design notes:
 *  - Server never stores issued challenges; client echoes the challenge back
 *    in `X-BTX-Challenge`. Pros: scales horizontally, no sticky routing.
 *    Cons: the challenge JSON (~3-5 KB) lives in an HTTP header, so check
 *    your reverse proxy's `large_client_header_buffers` / equivalent.
 *  - A stateful variant (server-side `challenge_id` cache) is a future
 *    enhancement queued as `btxAdmission({ store })`.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  BtxChallengeClient,
  Challenge,
  IssueParams,
  VerifyResult,
} from '@btx-tools/challenges-sdk';

// ----------------------------------------------------------------------------
// Public constants
// ----------------------------------------------------------------------------

export const HEADER_CHALLENGE = 'X-BTX-Challenge';
export const HEADER_CHALLENGE_ID = 'X-BTX-Challenge-Id';
export const HEADER_PROOF_NONCE = 'X-BTX-Proof-Nonce';
export const HEADER_PROOF_DIGEST = 'X-BTX-Proof-Digest';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type StringOrFn = string | ((req: Request) => string);

/** Options for {@link btxAdmission}. */
export interface BtxAdmissionOpts {
  /** The BTX RPC client (constructed once at boot). */
  client: BtxChallengeClient;
  /** Logical purpose label, e.g. `'ai_inference_gate'` or `'rate_limit'`. */
  purpose: StringOrFn;
  /** Resource identifier, e.g. `(req) => \`model:${req.body.model}|route:${req.path}\``. */
  resource: StringOrFn;
  /** Subject identifier, e.g. `(req) => \`tenant:${req.user.id}\``. */
  subject: StringOrFn;
  /** Extra issue params forwarded to `client.issue()` (target_solve_time_s, expires_in_s, etc.). */
  issueParams?: Partial<Omit<IssueParams, 'purpose' | 'resource' | 'subject'>>;
  /**
   * Enforce that the redeemed challenge's `binding.{resource,subject,purpose}`
   * matches what *this* request resolves to (audit H-1). Default **`true`**.
   * Without it, a valid proof issued for one binding (e.g. a cheap route) can be
   * replayed to admit a different route/tenant on the same btxd, since btxd's
   * redeem can't see the HTTP request. **The `resource`/`subject`/`purpose`
   * resolvers must be deterministic per request** for this to pass. Set to
   * `false` only if you intentionally reuse proofs across bindings.
   */
  enforceBinding?: boolean;
  /** Optional hook fired on successful admission. Receives `req` + the redeem result. */
  onAdmit?: (req: Request, result: VerifyResult) => void;
  /**
   * Optional hook fired when `client.issue()` or `client.redeem()` throws.
   * Receives the original error + the request. Fires exactly once before
   * the middleware calls `next(err)` to hand off to Express's error pipeline.
   * Use this for logging/observability — don't mutate the error or the
   * response. Added in 0.2.0 (audit finding D-1).
   */
  onError?: (err: unknown, req: Request) => void;
  /**
   * Override the default "is the proof present?" check. By default it returns
   * true iff all of `X-BTX-Challenge`, `X-BTX-Proof-Nonce`, `X-BTX-Proof-Digest`
   * are set.
   */
  isProofPresent?: (req: Request) => boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Namespaced container for BTX middleware state. Populated on successful
       * admission. Renamed from `req.btxResult` in 0.2.0 to avoid global
       * Request-augmentation pollution (audit finding C-3).
       */
      btx?: {
        /** The `client.redeem()` result that admitted this request. */
        result: VerifyResult;
      };
    }
  }
}

// ----------------------------------------------------------------------------
// Middleware
// ----------------------------------------------------------------------------

/**
 * Build an Express `RequestHandler` that gates downstream handlers behind
 * a BTX service challenge.
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
 * import { btxAdmission } from '@btx-tools/middleware-express';
 *
 * const client = new BtxChallengeClient({
 *   rpcUrl: 'http://127.0.0.1:19334',
 *   rpcAuth: { user: 'rpcuser', pass: 'rpcpass' },
 * });
 *
 * const app = express();
 * app.use(express.json());
 *
 * app.post('/v1/generate',
 *   btxAdmission({
 *     client,
 *     purpose: 'ai_inference_gate',
 *     resource: (req) => `model:${req.body.model}|route:${req.path}`,
 *     subject: (req) => `tenant:${req.body.tenant_id}`,
 *     issueParams: { target_solve_time_s: 1.0, expires_in_s: 60 },
 *   }),
 *   async (req, res) => {
 *     // req.btx?.result is populated with the redeem VerifyResult
 *     res.json({ ok: true, generated: '...' });
 *   },
 * );
 * ```
 */
export function btxAdmission(opts: BtxAdmissionOpts): RequestHandler {
  const proofPresent = opts.isProofPresent ?? defaultIsProofPresent;

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!proofPresent(req)) {
      return issueAndRespond(req, res, next, opts);
    }
    return redeemAndAdmit(req, res, next, opts);
  };
}

function defaultIsProofPresent(req: Request): boolean {
  return Boolean(
    req.header(HEADER_CHALLENGE) &&
    req.header(HEADER_PROOF_NONCE) &&
    req.header(HEADER_PROOF_DIGEST),
  );
}

async function issueAndRespond(
  req: Request,
  res: Response,
  next: NextFunction,
  opts: BtxAdmissionOpts,
): Promise<void> {
  try {
    const purpose = resolve(opts.purpose, req);
    const resource = resolve(opts.resource, req);
    const subject = resolve(opts.subject, req);
    // binding fields LAST so issueParams can never override them at runtime
    // (defense-in-depth, mirrors mcp-gateway HIGH-2) — also keeps the issued
    // binding equal to what the H-1 redeem check re-derives.
    const challenge = await opts.client.issue({
      ...opts.issueParams,
      purpose,
      resource,
      subject,
    });
    res
      .status(402)
      .setHeader(HEADER_CHALLENGE, JSON.stringify(challenge))
      .setHeader('Content-Type', 'application/json')
      .json({
        challenge,
        retry_with: [HEADER_CHALLENGE, HEADER_PROOF_NONCE, HEADER_PROOF_DIGEST],
      });
  } catch (err) {
    opts.onError?.(err, req);
    next(err);
  }
}

async function redeemAndAdmit(
  req: Request,
  res: Response,
  next: NextFunction,
  opts: BtxAdmissionOpts,
): Promise<void> {
  const challengeRaw = req.header(HEADER_CHALLENGE);
  const nonce = req.header(HEADER_PROOF_NONCE);
  const digest = req.header(HEADER_PROOF_DIGEST);

  if (!challengeRaw) {
    res
      .status(400)
      .setHeader('Content-Type', 'application/json')
      .json({
        error: 'missing_challenge_header',
        message: `Retry must include the original challenge in the ${HEADER_CHALLENGE} header (echo-back).`,
      });
    return;
  }

  // L-7 (audit 2026-05-24): bound the attacker-controlled header before JSON.parse
  // (legit challenges are ~3-5 KB; cap well above that).
  if (challengeRaw.length > MAX_CHALLENGE_HEADER_BYTES) {
    res
      .status(400)
      .setHeader('Content-Type', 'application/json')
      .json({
        error: 'challenge_header_too_large',
        message: `${HEADER_CHALLENGE} exceeds ${MAX_CHALLENGE_HEADER_BYTES} bytes.`,
      });
    return;
  }

  let challenge: Challenge;
  try {
    challenge = JSON.parse(challengeRaw) as Challenge;
  } catch {
    res
      .status(400)
      .setHeader('Content-Type', 'application/json')
      .json({
        error: 'malformed_challenge_header',
        message: `${HEADER_CHALLENGE} must be a JSON-encoded Challenge envelope.`,
      });
    return;
  }

  // Optional sanity check: if the client also sent the challenge_id header,
  // make sure it matches the embedded id.
  const idHeader = req.header(HEADER_CHALLENGE_ID);
  if (idHeader && idHeader !== challenge.challenge_id) {
    res
      .status(400)
      .setHeader('Content-Type', 'application/json')
      .json({
        error: 'challenge_id_mismatch',
        message: `${HEADER_CHALLENGE_ID} does not match challenge_id in ${HEADER_CHALLENGE}.`,
      });
    return;
  }

  // H-1 (audit 2026-05-24): enforce that the echoed challenge was issued for
  // THIS request's binding. btxd's redeem only proves the challenge was
  // locally issued + unredeemed + unexpired — it cannot see the HTTP request,
  // so without this check a valid proof for one (resource/subject/purpose)
  // admits a different route/tenant. Default-on; opt out with enforceBinding:false.
  if (opts.enforceBinding !== false) {
    const b = challenge.binding;
    if (
      b?.resource !== resolve(opts.resource, req) ||
      b?.subject !== resolve(opts.subject, req) ||
      b?.purpose !== resolve(opts.purpose, req)
    ) {
      res
        .status(403)
        .setHeader('Content-Type', 'application/json')
        .json({
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
    // M-3 (audit 2026-05-24): strict success whitelist — admit only on
    // valid===true AND not an explicit redeemed===false (a truthy-non-true
    // `valid` or a verify-only `redeemed:false` must NOT admit).
    if (result.valid !== true || result.redeemed === false) {
      res.status(403).setHeader('Content-Type', 'application/json').json({
        valid: false,
        reason: result.reason,
        expired: result.expired,
      });
      return;
    }
    req.btx = { result };
    opts.onAdmit?.(req, result);
    next();
  } catch (err) {
    opts.onError?.(err, req);
    next(err);
  }
}

const MAX_CHALLENGE_HEADER_BYTES = 64 * 1024;

function resolve(value: StringOrFn, req: Request): string {
  return typeof value === 'function' ? value(req) : value;
}
