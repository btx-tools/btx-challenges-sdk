/**
 * Batch-size selection. Each dispatched batch allocates two per-nonce storage
 * slabs (`A'`, `B'`) of `batch · n² · 4` bytes, so the batch is capped by
 * `maxStorageBufferBindingSize` (spec default 128 MiB) and by
 * `maxComputeWorkgroupsPerDimension` (one workgroup per nonce). Kept pure so the
 * clamp is unit-testable without a GPU.
 */

/** Subset of `GPUSupportedLimits` the clamp needs. */
export interface DeviceLimitsLike {
  maxStorageBufferBindingSize: number;
  maxComputeWorkgroupsPerDimension: number;
}

/** Default requested batch when the caller doesn't specify one. */
export const DEFAULT_BATCH = 256;
/** Hard cap so a huge-binding device doesn't allocate absurd slabs for tiny n. */
export const MAX_BATCH = 1024;

/**
 * Largest valid batch for `(limits, n)`, then clamped to `requested` (or
 * {@link DEFAULT_BATCH}) and {@link MAX_BATCH}. Always ≥ 1.
 *
 * @throws if a single nonce's slab already exceeds the binding limit (n far too
 *   large for this device) — better than silently truncating to a wrong result.
 */
export function clampBatchSize(limits: DeviceLimitsLike, n: number, requested?: number): number {
  const bytesPerSlab = n * n * 4;
  const byBinding = Math.floor(limits.maxStorageBufferBindingSize / bytesPerSlab);
  if (byBinding < 1) {
    throw new Error(
      `n=${n} needs ${bytesPerSlab} B per nonce, exceeding maxStorageBufferBindingSize=` +
        `${limits.maxStorageBufferBindingSize}. This n is too large for this device.`,
    );
  }
  const ceiling = Math.max(
    1,
    Math.min(byBinding, limits.maxComputeWorkgroupsPerDimension, MAX_BATCH),
  );
  const want = requested ?? DEFAULT_BATCH;
  if (want !== undefined && (!Number.isInteger(want) || want < 1)) {
    throw new Error(`batchSize must be a positive integer, got ${want}`);
  }
  return Math.max(1, Math.min(want, ceiling));
}
