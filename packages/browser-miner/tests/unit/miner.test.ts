import { describe, expect, it } from 'vitest';
import { BrowserMiner } from '../../src/index.js';
import {
  MockPoolAdapter,
  spyBackend,
  synthChallenge,
  synthJob,
  until,
  verifyShareLocal,
  yieldSleep,
} from './_helpers.js';

const noSleep = yieldSleep; // a macrotask yield (the loop always awaits sleep — keeps it cooperative)

describe('BrowserMiner loop (spy backend, headless)', () => {
  it('finds, submits, and counts accepted shares; earnings stay 0', async () => {
    const adapter = new MockPoolAdapter(() => synthJob('job-A'));
    const backend = spyBackend({ hit: true });
    let shares = 0;
    const miner = new BrowserMiner({
      adapter,
      backend,
      pollIntervalMs: 1e9,
      sleep: noSleep,
      onShare: () => (shares += 1),
    });
    miner.start();
    await until(() => shares >= 3);
    await miner.stop();
    expect(adapter.shares.length).toBeGreaterThanOrEqual(3);
    expect(miner.stats.sharesAccepted).toBeGreaterThanOrEqual(3);
    expect(miner.stats.estimatedEarnings).toBe(0);
    expect(miner.stats.backend).toBe('pure-js'); // the spy's name
    expect(backend.state.destroyed).toBeGreaterThanOrEqual(1); // stop() destroyed the session
  });

  it('preempts on a new job: destroys the old session, builds a new one, resets jobId', async () => {
    let call = 0;
    // first getJob → job-A; subsequent → job-B (different id)
    const adapter = new MockPoolAdapter(() => synthJob(call++ === 0 ? 'job-A' : 'job-B'));
    const backend = spyBackend({ hit: true });
    const miner = new BrowserMiner({ adapter, backend, pollIntervalMs: 0, sleep: noSleep });
    miner.start();
    await until(() => miner.stats.jobId === 'job-B' && backend.state.built >= 2);
    await miner.stop();
    expect(backend.state.built).toBeGreaterThanOrEqual(2); // A then B
    expect(backend.state.destroyed).toBeGreaterThanOrEqual(2); // old session + final
    expect(miner.stats.jobId).toBe('job-B');
  });

  it('pause() halts progress; resume() continues', async () => {
    const adapter = new MockPoolAdapter(() => synthJob('job-A'));
    const miner = new BrowserMiner({
      adapter,
      backend: spyBackend({ hit: true }),
      pollIntervalMs: 1e9,
      sleep: noSleep,
    });
    miner.start();
    await until(() => miner.stats.attempts > 0);
    miner.pause();
    await new Promise((r) => setTimeout(r, 10));
    const paused = miner.stats.attempts;
    await new Promise((r) => setTimeout(r, 10));
    expect(miner.stats.attempts).toBe(paused); // no progress while paused
    expect(miner.stats.paused).toBe(true);
    miner.resume();
    await until(() => miner.stats.attempts > paused);
    await miner.stop();
    expect(miner.stats.attempts).toBeGreaterThan(paused);
  });

  it('duty-cycle < 1 sleeps a positive interval between chunks; full duty sleeps 0', async () => {
    const mk = (dutyCycle: number) => {
      const calls: number[] = [];
      const adapter = new MockPoolAdapter(() => synthJob('job-A'));
      const miner = new BrowserMiner({
        adapter,
        backend: spyBackend({ hit: false, delayMs: 3 }), // ~3ms of "work" → dt > 0
        pollIntervalMs: 1e9,
        dutyCycle,
        sleep: async (ms) => {
          calls.push(ms);
          await yieldSleep(); // stay cooperative
        },
      });
      return { miner, calls };
    };
    const throttled = mk(0.5);
    throttled.miner.start();
    await until(() => throttled.calls.length >= 2, 4000);
    await throttled.miner.stop();
    expect(Math.max(...throttled.calls)).toBeGreaterThan(0); // throttle ≈ dt·(1/0.5−1) > 0

    const full = mk(1);
    full.miner.start();
    await until(() => full.calls.length >= 2, 4000);
    await full.miner.stop();
    expect(Math.max(...full.calls)).toBe(0); // full duty → throttle is 0 (still yields a macrotask)
  });

  it('stop() is graceful and destroys the session (finally)', async () => {
    const backend = spyBackend({ hit: false });
    const miner = new BrowserMiner({
      adapter: new MockPoolAdapter(() => synthJob('job-A')),
      backend,
      pollIntervalMs: 1e9,
      sleep: noSleep,
    });
    miner.start();
    await until(() => backend.state.built >= 1);
    await miner.stop();
    expect(miner.stats.running).toBe(false);
    expect(backend.state.destroyed).toBe(backend.state.built);
  });

  it('does NOT dispose an injected backend (caller owns its device) — audit M-2', async () => {
    const backend = spyBackend({ hit: false });
    const miner = new BrowserMiner({
      adapter: new MockPoolAdapter(() => synthJob('job-A')),
      backend,
      pollIntervalMs: 1e9,
      sleep: noSleep,
    });
    miner.start();
    await until(() => backend.state.built >= 1);
    await miner.stop();
    expect(backend.state.disposed).toBe(0); // injected → not disposed by the miner
  });

  it('resets running on a setup throw so the SAME miner is restartable — audit M-1', async () => {
    let errors = 0;
    const miner = new BrowserMiner({
      adapter: new MockPoolAdapter(() => synthJob('job-A')),
      backend: spyBackend({ failForJob: true }), // forJob throws during setup, every time
      sleep: noSleep,
      onError: () => (errors += 1),
    });
    miner.start();
    await until(() => errors === 1 && miner.stats.running === false);
    expect(miner.stats.running).toBe(false);
    // Pre-fix, this.running stayed true → start() would no-op forever (errors stuck at 1).
    miner.start();
    await until(() => errors === 2);
    expect(errors).toBe(2); // the loop actually re-ran → running was reset
  });
});

describe('BrowserMiner end-to-end with real pure-js backend + local verify', () => {
  it('mines real shares the work source accepts via Solver 1-nonce verify', async () => {
    // all-ones target → every nonce is a valid share; the adapter independently
    // re-verifies each submitted (nonce,digest) locally (no btxd).
    const challenge = synthChallenge('ff'.repeat(32));
    const adapter = new MockPoolAdapter(
      () => ({ jobId: 'real', challenge }),
      (s) => verifyShareLocal(challenge, s.nonce64_hex, s.digest_hex),
    );
    let accepted = 0;
    const miner = new BrowserMiner({
      adapter,
      prefer: 'pure-js',
      chunkSize: 1,
      pollIntervalMs: 1e9,
      sleep: noSleep,
      onShare: (_s, r) => {
        if (r.accepted) accepted += 1;
      },
    });
    miner.start();
    await until(() => accepted >= 2, 8000);
    await miner.stop();
    expect(accepted).toBeGreaterThanOrEqual(2);
    expect(miner.stats.sharesRejected).toBe(0); // locally-verified shares all valid
  });
});
