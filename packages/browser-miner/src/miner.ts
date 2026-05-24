/**
 * {@link BrowserMiner} — the pool-agnostic mining loop. Consent is explicit
 * (`start()`), GPU use is bounded (duty-cycle sleep between chunks), and new jobs
 * preempt in-flight work. Reuses one {@link SolveSession} per job and drives it in
 * small bounded chunks (the only preemption/throttle point, since local solvers
 * have no mid-solve abort).
 *
 * **Honest framing:** browser hashrate ≪ native and BTX network hashrate is high,
 * so a browser miner earns ≈ nothing — `stats.estimatedEarnings` is always 0. The
 * value is engagement / decentralization / zero-install, never "earn money in your
 * browser."
 */
import type { MiningPoolAdapter, ShareResult, ShareSubmission } from './adapter.js';
import {
  selectBackend,
  type BackendName,
  type SolveBackend,
  type SolveSession,
} from './backend.js';

/** Live miner telemetry. */
export interface MinerStats {
  backend: BackendName | 'starting';
  running: boolean;
  paused: boolean;
  jobId: string | null;
  /** Exponential moving average, nonces/second. */
  hashrate: number;
  sharesAccepted: number;
  sharesRejected: number;
  /** Total nonces searched. */
  attempts: number;
  /** Always 0 — browser mining ≈ no earnings (engagement/decentralization only). */
  estimatedEarnings: number;
}

/** Options for {@link BrowserMiner}. Only `adapter` is required. */
export interface BrowserMinerOptions {
  adapter: MiningPoolAdapter;
  /** Inject a backend (tests / explicit choice). Default: {@link selectBackend}. */
  backend?: SolveBackend;
  /** Backend preference for auto-select (still falls back to pure-js). */
  prefer?: BackendName;
  workerId?: string;
  /** Nonces per chunk (preemption/throttle granularity). Default: session.suggestedChunk. */
  chunkSize?: number;
  /** GPU duty cycle in (0, 1]. Sleeps `chunkMs·(1/d−1)` between chunks. Default 1 (full). */
  dutyCycle?: number;
  /** Job-refresh cadence in ms. Default 3000. */
  pollIntervalMs?: number;
  /** Nonce search-space ceiling. Default 2³² (the matmul-webgpu kernel's range limit). */
  maxNonce?: bigint;
  onShare?: (share: ShareSubmission, result: ShareResult) => void;
  onStats?: (stats: Readonly<MinerStats>) => void;
  onError?: (err: unknown) => void;
  /** Injectable sleep (tests). Default: `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const HASHRATE_ALPHA = 0.3;
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));
const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class BrowserMiner {
  private readonly opts: BrowserMinerOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;
  private paused = false;
  private loop: Promise<void> | null = null;
  private resumeWaiters: Array<() => void> = [];
  private readonly st: MinerStats = {
    backend: 'starting',
    running: false,
    paused: false,
    jobId: null,
    hashrate: 0,
    sharesAccepted: 0,
    sharesRejected: 0,
    attempts: 0,
    estimatedEarnings: 0,
  };

  constructor(opts: BrowserMinerOptions) {
    this.opts = opts;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** A snapshot of current telemetry. */
  get stats(): Readonly<MinerStats> {
    return { ...this.st };
  }

  /** Begin mining (explicit consent). Idempotent while running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.st.running = true;
    this.loop = this.run().catch((e) => {
      this.opts.onError?.(e);
    });
  }

  /** Stop gracefully: end the loop and release the GPU session. */
  async stop(): Promise<void> {
    this.running = false;
    this.st.running = false;
    this.flushResume(); // wake a paused loop so it can exit
    await this.loop;
    this.loop = null;
  }

  pause(): void {
    this.paused = true;
    this.st.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.st.paused = false;
    this.flushResume();
  }

