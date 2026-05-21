/**
 * Unit tests for btxAdmission. Mocks the BtxChallengeClient at the method
 * level so we exercise the middleware's HTTP/JSON behavior without spinning
 * up a real btxd or hitting the network.
 */

import express, { type Application } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BtxChallengeClient,
  Challenge,
  VerifyResult,
} from '@btx-tools/challenges-sdk';

import {
  HEADER_CHALLENGE,
  HEADER_CHALLENGE_ID,
  HEADER_PROOF_DIGEST,
  HEADER_PROOF_NONCE,
  btxAdmission,
  type BtxAdmissionOpts,
} from '../../src/index.js';

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

const STUB_CHALLENGE: Challenge = {
  kind: 'matmul_service_challenge_v1',
  challenge_id: 'test-challenge-id-abc123',
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
    bits: '1d00ffff',
    difficulty: 0.0001,
    target: 'ff'.repeat(32),
    noncerange: '0000000000000000ffffffffffffffff',
    header_context: {
      version: 1,
      previousblockhash: 'pp',
      merkleroot: 'mm',
      time: 1700000000,
      bits: '1d00ffff',
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
};

const STUB_VERIFY_OK: VerifyResult = {
  valid: true,
  reason: 'ok',
  redeemed: true,
  redeemable: true,
  issued_by_local_node: true,
};

const STUB_VERIFY_INVALID: VerifyResult = {
  valid: false,
  reason: 'invalid_proof',
  redeemed: false,
  redeemable: false,
  expired: false,
};

const STUB_VERIFY_ALREADY: VerifyResult = {
  valid: false,
  reason: 'already_redeemed',
  redeemed: true,
  redeemable: false,
  expired: false,
};

/** Build a fake BtxChallengeClient with vitest spies on issue() and redeem(). */
function makeClient(overrides: Partial<{
  issue: BtxChallengeClient['issue'];
  redeem: BtxChallengeClient['redeem'];
}> = {}): BtxChallengeClient {
  return {
    issue: overrides.issue ?? vi.fn().mockResolvedValue(STUB_CHALLENGE),
    redeem: overrides.redeem ?? vi.fn().mockResolvedValue(STUB_VERIFY_OK),
  } as unknown as BtxChallengeClient;
}

function makeApp(opts: BtxAdmissionOpts, downstream?: express.RequestHandler): Application {
  const app = express();
  app.use(express.json());
  app.post(
    '/gated',
    btxAdmission(opts),
    downstream ??
      ((req, res) => {
        res.status(200).json({ ok: true, btxResult: req.btxResult });
      }),
  );
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ----------------------------------------------------------------------------
// tests
// ----------------------------------------------------------------------------

describe('btxAdmission — 402 issue path (no proof headers)', () => {
  it('returns 402 with challenge in X-BTX-Challenge header + JSON body', async () => {
    const client = makeClient();
    const app = makeApp({
      client,
      purpose: 'rate_limit',
      resource: 'test:/v1/gate',
      subject: 'tenant:test',
    });

    const res = await request(app).post('/gated').send({});

    expect(res.status).toBe(402);
    expect(res.headers['x-btx-challenge']).toBe(JSON.stringify(STUB_CHALLENGE));
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.challenge).toEqual(STUB_CHALLENGE);
    expect(res.body.retry_with).toEqual([
      HEADER_CHALLENGE,
      HEADER_PROOF_NONCE,
      HEADER_PROOF_DIGEST,
    ]);
    expect(client.issue).toHaveBeenCalledOnce();
  });

  it('passes string opts directly to client.issue', async () => {
    const client = makeClient();
    const app = makeApp({
      client,
      purpose: 'ai_inference_gate',
      resource: 'model:gpt-x|route:/gen',
      subject: 'tenant:abc',
    });
    await request(app).post('/gated').send({});
    expect(client.issue).toHaveBeenCalledWith({
      purpose: 'ai_inference_gate',
      resource: 'model:gpt-x|route:/gen',
      subject: 'tenant:abc',
    });
  });

  it('resolves callable opts against the request', async () => {
    const client = makeClient();
    const app = makeApp({
      client,
      purpose: 'api_gate',
      resource: (req) => `model:${req.body.model}|route:${req.path}`,
      subject: (req) => `tenant:${req.body.tenant_id}`,
    });
    await request(app).post('/gated').send({ model: 'gpt-x', tenant_id: 'org-42' });
    expect(client.issue).toHaveBeenCalledWith({
      purpose: 'api_gate',
      resource: 'model:gpt-x|route:/gated',
      subject: 'tenant:org-42',
    });
  });

  it('forwards issueParams (target_solve_time_s, expires_in_s)', async () => {
    const client = makeClient();
    const app = makeApp({
      client,
      purpose: 'rate_limit',
      resource: 'r',
      subject: 's',
      issueParams: {
        target_solve_time_s: 2.5,
        expires_in_s: 90,
      },
    });
    await request(app).post('/gated').send({});
    expect(client.issue).toHaveBeenCalledWith({
      purpose: 'rate_limit',
      resource: 'r',
      subject: 's',
      target_solve_time_s: 2.5,
      expires_in_s: 90,
    });
  });
});

describe('btxAdmission — 200 admit path (valid proof)', () => {
  it('redeems + calls next() + populates req.btxResult', async () => {
    const client = makeClient();
    const app = makeApp({
      client,
      purpose: 'rate_limit',
      resource: 'r',
      subject: 's',
    });

    const res = await request(app)
      .post('/gated')
      .set(HEADER_CHALLENGE, JSON.stringify(STUB_CHALLENGE))
      .set(HEADER_PROOF_NONCE, 'abcdef0123456789')
      .set(HEADER_PROOF_DIGEST, '00'.repeat(32))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.btxResult).toEqual(STUB_VERIFY_OK);
    expect(client.redeem).toHaveBeenCalledWith(
      STUB_CHALLENGE,
      'abcdef0123456789',
      '00'.repeat(32),
    );
    expect(client.issue).not.toHaveBeenCalled();
  });

  it('fires onAdmit hook with req + result', async () => {
    const onAdmit = vi.fn();
    const client = makeClient();
    const app = makeApp({
      client,
      purpose: 'r',
      resource: 'r',
      subject: 's',
      onAdmit,
    });

    await request(app)
      .post('/gated')
      .set(HEADER_CHALLENGE, JSON.stringify(STUB_CHALLENGE))
      .set(HEADER_PROOF_NONCE, '01'.padStart(16, '0'))
      .set(HEADER_PROOF_DIGEST, '11'.repeat(32))
      .send({});

    expect(onAdmit).toHaveBeenCalledOnce();
    const [req, result] = onAdmit.mock.calls[0]!;
    expect((req as express.Request).path).toBe('/gated');
    expect(result).toEqual(STUB_VERIFY_OK);
  });

  it('accepts matching X-BTX-Challenge-Id', async () => {
    const client = makeClient();
    const app = makeApp({
      client,
      purpose: 'r',
      resource: 'r',
      subject: 's',
    });

    const res = await request(app)
      .post('/gated')
      .set(HEADER_CHALLENGE, JSON.stringify(STUB_CHALLENGE))
      .set(HEADER_CHALLENGE_ID, STUB_CHALLENGE.challenge_id)
      .set(HEADER_PROOF_NONCE, '01')
      .set(HEADER_PROOF_DIGEST, '02')
      .send({});

    expect(res.status).toBe(200);
  });
});

