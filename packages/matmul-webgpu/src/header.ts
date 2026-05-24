/**
 * Host-side construction of the kernel's `params` buffer and parameter
 * validation. Mirrors `@btx-tools/challenges-sdk`'s
 * `core/src/matmul/{header,pow,constants}.ts` so this package rejects the same
 * inputs and serializes byte-identically (a divergence would emit an
 * un-redeemable proof).
 */

/** M31 modulus, 2³¹−1. (`core` `M31_MODULUS`.) */
export const M31_MODULUS = 0x7fffffff;
/** Max matrix dimension `n`. (`core` `MAX_MATMUL_N`.) */
export const MAX_MATMUL_N = 4096;
/** Max noise rank `r`. (`core` `MAX_MATMUL_R`.) */
export const MAX_MATMUL_R = 256;

/**
 * The five protocol domain tags, in the order the kernel expects them
 * (`fill` reads 0..3 as the noise seeds; `solve` reads 4 as the compress seed).
 * Frozen constants from `core/src/matmul/constants.ts` — each is exactly 18 ASCII bytes.
 */
export const DOMAIN_TAGS = [
  'matmul_noise_EL_v1',
  'matmul_noise_ER_v1',
  'matmul_noise_FL_v1',
  'matmul_noise_FR_v1',
  'matmul-compress-v1',
] as const;

/**
 * Largest `n/b` (= blocks-per-side `N`) whose transcript byte count `4·N³` still
 * fits the kernel's u32 byte counter. `1023³·4 < 2³² ≤ 1024³·4`. Beyond this the
 * GPU streaming counter / SHA length would overflow (audit M-1); fail closed so a
 * caller can fall back to `wasm`/`pure-js` rather than get a wrong proof. Covers
 * all `n ≤ 512` at any `b`, and `n ≤ 4096` at `b ≥ 4`.
 */
export const MAX_BLOCKS_PER_SIDE = 1023;

/**
 * Reject `(n, b)` whose transcript (`N³` words, `N=n/b`) would overflow the
 * kernel's u32 byte counter. Separate from {@link validateMatmulParams} (which
 * mirrors core exactly) — this is a WebGPU-kernel capacity limit, not a protocol rule.
 * @throws if `n/b > MAX_BLOCKS_PER_SIDE`.
 */
export function assertTranscriptCapacity(n: number, b: number): void {
  const blocks = n / b; // integer: validateMatmulParams already enforced n % b === 0
  if (blocks > MAX_BLOCKS_PER_SIDE) {
    throw new Error(
      `matmul-webgpu: n/b=${blocks} exceeds the kernel's transcript capacity ` +
        `(max ${MAX_BLOCKS_PER_SIDE}); the u32 byte counter would overflow. ` +
        `Use a larger b, or solve via wasm/pure-js/rpc.`,
    );
  }
}

/** Field values needed to construct the 150-byte matmul header + the seeds/target. */
export interface SolveParams {
  version: number;
  /** Previous block hash, 64 hex chars (BE display). */
  prevhash: string;
  /** Merkle root, 64 hex chars (BE display). */
  merkleroot: string;
  time: number;
  /** Difficulty bits, 8 hex chars (BE, e.g. `1d00ffff`). */
  bits: string;
  n: number;
  b: number;
  r: number;
  /** Seed A, 64 hex chars. */
  seedA: string;
  /** Seed B, 64 hex chars. */
  seedB: string;
  /** Target, 64 hex chars (BE display; compared `uintLE(digest) ≤ uintBE(target)`). */
  target: string;
}

/**
 * Validate `n`/`b`/`r` before any `n×n` allocation. Mirrors `core`'s
 * `validateMatmulParams` exactly (integers, positivity, bounds, `b≤n`, `b|n`).
 * @throws on any violation.
 */
export function validateMatmulParams(n: number, b: number, r: number): void {
  if (!Number.isInteger(n) || !Number.isInteger(b) || !Number.isInteger(r)) {
    throw new Error(`matmul params must be integers (n=${n}, b=${b}, r=${r})`);
  }
  if (n <= 0 || b <= 0 || r <= 0) throw new Error(`invalid matmul params (n=${n}, b=${b}, r=${r})`);
  if (n > MAX_MATMUL_N) throw new Error(`n=${n} exceeds max ${MAX_MATMUL_N}`);
  if (r > MAX_MATMUL_R) throw new Error(`r=${r} exceeds max ${MAX_MATMUL_R}`);
  if (b > n) throw new Error(`b=${b} exceeds n=${n}`);
  if (n % b !== 0) throw new Error(`n=${n} not divisible by b=${b}`);
}

