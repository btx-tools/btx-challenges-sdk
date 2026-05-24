/**
 * Solve backends — selected **once** (`webgpu → wasm → pure-js`), then a single
 * solver is reused across the many nonce chunks of a job. (Going through the SDK's
 * per-call `Solver.solve` would re-acquire the GPU device + rebuild pipelines every
 * chunk; mining is sustained, so we build the kernel once per job.)
 *
 * Optional deps (`@btx-tools/matmul-webgpu`, `@btx-tools/matmul-wasm`) are loaded
 * via variable-specifier dynamic import so bundlers treat them as runtime-only; if
 * absent/uninitializable, selection falls through. pure-js (via the SDK `Solver`)
 * is always available.
 */
import { solveJs, validateMatmulParams, type Challenge } from '@btx-tools/challenges-sdk';

/** A found share (the kernel/Solver output shape, narrowed). */
export interface FoundShare {
  nonce_hex: string;
  digest_hex: string;
}

/** A solver bound to one job's challenge; searched in bounded chunks. */
export interface SolveSession {
  /** A natural chunk size (≈ one GPU dispatch) — fine preemption/throttle granularity. */
  readonly suggestedChunk: number;
  /** Search nonces `[nonceStart, nonceStart+count)`; resolve the first hit or `undefined`. */
  searchChunk(nonceStart: bigint, count: number): Promise<FoundShare | undefined>;
  /** Release the session's solver/GPU resources. */
  destroy(): void;
}

export type BackendName = 'webgpu' | 'wasm' | 'pure-js';

/** A selected backend. `forJob` builds the reusable per-job session. */
export interface SolveBackend {
  readonly name: BackendName;
  forJob(challenge: Challenge): Promise<SolveSession>;
  /** Release backend-wide resources (e.g. the GPU device). */
  dispose?(): void;
}

/** The 11 positional kernel args (identical to the SDK's `WasmSolverArgs`). */
type KernelArgs = [
  number,
  string,
  string,
  number,
  string,
  number,
  number,
  number,
  string,
  string,
  string,
];

/**
 * Map a challenge envelope to the kernel's positional args. Mirrors the SDK's
 * `challengeToWasmArgs`: runs `validateMatmulParams` (n/b/r bounds) **and** the
 * **C-1 seed/dim guard** (the kernels + btxd use one seed/dim for both the seed
 * matrices and the header sigma; a divergence yields an un-redeemable share) —
 * so this rejects exactly what the SDK rejects, at the SDK boundary.
 */
export function challengeToArgs(challenge: Challenge): KernelArgs {
  const payload = challenge.challenge;
  const ctx = payload.header_context;
  const { n, b, r, seed_a, seed_b } = payload.matmul;
  validateMatmulParams(n, b, r); // bounds parity with challengeToWasmArgs (n≤4096, r≤256, b|n, …)
  if (ctx.seed_a !== seed_a || ctx.seed_b !== seed_b || ctx.matmul_dim !== n) {
    throw new Error(
      'browser-miner: challenge header_context.{seed_a,seed_b,matmul_dim} must equal ' +
        'matmul.{seed_a,seed_b,n} — they differ, which would produce an un-redeemable share.',
    );
  }
  return [
    ctx.version,
    ctx.previousblockhash,
    ctx.merkleroot,
    ctx.time,
    ctx.bits,
    n,
    b,
    r,
    seed_a,
    seed_b,
    payload.target,
  ];
}

// ── optional-dep module shapes (structural — no build-time dep) ──────────────
interface WebGpuSolverHandle {
  readonly batchSize?: number;
  solveChunk(nonceStart: bigint, stride: bigint, maxTries: bigint): Promise<FoundShare | undefined>;
  destroy(): void;
}
type WebGpuFactory = (
  ...args: [...KernelArgs, { device?: unknown; batchSize?: number }?]
) => Promise<WebGpuSolverHandle>;
interface WasmSolution {
  readonly nonce_hex: string;
  readonly digest_hex: string;
}
interface WasmSolverInstance {
  solve_chunk(nonceStart: bigint, stride: bigint, maxTries: bigint): WasmSolution | undefined;
}
type WasmSolverCtor = new (...args: KernelArgs) => WasmSolverInstance;

