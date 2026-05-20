/**
 * Type definitions mirroring the BTX service-challenges RPC schema.
 * Source: btx.dev/docs/rpc/service-challenges (verified 2026-05-20).
 *
 * All fields are mirrored verbatim from btxd help output. We do NOT
 * camelCase rename — the RPC schema is the contract.
 */

/** Difficulty calibration policy for issued challenges. */
export type DifficultyPolicy = 'fixed' | 'adaptive_window';

/** Standard purpose labels recognized by the chain. Free-form strings allowed too. */
export type ChallengePurpose =
  | 'rate_limit'
  | 'api_gate'
  | 'ai_inference_gate'
  | (string & {});

/** Parameters for issuing a challenge via getmatmulservicechallenge. */
export interface IssueParams {
  purpose: ChallengePurpose;
  resource: string;
  subject: string;
  /** Default 1.0 — calibrates compute work to roughly this many seconds on a baseline solver. */
  target_solve_time_s?: number;
  /** Default 300 — challenge expiry in seconds (range 1–86400). */
  expires_in_s?: number;
  validation_overhead_s?: number;
  propagation_overhead_s?: number;
  difficulty_policy?: DifficultyPolicy;
  difficulty_window_blocks?: number;
  min_solve_time_s?: number;
  max_solve_time_s?: number;
  solver_parallelism?: number;
  solver_duty_cycle_pct?: number;
}

/** The challenge envelope returned by btxd. Opaque to the SDK — pass through to solver / verifier. */
export interface Challenge {
  challenge_id: string;
  issued_at: number;
  expires_at: number;
  expires_in_s: number;
  binding: {
    purpose: string;
    resource: string;
    subject: string;
    [k: string]: unknown;
  };
  proof_policy: Record<string, unknown>;
  challenge: {
    target_bits?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Outcome of verifymatmulserviceproof / redeemmatmulserviceproof. */
export interface VerifyResult {
  valid: boolean;
  expired?: boolean;
  reason: string;
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
  /** Full JSON-RPC endpoint, e.g. http://127.0.0.1:19332 */
  rpcUrl: string;
  /** Basic-auth credentials matching btxd's rpcauth / rpcuser+rpcpassword. */
  rpcAuth: {
    user: string;
    pass: string;
  };
  /** Request timeout in ms (default 30000). */
  timeoutMs?: number;
}

/** Errors thrown by the SDK. */
export class BtxRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly method?: string,
  ) {
    super(message);
    this.name = 'BtxRpcError';
  }
}

export class BtxHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly method?: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'BtxHttpError';
  }
}
