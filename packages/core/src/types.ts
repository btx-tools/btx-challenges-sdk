/**
 * Type definitions mirroring the BTX service-challenges RPC schema.
 *
 * Source: btx.dev/docs/rpc/service-challenges (verified 2026-05-20).
 * Schema captured against live btxd v0.29.7 at btx-iowa (block 106270).
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
  /** Request timeout in ms (default 30000). */
  timeoutMs?: number;
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
