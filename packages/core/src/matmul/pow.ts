/**
 * Top-level pure-JS solver for the BTX MatMul service-challenge PoW.
 *
 * Ported from `btxd v0.29.7 src/matmul/matmul_pow.cpp` lines 293-358 (`Solve`).
 *
 *   A = FromSeed(seed_a, n)
 *   B = FromSeed(seed_b, n)
 *   for nonce in [start, start + maxTries):
 *     sigma   = DeriveSigma(state(nonce))
 *     noise   = noise::Generate(sigma, n, r)
 *     E       = noise.E_L · noise.E_R
 *     F       = noise.F_L · noise.F_R
 *     A'      = A + E
 *     B'      = B + F
 *     result  = transcript::CanonicalMatMul(A', B', b, sigma)
 *     if uintLE(result.transcript_hash) <= uintBE(target): return success
 *
 * Comparison semantics: `transcript_hash` is the raw SHA-256d output, treated
 * as a 256-bit integer in **little-endian byte order** (btxd's `uint256` ↔
 * `arith_uint256` convention). `target` arrives as a BE hex string. Both are
 * converted to `bigint` for the `<=` test.
 */

import type { Challenge, SolverOutput } from '../types.js';
import { deriveSigma, headerInputForNonce } from './header.js';
import { fromSeedRect, matAdd, matMul } from './matrix.js';
import { generate as generateNoise } from './noise.js';
import { canonicalMatMul } from './transcript.js';

const MAX_U64 = (1n << 64n) - 1n;

/** Options for {@link solveJs}. */
export interface SolveJsOptions {
  /** Max nonces to try before giving up. Default 1_000_000. */
  maxTries?: number;
  /** Override the starting nonce (default: challenge.header_context.nonce64_start). */
  nonceStart?: bigint;
  /** Optional callback fired every N attempts for progress reporting. */
  onAttempt?: (attemptIndex: number, nonce: bigint) => void;
  /** Frequency of `onAttempt` calls (default every 1 attempt). */
  attemptInterval?: number;
}

/**
 * Pure-JS solver for a BTX MatMul service challenge. Searches nonces starting
 * from `header_context.nonce64_start` (or `options.nonceStart`) until the
 * transcript-hash satisfies `digest_le256 <= target_be256` or `maxTries` is
 * exhausted.
 *
 * Returns `null` if no solution was found within the budget.
 *
 * @throws if the challenge envelope is malformed (wrong-shape matmul params,
 *   non-square matrix dimensions, b doesn't divide n, etc.).
 */
export function solveJs(challenge: Challenge, options: SolveJsOptions = {}): SolverOutput | null {
  const payload = challenge.challenge;
  const ctx = payload.header_context;
  const { n, b, r } = payload.matmul;

  const maxTries = options.maxTries ?? 1_000_000;
  const nonceStart = options.nonceStart ?? BigInt(ctx.nonce64_start ?? 0);
  const attemptInterval = options.attemptInterval ?? 1;

  if (n <= 0 || b <= 0 || r <= 0) {
    throw new Error(`solveJs: invalid matmul params (n=${n}, b=${b}, r=${r})`);
  }
  if (n % b !== 0) {
    throw new Error(`solveJs: n=${n} not divisible by b=${b}`);
  }

  // Parse fixed inputs.
  const seedA = parseHex32(payload.matmul.seed_a, 'seed_a');
  const seedB = parseHex32(payload.matmul.seed_b, 'seed_b');
  const targetBE = parseHex32(payload.target, 'target');
  const targetValue = bytesBEToBigInt(targetBE);

  // A and B don't change per attempt.
  const A = fromSeedRect(seedA, n, n);
  const B = fromSeedRect(seedB, n, n);

  let nonce = nonceStart & MAX_U64;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    if (options.onAttempt && attempt % attemptInterval === 0) {
      options.onAttempt(attempt, nonce);
    }

    const headerInput = headerInputForNonce(ctx, nonce);
    const sigmaBE = deriveSigma(headerInput);
    const noise = generateNoise(sigmaBE, n, r);

    const E = matMul(noise.E_L, noise.E_R);
    const F = matMul(noise.F_L, noise.F_R);
    const aPrime = matAdd(A, E);
    const bPrime = matAdd(B, F);

    const result = canonicalMatMul(aPrime, bPrime, b, sigmaBE);
    const digestValue = bytesLEToBigInt(result.transcriptHash);
    if (digestValue <= targetValue) {
      const nonce64_hex = nonce.toString(16).padStart(16, '0');
      const digest_hex = bytesLEToHexBE(result.transcriptHash);
      return {
        nonce64_hex,
        digest_hex,
        // Same shape btxd's solve RPC returns: {challenge, nonce64_hex, digest_hex}.
        // See `solvematmulservicechallenge` in btxd src/rpc/mining.cpp.
        proof: { challenge, nonce64_hex, digest_hex },
      };
    }

    if (nonce === MAX_U64) return null;
    nonce = (nonce + 1n) & MAX_U64;
  }

  return null;
}

// ----------------------------------------------------------------------------
// hex / int conversion
// ----------------------------------------------------------------------------

function parseHex32(hex: string, field: string): Uint8Array {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length !== 64) {
    throw new Error(`solveJs.${field}: expected 64 hex chars, got ${h.length}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`solveJs.${field}: invalid hex at byte ${i}`);
    }
    out[i] = byte;
  }
  return out;
}

/** Interpret 32 bytes as a 256-bit integer in big-endian byte order. */
function bytesBEToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) {
    v = (v << 8n) | BigInt(bytes[i]!);
  }
  return v;
}

/** Interpret 32 bytes as a 256-bit integer in little-endian byte order. */
function bytesLEToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]!);
  }
  return v;
}

/** Reverse LE-stored bytes and hex-encode as a BE/display string. */
function bytesLEToHexBE(bytes: Uint8Array): string {
  const chars: string[] = [];
  for (let i = bytes.length - 1; i >= 0; i--) {
    chars.push(bytes[i]!.toString(16).padStart(2, '0'));
  }
  return chars.join('');
}
