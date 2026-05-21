import { describe, expect, it } from 'vitest';

import { M31_MODULUS } from '../../../src/matmul/constants.js';
import { fromSeedRect, get, matMul, zeros } from '../../../src/matmul/matrix.js';
import {
  TranscriptHasher,
  canonicalMatMul,
  compressBlock,
  deriveCompressionVector,
} from '../../../src/matmul/transcript.js';

const sigma32 = (fill: number): Uint8Array => {
  const s = new Uint8Array(32);
  s.fill(fill);
  return s;
};

const seed32 = sigma32;

describe('matmul/transcript — deriveCompressionVector', () => {
  it('produces a b·b element vector', () => {
    const v = deriveCompressionVector(sigma32(0x42), 4);
    expect(v.length).toBe(16);
  });

  it('all entries are canonical field elements', () => {
    const v = deriveCompressionVector(sigma32(0x42), 8);
    for (const x of v) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(M31_MODULUS);
    }
  });

  it('is deterministic', () => {
    expect(deriveCompressionVector(sigma32(0x42), 4)).toEqual(
      deriveCompressionVector(sigma32(0x42), 4),
    );
  });

  it('differs across sigmas', () => {
    const a = deriveCompressionVector(sigma32(0x00), 4);
    const b = deriveCompressionVector(sigma32(0x01), 4);
    expect([...a]).not.toEqual([...b]);
  });

  it('rejects b <= 0', () => {
    expect(() => deriveCompressionVector(sigma32(0x42), 0)).toThrow('block size b must be positive');
    expect(() => deriveCompressionVector(sigma32(0x42), -1)).toThrow('block size b must be positive');
  });
});

describe('matmul/transcript — compressBlock', () => {
  it('matches hand-computed dot product', () => {
    const block = new Uint32Array([1, 2, 3, 4]);
    const v = new Uint32Array([5, 6, 7, 8]);
    // 1*5 + 2*6 + 3*7 + 4*8 = 5 + 12 + 21 + 32 = 70
    expect(compressBlock(block, v)).toBe(70);
  });

  it('rejects dim mismatch', () => {
    expect(() => compressBlock(new Uint32Array(4), new Uint32Array(3))).toThrow(
      'dim mismatch',
    );
  });
});

describe('matmul/transcript — TranscriptHasher', () => {
  it('finalize is 32 bytes', () => {
    const h = new TranscriptHasher(sigma32(0x99), 2);
    const block = new Uint32Array(4);
    h.addIntermediate(0, 0, 0, block);
    const digest = h.finalize();
    expect(digest.length).toBe(32);
    expect(digest).toBeInstanceOf(Uint8Array);
  });

  it('is deterministic across instances given identical input sequence', () => {
    const make = (): Uint8Array => {
      const h = new TranscriptHasher(sigma32(0x99), 2);
      h.addIntermediate(0, 0, 0, new Uint32Array([1, 2, 3, 4]));
      h.addIntermediate(0, 0, 1, new Uint32Array([5, 6, 7, 8]));
      h.addIntermediate(0, 1, 0, new Uint32Array([9, 10, 11, 12]));
      return h.finalize();
    };
    expect(make()).toEqual(make());
  });

  it('different c-block content yields different digest', () => {
    const sigma = sigma32(0x99);
    const a = new TranscriptHasher(sigma, 2);
    a.addIntermediate(0, 0, 0, new Uint32Array([1, 2, 3, 4]));
    const b = new TranscriptHasher(sigma, 2);
    b.addIntermediate(0, 0, 0, new Uint32Array([1, 2, 3, 5]));
    expect(a.finalize()).not.toEqual(b.finalize());
  });

  it('different sigma yields different digest (different compression vector)', () => {
    const block = new Uint32Array([1, 2, 3, 4]);
    const a = new TranscriptHasher(sigma32(0x00), 2);
    a.addIntermediate(0, 0, 0, block);
    const b = new TranscriptHasher(sigma32(0x01), 2);
    b.addIntermediate(0, 0, 0, block);
    expect(a.finalize()).not.toEqual(b.finalize());
  });

  it('rejects wrong-sized c-block', () => {
    const h = new TranscriptHasher(sigma32(0x99), 2);
    expect(() => h.addIntermediate(0, 0, 0, new Uint32Array(3))).toThrow(
      'must be 4 elements',
    );
  });
});

