import { describe, expect, it } from 'vitest';

import { M31_MODULUS } from '../../../src/matmul/constants.js';
import { deriveNoiseSeed, generate } from '../../../src/matmul/noise.js';

const sigma32 = (fill: number): Uint8Array => {
  const s = new Uint8Array(32);
  s.fill(fill);
  return s;
};

describe('matmul/noise — deriveNoiseSeed', () => {
  const sigma = sigma32(0xaa);

  it('returns 32-byte seed', () => {
    expect(deriveNoiseSeed('matmul_noise_EL_v1', sigma).length).toBe(32);
  });

  it('rejects wrong-length sigma', () => {
    expect(() => deriveNoiseSeed('matmul_noise_EL_v1', sigma32(0xaa).slice(0, 16))).toThrow(
      'sigma must be 32 bytes',
    );
  });

  it('rejects non-18-char domain tag (matches btxd assert)', () => {
    expect(() => deriveNoiseSeed('short', sigma)).toThrow('domain tag must be 18 chars');
    expect(() => deriveNoiseSeed('a_very_long_tag_xx', sigma)).not.toThrow();
  });

  it('is deterministic', () => {
    expect(deriveNoiseSeed('matmul_noise_EL_v1', sigma)).toEqual(
      deriveNoiseSeed('matmul_noise_EL_v1', sigma),
    );
  });

  it('produces 4 distinct seeds across the 4 tags', () => {
    const a = deriveNoiseSeed('matmul_noise_EL_v1', sigma);
    const b = deriveNoiseSeed('matmul_noise_ER_v1', sigma);
    const c = deriveNoiseSeed('matmul_noise_FL_v1', sigma);
    const d = deriveNoiseSeed('matmul_noise_FR_v1', sigma);
    const set = new Set([a, b, c, d].map((u) => Buffer.from(u).toString('hex')));
    expect(set.size).toBe(4);
  });

  it('differs across different sigmas', () => {
    const s0 = deriveNoiseSeed('matmul_noise_EL_v1', sigma32(0x00));
    const s1 = deriveNoiseSeed('matmul_noise_EL_v1', sigma32(0x01));
    expect(s0).not.toEqual(s1);
  });
});

describe('matmul/noise — generate', () => {
  const sigma = sigma32(0x5a);

  it('produces 4 matrices with correct asymmetric dims (n×r, r×n, n×r, r×n)', () => {
    const np = generate(sigma, 8, 3);
    expect(np.E_L.rows).toBe(8);
    expect(np.E_L.cols).toBe(3);
    expect(np.E_R.rows).toBe(3);
    expect(np.E_R.cols).toBe(8);
    expect(np.F_L.rows).toBe(8);
    expect(np.F_L.cols).toBe(3);
    expect(np.F_R.rows).toBe(3);
    expect(np.F_R.cols).toBe(8);
  });

  it('all entries are canonical field elements', () => {
    const np = generate(sigma, 6, 2);
    for (const m of [np.E_L, np.E_R, np.F_L, np.F_R]) {
      for (const v of m.data) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(M31_MODULUS);
      }
    }
  });

  it('is deterministic', () => {
    const a = generate(sigma, 4, 2);
    const b = generate(sigma, 4, 2);
    expect([...a.E_L.data]).toEqual([...b.E_L.data]);
    expect([...a.E_R.data]).toEqual([...b.E_R.data]);
    expect([...a.F_L.data]).toEqual([...b.F_L.data]);
    expect([...a.F_R.data]).toEqual([...b.F_R.data]);
  });

  it('the 4 matrices have distinct content (different domain seeds)', () => {
    const np = generate(sigma, 4, 2);
    const hexEL = Buffer.from(np.E_L.data.buffer).toString('hex');
    const hexER = Buffer.from(np.E_R.data.buffer).toString('hex');
    // E_L and E_R have different dims so .data lengths differ; just check
    // that for matrices of the same shape, content differs.
    const hexFL = Buffer.from(np.F_L.data.buffer).toString('hex');
    const hexFR = Buffer.from(np.F_R.data.buffer).toString('hex');
    expect(hexEL).not.toBe(hexFL); // both n×r, different tags
    expect(hexER).not.toBe(hexFR); // both r×n, different tags
  });

  it('differs across different sigmas', () => {
    const a = generate(sigma32(0x00), 4, 2);
    const b = generate(sigma32(0x01), 4, 2);
    expect([...a.E_L.data]).not.toEqual([...b.E_L.data]);
  });
});
