/**
 * Serialize a `PowState`-equivalent block header to the bytes that
 * `ComputeMatMulHeaderHash` then `DeriveSigma` (btxd) hash.
 *
 * Ported from `btxd v0.29.7 src/matmul/matmul_pow.cpp` lines 215-274.
 *
 * Wire format (150 bytes total, all integer fields little-endian):
 *  - LE32 version
 *  - 32 bytes previousblockhash (uint256 LE *storage* — i.e. reverse of display hex)
 *  - 32 bytes merkleroot (uint256 LE storage)
 *  - LE32 time
 *  - LE32 bits
 *  - LE64 nonce64
 *  - LE16 matmul_dim
 *  - 32 bytes seed_a (uint256 LE storage)
 *  - 32 bytes seed_b (uint256 LE storage)
 *
 * Byte-order convention (this module + everything downstream):
 *  - All hex strings are interpreted as **display/big-endian** (Bitcoin Core's
 *    `uint256::ToString()` convention — first hex pair = most-significant byte).
 *  - In-memory `Uint8Array` seeds/sigmas are kept in display/BE order too.
 *  - This module reverses hex-parsed bytes back to LE storage for the header
 *    serialization, and reverses the final SHA-256 output back to BE so the
 *    sigma can flow into `fromOracle` (which expects BE) without further
 *    transformation. Net effect: byte-for-byte equivalent to btxd's behavior.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import type { ChallengeHeaderContext } from '../types.js';

/** Header fields the matmul header hash binds to. */
export interface MatMulHeaderInput {
  version: number;
  previousblockhash: string;
  merkleroot: string;
  time: number;
  /** Encoded as a hex string in btxd's header_context (e.g. `"1d00ffff"`). */
  bits: string;
  /** 64-bit nonce; pass as `bigint` to preserve full range. */
  nonce64: bigint;
  matmul_dim: number;
  seed_a: string;
  seed_b: string;
}

/**
 * Build a `MatMulHeaderInput` from a challenge envelope + the candidate nonce.
 * Reusing the existing `ChallengeHeaderContext` shape avoids a parallel struct.
 */
export function headerInputForNonce(
  ctx: ChallengeHeaderContext,
  nonce64: bigint,
): MatMulHeaderInput {
  return {
    version: ctx.version,
    previousblockhash: ctx.previousblockhash,
    merkleroot: ctx.merkleroot,
    time: ctx.time,
    bits: ctx.bits,
    nonce64,
    matmul_dim: ctx.matmul_dim,
    seed_a: ctx.seed_a,
    seed_b: ctx.seed_b,
  };
}

/** Serialize the 150-byte header buffer that `ComputeMatMulHeaderHash` hashes. */
export function serializeMatMulHeader(input: MatMulHeaderInput): Uint8Array {
  const buf = new Uint8Array(4 + 32 + 32 + 4 + 4 + 8 + 2 + 32 + 32);
  let off = 0;

  writeUint32LE(buf, off, input.version >>> 0);
  off += 4;

  buf.set(parseUint256HexToLE(input.previousblockhash, 'previousblockhash'), off);
  off += 32;

  buf.set(parseUint256HexToLE(input.merkleroot, 'merkleroot'), off);
  off += 32;

  writeUint32LE(buf, off, input.time >>> 0);
  off += 4;

  writeUint32LE(buf, off, parseBitsHex(input.bits));
  off += 4;

  writeUint64LE(buf, off, input.nonce64);
  off += 8;

  writeUint16LE(buf, off, input.matmul_dim & 0xffff);
  off += 2;

  buf.set(parseUint256HexToLE(input.seed_a, 'seed_a'), off);
  off += 32;

  buf.set(parseUint256HexToLE(input.seed_b, 'seed_b'), off);
  off += 32;

  return buf;
}

/** Equivalent of btxd's `ComputeMatMulHeaderHash`. Returns 32 raw SHA-256 bytes. */
export function computeMatMulHeaderHash(input: MatMulHeaderInput): Uint8Array {
  return sha256(serializeMatMulHeader(input));
}

/**
 * Equivalent of btxd's `DeriveSigma`. Returns a 32-byte sigma in **display/BE
 * order** so it can flow directly into {@link fromOracle} and the transcript
 * compression vector.
 */
export function deriveSigma(input: MatMulHeaderInput): Uint8Array {
  const headerHash = computeMatMulHeaderHash(input);
  const sigmaRaw = sha256(headerHash);
  // sigmaRaw is "LE storage" per btxd's uint256 view; reverse to BE for
  // downstream consumers that operate on display-order seeds.
  const sigmaBE = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sigmaBE[i] = sigmaRaw[31 - i]!;
  return sigmaBE;
}

// ----------------------------------------------------------------------------
// internal helpers
// ----------------------------------------------------------------------------

function parseUint256HexToLE(hex: string, field: string): Uint8Array {
  const beBytes = parseHexFixed(hex, 32, field);
  // Reverse: BE display → LE storage.
  const leBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) leBytes[i] = beBytes[31 - i]!;
  return leBytes;
}

function parseHexFixed(hex: string, byteLen: number, field: string): Uint8Array {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length !== byteLen * 2) {
    throw new Error(
      `header.${field}: expected ${byteLen * 2} hex chars (${byteLen} bytes), got ${h.length}`,
    );
  }
  const out = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`header.${field}: invalid hex at byte ${i}`);
    }
    out[i] = byte;
  }
  return out;
}

function parseBitsHex(bits: string): number {
  // btxd serializes bits as a 4-byte big-endian hex string (matching getblockheader).
  // Parse, then write LE in serializeMatMulHeader.
  const h = bits.startsWith('0x') || bits.startsWith('0X') ? bits.slice(2) : bits;
  if (h.length !== 8) {
    throw new Error(`header.bits: expected 8 hex chars, got ${h.length}`);
  }
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) {
    throw new Error(`header.bits: invalid hex`);
  }
  return n >>> 0;
}

function writeUint16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function writeUint64LE(buf: Uint8Array, offset: number, value: bigint): void {
  const lo = Number(value & 0xffffffffn);
  const hi = Number((value >> 32n) & 0xffffffffn);
  writeUint32LE(buf, offset, lo);
  writeUint32LE(buf, offset + 4, hi);
}
