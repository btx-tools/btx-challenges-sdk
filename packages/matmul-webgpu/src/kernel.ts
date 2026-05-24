/**
 * GPU resource management + per-batch dispatch for the matmul solver. Owns the
 * compiled pipelines, the shared bind group, and the reused storage/readback
 * buffers; {@link GpuKernel.solveBatch} runs `fill` then `solve` over a batch of
 * nonces and reads back the first accepting slot.
 */
import { buildSolveShader } from './wgsl/shaders.js';

/** Workgroup size for the parallel `fill` pass (one workgroup per nonce). */
export const FILL_WORKGROUP_SIZE = 64;

/** A nonce whose digest satisfies the target. */
export interface BatchHit {
  /** The winning nonce (bigint, == nonceBase + slot). */
  nonce: bigint;
  /** Canonical display digest, 64 hex chars (reverse(rawSHA256d)). */
  digestHex: string;
}

/**
 * Holds all GPU resources for one `(n, b, r, batch)` configuration. Construct via
 * {@link createGpuKernel} (it surfaces shader/pipeline errors via an error scope).
 */
export class GpuKernel {
  private destroyed = false;

  private constructor(
    private readonly device: GPUDevice,
    private readonly n: number,
    private readonly batch: number,
    private readonly fillPipe: GPUComputePipeline,
    private readonly solvePipe: GPUComputePipeline,
    private readonly bind: GPUBindGroup,
    private readonly ctlBuf: GPUBuffer,
    private readonly accBuf: GPUBuffer,
    private readonly digBuf: GPUBuffer,
    private readonly slabBufs: GPUBuffer[],
    private readonly accRead: GPUBuffer,
    private readonly digRead: GPUBuffer,
  ) {}

  static async create(
    device: GPUDevice,
    params: Uint32Array,
    n: number,
    b: number,
    r: number,
    batch: number,
  ): Promise<GpuKernel> {
    const code = buildSolveShader(n, b, r, FILL_WORKGROUP_SIZE);
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code });
    const ci = await module.getCompilationInfo();
    const errs = ci.messages.filter((m) => m.type === 'error');
    if (errs.length) {
      throw new Error(
        `matmul-webgpu shader compile error: ${errs.map((m) => `L${m.lineNum}: ${m.message}`).join('; ')}`,
      );
    }

    const mk = (data: Uint32Array, usage: number): GPUBuffer => {
      const buf = device.createBuffer({
        size: Math.max(4, data.byteLength),
        usage,
        mappedAtCreation: true,
      });
      new Uint32Array(buf.getMappedRange()).set(data);
      buf.unmap();
      return buf;
    };
    const STORAGE = GPUBufferUsage.STORAGE;
    const paramsBuf = mk(params, STORAGE);
    const slabBytes = batch * n * n * 4;
    const apBuf = device.createBuffer({ size: slabBytes, usage: STORAGE });
    const bpBuf = device.createBuffer({ size: slabBytes, usage: STORAGE });
    const accBuf = device.createBuffer({
      size: batch * 4,
      usage: STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const digBuf = device.createBuffer({
      size: batch * 8 * 4,
      usage: STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const ctlBuf = device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const ro = { type: 'read-only-storage' } as const;
    const rw = { type: 'storage' } as const;
    const un = { type: 'uniform' } as const;
    const bgl = device.createBindGroupLayout({
      entries: [ro, rw, rw, rw, rw, un].map((buffer, binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer,
      })),
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const fillPipe = device.createComputePipeline({
      layout,
      compute: { module, entryPoint: 'fill' },
    });
    const solvePipe = device.createComputePipeline({
      layout,
      compute: { module, entryPoint: 'solve' },
    });
    const bind = device.createBindGroup({
      layout: bgl,
      entries: [paramsBuf, apBuf, bpBuf, accBuf, digBuf, ctlBuf].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });

    const accRead = device.createBuffer({
      size: batch * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const digRead = device.createBuffer({
      size: batch * 8 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const err = await device.popErrorScope();
    if (err) throw new Error(`matmul-webgpu pipeline setup failed: ${err.message}`);

    return new GpuKernel(
      device,
      n,
      batch,
      fillPipe,
      solvePipe,
      bind,
      ctlBuf,
      accBuf,
      digBuf,
      [paramsBuf, apBuf, bpBuf],
      accRead,
      digRead,
    );
  }

  /** Maximum nonces per call (the configured batch). */
  get batchSize(): number {
    return this.batch;
  }

  /**
   * Solve `count` nonces starting at `nonceBase` (count ≤ batchSize). Returns the
   * first accepting nonce (lowest slot), or `null` if none in this batch.
   */
  async solveBatch(nonceBase: bigint, count: number): Promise<BatchHit | null> {
    if (this.destroyed) throw new Error('GpuKernel.solveBatch called after destroy()');
    if (count < 1 || count > this.batch)
      throw new Error(`count=${count} out of range [1, ${this.batch}]`);
    const base32 = Number(nonceBase & 0xffffffffn); // kernel patches the low 32 bits (M2: nonce < 2^32)
    this.device.queue.writeBuffer(this.ctlBuf, 0, Uint32Array.from([count, base32]));

    const enc = this.device.createCommandEncoder();
    {
      const p = enc.beginComputePass();
      p.setPipeline(this.fillPipe);
      p.setBindGroup(0, this.bind);
      p.dispatchWorkgroups(count);
      p.end();
    }
    {
      const p = enc.beginComputePass();
      p.setPipeline(this.solvePipe);
      p.setBindGroup(0, this.bind);
      p.dispatchWorkgroups(count);
      p.end();
    }
    enc.copyBufferToBuffer(this.accBuf, 0, this.accRead, 0, count * 4);
    enc.copyBufferToBuffer(this.digBuf, 0, this.digRead, 0, count * 8 * 4);
    this.device.queue.submit([enc.finish()]);

    await Promise.all([
      this.accRead.mapAsync(GPUMapMode.READ, 0, count * 4),
      this.digRead.mapAsync(GPUMapMode.READ, 0, count * 8 * 4),
    ]);
    const acc = new Uint32Array(this.accRead.getMappedRange(0, count * 4).slice(0));
    const dig = new Uint32Array(this.digRead.getMappedRange(0, count * 8 * 4).slice(0));
    this.accRead.unmap();
    this.digRead.unmap();

    const slot = acc.indexOf(1);
    if (slot < 0) return null;
    const dv = new DataView(new ArrayBuffer(32));
    for (let i = 0; i < 8; i++) dv.setUint32(i * 4, dig[slot * 8 + i]!, false);
    const digestHex = [...new Uint8Array(dv.buffer)]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
    return { nonce: nonceBase + BigInt(slot), digestHex };
  }

  /** Release all GPU buffers. Idempotent — a double call is a no-op (audit M-2). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const buf of [
      ...this.slabBufs,
      this.accBuf,
      this.digBuf,
      this.ctlBuf,
      this.accRead,
      this.digRead,
    ])
      buf.destroy();
  }
}

/** Convenience wrapper over {@link GpuKernel.create}. */
export function createGpuKernel(
  device: GPUDevice,
  params: Uint32Array,
  n: number,
  b: number,
  r: number,
  batch: number,
): Promise<GpuKernel> {
  return GpuKernel.create(device, params, n, b, r, batch);
}
