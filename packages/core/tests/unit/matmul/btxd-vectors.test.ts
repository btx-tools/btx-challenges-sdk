/**
 * Cross-validation against pinned golden vectors from btxd v0.29.7's own
 * test suite (`src/test/matmul_*_tests.cpp`). These tests prove our pure-JS
 * port produces byte-equal output to btxd's C++ implementation.
 *
 * Captured 2026-05-21 during Day 2.5 Step 10. Sigma additionally validated
 * against the live `verifymatmulserviceproof` RPC on btx-iowa.
 *
 * Source locations in btxd:
 *  - matrix_from_seed_deterministic   → src/test/matmul_matrix_tests.cpp
 *  - noise_derived_seed_pinned_EL     → src/test/matmul_noise_tests.cpp
 *  - noise_EL_pinned_elements         → src/test/matmul_noise_tests.cpp
 *  - noise_ER_pinned_elements         → src/test/matmul_noise_tests.cpp
 *  - canonical_matmul_n8_b4_pinned_transcript → src/test/matmul_transcript_tests.cpp
 */

import { describe, expect, it } from 'vitest';

import { NOISE_TAG_EL } from '../../../src/matmul/constants.js';
import { fromSeedRect } from '../../../src/matmul/matrix.js';
import { deriveNoiseSeed, generate as generateNoise } from '../../../src/matmul/noise.js';
import { canonicalMatMul } from '../../../src/matmul/transcript.js';

const ZERO_SIGMA = new Uint8Array(32);

function parseHex32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}

describe('btxd golden vectors — matrix.fromSeedRect', () => {
  it('FromSeed(zero, n=8) — pinned first 3 elements (btxd: matrix_from_seed_deterministic)', () => {
    const m = fromSeedRect(ZERO_SIGMA, 8, 8);
    expect(m.data[0]).toBe(1432335981);
    expect(m.data[1]).toBe(1134348657);
    expect(m.data[2]).toBe(428617384);
  });
});

describe('btxd golden vectors — noise.deriveNoiseSeed', () => {
  it('DeriveNoiseSeed(TAG_EL, zero_sigma) — pinned hex (btxd: noise_derived_seed_pinned_EL)', () => {
    const seed = deriveNoiseSeed(NOISE_TAG_EL, ZERO_SIGMA);
    expect(bytesToHex(seed)).toBe(
      '993a427eeb3dc053000d570842d2e7f0f093393c00e8e729155c48719118b386',
    );
  });
});

describe('btxd golden vectors — noise.generate', () => {
  it('Generate(zero_sigma, 4, 2) — E_L pinned matrix (btxd: noise_EL_pinned_elements)', () => {
    const np = generateNoise(ZERO_SIGMA, 4, 2);
    const expected = [
      [1931902215, 129748845],
      [505403935, 538008036],
      [1006343602, 1697202758],
      [2128262120, 942473671],
    ];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 2; c++) {
        expect(np.E_L.data[r * 2 + c]).toBe(expected[r]![c]!);
      }
    }
  });

  it('Generate(zero_sigma, 4, 2) — E_R pinned matrix (btxd: noise_ER_pinned_elements)', () => {
    const np = generateNoise(ZERO_SIGMA, 4, 2);
    const expected = [
      [962405871, 1142251768, 505582893, 443901062],
      [858057583, 2082571321, 70698889, 1087797252],
    ];
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) {
        expect(np.E_R.data[r * 4 + c]).toBe(expected[r]![c]!);
      }
    }
  });
});

describe('btxd golden vectors — transcript.canonicalMatMul', () => {
  it('CanonicalMatMul(A=FromSeed(seed_a,8), B=FromSeed(seed_b,8), b=4, sigma) — pinned transcript_hash', () => {
    // From btxd src/test/matmul_transcript_tests.cpp:
    //   canonical_matmul_n8_b4_pinned_transcript
    const seedA = parseHex32('376d8f3e225ed14f5614a884f822920360a7b021684bd74600aa5f88dbd32a27');
    const seedB = parseHex32('3609c5eaeae940efb3035712cd65b09f0330d77fdf852128a89069b3ac02f586');
    const sigma = parseHex32('ffc381ccd5e78ab52348ec8ba82f51d5feb0e857d7969ab0df9a5891c68cdf15');

    const A = fromSeedRect(seedA, 8, 8);
    const B = fromSeedRect(seedB, 8, 8);

    const result = canonicalMatMul(A, B, 4, sigma);

    // ParseUint256Raw — bytes stored direct, no reverse. Our transcriptHash
    // is the raw SHA-256d output, also stored direct. So this is a literal
    // byte-equal comparison.
    expect(bytesToHex(result.transcriptHash)).toBe(
      'b134b59bfdd28f3bf566e35a4d44b0af8e9530dce8047125a59d308ed22c17b8',
    );
  });
});
