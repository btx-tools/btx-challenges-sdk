/**
 * The pool-agnostic contract between {@link BrowserMiner} and a work source.
 *
 * A "job" is a BTX matmul **service-challenge envelope** whose `target` is the
 * **share-target** (easier than a block-target — calibrated to the device via
 * vardiff). A "share" is a nonce whose matmul digest ≤ that target. This is the
 * exact shape the SDK's `Solver` / `@btx-tools/matmul-webgpu` already consume, so
 * the miner needs no special handling — it just solves the job's challenge.
 *
 * Any pool implements this interface; the package ships an in-page reference
 * work source (see `examples/04-browser-miner`). A real pool/btxd swaps in behind
 * the same two methods (HTTP `getJob`/`submitShare`, or btxd `issue`/`redeem`).
 */
import type { Challenge } from '@btx-tools/challenges-sdk';

/** A unit of work handed to the miner. */
export interface MiningJob {
  /** Opaque job identifier. A change signals the miner to abandon prior work. */
  jobId: string;
  /**
   * The service-challenge envelope to solve. `challenge.challenge.target` is the
   * **share-target**; `header_context.nonce64_start` seeds the search cursor.
   */
  challenge: Challenge;
  /** If true, prior in-flight jobs must be abandoned immediately (stratum-style). */
  cleanJobs?: boolean;
  /** Optional epoch-ms expiry; the miner refetches a job once past it. */
  expiresAt?: number;
}

/** A found share submitted back to the work source. */
export interface ShareSubmission {
  jobId: string;
  /** Winning nonce, 16 hex chars (big-endian). */
  nonce64_hex: string;
  /** Canonical display digest, 64 hex chars. */
  digest_hex: string;
  /** Optional worker identity (per-worker share accounting). */
  workerId?: string;
}

/** The work source's verdict on a submitted share. */
export interface ShareResult {
  accepted: boolean;
  /** Optional machine-readable reason (e.g. `'ok'`, `'stale'`, `'invalid'`, `'dup'`). */
  reason?: string;
}

/**
 * The only surface a pool must implement. `getJob` returns the current job
 * (poll/long-poll/fetch); `submitShare` validates + credits a share. Both are
 * async so HTTP/WebSocket adapters drop in unchanged.
 */
export interface MiningPoolAdapter {
  getJob(): Promise<MiningJob>;
  submitShare(share: ShareSubmission): Promise<ShareResult>;
}
