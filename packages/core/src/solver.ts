import type { BtxChallengeClient } from './client.js';
import { solveJs, validateMatmulParams, type SolveJsOptions } from './matmul/pow.js';
import type { Challenge, SolverOutput } from './types.js';

/**
 * How a challenge should be solved.
 *
 * Solving is the costly half of the protocol — it needs either a reachable
 * **btxd** node (`'rpc'`), the optional WASM kernel (`'wasm'`), or a lot of
 * local CPU time (`'pure-js'`). See {@link Solver.solve} for the node
 * prerequisite and who runs what.
 *
 * - `'rpc'` — delegate to btxd's `solvematmulservicechallenge`. Requires
 *   `opts.rpcClient` pointed at a **non-mining** btxd. Server-side / Node-only.
 *   Fast (~1–4 s) — the production path.
 *
 * - `'wasm'` — solve locally with the optional
 *   [`@btx-tools/matmul-wasm`](https://github.com/btx-tools/btx-challenges-wasm)
 *   kernel (byte-identical proof to `'pure-js'`, ~24× faster). No node required.
 *   The published build targets **browsers/bundlers** (Vite, Next, Workers); in
 *   **plain Node**, build the package's `nodejs` target from source or solve via
 *   `'rpc'`. Throws a clear, distinct error if the package isn't installed vs
 *   installed-but-uninitializable-here. Still **far slower than native** at the
 *   production `n=512` (a browser pool floor is ~16 s) — great for browser/edge
 *   solving without a btxd, not a casual per-request browser captcha.
 *
 * - `'pure-js'` — solve locally with a pure-TypeScript MatMul implementation.
 *   No node and no optional package required, browser-compatible. **Slow**:
 *   bounded by `BigInt`-based M31 multiplication. Prefer `'wasm'` when the
 *   kernel is installed; solve server-side via `'rpc'` at production difficulty.
 *
 * - `'webgpu'` — solve locally on the GPU with the optional
 *   [`@btx-tools/matmul-webgpu`](https://www.npmjs.com/package/@btx-tools/matmul-webgpu)
 *   kernel (byte-identical proof to `'pure-js'`/`'wasm'`). Requires a WebGPU
 *   runtime (`navigator.gpu`) — browsers, Deno `--unstable-webgpu`, or a
 *   caller-supplied `opts.webgpu.device`. Throws a clear, distinct error if
 *   WebGPU is unavailable here or the package isn't installed. Far faster than
 *   `'wasm'`/`'pure-js'` per attempt; the production path for in-browser solving
 *   (admission) and browser mining. Still bounded by browser GPU + network
 *   difficulty — not free money (see the package README).
 *
 * - `'auto'` — pick automatically: `'rpc'` if `opts.rpcClient` is provided, else
 *   `'webgpu'` if WebGPU + `@btx-tools/matmul-webgpu` are available, else
 *   `'wasm'` if `@btx-tools/matmul-wasm` is installed, else `'pure-js'`. Once a
 *   local kernel is selected, its solve errors surface — there is no second
 *   fallback (a bad-input/range error would just re-throw on the next kernel).
 */
export type SolverMode = 'rpc' | 'pure-js' | 'wasm' | 'webgpu' | 'auto';

/** Options forwarded to the WASM solver (`Solver.solve` with `mode: 'wasm'`). */
export interface WasmSolveOptions {
  /** Max nonces to try before giving up. Default 1_000_000. */
  maxTries?: number;
  /** Override the starting nonce (default: challenge.header_context.nonce64_start). */
  nonceStart?: bigint;
}

/** Options forwarded to the WebGPU solver (`Solver.solve` with `mode: 'webgpu'`). */
export interface WebGpuSolveOptions {
  /** Max nonces to try before giving up. Default 1_000_000 (must keep the range within [0, 2³²)). */
  maxTries?: number;
  /** Override the starting nonce (default: challenge.header_context.nonce64_start). */
  nonceStart?: bigint;
  /** Provide a `GPUDevice` (e.g. plain Node with a polyfill, or to reuse one). Default: `navigator.gpu`. */
  device?: unknown;
  /** Nonces per GPU batch. Default: auto-clamped from `device.limits` and `n`. */
  batchSize?: number;
}

