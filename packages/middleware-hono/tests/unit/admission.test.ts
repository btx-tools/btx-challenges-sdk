/**
 * Unit tests for the Hono btxAdmission middleware. Mocks BtxChallengeClient
 * at the method level and uses Hono's built-in `app.request()` (Web fetch API)
 * for HTTP simulation — runs on Node without an actual server.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { BtxChallengeClient, Challenge, VerifyResult } from '@btx-tools/challenges-sdk';

import {
  HEADER_CHALLENGE,
  HEADER_CHALLENGE_ID,
  HEADER_PROOF_DIGEST,
  HEADER_PROOF_NONCE,
  btxAdmission,
  type BtxAdmissionOpts,
  type BtxAdmissionVariables,
} from '../../src/index.js';

// ----------------------------------------------------------------------------
// fixtures
// ----------------------------------------------------------------------------

const STUB_CHALLENGE: Challenge = {
  kind: 'matmul_service_challenge_v1',
  challenge_id: 'test-challenge-id-hono',
  issued_at: 1700000000,
  expires_at: 1700000300,
  expires_in_s: 300,
  binding: {
    chain: 'main',
    purpose: 'rate_limit',
    resource: 'test:/v1/gate',
    subject: 'tenant:test',
    resource_hash: 'aa',
    subject_hash: 'bb',
    salt: 'cc',
    anchor_height: 1,
    anchor_hash: 'dd',
  },
  proof_policy: {
    verification_rule: 'rule',
    sigma_gate_applied: false,
    expiration_enforced: true,
    challenge_id_required: true,
    replay_protection: 'redeemmatmulserviceproof',
    redeem_rpc: 'redeemmatmulserviceproof',
    solve_rpc: 'solvematmulservicechallenge',
    locally_issued_required: true,
  },
  challenge: {
    chain: 'main',
    algorithm: 'matmul',
    height: 2,
    previousblockhash: 'pp',
    mintime: 1700000000,
    bits: '1e1bb4ae',
    difficulty: 0.0001,
    target: '0000...',
    noncerange: '0000000000000000ffffffffffffffff',
    header_context: {
      version: 1,
      previousblockhash: 'pp',
      merkleroot: 'mm',
      time: 1700000000,
      bits: '1e1bb4ae',
      nonce64_start: 0,
      matmul_dim: 512,
      seed_a: 'aaaa',
      seed_b: 'bbbb',
    },
    matmul: {
      n: 512,
      b: 16,
      r: 8,
      q: 2147483647,
      min_dimension: 64,
      max_dimension: 2048,
      seed_a: 'aaaa',
      seed_b: 'bbbb',
    },
  },
} as Challenge;

const STUB_VALID: VerifyResult = {
  valid: true,
  reason: 'ok',
  redeemed: true,
  expired: false,
};

const STUB_INVALID: VerifyResult = {
  valid: false,
  reason: 'digest_mismatch',
  redeemed: false,
  expired: false,
};

function mockClient(
  overrides: Partial<{
    issue: () => Promise<Challenge>;
    redeem: () => Promise<VerifyResult>;
  }> = {},
): BtxChallengeClient {
  return {
    issue: overrides.issue ?? vi.fn(async () => STUB_CHALLENGE),
    redeem: overrides.redeem ?? vi.fn(async () => STUB_VALID),
  } as unknown as BtxChallengeClient;
}

function buildApp(
  opts: Partial<BtxAdmissionOpts> = {},
): Hono<{ Variables: BtxAdmissionVariables }> {
  const o: BtxAdmissionOpts = {
    client: opts.client ?? mockClient(),
    purpose: opts.purpose ?? 'rate_limit',
    resource: opts.resource ?? 'test:/v1/gate',
    subject: opts.subject ?? 'tenant:test',
    issueParams: opts.issueParams,
    onAdmit: opts.onAdmit,
    onError: opts.onError,
    isProofPresent: opts.isProofPresent,
    enforceBinding: opts.enforceBinding,
  };
  const app = new Hono<{ Variables: BtxAdmissionVariables }>();
  app.onError((err, c) => c.json({ error: String(err) }, 500));
  app.post('/v1/gate', btxAdmission(o), async (c) => {
    const admit = c.get('btx');
    return c.json({ ok: true, admitted_via: admit?.result?.reason });
  });
  return app;
}

// ----------------------------------------------------------------------------
// tests
// ----------------------------------------------------------------------------

describe('btxAdmission (Hono) — issue path (no proof headers)', () => {
  it('returns 402 with X-BTX-Challenge header on first request', async () => {
    const app = buildApp();
    const res = await app.request('/v1/gate', { method: 'POST', body: '{}' });
    expect(res.status).toBe(402);
    expect(res.headers.get(HEADER_CHALLENGE)).toBeTruthy();
    const body = (await res.json()) as { challenge: Challenge; retry_with: string[] };
    expect(body.challenge.challenge_id).toBe('test-challenge-id-hono');
    expect(body.retry_with).toContain(HEADER_CHALLENGE);
  });

  it('passes issueParams through to client.issue', async () => {
    const issue = vi.fn(async () => STUB_CHALLENGE);
    const app = buildApp({
      client: mockClient({ issue }),
      issueParams: { target_solve_time_s: 1.5, expires_in_s: 60 },
    });
    await app.request('/v1/gate', { method: 'POST', body: '{}' });
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'rate_limit',
        resource: 'test:/v1/gate',
        subject: 'tenant:test',
        target_solve_time_s: 1.5,
        expires_in_s: 60,
      }),
    );
  });

  it('resolves purpose/resource/subject when given as sync or async functions', async () => {
    const issue = vi.fn(async () => STUB_CHALLENGE);
    const app = buildApp({
      client: mockClient({ issue }),
      purpose: () => 'ai_inference_gate',
      resource: (c) => `route:${c.req.path}`,
      subject: async () => `tenant:async-resolved`, // async resolver
    });
    await app.request('/v1/gate', { method: 'POST', body: '{}' });
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'ai_inference_gate',
        resource: 'route:/v1/gate',
        subject: 'tenant:async-resolved',
      }),
    );
  });
});

describe('btxAdmission (Hono) — redeem path (proof headers present)', () => {
  it('admits valid proof + populates c.get("btx").result', async () => {
    const redeem = vi.fn(async () => STUB_VALID);
    const onAdmit = vi.fn();
    const app = buildApp({ client: mockClient({ redeem }), onAdmit });
    const res = await app.request('/v1/gate', {
      method: 'POST',
      headers: {
        [HEADER_CHALLENGE]: JSON.stringify(STUB_CHALLENGE),
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: '00'.repeat(32),
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; admitted_via: string };
    expect(body).toEqual({ ok: true, admitted_via: 'ok' });
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(onAdmit).toHaveBeenCalledTimes(1);
  });

  // Audit H-1: challenge binding must match this request (default-on).
  it('denies 403 challenge_binding_mismatch when binding ≠ request', async () => {
    const redeem = vi.fn(async () => STUB_VALID);
    // resource 'other' ≠ stub binding 'test:/v1/gate'; enforceBinding defaults true.
    const app = buildApp({ client: mockClient({ redeem }), resource: 'other' });
    const res = await app.request('/v1/gate', {
      method: 'POST',
      headers: {
        [HEADER_CHALLENGE]: JSON.stringify(STUB_CHALLENGE),
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: '00'.repeat(32),
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('challenge_binding_mismatch');
    expect(redeem).not.toHaveBeenCalled();
  });

  it('admits a mismatched binding when enforceBinding:false (opt-out)', async () => {
    const app = buildApp({ resource: 'other', enforceBinding: false });
    const res = await app.request('/v1/gate', {
      method: 'POST',
      headers: {
        [HEADER_CHALLENGE]: JSON.stringify(STUB_CHALLENGE),
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: '00'.repeat(32),
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  it('rejects invalid proof with 403 + reason', async () => {
    const app = buildApp({ client: mockClient({ redeem: vi.fn(async () => STUB_INVALID) }) });
    const res = await app.request('/v1/gate', {
      method: 'POST',
      headers: {
        [HEADER_CHALLENGE]: JSON.stringify(STUB_CHALLENGE),
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: 'ff'.repeat(32),
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { valid: boolean; reason: string };
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('digest_mismatch');
  });

  it('rejects mismatched X-BTX-Challenge-Id with 400', async () => {
    const app = buildApp();
    const res = await app.request('/v1/gate', {
      method: 'POST',
      headers: {
        [HEADER_CHALLENGE]: JSON.stringify(STUB_CHALLENGE),
        [HEADER_CHALLENGE_ID]: 'wrong-id',
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: '00'.repeat(32),
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('challenge_id_mismatch');
  });

  it('rejects malformed X-BTX-Challenge JSON with 400', async () => {
    const app = buildApp();
    const res = await app.request('/v1/gate', {
      method: 'POST',
      headers: {
        [HEADER_CHALLENGE]: 'not-json',
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: '00'.repeat(32),
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('malformed_challenge_header');
  });
});

describe('btxAdmission (Hono) — D-1 onError hook', () => {
  it('fires onError when client.issue throws + bubbles to Hono onError', async () => {
    const onError = vi.fn();
    const boom = new Error('btxd down');
    const app = buildApp({
      client: mockClient({
        issue: vi.fn(async () => {
          throw boom;
        }),
      }),
      onError,
    });
    const res = await app.request('/v1/gate', { method: 'POST', body: '{}' });
    expect(res.status).toBe(500);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom, expect.anything());
  });

  it('fires onError when client.redeem throws', async () => {
    const onError = vi.fn();
    const boom = new Error('rpc timeout');
    const app = buildApp({
      client: mockClient({
        redeem: vi.fn(async () => {
          throw boom;
        }),
      }),
      onError,
    });
    const res = await app.request('/v1/gate', {
      method: 'POST',
      headers: {
        [HEADER_CHALLENGE]: JSON.stringify(STUB_CHALLENGE),
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: '00'.repeat(32),
      },
      body: '{}',
    });
    expect(res.status).toBe(500);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom, expect.anything());
  });

  it('does NOT fire onError on a 403 invalid-proof rejection', async () => {
    const onError = vi.fn();
    const app = buildApp({
      client: mockClient({ redeem: vi.fn(async () => STUB_INVALID) }),
      onError,
    });
    await app.request('/v1/gate', {
      method: 'POST',
      headers: {
        [HEADER_CHALLENGE]: JSON.stringify(STUB_CHALLENGE),
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: '00'.repeat(32),
      },
      body: '{}',
    });
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('btxAdmission (Hono) — isProofPresent override', () => {
  it('honors custom isProofPresent predicate', async () => {
    let alwaysSay = true;
    const app = buildApp({
      isProofPresent: () => alwaysSay,
      client: mockClient({
        issue: vi.fn(async () => STUB_CHALLENGE),
        redeem: vi.fn(async () => STUB_VALID),
      }),
    });
    // alwaysSay=true → redeem path → 400 because no challenge header
    let res = await app.request('/v1/gate', { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('missing_challenge_header');

    // alwaysSay=false → issue path → 402
    alwaysSay = false;
    res = await app.request('/v1/gate', { method: 'POST', body: '{}' });
    expect(res.status).toBe(402);
  });
});
