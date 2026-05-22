/**
 * Unit tests for the Fastify btxAdmission preHandler. Mocks BtxChallengeClient
 * at the method level (no real btxd) and uses Fastify's built-in `inject`
 * (light-my-request) for HTTP simulation.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BtxChallengeClient, Challenge, VerifyResult } from '@btx-tools/challenges-sdk';

import {
  HEADER_CHALLENGE,
  HEADER_CHALLENGE_ID,
  HEADER_PROOF_DIGEST,
  HEADER_PROOF_NONCE,
  btxAdmission,
  type BtxAdmissionOpts,
} from '../../src/index.js';

// ----------------------------------------------------------------------------
// fixtures
// ----------------------------------------------------------------------------

const STUB_CHALLENGE: Challenge = {
  kind: 'matmul_service_challenge_v1',
  challenge_id: 'test-challenge-id-fastify',
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

function mockClient(overrides: Partial<{
  issue: () => Promise<Challenge>;
  redeem: () => Promise<VerifyResult>;
}> = {}): BtxChallengeClient {
  return {
    issue: overrides.issue ?? vi.fn(async () => STUB_CHALLENGE),
    redeem: overrides.redeem ?? vi.fn(async () => STUB_VALID),
  } as unknown as BtxChallengeClient;
}

function buildApp(opts: Partial<BtxAdmissionOpts> = {}): FastifyInstance {
  const app = Fastify();
  const o: BtxAdmissionOpts = {
    client: opts.client ?? mockClient(),
    purpose: opts.purpose ?? 'rate_limit',
    resource: opts.resource ?? 'test:/v1/gate',
    subject: opts.subject ?? 'tenant:test',
    issueParams: opts.issueParams,
    onAdmit: opts.onAdmit,
    onError: opts.onError,
    isProofPresent: opts.isProofPresent,
  };
  app.post('/v1/gate', { preHandler: btxAdmission(o) }, async (req) => {
    return { ok: true, admitted_via: req.btx?.result?.reason };
  });
  return app;
}

// ----------------------------------------------------------------------------
// tests
// ----------------------------------------------------------------------------

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe('btxAdmission (Fastify) — issue path (no proof headers)', () => {
  it('returns 402 with X-BTX-Challenge header on first request', async () => {
    app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/gate', payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.headers[HEADER_CHALLENGE]).toBeTruthy();
    const body = JSON.parse(res.payload) as { challenge: Challenge; retry_with: string[] };
    expect(body.challenge.challenge_id).toBe('test-challenge-id-fastify');
    expect(body.retry_with).toContain(HEADER_CHALLENGE);
    expect(body.retry_with).toContain(HEADER_PROOF_NONCE);
    expect(body.retry_with).toContain(HEADER_PROOF_DIGEST);
  });

  it('passes issueParams through to client.issue', async () => {
    const issue = vi.fn(async () => STUB_CHALLENGE);
    app = buildApp({
      client: mockClient({ issue }),
      issueParams: { target_solve_time_s: 1.5, expires_in_s: 60 },
    });
    await app.inject({ method: 'POST', url: '/v1/gate', payload: {} });
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

  it('resolves purpose/resource/subject when given as functions', async () => {
    const issue = vi.fn(async () => STUB_CHALLENGE);
    app = buildApp({
      client: mockClient({ issue }),
      purpose: () => 'ai_inference_gate',
      resource: (req) => `route:${req.url}`,
      subject: () => 'tenant:fn-resolved',
    });
    await app.inject({ method: 'POST', url: '/v1/gate', payload: {} });
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'ai_inference_gate',
        resource: 'route:/v1/gate',
        subject: 'tenant:fn-resolved',
      }),
    );
  });
});

describe('btxAdmission (Fastify) — redeem path (proof headers present)', () => {
  it('admits valid proof + populates request.btx.result', async () => {
    const redeem = vi.fn(async () => STUB_VALID);
    const onAdmit = vi.fn();
    app = buildApp({ client: mockClient({ redeem }), onAdmit });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/gate',
      headers: {
        [HEADER_CHALLENGE]: JSON.stringify(STUB_CHALLENGE),
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: '00'.repeat(32),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, admitted_via: 'ok' });
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(onAdmit).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid proof with 403 + reason', async () => {
    app = buildApp({ client: mockClient({ redeem: vi.fn(async () => STUB_INVALID) }) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/gate',
      headers: {
        [HEADER_CHALLENGE]: JSON.stringify(STUB_CHALLENGE),
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: 'ff'.repeat(32),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.payload);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('digest_mismatch');
  });

  it('rejects mismatched X-BTX-Challenge-Id with 400', async () => {
    app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/gate',
      headers: {
        [HEADER_CHALLENGE]: JSON.stringify(STUB_CHALLENGE),
        [HEADER_CHALLENGE_ID]: 'wrong-id',
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: '00'.repeat(32),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('challenge_id_mismatch');
  });

  it('rejects malformed X-BTX-Challenge JSON with 400', async () => {
    app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/gate',
      headers: {
        [HEADER_CHALLENGE]: 'not-json',
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: '00'.repeat(32),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('malformed_challenge_header');
  });
});

describe('btxAdmission (Fastify) — D-1 onError hook', () => {
  it('fires onError when client.issue throws + propagates to Fastify error pipeline', async () => {
    const onError = vi.fn();
    const boom = new Error('btxd down');
    app = buildApp({
      client: mockClient({ issue: vi.fn(async () => { throw boom; }) }),
      onError,
    });
    const res = await app.inject({ method: 'POST', url: '/v1/gate', payload: {} });
    expect(res.statusCode).toBe(500);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom, expect.anything());
  });

  it('fires onError when client.redeem throws', async () => {
    const onError = vi.fn();
    const boom = new Error('rpc timeout');
    app = buildApp({
      client: mockClient({ redeem: vi.fn(async () => { throw boom; }) }),
      onError,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/gate',
      headers: {
        [HEADER_CHALLENGE]: JSON.stringify(STUB_CHALLENGE),
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: '00'.repeat(32),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(500);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom, expect.anything());
  });

  it('does NOT fire onError on a 403 invalid-proof rejection', async () => {
    const onError = vi.fn();
    app = buildApp({
      client: mockClient({ redeem: vi.fn(async () => STUB_INVALID) }),
      onError,
    });
    await app.inject({
      method: 'POST',
      url: '/v1/gate',
      headers: {
        [HEADER_CHALLENGE]: JSON.stringify(STUB_CHALLENGE),
        [HEADER_PROOF_NONCE]: '00'.repeat(8),
        [HEADER_PROOF_DIGEST]: '00'.repeat(32),
      },
      payload: {},
    });
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('btxAdmission (Fastify) — isProofPresent override', () => {
  it('honors custom isProofPresent predicate', async () => {
    let alwaysSay = true;
    app = buildApp({
      isProofPresent: () => alwaysSay,
      client: mockClient({
        issue: vi.fn(async () => STUB_CHALLENGE),
        redeem: vi.fn(async () => STUB_VALID),
      }),
    });
    // alwaysSay=true → redeem path → 400 because no challenge header
    let res = await app.inject({ method: 'POST', url: '/v1/gate', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('missing_challenge_header');

    // alwaysSay=false → issue path → 402
    alwaysSay = false;
    res = await app.inject({ method: 'POST', url: '/v1/gate', payload: {} });
    expect(res.statusCode).toBe(402);
  });
});
