/**
 * End-to-end integration test — issue → Solver.solve(rpc) → redeem.
 *
 * **Triple-gated** so it doesn't run in CI or against mining-loaded nodes:
 *   BTX_INTEGRATION_URL              — e.g. http://127.0.0.1:19334/
 *   BTX_INTEGRATION_AUTH             — "user:pass"
 *   BTX_INTEGRATION_NODE_DEDICATED   — "1" (must be a NOT-MINING btxd)
 *
 * Why the third gate (NODE_DEDICATED): btxd's service-challenge solver shares
 * the matmul backend with block-template mining. On a mining-loaded node like
 * any of our fleet rentals, `solvematmulservicechallenge` queues behind
 * block work and takes 5+ minutes — unusable for a test loop.
 *
 * Day 2 measurement (2026-05-20 against btx-iowa via SSH tunnel):
 *   - HTTP/auth path: ✅ works (200 OK on getblockcount in milliseconds)
 *   - getmatmulservicechallenge: ✅ ~3s
 *   - solvematmulservicechallenge: ❌ >5 min (timed out at 300_000 ms)
 *
 * To run this suite usefully, point at a btxd with mining DISABLED:
 *   # Spin up a $5 DO droplet OR a clone of iowa with btx.conf gen=0:
 *   export BTX_INTEGRATION_URL="http://127.0.0.1:19334/"
 *   export BTX_INTEGRATION_AUTH="rpcuser:rpcpass"
 *   export BTX_INTEGRATION_NODE_DEDICATED=1
 *   pnpm test:integration
 *
 * Default behavior: skipped. Day 2 closure relies on the unit suite + Day 1
 * smoke test for confidence.
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

describe.skipIf(SKIP_REASON !== null)('Day 2 — Solver end-to-end (real btxd via HTTP)', () => {
  const [user, pass] = (RPC_AUTH ?? '').split(':');

  const makeClient = () =>
    new BtxChallengeClient({
      rpcUrl: RPC_URL!,
      rpcAuth: { user: user ?? '', pass: pass ?? '' },
      // 5 min — service-challenge solving on a mining-loaded node contends
      // with block-template work. Day 1 telemetry showed matmul solver mean
      // ~64s, max ~127s, on iowa. Generous timeout lets us actually witness
      // a successful solve at least once during integration.
      timeoutMs: 300_000,
    });

  it('issue → Solver.solve(mode:"rpc") → redeem succeeds', async () => {
    const client = makeClient();

    // Step 1: issue
    const challenge = await client.issue({
      purpose: 'rate_limit',
      resource: 'sdk-day2-test:/v1/lifecycle',
      subject: 'tenant:day2-e2e',
      target_solve_time_s: 1,
      expires_in_s: 120,
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

    console.log('[day2-e2e] challenge_id:', challenge.challenge_id);
    console.log('[day2-e2e] proof.nonce64_hex:', proof.nonce64_hex);
    console.log('[day2-e2e] redeem.reason:', result.reason);
  }, 360_000);

  it('replay rejected (already_redeemed) on second redeem of the same proof', async () => {
    const client = makeClient();
    const challenge = await client.issue({
      purpose: 'rate_limit',
      resource: 'sdk-day2-test:/v1/replay',
      subject: 'tenant:day2-replay',
      target_solve_time_s: 1,
      expires_in_s: 120,
    });
    const proof = await Solver.solve(challenge, { mode: 'rpc', rpcClient: client });

    const first = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
    expect(first.valid).toBe(true);

    const second = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('already_redeemed');
  }, 360_000);

  it('Solver.solve mode:"auto" picks rpc when client provided', async () => {
    const client = makeClient();
    const challenge = await client.issue({
      purpose: 'rate_limit',
      resource: 'sdk-day2-test:/v1/auto',
      subject: 'tenant:day2-auto',
      target_solve_time_s: 1,
      expires_in_s: 120,
    });
    const proof = await Solver.solve(challenge, { rpcClient: client });
    expect(proof.nonce64_hex).toMatch(/^[0-9a-fA-F]+$/);
  }, 360_000);
});