function hexToBytes(hex: string, name: string, expectBytes: number): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length !== expectBytes * 2) {
    throw new Error(`${name}: expected ${expectBytes * 2} hex chars, got ${hex.length}`);
  }
  const out = new Uint8Array(expectBytes);
  for (let i = 0; i < expectBytes; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 4 big-endian bytes → one u32 word (how SHA-256 + the BE target consume bytes). */
function beWords(bytes: Uint8Array): Uint32Array {
  const w = new Uint32Array(bytes.length >> 2);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < w.length; i++) w[i] = dv.getUint32(i * 4, false);
  return w;
}

function parseBitsHex(bits: string): number {
  const h = bits.startsWith('0x') || bits.startsWith('0X') ? bits.slice(2) : bits;
  if (h.length !== 8) throw new Error(`bits: expected 8 hex chars, got ${h.length}`);
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) throw new Error('bits: invalid hex');
  return n >>> 0;
}

/** 18-byte tag → `[w0,w1,w2,w3, hi16]` for the kernel's `shaTagSigma`. */
function tagWords(tag: string): number[] {
  const b = new TextEncoder().encode(tag);
  if (b.length !== 18) throw new Error(`domain tag must be 18 bytes: "${tag}"`);
  const dv = new DataView(b.buffer);
  return [
    dv.getUint32(0, false),
    dv.getUint32(4, false),
    dv.getUint32(8, false),
    dv.getUint32(12, false),
    (b[16]! << 8) | b[17]!,
  ];
}

/**
 * Build the kernel's read-only `params` buffer:
 * `hdr[48] ‖ seedA[8] ‖ seedB[8] ‖ tags[25] ‖ targetBE[8]` = **97 u32**.
 *
 * `hdr` is the 150-byte matmul header (`serializeMatMulHeader`) with the nonce64
 * field left zero (the kernel patches it per-nonce), SHA-padded to 3 blocks
 * (192 B → 48 BE words). Header seeds are stored **reversed** (BE→LE), but the
 * `seedA/seedB` words used as `fromOracle` seeds are **non-reversed** (BE) — two
 * distinct uses of the same hex, matching `core`.
 */
export function buildParams(p: SolveParams): Uint32Array {
  validateMatmulParams(p.n, p.b, p.r);
  if (p.n > 0xffff) throw new Error(`matmul_dim=${p.n} out of uint16 range`);
  assertTranscriptCapacity(p.n, p.b);

  // 150-byte header, nonce64=0; seeds reversed (BE display → LE storage).
  const hdr = new Uint8Array(150);
  const dv = new DataView(hdr.buffer);
  let o = 0;
  dv.setUint32(o, p.version >>> 0, true);
  o += 4;
  hdr.set(hexToBytes(p.prevhash, 'prevhash', 32).reverse(), o);
  o += 32;
  hdr.set(hexToBytes(p.merkleroot, 'merkleroot', 32).reverse(), o);
  o += 32;
  dv.setUint32(o, p.time >>> 0, true);
  o += 4;
  dv.setUint32(o, parseBitsHex(p.bits), true);
  o += 4;
  o += 8; // nonce64 (patched per-nonce on GPU)
  dv.setUint16(o, p.n, true);
  o += 2;
  hdr.set(hexToBytes(p.seedA, 'seedA', 32).reverse(), o);
  o += 32;
  hdr.set(hexToBytes(p.seedB, 'seedB', 32).reverse(), o);
  o += 32;

  // SHA-pad 150 → 192 (3 blocks): 0x80 @150, 64-bit BE length (1200 bits) at the end.
  const padded = new Uint8Array(192);
  padded.set(hdr);
  padded[150] = 0x80;
  new DataView(padded.buffer).setUint32(188, 1200, false);

  const params = new Uint32Array(97);
  params.set(beWords(padded), 0); // 48
  params.set(beWords(hexToBytes(p.seedA, 'seedA', 32)), 48); // 8, non-reversed (fromOracle seed)
  params.set(beWords(hexToBytes(p.seedB, 'seedB', 32)), 56); // 8
  params.set(Uint32Array.from(DOMAIN_TAGS.flatMap(tagWords)), 64); // 25
  params.set(beWords(hexToBytes(p.target, 'target', 32)), 89); // 8, BE
  return params;
}
