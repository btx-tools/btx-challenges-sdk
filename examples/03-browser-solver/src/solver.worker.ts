/**
 * Web Worker that runs the SDK's pure-JS solver off the main thread.
 *
 * Browser perf at floor difficulty is ~7-10 min wall-clock per attempt on an
 * M-series Mac. Keep this off the UI thread so the page stays responsive.
 */

import { Solver, type Challenge } from '@btx-tools/challenges-sdk';

interface WorkerRequest {
  type: 'solve';
  challenge: Challenge;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  if (ev.data.type !== 'solve') return;
  const t0 = performance.now();
  try {
    const proof = await Solver.solve(ev.data.challenge, { mode: 'pure-js' });
    self.postMessage({
      type: 'solved',
      nonce64_hex: proof.nonce64_hex,
      digest_hex: proof.digest_hex,
      msElapsed: performance.now() - t0,
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
