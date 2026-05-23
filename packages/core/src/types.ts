/**
 * Type definitions mirroring the BTX service-challenges RPC schema.
 *
 * Source: btx.dev/docs/rpc/service-challenges (verified 2026-05-20).
 * Schema captured against live btxd v0.29.7 at btx-node (block 106270).
 *
 * IMPORTANT: We do NOT camelCase rename — the RPC schema is the wire contract.
 * Field names mirror btxd output verbatim.
 */

/** Difficulty calibration policy for issued challenges. */
export type DifficultyPolicy = 'fixed' | 'adaptive_window';

/**
 * Standard purpose labels recognized by the chain. Free-form strings allowed too.
 *
 * The `(string & {})` trick keeps autocomplete on the known labels while still
 * accepting arbitrary purpose strings. Don't "simplify" to plain `string` — it
 * loses the autocompletion benefit. See: https://github.com/microsoft/TypeScript/issues/29729
 */
export type ChallengePurpose = 'rate_limit' | 'api_gate' | 'ai_inference_gate' | (string & {});

/** Parameters for issuing a challenge via getmatmulservicechallenge. */
export interface IssueParams {
  purpose: ChallengePurpose;
  resource: string;
  subject: string;
  /** Calibrates client compute work to roughly this many seconds. btxd default: 1.0. */
  target_solve_time_s?: number;
  /** Challenge lifetime in seconds. btxd default: 300. Range 1–86400. */
  expires_in_s?: number;
  validation_overhead_s?: number;
  propagation_overhead_s?: number;
  /** btxd default: "fixed". */
  difficulty_policy?: DifficultyPolicy;
  difficulty_window_blocks?: number;
  min_solve_time_s?: number;
  max_solve_time_s?: number;
  solver_parallelism?: number;
  solver_duty_cycle_pct?: number;
}

/**
 * Binding identifies the (purpose, resource, subject) trio the challenge is
 * scoped to. btxd also embeds hashes + anchor info for replay protection.
 */
export interface ChallengeBinding {
  chain: string;
  purpose: string;
  resource: string;
  subject: string;
  resource_hash: string;
  subject_hash: string;
  salt: string;
  anchor_height: number;
  anchor_hash: string;
  /** Hashing rule used to compute challenge_id. Treat as opaque docstring from btxd. */
  challenge_id_rule?: string;
  seed_derivation_rule?: string;
  /** Open extension — btxd may add fields without breaking us. */
  [k: string]: unknown;
}

/**
 * Proof policy describes what btxd will check when redeeming. Treat fields
 * as authoritative — do NOT re-derive verification rules client-side.
 */
export interface ChallengeProofPolicy {
  verification_rule: string;
  sigma_gate_applied: boolean;
  expiration_enforced: boolean;
  challenge_id_required: boolean;
  replay_protection: string;
  redeem_rpc: string;
  solve_rpc: string;
  locally_issued_required: boolean;
  issued_challenge_store?: string;
  issued_challenge_scope?: string;
  [k: string]: unknown;
}

/** MatMul parameters needed to solve. Day 2 solver consumes these. */
export interface ChallengeMatmul {
  /** Matrix dimension. btxd ships n=512 in production. */
  n: number;
  /** Block dimension for compression. */
  b: number;
  /** Noise rank. */
  r: number;
  /** Field modulus (Mersenne prime 2^31-1). */
  q: number;
  min_dimension: number;
  max_dimension: number;
  /** Hex-encoded seed for matrix A. */
  seed_a: string;
  /** Hex-encoded seed for matrix B. */
  seed_b: string;
}

/** Block header context the challenge is anchored to. */
export interface ChallengeHeaderContext {
  version: number;
  previousblockhash: string;
  merkleroot: string;
  time: number;
  bits: string;
  nonce64_start: number;
  matmul_dim: number;
  seed_a: string;
  seed_b: string;
}

/**
 * Inner challenge payload — what the solver actually needs.
 * The Day 2 MatMul solver reads `matmul`, `target`, `noncerange`, and `header_context`.
 */
export interface ChallengePayload {
  chain: string;
  algorithm: string;
  height: number;
  previousblockhash: string;
  mintime: number;
  bits: string;
  difficulty: number;
  /** Hex-encoded target. Digest must compare ≤ target for valid proof. */
  target: string;
  noncerange: string;
  header_context: ChallengeHeaderContext;
  matmul: ChallengeMatmul;
  /** btxd ships additional fields (work_profile, runtime_observability, etc.) we treat as opaque. */
  [k: string]: unknown;
}

/**
 * The challenge envelope returned by getmatmulservicechallenge.
 * Opaque to the SDK at the wire boundary — pass through to solver / redeem.
 */
export interface Challenge {
  /** btxd schema kind discriminator (e.g. "matmul_service_challenge_v1"). */
  kind?: string;
  challenge_id: string;
  issued_at: number;
  expires_at: number;
  expires_in_s: number;
  binding: ChallengeBinding;
  proof_policy: ChallengeProofPolicy;
  challenge: ChallengePayload;
  /** Open extension. */
  [k: string]: unknown;
}

