/**
 * Transcript-binding block compression + canonical matmul + final digest.
 *
 * Ported from `btxd v0.29.7 src/matmul/transcript.{h,cpp}`.
 *
 * For Day 2.5 (the canonical Solve path) we only need:
 *  - {@link deriveCompressionVector} — b·b M31 vector from sigma
 *  - {@link compressBlock} — block · compression-vector inner product
 *  - {@link TranscriptHasher} — accumulates LE32(compressed c-block) per
 *    (i, j, ell) step, finalizes as SHA-256d
 *  - {@link canonicalMatMul} — block-wise A' · B' with intermediate hashing
 *
 * The replay / product-committed / accelerated-solver helpers are verifier
 * optimizations; out of scope for Day 2.5 but easy to add in Day 2.6+ if
 * needed.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { TRANSCRIPT_COMPRESS_TAG } from './constants.js';
import { add as fieldAdd, dot as fieldDot, fromOracle } from './field.js';
import { zeros, type Matrix } from './matrix.js';

/**
 * Per-sigma compression seed. Mirrors `DeriveCompressionSeed` in transcript.cpp
 * (the anonymous-namespace helper). Returns 32 bytes in BE/display order so
 * it can flow into {@link fromOracle} directly.
 */
function deriveCompressionSeed(sigmaBE: Uint8Array): Uint8Array {
  const hasher = sha256.create();
  hasher.update(new TextEncoder().encode(TRANSCRIPT_COMPRESS_TAG));
  hasher.update(sigmaBE);
  const digest = hasher.digest();
  const seedBE = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seedBE[i] = digest[31 - i]!;
  return seedBE;
}

/**
 * Build the b·b-element M31 compression vector. Mirrors
 * `transcript::DeriveCompressionVector`.
 */
export function deriveCompressionVector(sigmaBE: Uint8Array, b: number): Uint32Array {
  if (b <= 0) throw new Error('block size b must be positive');
  const seed = deriveCompressionSeed(sigmaBE);
  const len = b * b;
  const vec = new Uint32Array(len);
  for (let k = 0; k < len; k++) vec[k] = fromOracle(seed, k);
  return vec;
}

/**
 * Compress a b·b block against the precomputed compression vector. Mirrors
 * `transcript::CompressBlock` — a plain M31 inner product, no per-row split.
 */
export function compressBlock(block: Uint32Array, v: Uint32Array): number {
  if (block.length !== v.length) {
    throw new Error(
      `compressBlock: dim mismatch block.length=${block.length} v.length=${v.length}`,
    );
  }
  return fieldDot(block, v, block.length);
}

/**
 * Accumulating SHA-256(-d) transcript hasher. Mirrors
 * `transcript::TranscriptHasher`.
 *
 *   compress_vec = DeriveCompressionVector(sigma, b)
 *   per (i,j,ell): add LE32(CompressBlock(c_block, compress_vec)) to inner
 *   finalize(): inner = SHA256.digest(); return SHA256(inner)  (i.e. SHA-256d)
 */
export class TranscriptHasher {
  private readonly hasher = sha256.create();
  private readonly compressVec: Uint32Array;
  private readonly b: number;
  private readonly le4 = new Uint8Array(4);

  constructor(sigmaBE: Uint8Array, b: number) {
    this.b = b;
    this.compressVec = deriveCompressionVector(sigmaBE, b);
  }

  /**
   * Append the LE32-encoded compressed `c_block` to the transcript.
   * Ignores `i`/`j`/`ell` for hashing (btxd's `(void)i;(void)j;(void)ell;`
   * proves they don't participate in the digest), but accepts them so the
   * call-site reads identically to the C++.
   */
  addIntermediate(_i: number, _j: number, _ell: number, cBlock: Uint32Array): void {
    if (cBlock.length !== this.b * this.b) {
      throw new Error(
        `addIntermediate: c_block must be ${this.b * this.b} elements, got ${cBlock.length}`,
      );
    }
    const compressed = compressBlock(cBlock, this.compressVec);
    this.le4[0] = compressed & 0xff;
    this.le4[1] = (compressed >>> 8) & 0xff;
    this.le4[2] = (compressed >>> 16) & 0xff;
    this.le4[3] = (compressed >>> 24) & 0xff;
    this.hasher.update(this.le4);
  }

  /** SHA-256d: inner = SHA256(transcript); return SHA256(inner). */
  finalize(): Uint8Array {
    const inner = this.hasher.digest();
    return sha256(inner);
  }
}

export interface CanonicalMatMulResult {
  /** Product matrix C' = A' · B' over M31. */
  cPrime: Matrix;
  /** SHA-256d over the LE32-encoded compressed c-blocks (in i,j,ell order). */
  transcriptHash: Uint8Array;
}

