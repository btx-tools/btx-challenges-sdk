/**
 * Phase-2 browser benchmark for the WASM matmul solver.
 *
 * Runs three things and writes results to #out (so Playwright can read them):
 *   1. correctness — n=8 fixture through the WASM in a worker; must reproduce
 *      the pinned nonce/digest (byte-exact, in-browser).
 *   2. micro — per-attempt cost at production n=512 (1 worker, impossible
 *      target, fixed attempt count → ms/attempt).
 *   3. pool — a real pooled solve at n=512 (N workers, loose target) → the
 *      end-to-end wall-clock for an actual solution.
 *
 * NOT a production captcha. Floor-difficulty, hashcash-grade only.
 */
import type { SolveRequest } from './wasm-solver.worker.ts';

const out = document.getElementById('out') as HTMLPreElement;
const log = (s: string) => {
  out.textContent += s + '\n';
};

// Shared header fields (only n/b/r/target vary between jobs).
const HEADER = {
  version: 1,
  prevhash: '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210',
  merkleroot: 'fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef',
  time: 1700000000,
  bits: '1d00ffff',
  seedA: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  seedB: 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100',
};
const ff = (lead: string) => lead + 'ff'.repeat(31);
const ZERO = '00'.repeat(32);

interface Reply {
  jobId: number;
  k: number;
  ms: number;
  found: { nonce: string; digest: string } | null;
}

function spawn(): Worker {
  return new Worker(new URL('./wasm-solver.worker.ts', import.meta.url), { type: 'module' });
}

/** Run one job on a fresh worker, resolve with its reply, then terminate it. */
function runOne(req: SolveRequest): Promise<Reply> {
  return new Promise((resolve) => {
    const w = spawn();
    w.onmessage = (e: MessageEvent<Reply>) => {
      w.terminate();
      resolve(e.data);
    };
    w.postMessage(req);
  });
}

/** N strided workers; first to report a solution wins, the rest are terminated. */
function runPool(
  challenge: SolveRequest['challenge'],
  n: number,
  maxTries: number,
): Promise<{ ms: number; found: Reply['found']; k: number }> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const workers: Worker[] = [];
    let done = false;
    for (let k = 0; k < n; k++) {
      const w = spawn();
      workers.push(w);
      w.onmessage = (e: MessageEvent<Reply>) => {
        if (done || !e.data.found) return;
        done = true;
        const ms = performance.now() - t0;
        workers.forEach((x) => x.terminate());
        resolve({ ms, found: e.data.found, k: e.data.k });
      };
      w.postMessage({ jobId: 2, k, stride: n, maxTries, challenge });
    }
  });
}

async function main() {
  const N = Math.min(Math.max(navigator.hardwareConcurrency || 4, 2), 8);
  log(`ua: ${navigator.userAgent}`);
  log(`hardwareConcurrency=${navigator.hardwareConcurrency} → pool N=${N}`);
  log('');

  // 1. Correctness (n=8) — byte-exact in-browser.
  const c8: SolveRequest['challenge'] = { ...HEADER, n: 8, b: 4, r: 2, target: ff('03') };
  const r8 = await runOne({ jobId: 0, k: 0, stride: 1, maxTries: 1000, challenge: c8 });
  const okN = r8.found?.nonce === '0000000000000007';
  const okD =
    r8.found?.digest === '03245d6fa3c749ae50ef90231a180fc970d3a5ad0e23ae1f51a4d95e49f81cf9';
  log(`[correctness] n=8 nonce=${r8.found?.nonce} digest=${r8.found?.digest?.slice(0, 16)}…`);
  log(`[correctness] ${okN && okD ? 'PASS — byte-exact in browser ✓' : 'FAIL ✗'}`);
  log('');

  // 2. Micro per-attempt cost at n=512 (impossible target → runs all attempts).
  const ATT = 8;
  const c512: SolveRequest['challenge'] = { ...HEADER, n: 512, b: 16, r: 8, target: ZERO };
  log(`[micro] n=512 b=16 r=8 — timing ${ATT} attempts (single worker)…`);
  const rMicro = await runOne({ jobId: 1, k: 0, stride: 1, maxTries: ATT, challenge: c512 });
  const perAttempt = rMicro.ms / ATT;
  const single = 1000 / perAttempt;
  log(`[micro] per-attempt = ${perAttempt.toFixed(1)} ms  (single ≈ ${single.toFixed(1)} att/s)`);
  log(`[throughput] pool(${N}) ≈ ${(single * N).toFixed(1)} att/s`);
  for (const A of [100, 770, 5000]) {
    const sec = ((Math.ceil(A / N) * perAttempt) / 1000).toFixed(1);
    log(`[projection] ~${A} attempts @ pool(${N}) ≈ ${sec} s`);
  }
  log('');

  // 3. Real pooled solve at n=512 (loose target ~1/4 so it finishes fast).
  const c512loose: SolveRequest['challenge'] = { ...HEADER, n: 512, b: 16, r: 8, target: ff('3f') };
  log(`[pool-solve] n=512 loose target, ${N} workers…`);
  const rp = await runPool(c512loose, N, 512);
  log(
    `[pool-solve] found by worker ${rp.k}: nonce=${rp.found?.nonce} in ${rp.ms.toFixed(0)} ms (wall-clock, ${N} workers)`,
  );
  log('');
  log('[done]');
}

main().catch((e) => log(`[error] ${e?.message ?? e}`));
