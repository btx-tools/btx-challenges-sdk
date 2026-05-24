// Pure orchestration tests — no GPU, run in CI under vitest. The byte-exact
// GPU battery lives in tests/gpu/ (Deno). Covers: param validation parity with
// core, the params-buffer layout, batch-size clamping, and shader codegen.
import { describe, expect, it } from 'vitest';

import {
  buildParams,
  validateMatmulParams,
  assertTranscriptCapacity,
  MAX_BLOCKS_PER_SIDE,
  DOMAIN_TAGS,
} from '../../src/header.js';
import { clampBatchSize, DEFAULT_BATCH, MAX_BATCH } from '../../src/limits.js';
import { buildSolveShader } from '../../src/wgsl/shaders.js';

const PREV = '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210';
const MERK = 'fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef';
const SEED_A = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const SEED_B = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
const TARGET = '03' + 'ff'.repeat(31);
const base = {
  version: 1,
  prevhash: PREV,
  merkleroot: MERK,
  time: 1700000000,
  bits: '1d00ffff',
  seedA: SEED_A,
  seedB: SEED_B,
  target: TARGET,
};

describe('validateMatmulParams (parity with core)', () => {
  it('rejects n=0', () =>
    expect(() => validateMatmulParams(0, 2, 1)).toThrow('invalid matmul params'));
  it('rejects b=0', () =>
    expect(() => validateMatmulParams(8, 0, 1)).toThrow('invalid matmul params'));
  it('rejects r=0', () =>
    expect(() => validateMatmulParams(8, 4, 0)).toThrow('invalid matmul params'));
  it('rejects n not divisible by b', () =>
    expect(() => validateMatmulParams(8, 3, 1)).toThrow('not divisible'));
  it('rejects b greater than n', () =>
    expect(() => validateMatmulParams(4, 8, 1)).toThrow('exceeds n'));
  it('rejects n over MAX_MATMUL_N', () =>
    expect(() => validateMatmulParams(8192, 8, 1)).toThrow('exceeds max 4096'));
  it('rejects r over MAX_MATMUL_R', () =>
    expect(() => validateMatmulParams(512, 8, 512)).toThrow('exceeds max 256'));
  it('rejects non-integer n', () =>
    expect(() => validateMatmulParams(8.5, 4, 1)).toThrow('must be integers'));
  it('accepts n=64 b=8 r=4', () => expect(() => validateMatmulParams(64, 8, 4)).not.toThrow());
});

describe('buildParams layout', () => {
  it('emits exactly 97 words', () => {
    expect(buildParams({ ...base, n: 8, b: 4, r: 2 })).toHaveLength(97);
  });

  it('encodes version LE at word 0 (header byte0..3 read BE)', () => {
    // version=1 → LE32 bytes [01,00,00,00] → BE word 0x01000000.
    expect(buildParams({ ...base, n: 8, b: 4, r: 2 })[0]).toBe(0x01000000);
  });

  it('places the first noise tag at word 64 (TAG_OFS)', () => {
    // "matmul_noise_EL_v1" first 4 bytes "matm" = 0x6d61746d.
    expect(buildParams({ ...base, n: 8, b: 4, r: 2 })[64]).toBe(0x6d61746d);
  });

  it('places the BE target at word 89 (TGT_OFS)', () => {
    expect(buildParams({ ...base, n: 8, b: 4, r: 2 })[89]).toBe(0x03ffffff);
  });

  it('rejects a short seed', () => {
    expect(() => buildParams({ ...base, n: 8, b: 4, r: 2, seedA: 'deadbeef' })).toThrow(
      'expected 64 hex chars',
    );
  });

  it('rejects malformed bits', () => {
    expect(() => buildParams({ ...base, n: 8, b: 4, r: 2, bits: 'zz' })).toThrow(
      'expected 8 hex chars',
    );
  });

  it('has exactly five 18-byte domain tags', () => {
    expect(DOMAIN_TAGS).toHaveLength(5);
    for (const t of DOMAIN_TAGS) expect(new TextEncoder().encode(t)).toHaveLength(18);
  });
});

describe('assertTranscriptCapacity (audit M-1: u32 transcript-counter bound)', () => {
  it('accepts n/b at the limit (1023)', () => {
    expect(() => assertTranscriptCapacity(MAX_BLOCKS_PER_SIDE, 1)).not.toThrow();
  });

  it('rejects n/b just over the limit', () => {
    expect(() => assertTranscriptCapacity(MAX_BLOCKS_PER_SIDE + 1, 1)).toThrow(
      'transcript capacity',
    );
  });

  it('accepts all realistic configs (n=512, any b)', () => {
    for (const b of [1, 2, 4, 8, 16]) expect(() => assertTranscriptCapacity(512, b)).not.toThrow();
  });

  it('buildParams rejects an over-capacity config', () => {
    // n=2048, b=1 → N=2048 > 1023 → 4·N³ overflows u32.
    expect(() => buildParams({ ...base, n: 2048, b: 1, r: 1 })).toThrow('transcript capacity');
  });
});

describe('clampBatchSize', () => {
  const big = {
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
    maxComputeWorkgroupsPerDimension: 65535,
  };

  it('caps n=512 at 128 (128 MiB / 1 MiB slab)', () => {
    expect(clampBatchSize(big, 512)).toBe(128);
  });

  it('returns DEFAULT_BATCH for small n', () => {
    expect(clampBatchSize(big, 64)).toBe(DEFAULT_BATCH);
  });

  it('honors a smaller requested batch', () => {
    expect(clampBatchSize(big, 64, 32)).toBe(32);
  });

  it('never exceeds MAX_BATCH', () => {
    expect(clampBatchSize(big, 8, 100_000)).toBe(MAX_BATCH);
  });

  it('clamps by dispatch-dimension limit', () => {
    expect(
      clampBatchSize(
        { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxComputeWorkgroupsPerDimension: 16 },
        64,
      ),
    ).toBe(16);
  });

  it('throws if a single nonce slab exceeds the binding limit', () => {
    expect(() =>
      clampBatchSize(
        { maxStorageBufferBindingSize: 1024, maxComputeWorkgroupsPerDimension: 65535 },
        512,
      ),
    ).toThrow('too large');
  });

  it('rejects a non-positive requested batch', () => {
    expect(() => clampBatchSize(big, 64, 0)).toThrow('positive integer');
  });
});

describe('buildSolveShader codegen', () => {
  it('injects n/b/r/N and the b² array sizes', () => {
    const src = buildSolveShader(64, 8, 4, 64);
    expect(src).toContain('const NN:u32=64u;');
    expect(src).toContain('const BB:u32=8u;');
    expect(src).toContain('const RR:u32=4u;');
    expect(src).toContain('const NB:u32=8u;'); // 64/8
    expect(src).toContain('const CV:u32=64u;'); // b²
    expect(src).toContain('var cv:array<u32,64>;'); // sized to b², not the spike's 16
    expect(src).toContain('var cacc:array<u32,64>;');
  });

  it('sizes arrays to 16 at b=4 (n=8 case)', () => {
    const src = buildSolveShader(8, 4, 2, 64);
    expect(src).toContain('const CV:u32=16u;');
    expect(src).toContain('var cv:array<u32,16>;');
  });

  it('declares both entry points and the 6-binding group', () => {
    const src = buildSolveShader(8, 4, 2, 64);
    expect(src).toContain('fn fill(');
    expect(src).toContain('fn solve(');
    expect(src).toContain('@binding(5) var<uniform> ctl: vec2<u32>;');
  });
});