/** Options for {@link Solver.solve}. */
export interface SolverOptions {
  /**
   * Solve strategy. Default: `'auto'` (rpc if client provided, else wasm if
   * `@btx-tools/matmul-wasm` is installed, else pure-js).
   */
  mode?: SolverMode;
  /** Required for `mode === 'rpc'`. Ignored otherwise. */
  rpcClient?: BtxChallengeClient;
  /** Forwarded to the pure-JS solver. Ignored for other modes. */
  pureJs?: SolveJsOptions;
  /** Forwarded to the WASM solver. Ignored for other modes. */
  wasm?: WasmSolveOptions;
  /** Forwarded to the WebGPU solver. Ignored for other modes. */
  webgpu?: WebGpuSolveOptions;
}

/**
 * Solve a BTX service challenge to produce a (nonce, digest, proof) tuple
 * that btxd will accept on redemption.
 *
 * **Modes**:
 *  - `'rpc'`: delegate to btxd's `solvematmulservicechallenge` RPC. Pass an
 *    authenticated `BtxChallengeClient` in `opts.rpcClient`. **Production
 *    note**: the solve RPC shares the matmul backend with block-template
 *    mining; consumers MUST point at a dedicated non-mining btxd, otherwise
 *    individual solves can queue behind mining work for 10+ minutes.
 *  - `'wasm'`: solve locally with the optional `@btx-tools/matmul-wasm` kernel —
 *    byte-identical proof to `'pure-js'`, ~24× faster. Throws a clear error if
 *    the package isn't installed. No node required.
 *  - `'pure-js'`: solve locally with the ported TypeScript MatMul. Browser-
 *    compatible, no optional package. Slower than `'rpc'`/`'wasm'`.
 *  - `'auto'`: prefers `'rpc'` if a client is provided, else `'wasm'` if the
 *    kernel is installed, else `'pure-js'`.
 *
 * @example Server-side (Node, RPC mode)
 * ```typescript
 * import { BtxChallengeClient, Solver } from '@btx-tools/challenges-sdk';
 *
 * const client = new BtxChallengeClient({
 *   rpcUrl: 'http://127.0.0.1:19332',
 *   rpcAuth: { user: 'rpcuser', pass: 'rpcpass' },
 * });
 *
 * const challenge = await client.issue({
 *   purpose: 'ai_inference_gate',
 *   resource: 'model:gpt-x|route:/v1/generate',
 *   subject: 'tenant:abc123',
 * });
 *
 * const proof = await Solver.solve(challenge, { mode: 'rpc', rpcClient: client });
 * const result = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
 *
 * if (result.valid && result.reason === 'ok') {
 *   // Admit the caller.
 * }
 * ```
 *
 * @example Browser-side (pure-JS mode)
 * ```typescript
 * import { Solver } from '@btx-tools/challenges-sdk';
 *
 * // Solve a challenge with no server-side help. Slow at default difficulty;
 * // for production browser use cases, calibrate via `target_solve_time_s`.
 * const proof = await Solver.solve(challenge, {
 *   mode: 'pure-js',
 *   pureJs: { maxTries: 100_000 },
 * });
 * ```
 *
 * @example No-node, faster (WASM mode — install `@btx-tools/matmul-wasm`)
 * ```typescript
 * import { Solver } from '@btx-tools/challenges-sdk';
 *
 * // ~24× the pure-JS kernel; byte-identical proof. Great for server/edge
 * // solving without a btxd. (`'auto'` uses it automatically when installed.)
 * const proof = await Solver.solve(challenge, {
 *   mode: 'wasm',
 *   wasm: { maxTries: 1_000_000 },
 * });
 * ```
 */
