/**
 * WASM solver worker (Phase 2). Loads the `@btx-tools/matmul-wasm` kernel and
 * runs one strided `solve_chunk` per message. Each worker is an independent
 * WASM instance (workers don't share memory) — the pool's parallelism is across
 * worker threads, not shared state.
 */
import init, { WasmSolver } from '@btx-tools/matmul-wasm';
import wasmUrl from '@btx-tools/matmul-wasm/btx_challenges_wasm_bg.wasm?url';

export interface SolveRequest {
  jobId: number;
  k: number; // worker index (strided residue)
  stride: number; // = N (pool size)
  maxTries: number;
  challenge: {
    version: number;
    prevhash: string;
    merkleroot: string;
    time: number;
    bits: string;
    n: number;
    b: number;
    r: number;
    seedA: string;
    seedB: string;
    target: string;
  };
}

const ready = init(wasmUrl);

self.onmessage = async (e: MessageEvent<SolveRequest>) => {
  await ready;
  const { jobId, k, stride, maxTries, challenge: c } = e.data;
  const solver = new WasmSolver(
    c.version,
    c.prevhash,
    c.merkleroot,
    c.time,
    c.bits,
    c.n,
    c.b,
    c.r,
    c.seedA,
    c.seedB,
    c.target,
  );
  const t0 = performance.now();
  const sol = solver.solve_chunk(BigInt(k), BigInt(stride), BigInt(maxTries));
  const ms = performance.now() - t0;
  self.postMessage({
    jobId,
    k,
    ms,
    found: sol ? { nonce: sol.nonce_hex, digest: sol.digest_hex } : null,
  });
};
