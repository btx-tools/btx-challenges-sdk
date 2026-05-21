/**
 * End-to-end integration tests — issue → Solver.solve → redeem.
 *
 * Two parallel suites: RPC mode (delegates solving to btxd) and pure-JS mode
 * (solves locally in TypeScript). Both are **triple-gated** so they don't run
 * in CI or against mining-loaded nodes:
 *   BTX_INTEGRATION_URL              — e.g. http://127.0.0.1:19334/
 *   BTX_INTEGRATION_AUTH             — "user:pass"
 *   BTX_INTEGRATION_NODE_DEDICATED   — "1" (must be a NOT-MINING btxd)
 *
 * Why the third gate (NODE_DEDICATED): btxd's service-challenge solver shares
 * the matmul backend with block-template mining. On a mining-loaded node like
 * any of mining-loaded nodes, `solvematmulservicechallenge` queues behind
 * block work and takes minutes-to-hours. For the pure-JS suite the gate is
 * less critical (we don't touch the solve RPC) but it still applies because
 * `verifymatmulserviceproof` does full transcript recomputation under load.
 *
 * Day 2 measurement (2026-05-20 against btx-node via SSH tunnel):
 *   - HTTP/auth path: ✅ works (200 OK on getblockcount in milliseconds)
 *   - getmatmulservicechallenge: ✅ ~3s
 *   - solvematmulservicechallenge (mining-loaded): ❌ ~15 min
 *
 * Day 2.5 cross-validation (2026-05-21): the pure-JS solver's algorithm
 * matches btxd's byte-equal against 5 pinned golden vectors lifted from
 * btxd's own `src/test/matmul_*_tests.cpp` — see
 * `tests/unit/matmul/btxd-vectors.test.ts`. These integration tests
 * additionally exercise the live HTTP path against a real btxd.
 *
 * To run this suite, point at a btxd with mining DISABLED:
 *   # Spin up a $5 DO droplet OR a clone of a non-mining node with btx.conf gen=0:
 *   export BTX_INTEGRATION_URL="http://127.0.0.1:19334/"
 *   export BTX_INTEGRATION_AUTH="rpcuser:rpcpass"
 *   export BTX_INTEGRATION_NODE_DEDICATED=1
 *   pnpm test:integration
 *
 * Pure-JS suite caveat: at n=512 a single attempt takes ~5s on M-series
 * Mac. Even at btxd's lowest difficulty (`target_solve_time_s=0.001 +
 * min_solve_time_s=0.001`), expected ~770 attempts to find a target-
 * meeting solve ≈ 1 hour wall-clock. Per-test timeout is set accordingly.
 *
 * Default behavior: skipped.
 */

import { describe, expect, it } from 'vitest';
import { BtxChallengeClient, Solver } from '../../src/index.js';

const RPC_URL = process.env.BTX_INTEGRATION_URL;
const RPC_AUTH = process.env.BTX_INTEGRATION_AUTH;
const NODE_DEDICATED = process.env.BTX_INTEGRATION_NODE_DEDICATED === '1';

const SKIP_REASON =
  !RPC_URL || !RPC_AUTH
    ? 'set BTX_INTEGRATION_URL and BTX_INTEGRATION_AUTH'
    : !NODE_DEDICATED
      ? 'set BTX_INTEGRATION_NODE_DEDICATED=1 (must point at a non-mining btxd)'
      : null;

function makeClient() {
  const [user, pass] = (RPC_AUTH ?? '').split(':');
  return new BtxChallengeClient({
    rpcUrl: RPC_URL!,
    rpcAuth: { user: user ?? '', pass: pass ?? '' },
    // 15 min — service-challenge solving on CPU-only CPU-only mode at
    // btxd's floor difficulty (target_solve_time_s=0.001 + min=0.001) needs
    // ~770 expected attempts × ~600ms = ~7-10 min per solve. 5 min was
    // empirically too tight; 0.0.2 integration runs measured ~7-8 min mean
    // per solve. A dedicated CUDA-backed btxd would do this in seconds.
    timeoutMs: 900_000,
  });
}

