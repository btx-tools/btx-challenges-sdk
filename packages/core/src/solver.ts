import type { BtxChallengeClient } from './client.js';
import type { Challenge, SolverOutput } from './types.js';

/**
 * How a challenge should be solved.
 *
 * - `'rpc'` — delegate to btxd's `solvematmulservicechallenge`. Requires
 *   `opts.rpcClient`. Server-side / Node-only. Available **now (Day 2)**.
 *
 * - `'pure-js'` — solve locally with a TypeScript/WASM implementation.
 *   Browser-compatible. **Not yet implemented** (Day 2.5 of the build
 *   plan ports the MatMul algorithm). Throws explicit not-yet-implemented
 *   today so consuming code can structure around the eventual API.
 *
 * - `'auto'` — pick automatically: `'rpc'` if `opts.rpcClient` is provided,
 *   else `'pure-js'` (which will throw until Day 2.5 lands).
 */
export type SolverMode = 'rpc' | 'pure-js' | 'auto';

/** Options for {@link Solver.solve}. */
export interface SolverOptions {
  /** Solve strategy. Default: `'auto'` (rpc if client provided, else pure-js). */
  mode?: SolverMode;
  /** Required for `mode === 'rpc'`. Ignored for `'pure-js'`. */
  rpcClient?: BtxChallengeClient;
}

/**
 * Solve a BTX service challenge to produce a (nonce, digest, proof) tuple
 * that btxd will accept on redemption.
 *
 * **Day 2 ship: RPC mode only.** Pass an authenticated `BtxChallengeClient`
 * in `opts.rpcClient`; the call is delegated to btxd's
 * `solvematmulservicechallenge` RPC. The btxd node performs the MatMul work
 * (typical 1–4 seconds at default `target_solve_time_s`).
 *
 * **Day 2.5 ship (planned): pure-JS / WASM mode** for browser-side solving.
 * Until then, `mode: 'pure-js'` throws a not-yet-implemented error.
 *
 * @example Server-side (Node, RPC mode)
 * ```typescript
 * import { BtxChallengeClient, Solver } from '@btx/challenges-sdk';
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
 * @example Browser-side (Day 2.5+, pure-JS mode)
 * ```typescript
 * // const proof = await Solver.solve(challenge, { mode: 'pure-js' });
 * // Day 2: throws not_implemented. Day 2.5: solves with bundled WASM/JS.
 * ```
 */
export class Solver {
  static async solve(
    challenge: Challenge,
    opts: SolverOptions = {},
  ): Promise<SolverOutput> {
    const mode: SolverMode = opts.mode ?? (opts.rpcClient ? 'rpc' : 'pure-js');

    switch (mode) {
      case 'rpc':
        return solveViaRpc(challenge, opts);
      case 'pure-js':
        return solveViaPureJs(challenge);
      case 'auto':
        if (opts.rpcClient) return solveViaRpc(challenge, opts);
        return solveViaPureJs(challenge);
      default: {
        // Exhaustiveness guard — unreachable if SolverMode is the source of truth.
        const _exhaustive: never = mode;
        throw new Error(`Solver.solve: unknown mode "${_exhaustive as string}"`);
      }
    }
  }
}

async function solveViaRpc(
  challenge: Challenge,
  opts: SolverOptions,
): Promise<SolverOutput> {
  if (!opts.rpcClient) {
    throw new Error(
      'Solver.solve: mode="rpc" requires opts.rpcClient. ' +
        'Construct a BtxChallengeClient and pass it via opts.rpcClient.',
    );
  }
  return opts.rpcClient.solve(challenge);
}

async function solveViaPureJs(_challenge: Challenge): Promise<SolverOutput> {
  throw new Error(
    'Solver.solve: mode="pure-js" is not yet implemented. ' +
      'Day 2.5 of the build plan ports the MatMul algorithm to TypeScript. ' +
      'For now, construct a BtxChallengeClient and use mode="rpc" instead.',
  );
}
