import type { Challenge, SolverOutput } from './types.js';

/**
 * Browser-side / client-side MatMul challenge solver.
 *
 * **Day 1 STUB** — throws `not_implemented`. The real solver lands Day 2
 * of the 9-day build plan (port from btxd source to TypeScript; pure JS first,
 * WASM fallback if perf demands).
 *
 * For server-side solving (fixtures, tests) use {@link BtxChallengeClient.solve}
 * which RPC-delegates to `solvematmulservicechallenge` on btxd.
 *
 * Roadmap: https://github.com/btx-tools/btx-challenges-sdk#roadmap
 */
export class Solver {
  /** Solve a challenge locally. Returns `{nonce64_hex, digest_hex, proof}`. */
  static async solve(_challenge: Challenge): Promise<SolverOutput> {
    throw new Error(
      'Solver.solve is not yet implemented. Day 2 of the build plan ships the ' +
        'MatMul solver port. For server-side solving today, use ' +
        'BtxChallengeClient.solve(challenge) instead, which delegates to btxd.',
    );
  }
}
