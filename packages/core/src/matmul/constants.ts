/**
 * Magic numbers + domain tags from `btxd v0.29.7 src/matmul/`.
 *
 * Sourced from:
 * - `src/matmul/field.h` (M31 modulus)
 * - `src/matmul/noise.h` (4 noise domain tags)
 * - `src/matmul/transcript.h` (2 transcript tags)
 */

/** M31 prime: 2^31 - 1. From `src/matmul/field.h`. */
export const M31_MODULUS = 0x7fffffff;

/** Domain tag for noise matrix `E_L`. From `src/matmul/noise.h`. */
export const NOISE_TAG_EL = 'matmul_noise_EL_v1';
/** Domain tag for noise matrix `E_R`. From `src/matmul/noise.h`. */
export const NOISE_TAG_ER = 'matmul_noise_ER_v1';
/** Domain tag for noise matrix `F_L`. From `src/matmul/noise.h`. */
export const NOISE_TAG_FL = 'matmul_noise_FL_v1';
/** Domain tag for noise matrix `F_R`. From `src/matmul/noise.h`. */
export const NOISE_TAG_FR = 'matmul_noise_FR_v1';

/** Personalization for the per-block compression vector. From `src/matmul/transcript.h`. */
export const TRANSCRIPT_COMPRESS_TAG = 'matmul-compress-v1';
/** Personalization for the product-committed final digest. From `src/matmul/transcript.h`. */
export const TRANSCRIPT_PRODUCT_DIGEST_TAG = 'matmul-product-digest-v3';
