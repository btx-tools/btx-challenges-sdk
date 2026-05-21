import { describe, expect, it } from 'vitest';

import {
  M31_MODULUS,
  NOISE_TAG_EL,
  NOISE_TAG_ER,
  NOISE_TAG_FL,
  NOISE_TAG_FR,
  TRANSCRIPT_COMPRESS_TAG,
  TRANSCRIPT_PRODUCT_DIGEST_TAG,
} from '../../../src/matmul/constants.js';

describe('matmul/constants', () => {
  it('M31_MODULUS matches btxd field.h literal (2^31 - 1)', () => {
    expect(M31_MODULUS).toBe(0x7fffffff);
    expect(M31_MODULUS).toBe(2 ** 31 - 1);
    expect(M31_MODULUS).toBe(2147483647);
  });

  it('noise domain tags match btxd noise.h string literals', () => {
    expect(NOISE_TAG_EL).toBe('matmul_noise_EL_v1');
    expect(NOISE_TAG_ER).toBe('matmul_noise_ER_v1');
    expect(NOISE_TAG_FL).toBe('matmul_noise_FL_v1');
    expect(NOISE_TAG_FR).toBe('matmul_noise_FR_v1');
  });

  it('transcript domain tags match btxd transcript.h string literals', () => {
    expect(TRANSCRIPT_COMPRESS_TAG).toBe('matmul-compress-v1');
    expect(TRANSCRIPT_PRODUCT_DIGEST_TAG).toBe('matmul-product-digest-v3');
  });

  it('all 4 noise tags are distinct', () => {
    const tags = new Set([NOISE_TAG_EL, NOISE_TAG_ER, NOISE_TAG_FL, NOISE_TAG_FR]);
    expect(tags.size).toBe(4);
  });
});
