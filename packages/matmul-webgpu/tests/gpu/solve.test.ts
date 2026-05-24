// GPU byte-exact battery — runs under Deno (`deno run --unstable-webgpu`), NOT
// vitest (node has no WebGPU). Imports the BUILT dist so it exercises the
// published artifact. Prerequisite: `pnpm --filter @btx-tools/matmul-webgpu build`.
//
//   deno run --unstable-webgpu tests/gpu/solve.test.ts
//
// Goldens are frozen KAT vectors generated from @btx-tools/challenges-sdk's
// Solver.solve({mode:'pure-js'}) (which is itself byte-validated vs btxd):
//   target = "03" + "ff"*31.
import { createWebGpuSolver } from '../../dist/index.js';

const PREV = '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210';
const MERK = 'fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef';
const SEED_A = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const SEED_B = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
const TARGET = '03' + 'ff'.repeat(31);

interface Case {
  n: number;
  b: number;
  r: number;
  nonce_hex: string;
  digest_hex: string;
}
const CASES: Case[] = [
  // single-block transcript (N³=8) — regression on the n=8 spike vector
  {
    n: 8,
    b: 4,
    r: 2,
    nonce_hex: '0000000000000007',
    digest_hex: '03245d6fa3c749ae50ef90231a180fc970d3a5ad0e23ae1f51a4d95e49f81cf9',
  },
  // multi-block transcript (N³=512 = 32 SHA blocks) — the M2 gate
  {
    n: 64,
    b: 8,
    r: 4,
    nonce_hex: '000000000000000c',
    digest_hex: '02bef301fabd558731b31c14cc6736854a4e4dd0408478090b7e8f7d26218c55',
  },
];

const gpu = (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;
if (!gpu) {
  console.log('⏭️  no navigator.gpu — skipping GPU battery (run with: deno run --unstable-webgpu)');
  Deno.exit(0);
}

let allPass = true;
for (const c of CASES) {
  const solver = await createWebGpuSolver(
    1,
    PREV,
    MERK,
    1700000000,
    '1d00ffff',
    c.n,
    c.b,
    c.r,
    SEED_A,
    SEED_B,
    TARGET,
  );
  const hit = await solver.solveChunk(0n, 1n, 256n);
  solver.destroy();
  const ok = !!hit && hit.nonce_hex === c.nonce_hex && hit.digest_hex === c.digest_hex;
  allPass &&= ok;
  console.log(
    `n=${c.n} b=${c.b} r=${c.r}: nonce=${hit?.nonce_hex} digest=${hit?.digest_hex?.slice(0, 16)}…  ${ok ? '✅' : `❌ want ${c.nonce_hex} / ${c.digest_hex.slice(0, 16)}…`}`,
  );
}

// guards: stride≠1, nonce range (audit H-1), miss behavior, double-destroy (audit M-2)
const s = await createWebGpuSolver(
  1,
  PREV,
  MERK,
  1700000000,
  '1d00ffff',
  8,
  4,
  2,
  SEED_A,
  SEED_B,
  '00'.repeat(32),
);
const threwOn = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};
const strideThrew = await threwOn(() => s.solveChunk(0n, 2n, 10n));
const nonceLoThrew = await threwOn(() => s.solveChunk(-1n, 1n, 4n));
const nonceHiThrew = await threwOn(() => s.solveChunk(1n << 32n, 1n, 4n)); // start at 2³²
const crossThrew = await threwOn(() => s.solveChunk((1n << 32n) - 2n, 1n, 8n)); // crosses 2³²
const miss = await s.solveChunk(0n, 1n, 4n); // target all-zero, 4 nonces → no hit
s.destroy();
s.destroy(); // idempotent — must not throw
const guardsOk = strideThrew && nonceLoThrew && nonceHiThrew && crossThrew && miss === undefined;
allPass &&= guardsOk;
console.log(
  `guards: stride≠1=${strideThrew} nonce<0=${nonceLoThrew} nonce≥2³²=${nonceHiThrew} crosses2³²=${crossThrew} unsat→undef=${miss === undefined} dbl-destroy=ok  ${guardsOk ? '✅' : '❌'}`,
);

console.log(
  allPass
    ? '✅ GPU battery PASS (n=8 single-block + n=64 multi-block + guards)'
    : '❌ GPU battery FAIL',
);
Deno.exit(allPass ? 0 : 1);
