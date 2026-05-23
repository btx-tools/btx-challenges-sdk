/**
 * Perf-regression CI gate (audit F-5).
 *
 * Purpose: catch egregious slowdowns (≥20% regression) before they land on main.
 * NOT a precise benchmark — runs on shared GitHub Actions hardware so absolute
 * numbers are noisy. The ceilings here are deliberately generous (typically 5-10×
 * the local M-series Mac baseline). If CI fails here, something is genuinely
 * pathological in the hot path; investigate before merging.
 *
 * What's measured:
 *   - `canonicalMatMul` over `n=64, b=8` — the hot loop in pure-JS solve
 *   - `deriveCompressionVector` over `b=8` — sigma-derived compression coeffs
 *
 * What's NOT measured (out of scope for this gate):
 *   - End-to-end `Solver.solve` (non-deterministic attempt count → too flaky)
 *   - Cross-engine perf (covered by 0.0.2 cross-engine bench in CHANGELOG)
 *
 * Local baseline (M-series Mac, Node 22, 2026-05-22):
 *   - canonicalMatMul(n=64, b=8) ≈ 3 ms / call
 *   - deriveCompressionVector(b=8) ≈ 0.05 ms / call
 *
 * CI ceiling = ~5× local baseline. If a future PR pushes either ceiling within
 * spitting distance of the threshold, that's the signal — bump the ceiling or
 * fix the regression. Don't silently widen without a recorded reason.
 */

import { describe, expect, it } from 'vitest';

import { fromSeedRect } from '../../src/matmul/matrix.js';
import { canonicalMatMul, deriveCompressionVector } from '../../src/matmul/transcript.js';

const seed32 = (fill: number): Uint8Array => {
  const s = new Uint8Array(32);
  s.fill(fill);
  return s;
};

// Returns mean ms per iteration over N runs (drops slowest 20% as warmup/jitter)
function bench(fn: () => void, iterations: number): number {
  // Warmup
  for (let i = 0; i < 3; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const trimmed = samples.slice(0, Math.ceil(samples.length * 0.8));
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

describe('perf bench — F-5 regression gate', () => {
  it('canonicalMatMul(n=64, b=8) under 15 ms/call mean', () => {
    const aPrime = fromSeedRect(seed32(0x42), 64, 64);
    const bPrime = fromSeedRect(seed32(0x43), 64, 64);
    const sigma = seed32(0x44);
    const mean = bench(() => canonicalMatMul(aPrime, bPrime, 8, sigma), 20);
    // eslint-disable-next-line no-console
    console.log(`  canonicalMatMul(n=64,b=8) trimmed-mean=${mean.toFixed(3)}ms`);
    expect(mean).toBeLessThan(15);
  });

  it('deriveCompressionVector(b=8) under 0.5 ms/call mean', () => {
    const sigma = seed32(0x55);
    const mean = bench(() => deriveCompressionVector(sigma, 8), 50);
    // eslint-disable-next-line no-console
    console.log(`  deriveCompressionVector(b=8) trimmed-mean=${mean.toFixed(3)}ms`);
    expect(mean).toBeLessThan(0.5);
  });
});
