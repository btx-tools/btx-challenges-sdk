/**
 * `@btx-tools/browser-miner` — a pool-agnostic browser mining client for BTX
 * matmul service-challenge shares. Drives the SDK's solver cascade
 * (WebGPU → WASM → pure-JS) over a {@link MiningPoolAdapter}, with vardiff,
 * GPU duty-cycle throttling, and new-job preemption.
 *
 * **Honest framing:** engagement / decentralization / zero-install — *not*
 * per-user earnings (browser hashrate ≪ native). See README.
 */
export { BrowserMiner } from './miner.js';
export type { BrowserMinerOptions, MinerStats } from './miner.js';
export type { MiningPoolAdapter, MiningJob, ShareSubmission, ShareResult } from './adapter.js';
export {
  selectBackend,
  pureJsBackend,
  challengeToArgs,
  type SolveBackend,
  type SolveSession,
  type BackendName,
  type FoundShare,
} from './backend.js';
export { targetForExpectedAttempts, expectedAttemptsForTarget } from './vardiff.js';
