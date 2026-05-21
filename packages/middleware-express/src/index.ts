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
 *                       req.btxResult is the VerifyResult)
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

type StringOrFn = string | ((req: Request) => string);

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
  /** Optional hook fired on successful admission. Receives `req` + the redeem result. */
  onAdmit?: (req: Request, result: VerifyResult) => void;
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
      /** Populated on successful admission with the result of `client.redeem()`. */
      btxResult?: VerifyResult;
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
 *     // req.btxResult is populated with the redeem VerifyResult
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
    const challenge = await opts.client.issue({
      purpose,
      resource,
      subject,
      ...opts.issueParams,
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
    res.status(400).setHeader('Content-Type', 'application/json').json({
      error: 'missing_challenge_header',
      message: `Retry must include the original challenge in the ${HEADER_CHALLENGE} header (echo-back).`,
    });
    return;
  }

  let challenge: Challenge;
  try {
    challenge = JSON.parse(challengeRaw) as Challenge;
  } catch {
    res.status(400).setHeader('Content-Type', 'application/json').json({
      error: 'malformed_challenge_header',
      message: `${HEADER_CHALLENGE} must be a JSON-encoded Challenge envelope.`,
    });
    return;
  }

  // Optional sanity check: if the client also sent the challenge_id header,
  // make sure it matches the embedded id.
  const idHeader = req.header(HEADER_CHALLENGE_ID);
  if (idHeader && idHeader !== challenge.challenge_id) {
    res.status(400).setHeader('Content-Type', 'application/json').json({
      error: 'challenge_id_mismatch',
      message: `${HEADER_CHALLENGE_ID} does not match challenge_id in ${HEADER_CHALLENGE}.`,
    });
    return;
  }

  try {
    const result = await opts.client.redeem(challenge, nonce!, digest!);
    if (!result.valid) {
      res.status(403).setHeader('Content-Type', 'application/json').json({
        valid: false,
        reason: result.reason,
        expired: result.expired,
      });
      return;
    }
    req.btxResult = result;
    opts.onAdmit?.(req, result);
    next();
  } catch (err) {
    next(err);
  }
}

function resolve(value: StringOrFn, req: Request): string {
  return typeof value === 'function' ? value(req) : value;
}