describe('matmul/transcript — canonicalMatMul', () => {
  const sigma = sigma32(0xa5);

  it('produces square C\' matching matMul on a 4×4 / b=2 case', () => {
    const aPrime = fromSeedRect(seed32(0x11), 4, 4);
    const bPrime = fromSeedRect(seed32(0x22), 4, 4);

    const result = canonicalMatMul(aPrime, bPrime, 2, sigma);
    expect(result.cPrime.rows).toBe(4);
    expect(result.cPrime.cols).toBe(4);

    const reference = matMul(aPrime, bPrime);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        expect(get(result.cPrime, i, j)).toBe(get(reference, i, j));
      }
    }
  });

  it('produces square C\' matching matMul on an 8×8 / b=4 case', () => {
    const aPrime = fromSeedRect(seed32(0xab), 8, 8);
    const bPrime = fromSeedRect(seed32(0xcd), 8, 8);
    const result = canonicalMatMul(aPrime, bPrime, 4, sigma);
    const reference = matMul(aPrime, bPrime);
    expect([...result.cPrime.data]).toEqual([...reference.data]);
  });

  it('transcript_hash is 32 bytes and deterministic', () => {
    const aPrime = fromSeedRect(seed32(0x11), 4, 4);
    const bPrime = fromSeedRect(seed32(0x22), 4, 4);
    const r1 = canonicalMatMul(aPrime, bPrime, 2, sigma);
    const r2 = canonicalMatMul(aPrime, bPrime, 2, sigma);
    expect(r1.transcriptHash.length).toBe(32);
    expect(r1.transcriptHash).toEqual(r2.transcriptHash);
  });

  it('transcript_hash differs across sigmas', () => {
    const aPrime = fromSeedRect(seed32(0x11), 4, 4);
    const bPrime = fromSeedRect(seed32(0x22), 4, 4);
    const r0 = canonicalMatMul(aPrime, bPrime, 2, sigma32(0x00));
    const r1 = canonicalMatMul(aPrime, bPrime, 2, sigma32(0x01));
    expect(r0.transcriptHash).not.toEqual(r1.transcriptHash);
  });

  it('transcript_hash differs when matrix entries change', () => {
    const aPrime = fromSeedRect(seed32(0x11), 4, 4);
    const bPrime1 = fromSeedRect(seed32(0x22), 4, 4);
    const bPrime2 = fromSeedRect(seed32(0x23), 4, 4);
    const r1 = canonicalMatMul(aPrime, bPrime1, 2, sigma);
    const r2 = canonicalMatMul(aPrime, bPrime2, 2, sigma);
    expect(r1.transcriptHash).not.toEqual(r2.transcriptHash);
  });

  it('rejects non-square A or B', () => {
    expect(() => canonicalMatMul(zeros(2, 3), zeros(3, 3), 1, sigma)).toThrow('square');
  });

  it('rejects different-sized A and B', () => {
    expect(() => canonicalMatMul(zeros(4, 4), zeros(2, 2), 2, sigma)).toThrow('square');
  });

  it('rejects b that does not divide n', () => {
    expect(() => canonicalMatMul(zeros(4, 4), zeros(4, 4), 3, sigma)).toThrow(
      'invalid transcript block size',
    );
  });

  it('rejects b == 0', () => {
    expect(() => canonicalMatMul(zeros(4, 4), zeros(4, 4), 0, sigma)).toThrow(
      'invalid transcript block size',
    );
  });
});