export class Solver {
  static async solve(challenge: Challenge, opts: SolverOptions = {}): Promise<SolverOutput> {
    const mode: SolverMode = opts.mode ?? 'auto';

    switch (mode) {
      case 'rpc':
        return solveViaRpc(challenge, opts);
      case 'webgpu':
        return solveViaWebGpu(challenge, opts);
      case 'wasm':
        return solveViaWasm(challenge, opts);
      case 'pure-js':
        return solveViaPureJs(challenge, opts);
      case 'auto': {
        // rpc (if a node is reachable) → webgpu (if GPU + kernel) → wasm (if kernel) → pure-js.
        if (opts.rpcClient) return solveViaRpc(challenge, opts);
        if (hasWebGpu()) {
          const gpu = await loadWebGpu();
          if (gpu.kind === 'ok') return solveWithWebGpuFactory(challenge, gpu.create, opts.webgpu);
        }
        const load = await loadWasm();
        if (load.kind === 'ok') return solveWithWasmCtor(challenge, load.Ctor, opts.wasm);
        return solveViaPureJs(challenge, opts);
      }
      default: {
        // Exhaustiveness guard — unreachable if SolverMode is the source of truth.
        const _exhaustive: never = mode;
        throw new Error(`Solver.solve: unknown mode "${_exhaustive as string}"`);
      }
    }
  }
}

async function solveViaRpc(challenge: Challenge, opts: SolverOptions): Promise<SolverOutput> {
  if (!opts.rpcClient) {
    throw new Error(
      'Solver.solve: mode="rpc" requires opts.rpcClient. ' +
        'Construct a BtxChallengeClient and pass it via opts.rpcClient.',
    );
  }
  return opts.rpcClient.solve(challenge);
}

async function solveViaPureJs(challenge: Challenge, opts: SolverOptions): Promise<SolverOutput> {
  const result = solveJs(challenge, opts.pureJs);
  if (result === null) {
    const tries = opts.pureJs?.maxTries ?? 1_000_000;
    throw new Error(
      `Solver.solve: pure-JS solver exhausted maxTries=${tries} without finding a proof. ` +
        'Increase maxTries or lower challenge difficulty (target_solve_time_s).',
    );
  }
  return result;
}

// ----------------------------------------------------------------------------
// WASM solver (optional @btx-tools/matmul-wasm)
// ----------------------------------------------------------------------------

/** The ordered `WasmSolver` constructor arguments (see `@btx-tools/matmul-wasm`). */
export type WasmSolverArgs = [
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
];

/** Minimal structural shape of the optional `@btx-tools/matmul-wasm` exports. */
interface WasmSolution {
  readonly nonce_hex: string;
  readonly digest_hex: string;
}
interface WasmSolver {
  solve_chunk(nonceStart: bigint, stride: bigint, maxTries: bigint): WasmSolution | undefined;
}
/** Constructor of `@btx-tools/matmul-wasm`'s `WasmSolver`. */
export interface WasmSolverCtor {
  new (...args: WasmSolverArgs): WasmSolver;
}

/**
 * Map a challenge envelope to `WasmSolver`'s positional constructor arguments.
 * Header fields come from `header_context`; matmul params + seeds from `matmul`.
 *
 * **Invariant guard (audit C-1):** the pure-JS reference reads the A/B seed
 * matrices from `matmul.{seed_a,seed_b}`/`matmul.n` but the per-nonce header
 * sigma from `header_context.{seed_a,seed_b,matmul_dim}`. The Rust kernel takes
 * a *single* seed/dim used for **both**. btxd populates the two sources
 * identically, so the WASM proof is byte-identical to `solveJs` — but rather
 * than silently emit a divergent (un-redeemable) proof if they ever differ,
 * this throws. Callers can fall back to `mode: 'pure-js'` / `'rpc'`.
 */
