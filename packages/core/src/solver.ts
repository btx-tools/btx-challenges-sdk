import type { BtxChallengeClient } from './client.js';
import { solveJs, type SolveJsOptions } from './matmul/pow.js';
import type { Challenge, SolverOutput } from './types.js';

/**
 * How a challenge should be solved.
 *
 * - `'rpc'` — delegate to btxd's `solvematmulservicechallenge`. Requires
 *   `opts.rpcClient`. Server-side / Node-only.
 *
 * - `'pure-js'` — solve locally with a pure-TypeScript MatMul implementation.
 *   Browser-compatible. Ports the canonical CPU path of btxd's matmul solver.
 *   At default difficulty + n=512, pure-JS solving is slow (perf is currently
 *   bounded by `BigInt`-based M31 multiplication; WASM/SIMD acceleration is
 *   planned for a future iteration).
 *
 * - `'auto'` — pick automatically: `'rpc'` if `opts.rpcClient` is provided,
 *   else `'pure-js'`.
 */
export type SolverMode = 'rpc' | 'pure-js' | 'auto';

/** Options for {@link Solver.solve}. */
export interface SolverOptions {
  /** Solve strategy. Default: `'auto'` (rpc if client provided, else pure-js). */
  mode?: SolverMode;
  /** Required for `mode === 'rpc'`. Ignored for `'pure-js'`. */
  rpcClient?: BtxChallengeClient;
  /** Forwarded to the pure-JS solver. Ignored for `'rpc'`. */
  pureJs?: SolveJsOptions;
}

/**
 * Solve a BTX service challenge to produce a (nonce, digest, proof) tuple
 * that btxd will accept on redemption.
 *
 * **Modes**:
 *  - `'rpc'`: delegate to btxd's `solvematmulservicechallenge` RPC. Pass an
 *    authenticated `BtxChallengeClient` in `opts.rpcClient`. **Production
 *    note**: the solve RPC shares the matmul backend with block-template
 *    mining; consumers MUST point at a dedicated non-mining btxd, otherwise
 *    individual solves can queue behind mining work for 10+ minutes.
 *  - `'pure-js'`: solve locally with the ported TypeScript MatMul. Browser-
 *    compatible. Slower than `'rpc'` but no node required.
 *  - `'auto'`: prefers `'rpc'` if a client is provided, else `'pure-js'`.
 *
 * @example Server-side (Node, RPC mode)
 * ```typescript
 * import { BtxChallengeClient, Solver } from '@btx-tools/challenges-sdk';
 *
 * const client = new BtxChallengeClient({
 *   rpcUrl: 'http://127.0.0.1:19332',
 *   rpcAuth: { user: 'rpcuser', pass: 'rpcpass' },
 * });
 *
 * const challenge = await client.issue({
 *   purpose: 'ai_inference_gate',
 *   resource: 'model:gpt-x|route:/v1/generate',
 *   subject: 'tenant:abc123',
 * });
 *
 * const proof = await Solver.solve(challenge, { mode: 'rpc', rpcClient: client });
 * const result = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
 *
 * if (result.valid && result.reason === 'ok') {
 *   // Admit the caller.
 * }
 * ```
 *
 * @example Browser-side (pure-JS mode)
 * ```typescript
 * import { Solver } from '@btx-tools/challenges-sdk';
 *
 * // Solve a challenge with no server-side help. Slow at default difficulty;
 * // for production browser use cases, calibrate via `target_solve_time_s`.
 * const proof = await Solver.solve(challenge, {
 *   mode: 'pure-js',
 *   pureJs: { maxTries: 100_000 },
 * });
 * ```
 */
export class Solver {
  static async solve(challenge: Challenge, opts: SolverOptions = {}): Promise<SolverOutput> {
    const mode: SolverMode = opts.mode ?? (opts.rpcClient ? 'rpc' : 'pure-js');

    switch (mode) {
      case 'rpc':
        return solveViaRpc(challenge, opts);
      case 'pure-js':
        return solveViaPureJs(challenge, opts);
      case 'auto':
        if (opts.rpcClient) return solveViaRpc(challenge, opts);
        return solveViaPureJs(challenge, opts);
      default: {
        // Exhaustiveness guard — unreachable if SolverMode is the source of truth.
        const _exhaustive: never = mode;
        throw new Error(`Solver.solve: unknown mode "${_exhaustive as string}"`);
      }
    }
  }
}

async function solveViaRpc(challenge: Challenge, opts: SolverOptions): Promise<SolverOutput> {
  if (!opts.rpcClient) {
    throw new Error(
      'Solver.solve: mode="rpc" requires opts.rpcClient. ' +
        'Construct a BtxChallengeClient and pass it via opts.rpcClient.',
    );
  }
  return opts.rpcClient.solve(challenge);
}

async function solveViaPureJs(challenge: Challenge, opts: SolverOptions): Promise<SolverOutput> {
  const result = solveJs(challenge, opts.pureJs);
  if (result === null) {
    const tries = opts.pureJs?.maxTries ?? 1_000_000;
    throw new Error(
      `Solver.solve: pure-JS solver exhausted maxTries=${tries} without finding a proof. ` +
        'Increase maxTries or lower challenge difficulty (target_solve_time_s).',
    );
  }
  return result;
}
