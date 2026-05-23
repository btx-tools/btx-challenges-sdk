import type { BtxChallengeClient } from './client.js';
import { solveJs, type SolveJsOptions } from './matmul/pow.js';
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
 * - `'auto'` — pick automatically: `'rpc'` if `opts.rpcClient` is provided,
 *   else `'wasm'` if `@btx-tools/matmul-wasm` is installed, else `'pure-js'`.
 */
export type SolverMode = 'rpc' | 'pure-js' | 'wasm' | 'auto';

/** Options forwarded to the WASM solver (`Solver.solve` with `mode: 'wasm'`). */
export interface WasmSolveOptions {
  /** Max nonces to try before giving up. Default 1_000_000. */
  maxTries?: number;
  /** Override the starting nonce (default: challenge.header_context.nonce64_start). */
  nonceStart?: bigint;
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
      case 'wasm':
        return solveViaWasm(challenge, opts);
      case 'pure-js':
        return solveViaPureJs(challenge, opts);
      case 'auto': {
        // rpc (if a node is reachable) → wasm (if the kernel is usable) → pure-js.
        if (opts.rpcClient) return solveViaRpc(challenge, opts);
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
  } catch {
    cachedLoad = { kind: 'absent' };
    return cachedLoad;
  }
  try {
    cachedLoad = { kind: 'ok', Ctor: await resolveWasmCtor(mod) };
  } catch (cause) {
    cachedLoad = { kind: 'init-failed', cause };
  }
  return cachedLoad;
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