  private flushResume(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const w of waiters) w();
  }

  private waitWhilePaused(): Promise<void> {
    if (!this.paused || !this.running) return Promise.resolve();
    return new Promise<void>((res) => this.resumeWaiters.push(res));
  }

  private updateHashrate(nonces: number, ms: number): void {
    if (ms <= 0) return;
    const rate = (nonces / ms) * 1000;
    this.st.hashrate =
      this.st.hashrate === 0
        ? rate
        : this.st.hashrate * (1 - HASHRATE_ALPHA) + rate * HASHRATE_ALPHA;
  }

  private emit(): void {
    this.opts.onStats?.(this.stats);
  }

  private async run(): Promise<void> {
    // Whether we own (and must dispose) the backend, vs an injected one the caller owns.
    const ownsBackend = this.opts.backend === undefined;
    let backend: SolveBackend | null = null;
    let session: SolveSession | null = null;
    // All setup lives inside the try so a throw (getJob/forJob/select) still hits
    // the finally that resets `running` — otherwise a setup failure would leave a
    // dead-but-"running" miner that can't be restarted (audit M-1).
    try {
      backend = this.opts.backend ?? (await selectBackend({ prefer: this.opts.prefer }));
      this.st.backend = backend.name;
      const maxNonce = this.opts.maxNonce ?? 1n << 32n;
      const duty = Math.min(1, Math.max(1e-3, this.opts.dutyCycle ?? 1));
      const pollMs = this.opts.pollIntervalMs ?? 3000;

      let job = await this.opts.adapter.getJob();
      session = await backend.forJob(job.challenge);
      let cursor = startCursor(job);
      this.st.jobId = job.jobId;
      let lastPoll = nowMs();

      while (this.running) {
        if (this.paused) {
          await this.waitWhilePaused();
          continue;
        }

        const chunk = this.opts.chunkSize ?? session.suggestedChunk;
        const exhausted = cursor + BigInt(chunk) > maxNonce;
        const expired = job.expiresAt !== undefined && Date.now() >= job.expiresAt;

        // New-job / refresh: poll on cadence, on expiry, or when the space is spent.
        // On exhaustion with an unchanged job we re-mine the same window — that's
        // intentional; the pool is responsible for dup-share rejection (untrusted client).
        if (exhausted || expired || nowMs() - lastPoll >= pollMs) {
          lastPoll = nowMs();
          const fresh = await this.opts.adapter.getJob();
          if (fresh.jobId !== job.jobId || fresh.cleanJobs || exhausted || expired) {
            session.destroy();
            job = fresh;
            session = await backend.forJob(job.challenge);
            cursor = startCursor(job);
            this.st.jobId = job.jobId;
            continue;
          }
        }

        const t0 = nowMs();
        const hit = await session.searchChunk(cursor, chunk);
        const dt = nowMs() - t0;
        cursor += BigInt(chunk);
        this.st.attempts += chunk;
        this.updateHashrate(chunk, dt);

        if (hit) {
          const share: ShareSubmission = {
            jobId: job.jobId,
            nonce64_hex: hit.nonce_hex,
            digest_hex: hit.digest_hex,
            workerId: this.opts.workerId,
          };
          try {
            const result = await this.opts.adapter.submitShare(share);
            if (result.accepted) this.st.sharesAccepted++;
            else this.st.sharesRejected++;
            this.opts.onShare?.(share, result);
          } catch (e) {
            // transient submit failure — count as rejected, keep mining.
            this.st.sharesRejected++;
            this.opts.onError?.(e);
          }
        }

        this.emit();
        // Always yield a macrotask between chunks — keeps the host loop / browser UI
        // responsive (a microtask-only loop would freeze the tab). When duty < 1,
        // yield proportionally longer to bound GPU use.
        await this.sleep(duty < 1 ? dt * (1 / duty - 1) : 0);
      }
    } finally {
      session?.destroy();
      if (ownsBackend) backend?.dispose?.(); // release the GPU device we acquired (audit M-2)
      this.running = false; // allow a later start() (and clear the stuck-running setup-throw case)
      this.st.running = false;
    }
  }
}

function startCursor(job: {
  challenge: { challenge: { header_context: { nonce64_start?: number | string } } };
}): bigint {
  const start = job.challenge.challenge.header_context.nonce64_start ?? 0;
  return BigInt(start);
}
