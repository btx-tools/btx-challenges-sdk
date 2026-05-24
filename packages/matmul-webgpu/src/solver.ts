/**
 * Public solver API. {@link createWebGpuSolver} takes the **same positional
 * arguments as `@btx-tools/matmul-wasm`'s `WasmSolver`** so the SDK's
 * `challengeToWasmArgs` mapping (incl. its C-1 seed/dim guard) can be reused
 * verbatim for a `mode:'webgpu'` cascade. Async because WebGPU device
 * acquisition is async.
 */
import { buildParams, validateMatmulParams } from './header.js';
import { createGpuKernel, type GpuKernel } from './kernel.js';
import { clampBatchSize } from './limits.js';

/** A found proof. Mirrors `WasmSolution` (`{nonce_hex, digest_hex}`). */
export interface WebGpuSolution {
  /** Winning nonce, 16 hex chars (big-endian). */
  nonce_hex: string;
  /** Canonical display digest, 64 hex chars (reverse(rawSHA256d)). */
  digest_hex: string;
}

/** Construction options. */
export interface WebGpuSolverInit {
  /** Provide a device (tests / custom limits). Default: `navigator.gpu.requestAdapter()`. */
  device?: GPUDevice;
  /** Nonces per GPU batch. Default: auto-clamped from `device.limits` and `n`. */
  batchSize?: number;
}

/** A configured solver bound to one challenge's header/params and a GPU device. */
export interface WebGpuSolver {
  /**
   * Search nonces `[nonceStart, nonceStart + maxTries)` for one whose digest
   * satisfies the target. **`stride` must be 1** in this release (worker-shard
   * striding is a documented fast-follow); throws otherwise. Resolves to the
   * first hit, or `undefined` if `maxTries` is exhausted.
   */
  solveChunk(
    nonceStart: bigint,
    stride: bigint,
    maxTries: bigint,
  ): Promise<WebGpuSolution | undefined>;
  /** Nonces processed per GPU dispatch. */
  readonly batchSize: number;
  /** Release GPU resources. */
  destroy(): void;
}

async function acquireDevice(init?: WebGpuSolverInit): Promise<GPUDevice> {
  if (init?.device) return init.device;
  const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
  if (!gpu) {
    throw new Error(
      'matmul-webgpu: navigator.gpu is unavailable (no WebGPU in this environment). Pass init.device or use a WebGPU-capable runtime.',
    );
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter)
    throw new Error('matmul-webgpu: requestAdapter() returned null (no GPU adapter available).');
  return adapter.requestDevice();
}

/**
 * Create a WebGPU solver for one challenge. Positional args are identical to
 * `@btx-tools/matmul-wasm`'s `WasmSolver` constructor.
 *
 * @example
 * ```ts
 * const solver = await createWebGpuSolver(
 *   version, prevhash, merkleroot, time, bits, n, b, r, seedA, seedB, target,
 * );
 * const hit = await solver.solveChunk(0n, 1n, 100_000n);
 * solver.destroy();
 * ```
 */
export async function createWebGpuSolver(
  version: number,
  prevhash: string,
  merkleroot: string,
  time: number,
  bits: string,
  n: number,
  b: number,
  r: number,
  seedA: string,
  seedB: string,
  target: string,
  init?: WebGpuSolverInit,
): Promise<WebGpuSolver> {
  validateMatmulParams(n, b, r);
  const params = buildParams({
    version,
    prevhash,
    merkleroot,
    time,
    bits,
    n,
    b,
    r,
    seedA,
    seedB,
    target,
  });
  const device = await acquireDevice(init);
  const batch = clampBatchSize(device.limits, n, init?.batchSize);
  const kernel: GpuKernel = await createGpuKernel(device, params, n, b, r, batch);

  return {
    batchSize: batch,
    async solveChunk(
      nonceStart: bigint,
      stride: bigint,
      maxTries: bigint,
    ): Promise<WebGpuSolution | undefined> {
      if (stride !== 1n)
        throw new Error(
          `matmul-webgpu: only stride=1 is supported in this release (got ${stride}).`,
        );
      if (maxTries < 0n) throw new Error(`matmul-webgpu: maxTries must be ≥ 0 (got ${maxTries}).`);
      // The kernel patches only the low 32 bits of nonce64 (hi32 hardcoded 0), so
      // the searched range must stay within [0, 2³²) or it would derive sigma for a
      // different nonce than reported → an un-redeemable proof (audit H-1). Fail closed.
      if (nonceStart < 0n || nonceStart + maxTries > 1n << 32n) {
        throw new Error(
          `matmul-webgpu: nonce range [${nonceStart}, ${nonceStart + maxTries}) must lie within ` +
            `[0, 2³²) in this release (the kernel patches only the low 32 nonce bits).`,
        );
      }
      let done = 0n;
      while (done < maxTries) {
        const count = Number(maxTries - done > BigInt(batch) ? BigInt(batch) : maxTries - done);
        const hit = await kernel.solveBatch(nonceStart + done, count);
        if (hit) {
          return { nonce_hex: hit.nonce.toString(16).padStart(16, '0'), digest_hex: hit.digestHex };
        }
        done += BigInt(count);
      }
      return undefined;
    },
    destroy(): void {
      kernel.destroy();
    },
  };
}