export function challengeToWasmArgs(challenge: Challenge): WasmSolverArgs {
  const payload = challenge.challenge;
  const ctx = payload.header_context;
  const { n, b, r, seed_a, seed_b } = payload.matmul;
  // Audit M-1: bound-check before handing n/b/r to the kernel (the WASM kernel
  // also guards internally, but this gives a clear error at the SDK boundary and
  // keeps pure-JS / WASM rejecting the same inputs).
  validateMatmulParams(n, b, r);
  if (ctx.seed_a !== seed_a || ctx.seed_b !== seed_b || ctx.matmul_dim !== n) {
    throw new Error(
      'Solver.solve: mode="wasm" requires header_context.{seed_a,seed_b,matmul_dim} to equal ' +
        'matmul.{seed_a,seed_b,n} (the WASM kernel uses one seed/dim for both the seed matrices ' +
        'and the header). This challenge has them differing — use mode "pure-js" or "rpc".',
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

/**
 * Solve with a provided `WasmSolver` constructor (single-threaded, stride 1).
 * Pooling is an environment concern (Web Workers / worker_threads) and is left
 * to consumers — see the SDK's `examples/03-browser-solver` for an N-worker pool.
 * Exposed for tests; production calls go through {@link Solver.solve}.
 */
export function solveWithWasmCtor(
  challenge: Challenge,
  Ctor: WasmSolverCtor,
  opts: WasmSolveOptions = {},
): SolverOutput {
  const solver = new Ctor(...challengeToWasmArgs(challenge));
  const nonceStart =
    opts.nonceStart ?? BigInt(challenge.challenge.header_context.nonce64_start ?? 0);
  const maxTries = BigInt(opts.maxTries ?? 1_000_000);
  const sol = solver.solve_chunk(nonceStart, 1n, maxTries);
  if (!sol) {
    throw new Error(
      `Solver.solve: wasm solver exhausted maxTries=${maxTries} without finding a proof. ` +
        'Increase maxTries or lower challenge difficulty (target_solve_time_s).',
    );
  }
  const nonce64_hex = sol.nonce_hex;
  const digest_hex = sol.digest_hex;
  // Same proof shape as solveJs / btxd's solve RPC: {challenge, nonce64_hex, digest_hex}.
  return { nonce64_hex, digest_hex, proof: { challenge, nonce64_hex, digest_hex } };
}

/** Outcome of probing the optional `@btx-tools/matmul-wasm` kernel. */
type WasmLoad =
  | { kind: 'ok'; Ctor: WasmSolverCtor }
  | { kind: 'absent' } // package not installed / not resolvable
  | { kind: 'init-failed'; cause: unknown }; // installed, but init() threw or no ctor

/**
 * Resolve a `WasmSolver` constructor from an already-imported module, running
 * the `web` target's async `init()` if present. Separated from the import so it
 * is unit-testable with synthetic module shapes. Throws if the module can't
 * yield a usable constructor (init threw, or no `WasmSolver` export).
 *
 * **Node caveat (audit V-1):** the published build targets the `web` wasm-pack
 * shape, whose `init()` resolves the `.wasm` via `import.meta.url` — works in
 * browsers/bundlers (Vite, Next, Workers), but in **plain Node** that fetch
 * fails. Plain-Node consumers should build the package's `nodejs` target from
 * source or solve via `mode: 'rpc'`. Exposed for tests.
 */
export async function resolveWasmCtor(mod: unknown): Promise<WasmSolverCtor> {
  const m = mod as { default?: unknown; WasmSolver?: unknown };
  if (typeof m.default === 'function') {
    await (m.default as () => Promise<unknown>)();
  }
  const fromDefault = (m.default as { WasmSolver?: unknown } | undefined)?.WasmSolver;
  const Ctor = m.WasmSolver ?? fromDefault;
  if (typeof Ctor !== 'function') {
    throw new Error('@btx-tools/matmul-wasm did not export a WasmSolver constructor');
  }
  return Ctor as WasmSolverCtor;
}

// Memoized probe (audit H-1): `undefined` = not yet probed. Kept at module scope
// so `'auto'` attempts the optional import at most once per process.
let cachedLoad: WasmLoad | undefined;

/**
 * Best-effort load of the optional kernel. Distinguishes `absent` (not
 * installed → `'auto'` falls through to pure-js) from `init-failed` (installed
 * but unusable in this environment) so the explicit-mode error can be accurate.
 * The specifier is held in a variable so the bundler/`tsc` treat it as a
 * runtime-only dependency, never a build-time one.
 */
async function loadWasm(): Promise<WasmLoad> {
  if (cachedLoad !== undefined) return cachedLoad;
  const spec = '@btx-tools/matmul-wasm';
  let mod: unknown;
  try {
    mod = await import(spec);
  } catch (err) {
    // L-5 (audit 2026-05-24): only a genuine "not installed" is permanent (cache
    // it). Any other import error (transient loader/FS hiccup) is left UNcached
    // so a later call retries instead of being stuck on pure-js forever.
    const code = (err as { code?: unknown })?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      cachedLoad = { kind: 'absent' };
      return cachedLoad;
    }
    return { kind: 'absent' };
  }
  try {
    const ok: WasmLoad = { kind: 'ok', Ctor: await resolveWasmCtor(mod) };
    cachedLoad = ok; // success is permanent
    return ok;
  } catch (cause) {
    // init-failed left UNcached (retryable) — the import succeeded, so this is
    // either a transient init issue or web-target-in-Node (re-probed each call,
    // cheap: the module is runtime-cached, only init() re-runs).
    return { kind: 'init-failed', cause };
  }
}

async function solveViaWasm(challenge: Challenge, opts: SolverOptions): Promise<SolverOutput> {
  const load = await loadWasm();
  if (load.kind === 'ok') return solveWithWasmCtor(challenge, load.Ctor, opts.wasm);
  if (load.kind === 'absent') {
    throw new Error(
      'Solver.solve: mode="wasm" requires the optional @btx-tools/matmul-wasm package. ' +
        'Install it (e.g. `npm i @btx-tools/matmul-wasm`), or use mode "rpc" / "pure-js".',
    );
  }
  // init-failed: installed, but couldn't initialize in this environment.
  const cause = load.cause instanceof Error ? load.cause.message : String(load.cause);
  throw new Error(
    'Solver.solve: mode="wasm" found @btx-tools/matmul-wasm but could not initialize it here. ' +
      'The published build targets browsers/bundlers (Vite, Next, Workers); in plain Node, build ' +
      `the package's nodejs target from source or use mode "rpc" / "pure-js". (cause: ${cause})`,
  );
}

// ----------------------------------------------------------------------------
// WebGPU solver (optional @btx-tools/matmul-webgpu)
// ----------------------------------------------------------------------------

/** Minimal structural shape of `@btx-tools/matmul-webgpu`'s solution. */
interface WebGpuSolution {
  readonly nonce_hex: string;
  readonly digest_hex: string;
}
/** Construction knobs forwarded to the kernel's `init` (typed loosely — optional dep). */
interface WebGpuInit {
  device?: unknown;
  batchSize?: number;
}
/** A configured WebGPU solver handle (see `@btx-tools/matmul-webgpu`'s `WebGpuSolver`). */
interface WebGpuSolverHandle {
  solveChunk(
    nonceStart: bigint,
    stride: bigint,
    maxTries: bigint,
  ): Promise<WebGpuSolution | undefined>;
  destroy(): void;
}
/**
 * `@btx-tools/matmul-webgpu`'s `createWebGpuSolver`. Takes the **same positional
 * args as {@link WasmSolverArgs}** (so {@link challengeToWasmArgs} maps both), plus
 * an optional `init`, and resolves to a handle. Async — WebGPU device acquisition is async.
 */
export type WebGpuFactory = (
  ...args: [...WasmSolverArgs, WebGpuInit?]
) => Promise<WebGpuSolverHandle>;

/** Is a WebGPU runtime present in this environment? */
function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as { gpu?: unknown }).gpu;
}

