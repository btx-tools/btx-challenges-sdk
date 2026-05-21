import { describe, expect, it } from 'vitest';

import { M31_MODULUS } from '../../../src/matmul/constants.js';
import { add, dot, fromOracle, fromUint32, inv, mul, neg, sub } from '../../../src/matmul/field.js';

const MAX = M31_MODULUS - 1;

describe('matmul/field — add', () => {
  it('adds within range', () => {
    expect(add(2, 3)).toBe(5);
    expect(add(0, 0)).toBe(0);
    expect(add(MAX, 0)).toBe(MAX);
  });

  it('wraps when sum >= modulus', () => {
    expect(add(MAX, 1)).toBe(0);
    expect(add(MAX, MAX)).toBe(MAX - 1);
  });
});

describe('matmul/field — sub', () => {
  it('subtracts within range when a >= b', () => {
    expect(sub(5, 3)).toBe(2);
    expect(sub(MAX, 0)).toBe(MAX);
    expect(sub(MAX, MAX)).toBe(0);
  });

  it('wraps when a < b', () => {
    expect(sub(0, 1)).toBe(MAX);
    expect(sub(3, 5)).toBe(M31_MODULUS - 2);
  });
});

describe('matmul/field — mul', () => {
  it('multiplies small numbers', () => {
    expect(mul(2, 3)).toBe(6);
    expect(mul(0, MAX)).toBe(0);
    expect(mul(MAX, 0)).toBe(0);
    expect(mul(1, MAX)).toBe(MAX);
  });

  it('reduces correctly above modulus', () => {
    // (2^30) * (2^30) = 2^60. 2^31 ≡ 1 (mod M31), so 2^60 = 2^31 * 2^29 ≡ 2^29.
    expect(mul(1 << 30, 1 << 30)).toBe(1 << 29);
    // (M31 - 1) * (M31 - 1) ≡ (-1)^2 = 1
    expect(mul(MAX, MAX)).toBe(1);
    // M31 - 1 ≡ -1, so (M31 - 1) * 2 ≡ -2 ≡ M31 - 2
    expect(mul(MAX, 2)).toBe(MAX - 1);
  });

  it('is commutative', () => {
    const samples: Array<[number, number]> = [
      [123, 456],
      [MAX, 7],
      [(1 << 28) + 5, (1 << 29) + 11],
    ];
    for (const [a, b] of samples) {
      expect(mul(a, b)).toBe(mul(b, a));
    }
  });
});

describe('matmul/field — neg', () => {
  it('negates correctly', () => {
    expect(neg(0)).toBe(0);
    expect(neg(1)).toBe(MAX);
    expect(neg(MAX)).toBe(1);
  });

  it('a + neg(a) == 0', () => {
    for (const a of [1, 42, 123456, MAX]) {
      expect(add(a, neg(a))).toBe(0);
    }
  });
});

describe('matmul/field — fromUint32', () => {
  it('reduces to canonical form', () => {
    expect(fromUint32(0)).toBe(0);
    expect(fromUint32(M31_MODULUS - 1)).toBe(M31_MODULUS - 1);
    // M31_MODULUS itself ≡ 0
    expect(fromUint32(M31_MODULUS)).toBe(0);
    // 2^31 ≡ 1
    expect(fromUint32(1 << 30) << 0).toBe(1 << 30);
    expect(fromUint32(0xffffffff)).toBe(1); // 2^32 - 1 = 2*M31 + 1 ≡ 1
  });
});

describe('matmul/field — inv', () => {
  it('throws on zero', () => {
    expect(() => inv(0)).toThrow('cannot invert 0');
  });

  it('a * inv(a) == 1 for a sample', () => {
    for (const a of [1, 2, 3, 7, 123, MAX, MAX - 1, 65537]) {
      expect(mul(a, inv(a))).toBe(1);
    }
  });

  it('inv(1) == 1', () => {
    expect(inv(1)).toBe(1);
  });

  it('inv(MAX) == MAX (since MAX ≡ -1, -1 inverse is -1)', () => {
    expect(inv(MAX)).toBe(MAX);
  });
});

describe('matmul/field — fromOracle', () => {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i;

  it('rejects wrong-length seed', () => {
    expect(() => fromOracle(new Uint8Array(16), 0)).toThrow('must be 32 bytes');
  });

  it('returns canonical field element', () => {
    for (let i = 0; i < 10; i++) {
      const v = fromOracle(seed, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(M31_MODULUS);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('is deterministic', () => {
    expect(fromOracle(seed, 42)).toBe(fromOracle(seed, 42));
    expect(fromOracle(seed, 0)).toBe(fromOracle(seed, 0));
  });

  it('differs across different indices', () => {
    const samples = new Set([0, 1, 2, 100, 1_000_000].map((i) => fromOracle(seed, i)));
    expect(samples.size).toBe(5);
  });

  it('differs across different seeds', () => {
    const otherSeed = new Uint8Array(32);
    otherSeed[0] = 0xff;
    expect(fromOracle(seed, 0)).not.toBe(fromOracle(otherSeed, 0));
  });
});

describe('matmul/field — dot', () => {
  it('matches hand-computed result on small vectors', () => {
    // [1, 2, 3] · [4, 5, 6] = 4 + 10 + 18 = 32
    expect(dot([1, 2, 3], [4, 5, 6], 3)).toBe(32);
    // Empty vector
    expect(dot([], [], 0)).toBe(0);
  });

  it('respects length param', () => {
    expect(dot([1, 2, 3, 999], [4, 5, 6, 999], 3)).toBe(32);
  });

  it('matches naive sum-of-muls on a longer vector', () => {
    const a = Array.from({ length: 100 }, (_, i) => (i * 1234567 + 13) % M31_MODULUS);
    const b = Array.from({ length: 100 }, (_, i) => (i * 7654321 + 7) % M31_MODULUS);
    let expected = 0;
    for (let i = 0; i < 100; i++) expected = add(expected, mul(a[i]!, b[i]!));
    expect(dot(a, b, 100)).toBe(expected);
  });
});