function navigatorGpu(): GPU | undefined {
  return typeof navigator !== 'undefined' ? (navigator as { gpu?: GPU }).gpu : undefined;
}

/** Try to build the WebGPU backend (acquires one device, reused across jobs). */
async function tryWebGpu(): Promise<SolveBackend | null> {
  const gpu = navigatorGpu();
  if (!gpu) return null;
  let mod: { createWebGpuSolver?: unknown; default?: { createWebGpuSolver?: unknown } };
  try {
    const spec = '@btx-tools/matmul-webgpu';
    mod = await import(spec);
  } catch {
    return null;
  }
  const create = (mod.createWebGpuSolver ?? mod.default?.createWebGpuSolver) as
    | WebGpuFactory
    | undefined;
  if (typeof create !== 'function') return null;
  let device: GPUDevice;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    device = await adapter.requestDevice();
  } catch {
    return null;
  }
  return {
    name: 'webgpu',
    async forJob(challenge: Challenge): Promise<SolveSession> {
      const solver = await create(...challengeToArgs(challenge), { device });
      return {
        suggestedChunk: solver.batchSize ?? 256,
        searchChunk: (nonceStart, count) => solver.solveChunk(nonceStart, 1n, BigInt(count)),
        destroy: () => solver.destroy(),
      };
    },
    dispose: () => device.destroy(),
  };
}

/** Try to build the WASM backend (per-job `WasmSolver`). */
async function tryWasm(): Promise<SolveBackend | null> {
  let mod: { WasmSolver?: unknown; default?: unknown };
  try {
    const spec = '@btx-tools/matmul-wasm';
    mod = await import(spec);
  } catch {
    return null;
  }
  // web target ships an async init() default export; run it if present.
  if (typeof mod.default === 'function') {
    try {
      await (mod.default as () => Promise<unknown>)();
    } catch {
      return null;
    }
  }
  const Ctor = (mod.WasmSolver ??
    (mod.default as { WasmSolver?: unknown } | undefined)?.WasmSolver) as
    | WasmSolverCtor
    | undefined;
  if (typeof Ctor !== 'function') return null;
  return {
    name: 'wasm',
    async forJob(challenge: Challenge): Promise<SolveSession> {
      const solver = new Ctor(...challengeToArgs(challenge));
      return {
        suggestedChunk: 4096,
        async searchChunk(nonceStart, count): Promise<FoundShare | undefined> {
          const sol = solver.solve_chunk(nonceStart, 1n, BigInt(count));
          return sol ? { nonce_hex: sol.nonce_hex, digest_hex: sol.digest_hex } : undefined;
        },
        destroy() {},
      };
    },
  };
}

/** The always-available pure-JS backend (via the SDK's `solveJs`). */
export function pureJsBackend(): SolveBackend {
  return {
    name: 'pure-js',
    async forJob(challenge: Challenge): Promise<SolveSession> {
      // Validate the mapping (bounds + C-1 guard) up front so a bad envelope
      // fails loud rather than silently never finding a share.
      challengeToArgs(challenge);
      return {
        suggestedChunk: 512,
        async searchChunk(nonceStart, count): Promise<FoundShare | undefined> {
          // solveJs returns null on exhaustion (no exception/message coupling); a
          // malformed envelope throws synchronously and propagates (surfaced via onError).
          const out = solveJs(challenge, { nonceStart, maxTries: count });
          return out ? { nonce_hex: out.nonce64_hex, digest_hex: out.digest_hex } : undefined;
        },
        destroy() {},
      };
    },
  };
}

/**
 * Select a backend once: `webgpu → wasm → pure-js` (or honor `opts.prefer`, still
 * falling back to pure-js so mining always works). Acquires the GPU device up
 * front when webgpu is chosen.
 */
export async function selectBackend(opts: { prefer?: BackendName } = {}): Promise<SolveBackend> {
  const { prefer } = opts;
  if (prefer === 'pure-js') return pureJsBackend();
  if (prefer === 'wasm') return (await tryWasm()) ?? pureJsBackend();
  // 'webgpu' or auto: webgpu → wasm → pure-js
  return (await tryWebGpu()) ?? (await tryWasm()) ?? pureJsBackend();
}
