/**
 * WASM solver-mode tests (mode: 'wasm', optional @btx-tools/matmul-wasm).
 *
 * Three concerns:
 *  1. challengeToWasmArgs maps the envelope to the kernel's ctor args (pure).
 *  2. The WASM proof is byte-identical to the pure-JS proof — run against the
 *     locally-built crate artifact (`../btx-challenges-wasm/pkg-node`). Skipped
 *     if that build is absent (so SDK CI without the kernel stays green).
 *  3. mode:'wasm' degrades gracefully (clear error) when the optional package
 *     isn't installed — which is the case in this workspace.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Solver, challengeToWasmArgs, solveWithWasmCtor } from '../../src/solver.js';
import { solveJs } from '../../src/matmul/pow.js';
import type { Challenge } from '../../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/core/tests/unit → ~/code, then into the sibling crate's nodejs build.
const PKG_NODE = resolve(
  here,
  '../../../../../btx-challenges-wasm/pkg-node/btx_challenges_wasm.js',
);

/** A valid-hex challenge solvable by both kernels (tiny n=4, lax target). */
const challenge: Challenge = {
  kind: 'matmul_service_challenge_v1',
  challenge_id: 'wasm-test',
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

/** True if the optional @btx-tools/matmul-wasm package resolves in this workspace. */
async function wasmPackageInstalled(): Promise<boolean> {
  const spec = '@btx-tools/matmul-wasm';
  try {
    await import(spec);
    return true;
  } catch {
    return false;
  }
}
const pkgInstalled = await wasmPackageInstalled();

describe('challengeToWasmArgs', () => {
  it('maps the envelope to the ordered WasmSolver ctor args', () => {
    expect(challengeToWasmArgs(challenge)).toEqual([
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
  });

  // Audit C-1: the WASM kernel uses one seed/dim for both the seed matrices and
  // the header; the pure-JS path reads them from two sources. Guard that they
  // agree, so mode:'wasm' fails loud rather than emitting a divergent proof.
  it('throws when header_context seeds/dim differ from matmul seeds/n', () => {
    const divergent: Challenge = {
      ...challenge,
      challenge: {
        ...challenge.challenge,
        header_context: { ...challenge.challenge.header_context, seed_a: '55'.repeat(32) },
      },
    };
    expect(() => challengeToWasmArgs(divergent)).toThrow(
      /header_context\.\{seed_a,seed_b,matmul_dim\}/,
    );
  });

  it.skipIf(!existsSync(PKG_NODE))(
    'solveWithWasmCtor enforces the C-1 invariant before constructing the kernel',
    async () => {
      const mod = (await import(PKG_NODE)) as {
        WasmSolver?: unknown;
        default?: { WasmSolver?: unknown };
      };
      const Ctor = (mod.WasmSolver ?? mod.default?.WasmSolver) as Parameters<
        typeof solveWithWasmCtor
      >[1];
      const divergent: Challenge = {
        ...challenge,
        challenge: {
          ...challenge.challenge,
          header_context: { ...challenge.challenge.header_context, matmul_dim: 8 },
        },
      };
      expect(() => solveWithWasmCtor(divergent, Ctor)).toThrow(/matmul_dim/);
    },
  );
});

describe('WASM proof parity (against the built crate artifact)', () => {
  it.skipIf(!existsSync(PKG_NODE))(
    'produces a byte-identical proof to the pure-JS solver',
    async () => {
      const mod = (await import(PKG_NODE)) as {
        WasmSolver?: unknown;
        default?: { WasmSolver?: unknown };
      };
      const Ctor = (mod.WasmSolver ?? mod.default?.WasmSolver) as Parameters<
        typeof solveWithWasmCtor
      >[1];

      const wasmOut = solveWithWasmCtor(challenge, Ctor);
      const jsOut = solveJs(challenge);
      expect(jsOut).not.toBeNull();
      expect(wasmOut.nonce64_hex).toBe(jsOut!.nonce64_hex);
      expect(wasmOut.digest_hex).toBe(jsOut!.digest_hex);
      expect(wasmOut.nonce64_hex).toHaveLength(16);
      expect(wasmOut.digest_hex).toHaveLength(64);
    },
  );
});

describe('mode: "wasm" — graceful degradation', () => {
  it.skipIf(pkgInstalled)(
    'throws a clear error when @btx-tools/matmul-wasm is not installed',
    async () => {
      await expect(Solver.solve(challenge, { mode: 'wasm' })).rejects.toThrow(
        /@btx-tools\/matmul-wasm/,
      );
    },
  );
});
