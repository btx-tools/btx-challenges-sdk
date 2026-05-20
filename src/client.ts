import {
  BtxHttpError,
  BtxRpcError,
  type BatchEntry,
  type BatchResult,
  type BtxClientOpts,
  type Challenge,
  type IssueParams,
  type SolverOutput,
  type VerifyResult,
} from './types.js';

interface JsonRpcResponse<T> {
  result: T;
  error: { code: number; message: string } | null;
  id: number | string;
}

/**
 * JSON-RPC client for BTX service-challenges.
 *
 * Wraps the 5 core RPCs:
 *   - getmatmulservicechallenge   (issue)
 *   - verifymatmulserviceproof    (verify, stateless)
 *   - redeemmatmulserviceproof    (verify + consume, anti-replay)
 *   - verifymatmulserviceproofs   (batch verify)
 *   - redeemmatmulserviceproofs   (batch redeem)
 *
 * Plus helper RPCs:
 *   - solvematmulservicechallenge (local solver, server-side)
 *
 * RPC reference: https://btx.dev/docs/rpc/service-challenges
 */
export class BtxChallengeClient {
  private requestId = 0;

  constructor(private readonly opts: BtxClientOpts) {}

  /** Low-level: raw JSON-RPC call. Exposed for forward compatibility. */
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const id = ++this.requestId;
    const auth =
      'Basic ' + btoa(`${this.opts.rpcAuth.user}:${this.opts.rpcAuth.pass}`);
    const body = JSON.stringify({ jsonrpc: '1.0', id, method, params });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000);

    try {
      const res = await fetch(this.opts.rpcUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: auth,
        },
        body,
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new BtxHttpError(res.status, text, method);
      }

      const data = (await res.json()) as JsonRpcResponse<T>;

      if (data.error) {
        throw new BtxRpcError(data.error.code, data.error.message, method);
      }

      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Issue a fresh challenge bound to (purpose, resource, subject). */
  async issue(params: IssueParams): Promise<Challenge> {
    return this.call<Challenge>('getmatmulservicechallenge', [
      params.purpose,
      params.resource,
      params.subject,
      params.target_solve_time_s ?? 1,
      params.expires_in_s ?? 300,
      params.validation_overhead_s ?? 0,
      params.propagation_overhead_s ?? 0,
      params.difficulty_policy ?? 'fixed',
      params.difficulty_window_blocks ?? 24,
      params.min_solve_time_s ?? 0.25,
      params.max_solve_time_s ?? 30,
      params.solver_parallelism ?? 1,
      params.solver_duty_cycle_pct ?? 100,
    ]);
  }

  /**
   * Verify a proof statelessly. Does NOT consume the challenge.
   * Use this for diagnostic / monitoring paths.
   * For admission control, use {@link redeem} instead — verification alone
   * does not prevent replay.
   */
  async verify(
    challenge: Challenge,
    nonce64_hex: string,
    digest_hex: string,
    lookup_local_status = true,
  ): Promise<VerifyResult> {
    return this.call<VerifyResult>('verifymatmulserviceproof', [
      challenge,
      nonce64_hex,
      digest_hex,
      lookup_local_status,
    ]);
  }

  /**
   * Verify-and-consume atomically. THIS is the admission control entry point.
   * On success, the challenge is marked redeemed and cannot be replayed.
   */
  async redeem(
    challenge: Challenge,
    nonce64_hex: string,
    digest_hex: string,
  ): Promise<VerifyResult> {
    return this.call<VerifyResult>('redeemmatmulserviceproof', [
      challenge,
      nonce64_hex,
      digest_hex,
    ]);
  }

  /** Batch verify (1–256 proofs). No consumption. */
  async verifyBatch(entries: BatchEntry[]): Promise<BatchResult> {
    return this.call<BatchResult>('verifymatmulserviceproofs', [entries]);
  }

  /** Batch verify + consume. Sequential per-entry. */
  async redeemBatch(entries: BatchEntry[]): Promise<BatchResult> {
    return this.call<BatchResult>('redeemmatmulserviceproofs', [entries]);
  }

  /**
   * Server-side local solver. Useful when the client cannot solve locally
   * (e.g., generating fixtures, or pre-computing for tests).
   *
   * For production browser-side solving, ship a WASM solver instead — RPC-based
   * solving puts compute load on YOUR node, defeating the point.
   */
  async solve(challenge: Challenge): Promise<SolverOutput> {
    return this.call<SolverOutput>('solvematmulservicechallenge', [challenge]);
  }
}
