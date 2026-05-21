/**
 * Deterministic noise pair generation: {E_L, E_R, F_L, F_R}.
 *
 * Each matrix is rank-r (n × r or r × n); used to perturb (A, B) into
 * (A', B') = (A + E_L·E_R, B + F_L·F_R) before the canonical matmul.
 *
 * Ported from `btxd v0.29.7 src/matmul/noise.{h,cpp}`.
 *
 * Byte-order convention (see header.ts for full discussion): sigma + noise
 * seeds are kept in **display/BE order** in-memory. The C++ reverses LE
 * storage to BE for hashing; we already store BE, so we hash directly.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { NOISE_TAG_EL, NOISE_TAG_ER, NOISE_TAG_FL, NOISE_TAG_FR } from './constants.js';
import { fromSeedRect, type Matrix } from './matrix.js';

/** The 4 noise factor matrices. Sized (n×r, r×n, n×r, r×n) respectively. */
export interface NoisePair {
  E_L: Matrix;
  E_R: Matrix;
  F_L: Matrix;
  F_R: Matrix;
}

/**
 * Per-tag seed derivation. Matches `btxd noise::DeriveNoiseSeed`:
 *   seed = SHA-256(domain_tag || sigma_BE)
 *
 * Subtle byte-order point: btxd stores the noise seed via
 * `CanonicalBytesToUint256(digest)` — i.e. the uint256's LE storage is the
 * REVERSE of the raw SHA-256 output. Then `from_oracle` reverses that LE
 * storage again before hashing, so the bytes actually fed to the per-index
 * SHA-256 are the RAW digest. Our `fromOracle` hashes the seed directly
 * (no internal reverse), so we must return the raw digest here — no reverse.
 *
 * (Contrast with `deriveSigma`, which DOES reverse: btxd's sigma uint256 is
 * stored direct from the SHA-256 output, so `from_oracle`'s reverse lands on
 * REVERSE(raw). The reverse in our `deriveSigma` mirrors that asymmetry.)
 */
export function deriveNoiseSeed(domainTag: string, sigmaBE: Uint8Array): Uint8Array {
  if (sigmaBE.length !== 32) {
    throw new Error(`deriveNoiseSeed: sigma must be 32 bytes, got ${sigmaBE.length}`);
  }
  if (domainTag.length !== 18) {
    // C++ asserts this; all 4 noise tags are 18 chars.
    throw new Error(`deriveNoiseSeed: domain tag must be 18 chars, got ${domainTag.length}`);
  }
  const hasher = sha256.create();
  hasher.update(new TextEncoder().encode(domainTag));
  hasher.update(sigmaBE);
  return hasher.digest();
}

/**
 * Generate the 4 noise matrices. Mirrors `noise::Generate(sigma, n, r)`.
 *
 * Returned matrix sizes:
 *  - E_L : n × r
 *  - E_R : r × n
 *  - F_L : n × r
 *  - F_R : r × n
 *
 * Asymmetric on purpose — so `E_L · E_R` and `F_L · F_R` are n×n.
 */
export function generate(sigmaBE: Uint8Array, n: number, r: number): NoisePair {
  const seedEL = deriveNoiseSeed(NOISE_TAG_EL, sigmaBE);
  const seedER = deriveNoiseSeed(NOISE_TAG_ER, sigmaBE);
  const seedFL = deriveNoiseSeed(NOISE_TAG_FL, sigmaBE);
  const seedFR = deriveNoiseSeed(NOISE_TAG_FR, sigmaBE);
  return {
    E_L: fromSeedRect(seedEL, n, r),
    E_R: fromSeedRect(seedER, r, n),
    F_L: fromSeedRect(seedFL, n, r),
    F_R: fromSeedRect(seedFR, r, n),
  };
}
