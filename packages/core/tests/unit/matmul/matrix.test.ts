import { describe, expect, it } from 'vitest';

import { M31_MODULUS } from '../../../src/matmul/constants.js';
import { add as fieldAdd, mul as fieldMul } from '../../../src/matmul/field.js';
import {
  fromSeedRect,
  get,
  matAdd,
  matMul,
  set,
  zeros,
  type Matrix,
} from '../../../src/matmul/matrix.js';

const seed32 = (fill: number): Uint8Array => {
  const s = new Uint8Array(32);
  s.fill(fill);
  return s;
};

describe('matmul/matrix — zeros / get / set', () => {
  it('zeros produces correctly-sized all-zero matrix', () => {
    const m = zeros(3, 5);
    expect(m.rows).toBe(3);
    expect(m.cols).toBe(5);
    expect(m.data.length).toBe(15);
    expect([...m.data]).toEqual(Array(15).fill(0));
  });

  it('get/set roundtrip', () => {
    const m = zeros(2, 3);
    set(m, 1, 2, 42);
    expect(get(m, 1, 2)).toBe(42);
    expect(get(m, 0, 0)).toBe(0);
  });

  it('row-major layout', () => {
    const m = zeros(2, 3);
    set(m, 0, 1, 9);
    expect(m.data[1]).toBe(9); // row 0, col 1 → index 0*3 + 1 = 1
    set(m, 1, 0, 7);
    expect(m.data[3]).toBe(7); // row 1, col 0 → index 1*3 + 0 = 3
  });
});

describe('matmul/matrix — fromSeedRect', () => {
  it('produces correctly-sized matrix', () => {
    const m = fromSeedRect(seed32(0x42), 4, 6);
    expect(m.rows).toBe(4);
    expect(m.cols).toBe(6);
    expect(m.data.length).toBe(24);
  });

  it('all entries are canonical field elements', () => {
    const m = fromSeedRect(seed32(0x42), 8, 4);
    for (const v of m.data) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(M31_MODULUS);
    }
  });

  it('is deterministic for the same seed', () => {
    const a = fromSeedRect(seed32(0x99), 5, 3);
    const b = fromSeedRect(seed32(0x99), 5, 3);
    expect([...a.data]).toEqual([...b.data]);
  });

  it('differs across different seeds', () => {
    const a = fromSeedRect(seed32(0x00), 4, 4);
    const b = fromSeedRect(seed32(0xff), 4, 4);
    expect([...a.data]).not.toEqual([...b.data]);
  });

  it('uses row-major index ordering matching btxd FromSeedRect', () => {
    // Entry (row, col) should equal fromOracle(seed, row*cols + col).
    // The fromSeedRect contract: index = row*cols + col, and successive
    // entries within a row consume sequential indices.
    const m = fromSeedRect(seed32(0x01), 2, 3);
    // Indices 0..5: (0,0)=idx0, (0,1)=idx1, (0,2)=idx2, (1,0)=idx3, (1,1)=idx4, (1,2)=idx5
    // The actual values come from fromOracle but the *ordering* test:
    expect(get(m, 0, 0)).toBe(m.data[0]);
    expect(get(m, 0, 2)).toBe(m.data[2]);
    expect(get(m, 1, 0)).toBe(m.data[3]);
    expect(get(m, 1, 2)).toBe(m.data[5]);
  });
});

describe('matmul/matrix — matAdd', () => {
  it('adds element-wise mod M31', () => {
    const a = zeros(2, 2);
    const b = zeros(2, 2);
    set(a, 0, 0, 5);
    set(a, 0, 1, 10);
    set(b, 0, 0, 7);
    set(b, 0, 1, M31_MODULUS - 1);
    const c = matAdd(a, b);
    expect(get(c, 0, 0)).toBe(12);
    expect(get(c, 0, 1)).toBe(9); // 10 + (M31 - 1) mod M31 = 9
    expect(get(c, 1, 0)).toBe(0);
  });

  it('throws on dim mismatch', () => {
    expect(() => matAdd(zeros(2, 2), zeros(2, 3))).toThrow('dim mismatch');
    expect(() => matAdd(zeros(2, 2), zeros(3, 2))).toThrow('dim mismatch');
  });
});

describe('matmul/matrix — matMul', () => {
  it('multiplies 2x3 by 3x2 (hand-computed)', () => {
    // A = [[1,2,3],[4,5,6]], B = [[7,8],[9,10],[11,12]]
    // A·B = [[1*7+2*9+3*11, 1*8+2*10+3*12],
    //         [4*7+5*9+6*11, 4*8+5*10+6*12]]
    //     = [[58, 64], [139, 154]]
    const a: Matrix = zeros(2, 3);
    a.data.set([1, 2, 3, 4, 5, 6]);
    const b: Matrix = zeros(3, 2);
    b.data.set([7, 8, 9, 10, 11, 12]);
    const c = matMul(a, b);
    expect(c.rows).toBe(2);
    expect(c.cols).toBe(2);
    expect(get(c, 0, 0)).toBe(58);
    expect(get(c, 0, 1)).toBe(64);
    expect(get(c, 1, 0)).toBe(139);
    expect(get(c, 1, 1)).toBe(154);
  });

  it('agrees with naive triple-loop on a 4x4 case in field', () => {
    const a = fromSeedRect(seed32(0xa1), 4, 4);
    const b = fromSeedRect(seed32(0xb2), 4, 4);
    const naive = zeros(4, 4);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let acc = 0;
        for (let k = 0; k < 4; k++) {
          acc = fieldAdd(acc, fieldMul(get(a, i, k), get(b, k, j)));
        }
        set(naive, i, j, acc);
      }
    }
    const fast = matMul(a, b);
    expect([...fast.data]).toEqual([...naive.data]);
  });

  it('throws on inner-dim mismatch', () => {
    expect(() => matMul(zeros(2, 3), zeros(4, 2))).toThrow('inner-dim mismatch');
  });
});
