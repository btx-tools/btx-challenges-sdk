// M3 byte-exact integration — the PUBLIC Solver.solve({mode:'webgpu'}) path end-to-end
// through the BUILT SDK dist + the optional @btx-tools/matmul-webgpu kernel, on real GPU.
// Exercises the complete chain: dispatch → loadWebGpu → resolveWebGpuFactory →
// solveWithWebGpuFactory (challengeToWasmArgs + C-1 guard + destroy) → kernel. Node/vitest
// has no WebGPU, so this runs under Deno. The optional-dep bare specifier is mapped to the
// built package via tests/integration/deno.json (Deno doesn't auto-resolve it):
//
//   pnpm --filter @btx-tools/challenges-sdk build
//   pnpm --filter @btx-tools/matmul-webgpu build
//   (from packages/core/) deno run --unstable-webgpu --allow-read \
//       --config tests/integration/deno.json tests/integration/solver-webgpu.deno.ts
//
// Goldens = the same KAT vectors the package's GPU battery pins (from solveJs).
import { Solver } from '../../dist/index.js';

const PREV = '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210';
const MERK = 'fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef';
const SEED_A = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const SEED_B = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
const TARGET = '03' + 'ff'.repeat(31);
const ZERO = '00'.repeat(32);

// deno-lint-ignore no-explicit-any
function mk(n: number, b: number, r: number): any {
  return {
    kind: 'matmul_service_challenge_v1',
    challenge_id: 'webgpu-int',
    issued_at: 0,
    expires_at: 0,
    expires_in_s: 300,
    binding: {
      chain: 'main',
      purpose: 't',
      resource: 't',
      subject: 't',
      resource_hash: ZERO,
      subject_hash: ZERO,
      salt: '00',
      anchor_height: 0,
      anchor_hash: ZERO,
    },
    proof_policy: {
      verification_rule: 'r',
      sigma_gate_applied: false,
      expiration_enforced: false,
      challenge_id_required: false,
      replay_protection: 'none',
      redeem_rpc: 'redeemmatmulservicechallenge',
      solve_rpc: 'solvematmulservicechallenge',
      locally_issued_required: false,
    },
    challenge: {
      chain: 'main',
      algorithm: 'matmul',
      height: 0,
      previousblockhash: PREV,
      mintime: 0,
      bits: '1d00ffff',
      difficulty: 1,
      target: TARGET,
      noncerange: '00000000ffffffff',
      header_context: {
        version: 1,
        previousblockhash: PREV,
        merkleroot: MERK,
        time: 1700000000,
        bits: '1d00ffff',
        nonce64_start: 0,
        matmul_dim: n,
        seed_a: SEED_A,
        seed_b: SEED_B,
      },
      matmul: {
        n,
        b,
        r,
        q: 2147483647,
        min_dimension: 4,
        max_dimension: 512,
        seed_a: SEED_A,
        seed_b: SEED_B,
      },
    },
  };
}

interface Case {
  n: number;
  b: number;
  r: number;
  nonce: string;
  digest: string;
}
const CASES: Case[] = [
  {
    n: 8,
    b: 4,
    r: 2,
    nonce: '0000000000000007',
    digest: '03245d6fa3c749ae50ef90231a180fc970d3a5ad0e23ae1f51a4d95e49f81cf9',
  },
  {
    n: 64,
    b: 8,
    r: 4,
    nonce: '000000000000000c',
    digest: '02bef301fabd558731b31c14cc6736854a4e4dd0408478090b7e8f7d26218c55',
  },
];

const gpu = (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;
if (!gpu) {
  console.log(
    '⏭️  no navigator.gpu — skipping (run: deno run --unstable-webgpu --allow-read --config tests/integration/deno.json …)',
  );
  Deno.exit(0);
}

let allPass = true;
for (const c of CASES) {
  const out = await Solver.solve(mk(c.n, c.b, c.r), { mode: 'webgpu', webgpu: { maxTries: 256 } });
  const ok =
    out.nonce64_hex === c.nonce && out.digest_hex === c.digest && out.proof.nonce64_hex === c.nonce;
  allPass &&= ok;
  console.log(
    `mode:'webgpu' n=${c.n}: nonce=${out.nonce64_hex} digest=${out.digest_hex.slice(0, 16)}…  ${ok ? '✅' : `❌ want ${c.nonce} / ${c.digest.slice(0, 16)}…`}`,
  );
}

// auto cascade prefers webgpu over wasm/pure-js when navigator.gpu is present → same byte-exact proof.
const auto = await Solver.solve(mk(8, 4, 2), { mode: 'auto', webgpu: { maxTries: 256 } });
const autoOk = auto.nonce64_hex === CASES[0]!.nonce && auto.digest_hex === CASES[0]!.digest;
allPass &&= autoOk;
console.log(
  `mode:'auto' (gpu present → webgpu) n=8: nonce=${auto.nonce64_hex}  ${autoOk ? '✅' : '❌'}`,
);

console.log(
  allPass
    ? '✅ M3 INTEGRATION PASS — Solver.solve({mode:webgpu|auto}) byte-exact via real kernel'
    : '❌ M3 integration FAIL',
);
Deno.exit(allPass ? 0 : 1);
