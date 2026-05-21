import { describe, expect, it } from 'vitest';

import {
  computeMatMulHeaderHash,
  deriveSigma,
  headerInputForNonce,
  serializeMatMulHeader,
  type MatMulHeaderInput,
} from '../../../src/matmul/header.js';

const ZERO_HASH = '00'.repeat(32);
const ONE_HASH = '11'.repeat(32);
const TWO_HASH = '22'.repeat(32);
const THREE_HASH = '33'.repeat(32);

function makeHeader(overrides: Partial<MatMulHeaderInput> = {}): MatMulHeaderInput {
  return {
    version: 1,
    previousblockhash: ZERO_HASH,
    merkleroot: ONE_HASH,
    time: 1700000000,
    bits: '1d00ffff',
    nonce64: 0n,
    matmul_dim: 512,
    seed_a: TWO_HASH,
    seed_b: THREE_HASH,
    ...overrides,
  };
}

describe('matmul/header — serializeMatMulHeader', () => {
  it('produces 150-byte buffer matching btxd field order', () => {
    const buf = serializeMatMulHeader(makeHeader());
    expect(buf.length).toBe(150);
    // Field offsets (per btxd ComputeMatMulHeaderHash):
    // [0..4) LE32 version
    expect(buf[0]).toBe(0x01);
    expect(buf[1]).toBe(0x00);
    // [4..36) previousblockhash (LE storage = reversed BE hex)
    // ZERO_HASH all zeros: reversed is still all zeros.
    for (let i = 4; i < 36; i++) expect(buf[i]).toBe(0x00);
    // [36..68) merkleroot — ONE_HASH (0x11) all bytes
    for (let i = 36; i < 68; i++) expect(buf[i]).toBe(0x11);
    // [68..72) LE32 time = 1700000000 = 0x6553F100
    expect(buf[68]).toBe(0x00);
    expect(buf[69]).toBe(0xf1);
    expect(buf[70]).toBe(0x53);
    expect(buf[71]).toBe(0x65);
    // [72..76) LE32 bits = 0x1d00ffff
    expect(buf[72]).toBe(0xff);
    expect(buf[73]).toBe(0xff);
    expect(buf[74]).toBe(0x00);
    expect(buf[75]).toBe(0x1d);
    // [76..84) LE64 nonce64 = 0
    for (let i = 76; i < 84; i++) expect(buf[i]).toBe(0x00);
    // [84..86) LE16 matmul_dim = 512 = 0x0200
    expect(buf[84]).toBe(0x00);
    expect(buf[85]).toBe(0x02);
    // [86..118) seed_a = TWO_HASH = all 0x22 (reversal of all-0x22 is itself)
    for (let i = 86; i < 118; i++) expect(buf[i]).toBe(0x22);
    // [118..150) seed_b = THREE_HASH = all 0x33
    for (let i = 118; i < 150; i++) expect(buf[i]).toBe(0x33);
  });

  it('encodes nonce64 in little-endian over 8 bytes', () => {
    const buf = serializeMatMulHeader(makeHeader({ nonce64: 0x123456789abcdef0n }));
    // LE encoding: low byte first
    expect(buf[76]).toBe(0xf0);
    expect(buf[77]).toBe(0xde);
    expect(buf[78]).toBe(0xbc);
    expect(buf[79]).toBe(0x9a);
    expect(buf[80]).toBe(0x78);
    expect(buf[81]).toBe(0x56);
    expect(buf[82]).toBe(0x34);
    expect(buf[83]).toBe(0x12);
  });

  it('reverses uint256 hex (BE display) to LE storage when serializing', () => {
    // BE hex "01000000...00" (highest byte first) → LE bytes [0x00, ..., 0x00, 0x01]
    const beHex = '01' + '00'.repeat(31);
    const buf = serializeMatMulHeader(makeHeader({ previousblockhash: beHex }));
    // previousblockhash region [4..36): reversed BE → LE
    for (let i = 4; i < 35; i++) expect(buf[i]).toBe(0x00);
    expect(buf[35]).toBe(0x01);
  });

  it('accepts hex with 0x prefix', () => {
    expect(() =>
      serializeMatMulHeader(makeHeader({ previousblockhash: '0x' + ZERO_HASH })),
    ).not.toThrow();
  });

  it('rejects wrong-length uint256 hex', () => {
    expect(() => serializeMatMulHeader(makeHeader({ previousblockhash: '00' }))).toThrow(
      'expected 64 hex chars',
    );
  });

  it('rejects wrong-length bits hex', () => {
    expect(() => serializeMatMulHeader(makeHeader({ bits: '1d00ff' }))).toThrow(
      'expected 8 hex chars',
    );
  });
});

describe('matmul/header — computeMatMulHeaderHash', () => {
  it('produces 32-byte SHA-256 digest', () => {
    const h = computeMatMulHeaderHash(makeHeader());
    expect(h.length).toBe(32);
  });

  it('is deterministic', () => {
    const a = computeMatMulHeaderHash(makeHeader());
    const b = computeMatMulHeaderHash(makeHeader());
    expect(a).toEqual(b);
  });

  it('differs across different inputs', () => {
    const a = computeMatMulHeaderHash(makeHeader({ nonce64: 0n }));
    const b = computeMatMulHeaderHash(makeHeader({ nonce64: 1n }));
    expect(a).not.toEqual(b);
  });
});

describe('matmul/header — deriveSigma', () => {
  it('is double-SHA-256 of the serialized header (32 bytes, BE order)', () => {
    const sigma = deriveSigma(makeHeader());
    expect(sigma.length).toBe(32);
    expect(sigma).toBeInstanceOf(Uint8Array);
  });

  it('changes when nonce64 changes', () => {
    const s0 = deriveSigma(makeHeader({ nonce64: 0n }));
    const s1 = deriveSigma(makeHeader({ nonce64: 1n }));
    expect(s0).not.toEqual(s1);
  });

  it('changes when previousblockhash changes', () => {
    const s0 = deriveSigma(makeHeader({ previousblockhash: ZERO_HASH }));
    const s1 = deriveSigma(makeHeader({ previousblockhash: ONE_HASH }));
    expect(s0).not.toEqual(s1);
  });

  it('changes when seed_a changes', () => {
    const s0 = deriveSigma(makeHeader({ seed_a: TWO_HASH }));
    const s1 = deriveSigma(makeHeader({ seed_a: THREE_HASH }));
    expect(s0).not.toEqual(s1);
  });
});

describe('matmul/header — headerInputForNonce', () => {
  it('threads ChallengeHeaderContext through with the candidate nonce', () => {
    const ctx = {
      version: 1,
      previousblockhash: ZERO_HASH,
      merkleroot: ONE_HASH,
      time: 1700000000,
      bits: '1d00ffff',
      nonce64_start: 0,
      matmul_dim: 512,
      seed_a: TWO_HASH,
      seed_b: THREE_HASH,
    };
    const h = headerInputForNonce(ctx, 42n);
    expect(h.nonce64).toBe(42n);
    expect(h.seed_a).toBe(TWO_HASH);
    expect(h.bits).toBe('1d00ffff');
  });
});