/**
 * Resolve `createWebGpuSolver` from an already-imported module (named export or
 * `default.createWebGpuSolver`, mirroring {@link resolveWasmCtor}). Throws if the
 * module can't yield the factory. Exposed for tests.
 */
export function resolveWebGpuFactory(mod: unknown): WebGpuFactory {
  const m = mod as { default?: unknown; createWebGpuSolver?: unknown };
  const fromDefault = (m.default as { createWebGpuSolver?: unknown } | undefined)
    ?.createWebGpuSolver;
  const fn = m.createWebGpuSolver ?? fromDefault;
  if (typeof fn !== 'function') {
    throw new Error('@btx-tools/matmul-webgpu did not export a createWebGpuSolver function');
  }
  return fn as WebGpuFactory;
}

/**
 * Solve with a provided factory. Maps the challenge via {@link challengeToWasmArgs}
 * (reusing its C-1 seed/dim guard), runs a single chunk, and **always
 * `destroy()`s** the GPU resources. Exposed for tests; production goes through
 * {@link Solver.solve}.
 */
export async function solveWithWebGpuFactory(
  challenge: Challenge,
  create: WebGpuFactory,
  opts: WebGpuSolveOptions = {},
): Promise<SolverOutput> {
  const args = challengeToWasmArgs(challenge);
  const init: WebGpuInit = {};
  if (opts.device !== undefined) init.device = opts.device;
  if (opts.batchSize !== undefined) init.batchSize = opts.batchSize;
  const solver = await create(...args, init);
  try {
    const nonceStart =
      opts.nonceStart ?? BigInt(challenge.challenge.header_context.nonce64_start ?? 0);
    const maxTries = BigInt(opts.maxTries ?? 1_000_000);
    const sol = await solver.solveChunk(nonceStart, 1n, maxTries);
    if (!sol) {
      throw new Error(
        `Solver.solve: webgpu solver exhausted maxTries=${maxTries} without finding a proof. ` +
          'Increase maxTries or lower challenge difficulty (target_solve_time_s).',
      );
    }
    const { nonce_hex, digest_hex } = sol;
    return {
      nonce64_hex: nonce_hex,
      digest_hex,
      proof: { challenge, nonce64_hex: nonce_hex, digest_hex },
    };
  } finally {
    solver.destroy();
  }
}

