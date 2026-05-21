/**
 * Pure-JS solver perf bench. Measures wall-clock per full attempt at the
 * production matmul shape (n=512, b=16, r=8) on the current host.
 *
 * Each "attempt" walks the full canonical solve path for one nonce:
 *   A = FromSeed(seed_a, n=512)
 *   B = FromSeed(seed_b, n=512)
 *   sigma = DeriveSigma(header, nonce)
 *   noise = Generate(sigma, n, r)
 *   E = E_L · E_R, F = F_L · F_R   (n × r) · (r × n) → n × n
 *   A' = A + E, B' = B + F
 *   result = CanonicalMatMul(A', B', b, sigma)
 *
 * Reports mean / min / max / median over N attempts. Not part of `pnpm test`
 * — run on demand with:
 *
 *   npx tsx packages/core/tests/perf/solver-bench.ts
 *
 * Day 2.5 baseline on M-series Mac (2026-05-21): ~4.6 s / attempt. At
 * btxd's lowest difficulty (target_solve_time_s = min_solve_time_s = 0.001),
 * expected ~770 attempts to find a target-meeting nonce ≈ 1 hour wall-clock
 * end-to-end. Day 2.6 WASM port targets a 10× speed-up.
 */

import { deriveSigma, headerInputForNonce } from '../../src/matmul/header.js';
import { fromSeedRect, matAdd, matMul } from '../../src/matmul/matrix.js';
import { generate as generateNoise } from '../../src/matmul/noise.js';
import { canonicalMatMul } from '../../src/matmul/transcript.js';
import type { ChallengeHeaderContext } from '../../src/types.js';

const NUM_ATTEMPTS = Number(process.argv[2] ?? '5');
const N = 512;
const B = 16;
const R = 8;

const SYNTHETIC_HEADER_CTX: ChallengeHeaderContext = {
  version: 1,
  previousblockhash: '11'.repeat(32),
  merkleroot: '22'.repeat(32),
  time: 1700000000,
  bits: '1d00ffff',
  nonce64_start: 0,
  matmul_dim: N,
  seed_a: '33'.repeat(32),
  seed_b: '44'.repeat(32),
};

function parseHex32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function attemptOnce(nonce: bigint): number {
  const seedA = parseHex32(SYNTHETIC_HEADER_CTX.seed_a);
  const seedB = parseHex32(SYNTHETIC_HEADER_CTX.seed_b);
  const t0 = performance.now();
  const A = fromSeedRect(seedA, N, N);
  const Bm = fromSeedRect(seedB, N, N);
  const header = headerInputForNonce(SYNTHETIC_HEADER_CTX, nonce);
  const sigma = deriveSigma(header);
  const noise = generateNoise(sigma, N, R);
  const E = matMul(noise.E_L, noise.E_R);
  const F = matMul(noise.F_L, noise.F_R);
  const aPrime = matAdd(A, E);
  const bPrime = matAdd(Bm, F);
  const _result = canonicalMatMul(aPrime, bPrime, B, sigma);
  return performance.now() - t0;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

const samples: number[] = [];
console.log(
  `pure-JS solver bench — n=${N}, b=${B}, r=${R}, attempts=${NUM_ATTEMPTS}`,
);
console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);
console.log();

for (let i = 0; i < NUM_ATTEMPTS; i++) {
  const ms = attemptOnce(BigInt(i));
  samples.push(ms);
  console.log(`  attempt ${i}: ${fmtMs(ms)}`);
}

samples.sort((a, b) => a - b);
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
const median = samples[Math.floor(samples.length / 2)]!;
const min = samples[0]!;
const max = samples[samples.length - 1]!;

console.log();
console.log('summary:');
console.log(`  mean:   ${fmtMs(mean)}`);
console.log(`  median: ${fmtMs(median)}`);
console.log(`  min:    ${fmtMs(min)}`);
console.log(`  max:    ${fmtMs(max)}`);
console.log();
console.log(`At btxd target_solve_time_s=0.001 (P≈1.3e-3 per attempt),`);
console.log(`expected ~770 attempts ≈ ${fmtMs(770 * mean)} per solve.`);