describe('btxAdmission — 403 reject path', () => {
  it('returns 403 with reason on invalid_proof', async () => {
    const client = makeClient({
      redeem: vi.fn().mockResolvedValue(STUB_VERIFY_INVALID),
    });
    const app = makeApp({
      client,
      purpose: 'r',
      resource: 'r',
      subject: 's',
    });

    const res = await request(app)
      .post('/gated')
      .set(HEADER_CHALLENGE, JSON.stringify(STUB_CHALLENGE))
      .set(HEADER_PROOF_NONCE, '01')
      .set(HEADER_PROOF_DIGEST, '02')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ valid: false, reason: 'invalid_proof', expired: false });
  });

  it('returns 403 with already_redeemed reason on replay', async () => {
    const client = makeClient({
      redeem: vi.fn().mockResolvedValue(STUB_VERIFY_ALREADY),
    });
    const app = makeApp({
      client,
      purpose: 'r',
      resource: 'r',
      subject: 's',
    });

    const res = await request(app)
      .post('/gated')
      .set(HEADER_CHALLENGE, JSON.stringify(STUB_CHALLENGE))
      .set(HEADER_PROOF_NONCE, '01')
      .set(HEADER_PROOF_DIGEST, '02')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('already_redeemed');
  });
});

describe('btxAdmission — 400 bad request path', () => {
  it('returns 400 if challenge header missing but proof headers present', async () => {
    const client = makeClient();
    const app = makeApp({
      client,
      purpose: 'r',
      resource: 'r',
      subject: 's',
      // Force "proof present" so we bypass the no-headers 402 path
      isProofPresent: () => true,
    });

    const res = await request(app).post('/gated').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_challenge_header');
  });

  it('returns 400 on malformed JSON in X-BTX-Challenge', async () => {
    const client = makeClient();
    const app = makeApp({
      client,
      purpose: 'r',
      resource: 'r',
      subject: 's',
    });

    const res = await request(app)
      .post('/gated')
      .set(HEADER_CHALLENGE, 'not-json{{{')
      .set(HEADER_PROOF_NONCE, '01')
      .set(HEADER_PROOF_DIGEST, '02')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('malformed_challenge_header');
  });

  it('returns 400 on X-BTX-Challenge-Id mismatch with embedded id', async () => {
    const client = makeClient();
    const app = makeApp({
      client,
      purpose: 'r',
      resource: 'r',
      subject: 's',
    });

    const res = await request(app)
      .post('/gated')
      .set(HEADER_CHALLENGE, JSON.stringify(STUB_CHALLENGE))
      .set(HEADER_CHALLENGE_ID, 'wrong-id')
      .set(HEADER_PROOF_NONCE, '01')
      .set(HEADER_PROOF_DIGEST, '02')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('challenge_id_mismatch');
  });
});