/**
 * Canonical block-wise matmul with transcript binding. Mirrors
 * `transcript::CanonicalMatMul`.
 *
 *   for i,j in [0,N)²:
 *     for ell in [0,N):
 *       a = A'.block(i,ell)
 *       b = B'.block(ell,j)
 *       c_acc += a·b
 *       hasher.add(c_acc)
 *
 * Where N = n / b. Each block read/multiply/accumulate happens in a
 * pre-allocated b·b scratch buffer to avoid per-step allocation in the
 * hot path.
 */
export function canonicalMatMul(
  aPrime: Matrix,
  bPrime: Matrix,
  b: number,
  sigmaBE: Uint8Array,
): CanonicalMatMulResult {
  if (
    aPrime.rows !== aPrime.cols ||
    bPrime.rows !== bPrime.cols ||
    aPrime.rows !== bPrime.rows
  ) {
    throw new Error('canonicalMatMul requires square matrices of equal size');
  }
  if (b === 0 || aPrime.rows % b !== 0) {
    throw new Error('canonicalMatMul: invalid transcript block size');
  }

  const n = aPrime.rows;
  const N = n / b;
  const cPrime = zeros(n, n);
  const hasher = new TranscriptHasher(sigmaBE, b);

  const aBlock = new Uint32Array(b * b);
  const bBlock = new Uint32Array(b * b);
  const cBlock = new Uint32Array(b * b);

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      cBlock.fill(0);
      for (let ell = 0; ell < N; ell++) {
        readBlock(aPrime, i, ell, b, aBlock);
        readBlock(bPrime, ell, j, b, bBlock);
        multiplyAndAccumulateBlock(aBlock, bBlock, cBlock, b);
        hasher.addIntermediate(i, j, ell, cBlock);
      }
      writeBlock(cPrime, i, j, b, cBlock);
    }
  }

  return { cPrime, transcriptHash: hasher.finalize() };
}

// ----------------------------------------------------------------------------
// internal block kernels
// ----------------------------------------------------------------------------

/** Copy `m[bi*b..bi*b+b][bj*b..bj*b+b]` into the `b·b` `out` buffer. */
function readBlock(
  m: Matrix,
  bi: number,
  bj: number,
  b: number,
  out: Uint32Array,
): void {
  const rowStart = bi * b;
  const colStart = bj * b;
  const stride = m.cols;
  for (let r = 0; r < b; r++) {
    const src = (rowStart + r) * stride + colStart;
    const dst = r * b;
    for (let c = 0; c < b; c++) {
      out[dst + c] = m.data[src + c]!;
    }
  }
}

/** Copy a b·b `block` buffer into `m[bi*b..bi*b+b][bj*b..bj*b+b]`. */
function writeBlock(
  m: Matrix,
  bi: number,
  bj: number,
  b: number,
  block: Uint32Array,
): void {
  const rowStart = bi * b;
  const colStart = bj * b;
  const stride = m.cols;
  for (let r = 0; r < b; r++) {
    const dst = (rowStart + r) * stride + colStart;
    const src = r * b;
    for (let c = 0; c < b; c++) {
      m.data[dst + c] = block[src + c]!;
    }
  }
}

/**
 * `c += a · b` for square b·b blocks (all three buffers are length b·b).
 * Element-wise mod M31. Inner loop uses `field.dot` (Mersenne-fold every 4
 * products) to stay in the canonical scalar path.
 */
function multiplyAndAccumulateBlock(
  a: Uint32Array,
  b_buf: Uint32Array,
  c: Uint32Array,
  b: number,
): void {
  // c[i,j] += sum_k a[i,k] * b_buf[k,j]
  // Strategy: for each (i, j), pre-collect b_buf's column j into a temp,
  // then dot with a's row i. Reuses field.dot's batched reduction.
  const colBuf = new Uint32Array(b);
  for (let j = 0; j < b; j++) {
    for (let k = 0; k < b; k++) colBuf[k] = b_buf[k * b + j]!;
    for (let i = 0; i < b; i++) {
      const rowStart = i * b;
      // Compute dot(a[i,:], colBuf, b) and add to c[i,j].
      let acc = 0n;
      let pending = 0;
      for (let k = 0; k < b; k++) {
        acc += BigInt(a[rowStart + k]!) * BigInt(colBuf[k]!);
        if (++pending === 4) {
          acc = (acc & MOD_BIG) + (acc >> 31n);
          acc = (acc & MOD_BIG) + (acc >> 31n);
          pending = 0;
        }
      }
      // Final fold and add to c[i,j].
      acc = (acc & MOD_BIG) + (acc >> 31n);
      acc = (acc & MOD_BIG) + (acc >> 31n);
      let folded = Number(acc);
      if (folded >= MOD_NUM) folded -= MOD_NUM;
      c[rowStart + j] = fieldAdd(c[rowStart + j]!, folded);
    }
  }
}

const MOD_NUM = 0x7fffffff;
const MOD_BIG = 0x7fffffffn;
