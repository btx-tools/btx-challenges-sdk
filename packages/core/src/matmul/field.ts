/**
 * M31 (Mersenne prime 2^31 - 1) modular arithmetic.
 *
 * Ported from `btxd v0.29.7 src/matmul/field.{h,cpp}`.
 *
 * Field elements are JS `number`s in the canonical range [0, M31_MODULUS).
 *
 * `mul` and the `dot` accumulator use `BigInt` because the worst-case
 * product (2^31 - 1)^2 ≈ 2^62 exceeds Number's 2^53 precision. Day 2.6
 * may swap in a Number-only split-multiplication path for perf.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { M31_MODULUS } from './constants.js';

/** Canonical field element type. Always in [0, M31_MODULUS). */
export type Element = number;

const MODULUS_BIG = BigInt(M31_MODULUS);

/**
 * Mersenne fold for a non-negative `bigint` up to ~2^64. Matches btxd's
 * `reduce64` in `field.cpp` lines 23-34 (double fold + final canonical sub).
 */
function reduce64(x: bigint): Element {
  let v = (x & MODULUS_BIG) + (x >> 31n);
  v = (v & MODULUS_BIG) + (v >> 31n);
  let result = Number(v);
  if (result >= M31_MODULUS) result -= M31_MODULUS;
  return result;
}

/** Modular addition. Matches `field::add` in `field.cpp` line 84. */
export function add(a: Element, b: Element): Element {
  const s = a + b;
  return s >= M31_MODULUS ? s - M31_MODULUS : s;
}

/** Modular subtraction. Matches `field::sub` in `field.cpp` line 93. */
export function sub(a: Element, b: Element): Element {
  return a >= b ? a - b : a + M31_MODULUS - b;
}

/** Modular multiplication. Matches `field::mul` in `field.cpp` line 102. */
export function mul(a: Element, b: Element): Element {
  return reduce64(BigInt(a) * BigInt(b));
}

/** Modular negation. Matches `field::neg` in `field.cpp` line 108. */
export function neg(a: Element): Element {
  return a === 0 ? 0 : M31_MODULUS - a;
}

/** Reduce a uint32 input to canonical form. Matches `field::from_uint32`. */
export function fromUint32(x: number): Element {
  return reduce64(BigInt(x >>> 0));
}

/**
 * Modular inverse via Fermat's little theorem: a^(p-2) mod p.
 * Matches `field::inv` in `field.cpp` line 121.
 */
export function inv(a: Element): Element {
  if (a === 0) throw new Error('field.inv: cannot invert 0');
  let exp = M31_MODULUS - 2;
  let result: Element = 1;
  let base = a;
  while (exp > 0) {
    if ((exp & 1) !== 0) result = mul(result, base);
    exp >>>= 1;
    if (exp > 0) base = mul(base, base);
  }
  return result;
}

/**
 * Hash-to-field oracle for deterministic challenge derivation.
 *
 * Matches `field::from_oracle` in `field.cpp` line 138:
 *  - SHA-256(seed_bytes || LE32(index) [|| LE32(retry) if retry > 0])
 *  - candidate = ReadLE32(hash[0..4]) & MODULUS
 *  - accept if candidate < MODULUS; else retry (up to 256 retries)
 *  - deterministic fallback otherwise (essentially unreachable, ~2^-7936)
 *
 * @param seed - 32-byte seed in btxd "display/MSB-first" order. The C++
 *   reverses uint256's LE storage to MSB-first before hashing; standard hex
 *   parsing of a uint256 hex string already yields MSB-first bytes, so the
 *   caller can pass the hex-parsed bytes directly without reversing.
 */
export function fromOracle(seed: Uint8Array, index: number): Element {
  if (seed.length !== 32) {
    throw new Error(`field.fromOracle: seed must be 32 bytes, got ${seed.length}`);
  }
  const indexLe = new Uint8Array(4);
  writeUint32LE(indexLe, 0, index >>> 0);

  for (let retry = 0; retry < 256; retry++) {
    const hasher = sha256.create();
    hasher.update(seed);
    hasher.update(indexLe);
    if (retry > 0) {
      const retryLe = new Uint8Array(4);
      writeUint32LE(retryLe, 0, retry);
      hasher.update(retryLe);
    }
    const hash = hasher.digest();
    const candidate = readUint32LE(hash, 0) & M31_MODULUS;
    if (candidate < M31_MODULUS) return candidate;
  }

  // Deterministic fallback. Same construction as btxd `field.cpp` line 174.
  const fallback = sha256.create();
  fallback.update(seed);
  fallback.update(indexLe);
  fallback.update(new TextEncoder().encode('oracle-fallback'));
  const hash = fallback.digest();
  return readUint32LE(hash, 0) % M31_MODULUS;
}

/**
 * Inner-product over M31. Matches `field::ScalarDot` in `field.cpp` line 39
 * (the NEON kernel is a perf-equivalent rewrite of this canonical scalar path).
 *
 * Accumulates 4 products per Mersenne fold; uses BigInt for the 64-bit acc
 * because Number can't hold 4·(2^31-1)^2 ≈ 2^64.
 */
export function dot(a: Element[] | Uint32Array, b: Element[] | Uint32Array, len: number): Element {
  let acc = 0n;
  let pending = 0;
  for (let i = 0; i < len; i++) {
    acc += BigInt(a[i]!) * BigInt(b[i]!);
    if (++pending === 4) {
      acc = (acc & MODULUS_BIG) + (acc >> 31n);
      acc = (acc & MODULUS_BIG) + (acc >> 31n);
      pending = 0;
    }
  }
  return reduce64(acc);
}

function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function readUint32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      (buf[offset + 3]! << 24)) >>>
    0
  );
}