describe('btxAdmission — error propagation via next(err)', () => {
  it('client.issue throws → next(err) → Express returns 500', async () => {
    const client = makeClient({
      issue: vi.fn().mockRejectedValue(new Error('btxd unreachable')),
    });
    const app = makeApp({
      client,
      purpose: 'r',
      resource: 'r',
      subject: 's',
    });

    const res = await request(app).post('/gated').send({});
    expect(res.status).toBe(500);
  });

  it('client.redeem throws → next(err) → Express returns 500', async () => {
    const client = makeClient({
      redeem: vi.fn().mockRejectedValue(new Error('btxd unreachable')),
    });
    const app = makeApp({
      client,
      purpose: 'r',
      resource: 'r',
      subject: 's',
    });

    const res = await request(app)
      .post('/gated')
      .set(HEADER_CHALLENGE, JSON.stringify(STUB_CHALLENGE))
      .set(HEADER_PROOF_NONCE, '01')
      .set(HEADER_PROOF_DIGEST, '02')
      .send({});

    expect(res.status).toBe(500);
  });
});

describe('btxAdmission — isProofPresent override', () => {
  it('honors a custom presence check', async () => {
    const client = makeClient();
    const app = makeApp({
      client,
      purpose: 'r',
      resource: 'r',
      subject: 's',
      // Pretend proof is never present → always issue
      isProofPresent: () => false,
    });

    // Send proof headers anyway — override should ignore them
    const res = await request(app)
      .post('/gated')
      .set(HEADER_CHALLENGE, JSON.stringify(STUB_CHALLENGE))
      .set(HEADER_PROOF_NONCE, '01')
      .set(HEADER_PROOF_DIGEST, '02')
      .send({});

    expect(res.status).toBe(402);
    expect(client.issue).toHaveBeenCalledOnce();
    expect(client.redeem).not.toHaveBeenCalled();
  });
});