/** Reasons returned by verify/redeem. Open string — btxd may add more. */
export type VerifyReason =
  | 'ok'
  | 'invalid_proof'
  | 'challenge_mismatch'
  | 'expired'
  | 'unknown_challenge'
  | 'already_redeemed'
  | 'missing_proof'
  | (string & {});

/** Outcome of verifymatmulserviceproof / redeemmatmulserviceproof. */
export interface VerifyResult {
  valid: boolean;
  expired?: boolean;
  reason: VerifyReason;
  issued_by_local_node?: boolean;
  redeemed?: boolean;
  redeemable?: boolean;
  mismatch_field?: string;
}

/** Single entry in a batch redeem/verify call. */
export interface BatchEntry {
  challenge: Challenge;
  nonce64_hex: string;
  digest_hex: string;
}

/** Batch response — sequential per-proof results. */
export interface BatchResult {
  count: number;
  valid: number;
  invalid: number;
  by_reason: Record<string, number>;
  results: VerifyResult[];
}

/** Solver output (also returned by solvematmulservicechallenge RPC). */
export interface SolverOutput {
  nonce64_hex: string;
  digest_hex: string;
  proof: Record<string, unknown>;
}

/**
 * Retry configuration for {@link BtxChallengeClient.call}.
 *
 * Default `{ max: 0 }` — opt-in. Retries fire only on transient failures:
 * network errors (DNS/TCP/TLS) and 5xx HTTP responses. **Never** retries on
 * 4xx HTTP, JSON-RPC error envelopes, parse errors, or timeouts — those are
 * deterministic failures where another attempt won't help.
 *
 * Exponential backoff: delay between attempt N and N+1 is
 * `baseDelayMs * 2^(N-1)`. With `jitter: true`, adds `random(0, baseDelayMs)`.
 *
 * Audit ref: D-3 in `BTX/audits/btx-challenges-sdk-audit-2026-05-22.md`.
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts (in addition to the initial call). `0`
   * disables retry. Non-integer / negative / NaN values are clamped to `0`.
   */
  max: number;
  /**
   * Base delay in ms between attempts. The actual delay between attempt N and
   * N+1 is `baseDelayMs * 2^(N-1)`, **capped at 60 s** so a high `max` doesn't
   * schedule delays past the process lifetime. Default 500 ms.
   */
  baseDelayMs?: number;
  /** If `true`, adds `random(0, baseDelayMs)` of jitter to each delay. Default `false`. */
  jitter?: boolean;
  /**
   * Observability hook fired once per scheduled retry, **before** the backoff
   * sleep, with the exact delay (post-jitter) about to be slept.
   *
   * - `attempt` — 1-indexed retry number (1 = first retry after the initial call).
   * - `error` — the retryable error from the just-failed attempt (a {@link BtxError}
   *   subclass: {@link BtxNetworkError} or {@link BtxHttpError} for a 5xx).
   * - `nextDelayMs` — the precise delay (including jitter) about to be slept.
   *
   * Fires only for retryable failures — non-retryable errors throw before the
   * next attempt is scheduled, so the hook never sees them. If the caller's
   * AbortSignal fires during the subsequent backoff sleep, the retry is still
   * abandoned (the hook reports intent-to-retry, not success). Keep the callback
   * cheap and non-throwing: an exception thrown inside `onRetry` propagates out
   * of the client call.
   *
   * Audit ref: L-3 in `BTX/audits/btx-challenges-sdk-audit-2026-05-23.md`.
   */
  onRetry?: (attempt: number, error: unknown, nextDelayMs: number) => void;
}

/**
 * Per-call options accepted by every public method on {@link BtxChallengeClient}.
 *
 * Added in 0.2.0. Optional. Defaults preserve 0.1.x behavior — no change for
 * callers that don't pass an opts arg.
 */
export interface RpcCallOpts {
  /**
   * Optional AbortSignal to cancel the request. When the signal fires `abort`:
   * - If the signal is already aborted before the call starts, the method
   *   throws {@link BtxNetworkError} immediately without sending a request.
   * - If the signal fires mid-fetch, the underlying fetch is aborted and the
   *   call throws {@link BtxNetworkError} (distinguishable from
   *   {@link BtxTimeoutError} — see `cause` for the underlying CallerAbortError).
   * - If the signal fires during a retry backoff sleep, the retry loop exits
   *   immediately without sending another request.
   *
   * Honored across the full retry pipeline.
   *
   * **Caveat for {@link BtxChallengeClient.redeem}** and {@link BtxChallengeClient.redeemBatch}:
   * if the abort fires AFTER btxd has consumed the challenge (the RPC completed
   * server-side before the local fetch was aborted), the redemption stands
   * — the local promise rejects but btxd has already marked the proof spent.
   * Callers handling cancellation should verify via a separate {@link BtxChallengeClient.verify}
   * call if the post-abort state matters.
   */
  signal?: AbortSignal;
}