/** Outcome of probing the optional `@btx-tools/matmul-webgpu` kernel. */
type WebGpuLoad =
  | { kind: 'ok'; create: WebGpuFactory }
  | { kind: 'absent' }
  | { kind: 'init-failed'; cause: unknown };

// Memoized probe (mirrors loadWasm's cache discipline).
let cachedWebGpuLoad: WebGpuLoad | undefined;

async function loadWebGpu(): Promise<WebGpuLoad> {
  if (cachedWebGpuLoad !== undefined) return cachedWebGpuLoad;
  const spec = '@btx-tools/matmul-webgpu';
  let mod: unknown;
  try {
    mod = await import(spec);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      cachedWebGpuLoad = { kind: 'absent' }; // genuine "not installed" is permanent
      return cachedWebGpuLoad;
    }
    return { kind: 'absent' }; // transient import error left uncached (retryable)
  }
  try {
    const ok: WebGpuLoad = { kind: 'ok', create: resolveWebGpuFactory(mod) };
    cachedWebGpuLoad = ok; // success is permanent
    return ok;
  } catch (cause) {
    return { kind: 'init-failed', cause }; // installed but no factory export — uncached
  }
}

async function solveViaWebGpu(challenge: Challenge, opts: SolverOptions): Promise<SolverOutput> {
  if (!hasWebGpu() && opts.webgpu?.device === undefined) {
    throw new Error(
      'Solver.solve: mode="webgpu" needs a WebGPU runtime (navigator.gpu) or opts.webgpu.device. ' +
        'None available here — use mode "rpc" / "wasm" / "pure-js", or run in a WebGPU-capable environment.',
    );
  }
  const load = await loadWebGpu();
  if (load.kind === 'ok') return solveWithWebGpuFactory(challenge, load.create, opts.webgpu);
  if (load.kind === 'absent') {
    throw new Error(
      'Solver.solve: mode="webgpu" requires the optional @btx-tools/matmul-webgpu package. ' +
        'Install it (e.g. `npm i @btx-tools/matmul-webgpu`), or use mode "rpc" / "wasm" / "pure-js".',
    );
  }
  const cause = load.cause instanceof Error ? load.cause.message : String(load.cause);
  throw new Error(
    'Solver.solve: mode="webgpu" found @btx-tools/matmul-webgpu but could not initialize it here. ' +
      `(cause: ${cause})`,
  );
}
