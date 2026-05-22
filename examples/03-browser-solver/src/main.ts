/**
 * Browser-side admission flow:
 *   1. POST gate URL with no proof → expect 402, read challenge from header
 *   2. postMessage challenge to Web Worker; await { nonce, digest, msElapsed }
 *   3. POST gate URL with proof headers → expect 200
 *   4. Repeat N times, render timing table for the WASM-or-defer decision
 *
 * The worker runs Solver.solve({ mode: 'pure-js' }) off-thread so the UI
 * stays responsive while matmul work churns.
 */

import type { Challenge } from '@btx-tools/challenges-sdk';

// Re-export of header constants to avoid pulling the entire middleware-express
// package into the browser bundle. These four strings are the wire contract.
const HEADER_CHALLENGE = 'X-BTX-Challenge';
const HEADER_PROOF_NONCE = 'X-BTX-Proof-Nonce';
const HEADER_PROOF_DIGEST = 'X-BTX-Proof-Digest';

interface WorkerRequest {
  type: 'solve';
  challenge: Challenge;
}
interface WorkerResponse {
  type: 'solved';
  nonce64_hex: string;
  digest_hex: string;
  msElapsed: number;
}
interface WorkerError {
  type: 'error';
  message: string;
}

const els = {
  gateUrl: document.getElementById('gate-url') as HTMLInputElement,
  body: document.getElementById('body') as HTMLTextAreaElement,
  cycles: document.getElementById('cycles') as HTMLInputElement,
  run: document.getElementById('run') as HTMLButtonElement,
  status: document.getElementById('status') as HTMLDivElement,
  results: document.getElementById('results') as HTMLTableElement,
  resultsBody: document.querySelector('#results tbody') as HTMLTableSectionElement,
};

function setStatus(msg: string): void {
  els.status.textContent = msg;
}

function appendRow(
  attempt: number,
  ms402: number,
  msSolve: number,
  ms200: number,
  status: string,
  ok: boolean,
): void {
  els.results.hidden = false;
  const tr = document.createElement('tr');
  tr.className = ok ? 'ok' : 'fail';
  tr.innerHTML = `
    <td>${attempt}</td>
    <td>${ms402.toFixed(0)}</td>
    <td>${msSolve.toFixed(0)}</td>
    <td>${ms200.toFixed(0)}</td>
    <td>${(ms402 + msSolve + ms200).toFixed(0)}</td>
    <td>${status}</td>
  `;
  els.resultsBody.appendChild(tr);
}

async function postWithoutProof(url: string, body: string): Promise<{ challenge: Challenge; raw: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  if (res.status !== 402) {
    throw new Error(`expected 402 on first POST, got ${res.status}`);
  }
  const raw = res.headers.get(HEADER_CHALLENGE.toLowerCase());
  if (!raw) {
    throw new Error(
      `402 received but ${HEADER_CHALLENGE} header is absent — the server's CORS config likely omits this header from exposedHeaders`,
    );
  }
  return { challenge: JSON.parse(raw) as Challenge, raw };
}

async function postWithProof(
  url: string,
  body: string,
  challengeRaw: string,
  nonce: string,
  digest: string,
): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [HEADER_CHALLENGE]: challengeRaw,
      [HEADER_PROOF_NONCE]: nonce,
      [HEADER_PROOF_DIGEST]: digest,
    },
    body,
  });
  return res.status;
}

function solveInWorker(challenge: Challenge): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./solver.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (ev: MessageEvent<WorkerResponse | WorkerError>) => {
      if (ev.data.type === 'solved') {
        resolve(ev.data);
      } else {
        reject(new Error(ev.data.message));
      }
      worker.terminate();
    };
    worker.onerror = (ev: ErrorEvent) => {
      reject(new Error(ev.message || 'worker error'));
      worker.terminate();
    };
    const msg: WorkerRequest = { type: 'solve', challenge };
    worker.postMessage(msg);
  });
}

async function runOneCycle(attempt: number, total: number): Promise<{ ok: boolean }> {
  const url = els.gateUrl.value.trim();
  const body = els.body.value.trim();

  setStatus(`cycle ${attempt}/${total} — POST without proof...`);
  const t0 = performance.now();
  const { challenge, raw } = await postWithoutProof(url, body);
  const ms402 = performance.now() - t0;
  setStatus(
    `cycle ${attempt}/${total} — got 402 in ${ms402.toFixed(0)}ms, solving in worker (~7-10 min)...`,
  );

  const t1 = performance.now();
  const proof = await solveInWorker(challenge);
  const msSolve = performance.now() - t1;
  setStatus(
    `cycle ${attempt}/${total} — solved in ${(msSolve / 1000).toFixed(1)}s (worker reported ${(proof.msElapsed / 1000).toFixed(1)}s), retrying with proof...`,
  );

  const t2 = performance.now();
  const status = await postWithProof(url, body, raw, proof.nonce64_hex, proof.digest_hex);
  const ms200 = performance.now() - t2;
  const ok = status === 200;
  appendRow(attempt, ms402, msSolve, ms200, String(status), ok);
  if (!ok) {
    setStatus(`cycle ${attempt}/${total} — retry returned ${status} (expected 200)`);
  }
  return { ok };
}

els.run.addEventListener('click', async () => {
  els.run.disabled = true;
  els.resultsBody.innerHTML = '';
  const cycles = Math.max(1, Math.min(20, Number(els.cycles.value) || 1));
  let okCount = 0;
  try {
    for (let i = 1; i <= cycles; i++) {
      const { ok } = await runOneCycle(i, cycles);
      if (ok) okCount++;
    }
    setStatus(`done — ${okCount}/${cycles} cycles admitted`);
  } catch (err) {
    setStatus(`failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    els.run.disabled = false;
  }
});