/** RPC client configuration. */
export interface BtxClientOpts {
  /**
   * Full JSON-RPC endpoint, e.g. `http://127.0.0.1:19332`.
   *
   * **Security**: use HTTPS (or a localhost-only deployment) when the RPC
   * endpoint is not on `127.0.0.1`. Basic auth over plaintext exposes credentials.
   * Terminate TLS at stunnel/nginx/Caddy in front of btxd; do NOT expose
   * btxd's RPC port directly to the public internet.
   */
  rpcUrl: string;
  /** Basic-auth credentials matching btxd's rpcauth / rpcuser+rpcpassword. */
  rpcAuth: {
    user: string;
    pass: string;
  };
  /**
   * Client-wide request timeout in ms (default 30000). Overridden per-method
   * by {@link methodTimeouts}. Values ≤ 0 are treated as "no override" and
   * fall through to the 30000 ms default.
   */
  timeoutMs?: number;
  /**
   * Per-method timeout overrides (ms). Falls back to {@link timeoutMs}, then 30000.
   * Values ≤ 0 are treated as "no override" — fall through to the next layer
   * (audit M-1 2026-05-23).
   *
   * Keys may be either the **raw btxd RPC method name** or a **semantic
   * shortcut** (added 0.3.0, audit L-4):
   *
   * | semantic | raw RPC method |
   * |---|---|
   * | `issue` | `getmatmulservicechallenge` |
   * | `verify` | `verifymatmulserviceproof` |
   * | `redeem` | `redeemmatmulserviceproof` |
   * | `verifyBatch` | `verifymatmulserviceproofs` |
   * | `redeemBatch` | `redeemmatmulserviceproofs` |
   * | `solve` | `solvematmulservicechallenge` |
   *
   * Precedence: a raw-method key always wins over the semantic alias for the
   * same method (raw is more specific). A `≤ 0` value at either level is
   * skipped and resolution continues to the next layer.
   *
   * Useful because RPCs have very different time profiles: `solvematmulservicechallenge`
   * on a mining-loaded btxd can take 15+ minutes ({@link https://github.com/btx-tools/btx-challenges-sdk see btxd-solver-mining-contention}),
   * while `getmatmulservicechallenge` finishes in ~50 ms. Set `{ solve: 1_000_000 }`
   * (or the raw `{ solvematmulservicechallenge: 1_000_000 }`) to give the solver
   * a long runway without bloating the client-wide default.
   *
   * Audit ref: D-4 in `BTX/audits/btx-challenges-sdk-audit-2026-05-22.md`;
   * semantic shortcuts L-4 in `…-audit-2026-05-23.md`.
   */
  methodTimeouts?: Record<string, number>;
  /**
   * Retry policy. Default `{ max: 0 }` (off). See {@link RetryOptions}.
   *
   * Audit ref: D-3 in `BTX/audits/btx-challenges-sdk-audit-2026-05-22.md`.
   */
  retry?: RetryOptions;
}

// ============================================================================
// Error taxonomy
// ============================================================================

/** Base class — all SDK errors extend this for `instanceof BtxError` checks. */
export class BtxError extends Error {
  constructor(
    message: string,
    public readonly method?: string,
  ) {
    super(message);
    this.name = 'BtxError';
  }
}

/** btxd returned a JSON-RPC error envelope with code + message. */
export class BtxRpcError extends BtxError {
  constructor(
    public readonly code: number,
    message: string,
    method?: string,
  ) {
    super(message, method);
    this.name = 'BtxRpcError';
  }
}

/** btxd returned a non-2xx HTTP status. */
export class BtxHttpError extends BtxError {
  constructor(
    public readonly status: number,
    /** Response body, with `Authorization: Basic ...` patterns redacted. */
    public readonly body: string,
    method?: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`, method);
    this.name = 'BtxHttpError';
  }
}

/** The HTTP response was 2xx but the body wasn't valid JSON. */
export class BtxParseError extends BtxError {
  constructor(
    /** Underlying SyntaxError or similar. Overrides the ES2022 `Error.cause` slot. */
    public override readonly cause: unknown,
    /** Raw response body (redacted). */
    public readonly body: string,
    method?: string,
  ) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to parse RPC response: ${causeMsg}`, method);
    this.name = 'BtxParseError';
  }
}

/** Request exceeded `timeoutMs`. */
export class BtxTimeoutError extends BtxError {
  constructor(
    public readonly timeoutMs: number,
    method?: string,
  ) {
    super(`RPC request timed out after ${timeoutMs}ms`, method);
    this.name = 'BtxTimeoutError';
  }
}

/** Transport-level failure (DNS, TCP reset, TLS, etc.). Wraps the underlying cause. */
export class BtxNetworkError extends BtxError {
  constructor(
    /** Underlying error from fetch / dns / tls. Overrides the ES2022 `Error.cause` slot. */
    public override readonly cause: unknown,
    method?: string,
  ) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`RPC network error: ${causeMsg}`, method);
    this.name = 'BtxNetworkError';
  }
}
