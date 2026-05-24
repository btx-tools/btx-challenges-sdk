/**
 * WebGPU solver-mode tests (mode: 'webgpu', optional @btx-tools/matmul-webgpu).
 *
 * No GPU here — node/vitest has no WebGPU. These cover the *plumbing*:
 *  1. resolveWebGpuFactory maps a module to the createWebGpuSolver factory.
 *  2. solveWithWebGpuFactory maps the envelope (reusing challengeToWasmArgs +
 *     its C-1 guard), runs one chunk, and always destroy()s — exercised with a
 *     synthetic factory.
 *  3. mode:'webgpu' degrades with a clear error when no WebGPU runtime is present.
 *  4. mode:'auto' does not pick webgpu in node (falls through to pure-js).
 * Byte-exact end-to-end via a real GPU lives in tests/integration (Deno).
 */
import { describe, expect, it } from 'vitest';
import {
  Solver,
  resolveWebGpuFactory,
  solveWithWebGpuFactory,
  type WebGpuFactory,
} from '../../src/solver.js';
import type { Challenge } from '../../src/index.js';

/** A valid-hex challenge with a trivial target (pure-js solves it on nonce 0). */
const challenge: Challenge = {
  kind: 'matmul_service_challenge_v1',
  challenge_id: 'webgpu-test',
  issued_at: 1779270000,
  expires_at: 1779270120,
  expires_in_s: 120,
  binding: {
    chain: 'main',
    purpose: 'rate_limit',
    resource: 'test:/r',
    subject: 'test:s',
    resource_hash: 'aa',
    subject_hash: 'bb',
    salt: 'cc',
    anchor_height: 1,
    anchor_hash: 'dd',
  },
  proof_policy: {
    verification_rule: 'rule',
    sigma_gate_applied: false,
    expiration_enforced: true,
    challenge_id_required: true,
    replay_protection: 'redeemmatmulserviceproof',
    redeem_rpc: 'redeemmatmulserviceproof',
    solve_rpc: 'solvematmulservicechallenge',
    locally_issued_required: true,
  },
  challenge: {
    chain: 'main',
    algorithm: 'matmul',
    height: 2,
    previousblockhash: '11'.repeat(32),
    mintime: 1779270000,
    bits: '1e1bb4ae',
    difficulty: 0.0001,
    target: 'ff'.repeat(32),
    noncerange: '0000000000000000ffffffffffffffff',
    header_context: {
      version: 1,
      previousblockhash: '11'.repeat(32),
      merkleroot: '22'.repeat(32),
      time: 1779270000,
      bits: '1e1bb4ae',
      nonce64_start: 0,
      matmul_dim: 4,
      seed_a: '33'.repeat(32),
      seed_b: '44'.repeat(32),
    },
    matmul: {
      n: 4,
      b: 2,
      r: 1,
      q: 2147483647,
      min_dimension: 64,
      max_dimension: 2048,
      seed_a: '33'.repeat(32),
      seed_b: '44'.repeat(32),
    },
  },
};

describe('resolveWebGpuFactory — module-shape handling', () => {
  it('resolves a named createWebGpuSolver export', () => {
    const fn = async () => ({ solveChunk: async () => undefined, destroy: () => {} });
    expect(resolveWebGpuFactory({ createWebGpuSolver: fn })).toBe(fn);
  });

  it('resolves createWebGpuSolver under default', () => {
    const fn = async () => ({ solveChunk: async () => undefined, destroy: () => {} });
    expect(resolveWebGpuFactory({ default: { createWebGpuSolver: fn } })).toBe(fn);
  });

  it('throws when no factory is exported', () => {
    expect(() => resolveWebGpuFactory({})).toThrow('createWebGpuSolver function');
  });
});

describe('solveWithWebGpuFactory — mapping, destroy, exhaustion', () => {
  it('maps the envelope to WasmSolverArgs + init, returns a SolverOutput, and destroys', async () => {
    let capturedArgs: unknown[] = [];
    let destroyed = false;
    const fake: WebGpuFactory = async (...args) => {
      capturedArgs = args;
      return {
        async solveChunk() {
          return { nonce_hex: '0000000000000005', digest_hex: 'ab'.repeat(32) };
        },
        destroy() {
          destroyed = true;
        },
      };
    };
    const out = await solveWithWebGpuFactory(challenge, fake, { batchSize: 32 });
    // first 11 args == WasmSolverArgs (version..target), then the init object.
    expect(capturedArgs.slice(0, 11)).toEqual([
      1,
      '11'.repeat(32),
      '22'.repeat(32),
      1779270000,
      '1e1bb4ae',
      4,
      2,
      1,
      '33'.repeat(32),
      '44'.repeat(32),
      'ff'.repeat(32),
    ]);
    expect(capturedArgs[11]).toEqual({ batchSize: 32 });
    expect(out.nonce64_hex).toBe('0000000000000005');
    expect(out.proof).toMatchObject({
      nonce64_hex: '0000000000000005',
      digest_hex: 'ab'.repeat(32),
    });
    expect(destroyed).toBe(true);
  });

  it('throws (and still destroys) when the solver exhausts maxTries', async () => {
    let destroyed = false;
    const fake: WebGpuFactory = async () => ({
      async solveChunk() {
        return undefined;
      },
      destroy() {
        destroyed = true;
      },
    });
    await expect(solveWithWebGpuFactory(challenge, fake, { maxTries: 10 })).rejects.toThrow(
      'exhausted maxTries=10',
    );
    expect(destroyed).toBe(true);
  });

  it('reuses the C-1 seed/dim guard (rejects a mismatched envelope before creating the solver)', async () => {
    let created = false;
    const fake: WebGpuFactory = async () => {
      created = true;
      return {
        async solveChunk() {
          return undefined;
        },
        destroy() {},
      };
    };
    const mismatch: Challenge = {
      ...challenge,
      challenge: {
        ...challenge.challenge,
        header_context: { ...challenge.challenge.header_context, seed_a: '99'.repeat(32) },
      },
    };
    await expect(solveWithWebGpuFactory(mismatch, fake)).rejects.toThrow();
    expect(created).toBe(false);
  });
});

describe('mode:"webgpu" / "auto" in a non-WebGPU environment (node)', () => {
  it('mode:"webgpu" throws a clear error when navigator.gpu is absent', async () => {
    await expect(Solver.solve(challenge, { mode: 'webgpu' })).rejects.toThrow(
      'needs a WebGPU runtime',
    );
  });

  it('mode:"auto" skips webgpu in node and still produces a proof (pure-js)', async () => {
    const out = await Solver.solve(challenge, { mode: 'auto' });
    expect(out.nonce64_hex).toHaveLength(16);
    expect(out.digest_hex).toHaveLength(64);
  });
});