describe.skipIf(SKIP_REASON !== null)('Solver end-to-end — RPC mode (btxd-delegated solve)', () => {
  it('issue → Solver.solve(mode:"rpc") → redeem succeeds', async () => {
    const client = makeClient();

    // Step 1: issue
    const challenge = await client.issue({
      purpose: 'rate_limit',
      resource: 'sdk-test:/rpc/lifecycle',
      subject: 'tenant:rpc-e2e',
      target_solve_time_s: 0.001,
      min_solve_time_s: 0.001,
      expires_in_s: 1800,
    });
    expect(challenge.challenge_id).toBeTruthy();

    // Step 2: solve (delegates to btxd)
    const proof = await Solver.solve(challenge, { mode: 'rpc', rpcClient: client });
    expect(proof.nonce64_hex).toMatch(/^[0-9a-fA-F]{16}$/);
    expect(proof.digest_hex).toMatch(/^[0-9a-fA-F]{64}$/);
    expect(proof.proof).toBeDefined();

    // Step 3: redeem — the proof must be accepted by btxd
    const result = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.redeemed).toBe(true);
  }, 1_200_000);

  it('replay rejected (already_redeemed) on second redeem of the same proof', async () => {
    const client = makeClient();
    const challenge = await client.issue({
      purpose: 'rate_limit',
      resource: 'sdk-test:/rpc/replay',
      subject: 'tenant:rpc-replay',
      target_solve_time_s: 0.001,
      min_solve_time_s: 0.001,
      expires_in_s: 1800,
    });
    const proof = await Solver.solve(challenge, { mode: 'rpc', rpcClient: client });

    const first = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
    expect(first.valid).toBe(true);

    const second = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('already_redeemed');
  }, 1_200_000);

  it('Solver.solve mode:"auto" picks rpc when client provided', async () => {
    const client = makeClient();
    const challenge = await client.issue({
      purpose: 'rate_limit',
      resource: 'sdk-test:/rpc/auto',
      subject: 'tenant:rpc-auto',
      target_solve_time_s: 0.001,
      min_solve_time_s: 0.001,
      expires_in_s: 1800,
    });
    const proof = await Solver.solve(challenge, { rpcClient: client });
    expect(proof.nonce64_hex).toMatch(/^[0-9a-fA-F]+$/);
  }, 1_200_000);
});

describe.skipIf(SKIP_REASON !== null)(
  'Solver end-to-end — pure-JS mode (browser-compatible, no RPC solve)',
  () => {
    // Pure-JS solving at n=512 is ~5s per attempt on M-series Mac (BigInt-
    // based M31 multiplication; WASM port deferred to Day 2.6). At btxd's
    // absolute-floor difficulty (`target_solve_time_s=0.001 +
    // min_solve_time_s=0.001`), expected ~770 attempts per solve ≈ 1 hour.
    // These tests get a 75-min timeout to absorb the right tail.
    const PURE_JS_TIMEOUT_MS = 75 * 60 * 1000;

    it(
      'issue → Solver.solve(mode:"pure-js") → redeem succeeds',
      async () => {
        const client = makeClient();

        const challenge = await client.issue({
          purpose: 'rate_limit',
          resource: 'sdk-test:/pure-js/lifecycle',
          subject: 'tenant:pure-js-e2e',
          target_solve_time_s: 0.001,
          min_solve_time_s: 0.001,
          expires_in_s: 7200,
        });
        expect(challenge.challenge_id).toBeTruthy();

        const proof = await Solver.solve(challenge, {
          mode: 'pure-js',
          pureJs: { maxTries: 5000 },
        });
        expect(proof.nonce64_hex).toMatch(/^[0-9a-fA-F]{16}$/);
        expect(proof.digest_hex).toMatch(/^[0-9a-fA-F]{64}$/);
        expect(proof.proof).toMatchObject({
          challenge,
          nonce64_hex: proof.nonce64_hex,
          digest_hex: proof.digest_hex,
        });

        const result = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
        expect(result.valid).toBe(true);
        expect(result.reason).toBe('ok');
        expect(result.redeemed).toBe(true);
      },
      PURE_JS_TIMEOUT_MS,
    );

    it(
      'replay rejected on second redeem of a pure-JS-generated proof',
      async () => {
        const client = makeClient();
        const challenge = await client.issue({
          purpose: 'rate_limit',
          resource: 'sdk-test:/pure-js/replay',
          subject: 'tenant:pure-js-replay',
          target_solve_time_s: 0.001,
          min_solve_time_s: 0.001,
          expires_in_s: 7200,
        });
        const proof = await Solver.solve(challenge, {
          mode: 'pure-js',
          pureJs: { maxTries: 5000 },
        });

        const first = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
        expect(first.valid).toBe(true);

        const second = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
        expect(second.valid).toBe(false);
        expect(second.reason).toBe('already_redeemed');
      },
      PURE_JS_TIMEOUT_MS,
    );

    it(
      'Solver.solve mode:"auto" falls back to pure-js when no rpcClient',
      async () => {
        const client = makeClient();
        const challenge = await client.issue({
          purpose: 'rate_limit',
          resource: 'sdk-test:/pure-js/auto',
          subject: 'tenant:pure-js-auto',
          target_solve_time_s: 0.001,
          min_solve_time_s: 0.001,
          expires_in_s: 7200,
        });
        // Note: no rpcClient → auto picks pure-js
        const proof = await Solver.solve(challenge, { pureJs: { maxTries: 5000 } });
        expect(proof.nonce64_hex).toMatch(/^[0-9a-fA-F]{16}$/);

        const result = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
        expect(result.valid).toBe(true);
      },
      PURE_JS_TIMEOUT_MS,
    );
  },
);
