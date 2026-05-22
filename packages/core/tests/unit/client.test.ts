/**
 * Unit tests for BtxChallengeClient — exercises the HTTP path that ships to npm.
 *
 * Per audit finding C2: Day 1 only tested btxd-via-SSH, leaving the actual
 * `fetch`-based BtxChallengeClient at 0% coverage. This file fixes that.
 *
 * msw v2 intercepts at the http.request level (Node 18+ undici-compatible) so
 * we can assert request headers, request bodies, and response handling without
 * a real btxd.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BtxChallengeClient,
  BtxHttpError,
  BtxNetworkError,
  BtxParseError,
  BtxRpcError,
  BtxTimeoutError,
  type Challenge,
} from '../../src/index.js';

// --- mock server setup --------------------------------------------------------

const RPC_URL = 'http://127.0.0.1:19332/';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const makeClient = (overrides: Partial<{ user: string; pass: string; timeoutMs: number }> = {}) =>
  new BtxChallengeClient({
    rpcUrl: RPC_URL,
    rpcAuth: { user: overrides.user ?? 'rpcuser', pass: overrides.pass ?? 'rpcpass' },
    timeoutMs: overrides.timeoutMs ?? 5_000,
  });

const stubChallenge: Challenge = {
  challenge_id: 'test-cid',
  issued_at: 1779270000,
  expires_at: 1779270120,
  expires_in_s: 120,
  binding: {
    chain: 'main',
    purpose: 'rate_limit',
    resource: 'test:/r',
    subject: 'test:s',
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
    mintime: 1779270000,
    bits: '1e1bb4ae',
    difficulty: 0.0001,
    target: '0000...',
    noncerange: '0000000000000000ffffffffffffffff',
    header_context: {
      version: 1,
      previousblockhash: 'pp',
      merkleroot: 'mm',
      time: 1779270000,
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
};

// --- tests --------------------------------------------------------------------

describe('BtxChallengeClient.call() — request shape', () => {
  it('sends POST with content-type json and Basic auth (UTF-8 safe for non-ASCII passwords)', async () => {
    let observedAuth: string | null = null;
    let observedBody: unknown = null;

    server.use(
      http.post(RPC_URL, async ({ request }) => {
        observedAuth = request.headers.get('authorization');
        observedBody = await request.json();
        return HttpResponse.json({ result: { ok: true }, error: null, id: 1 });
      }),
    );

    const client = makeClient({ user: 'rpcuser', pass: 'pässwört' }); // non-ASCII
    const out = await client.call<{ ok: boolean }>('ping');

    expect(out).toEqual({ ok: true });
    // Buffer.from('rpcuser:pässwört', 'utf8').toString('base64')
    const expected = Buffer.from('rpcuser:pässwört', 'utf8').toString('base64');
    expect(observedAuth).toBe(`Basic ${expected}`);

    expect(observedBody).toMatchObject({
      jsonrpc: '1.0',
      method: 'ping',
      params: [],
    });
  });

  it('produces a unique id per call (no ++counter collision)', async () => {
    const seenIds = new Set<string | number>();
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const b = (await request.json()) as { id: string | number };
        seenIds.add(b.id);
        return HttpResponse.json({ result: null, error: null, id: b.id });
      }),
    );
    const client = makeClient();
    await Promise.all(Array.from({ length: 8 }, () => client.call('ping')));
    expect(seenIds.size).toBe(8);
  });

  it('passes positional params verbatim', async () => {
    let observedParams: unknown[] | null = null;
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const b = (await request.json()) as { params: unknown[] };
        observedParams = b.params;
        return HttpResponse.json({ result: 'ok', error: null, id: 1 });
      }),
    );
    const client = makeClient();
    await client.call('echo', ['a', 1, true, { nested: 'x' }]);
    expect(observedParams).toEqual(['a', 1, true, { nested: 'x' }]);
  });
});

describe('BtxChallengeClient — error normalization', () => {
  it('maps JSON-RPC error envelope → BtxRpcError', async () => {
    server.use(
      http.post(RPC_URL, () =>
        HttpResponse.json({ result: null, error: { code: -8, message: 'bad params' }, id: 1 }),
      ),
    );
    const client = makeClient();
    await expect(client.call('boom')).rejects.toMatchObject({
      name: 'BtxRpcError',
      code: -8,
    });
    await expect(client.call('boom')).rejects.toBeInstanceOf(BtxRpcError);
  });

  it('maps non-2xx HTTP → BtxHttpError with redacted body (H2)', async () => {
    server.use(
      http.post(RPC_URL, () =>
        HttpResponse.text('Authorization: basic dXNlcjpwYXNz\nrejected: bad creds', {
          status: 401,
        }),
      ),
    );
    const client = makeClient();
    try {
      await client.call('whoami');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BtxHttpError);
      const e = err as BtxHttpError;
      expect(e.status).toBe(401);
      // Audit H2: Authorization header in body must be redacted.
      expect(e.body).not.toContain('dXNlcjpwYXNz');
      expect(e.body).toContain('[REDACTED]');
    }
  });

  it('redacts btxd config-line credentials in error bodies (re-audit N2)', async () => {
    server.use(
      http.post(RPC_URL, () =>
        HttpResponse.text(
          'failed to load conf:\nrpcuser=alice\nrpcpassword=hunter2\nrpcauth=alice:abc$def',
          { status: 500 },
        ),
      ),
    );
    const client = makeClient();
    try {
      await client.call('debug');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BtxHttpError);
      const e = err as BtxHttpError;
      expect(e.body).not.toContain('hunter2');
      expect(e.body).not.toContain('alice:abc$def');
      // alice as rpcuser=value should also redact the value side
      expect(e.body).toContain('rpcuser=[REDACTED]');
      expect(e.body).toContain('rpcpassword=[REDACTED]');
      expect(e.body).toContain('rpcauth=[REDACTED]');
    }
  });

  it('maps non-JSON 2xx body → BtxParseError', async () => {
    server.use(
      http.post(RPC_URL, () => HttpResponse.text('<html>not json</html>', { status: 200 })),
    );
    const client = makeClient();
    await expect(client.call('weird')).rejects.toBeInstanceOf(BtxParseError);
  });

  it('maps abort/timeout → BtxTimeoutError', async () => {
    server.use(
      http.post(RPC_URL, async () => {
        // Hang past the timeout
        await new Promise((r) => setTimeout(r, 500));
        return HttpResponse.json({ result: 'late', error: null, id: 1 });
      }),
    );
    const client = makeClient({ timeoutMs: 50 });
    await expect(client.call('slow')).rejects.toBeInstanceOf(BtxTimeoutError);
  });

  it('maps network failure (no route) → BtxNetworkError', async () => {
    // Use an unmatched origin — msw with onUnhandledRequest:'error' would raise,
    // but we explicitly bypass to test the network-failure path.
    const client = new BtxChallengeClient({
      rpcUrl: 'http://127.0.0.1:1/',
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 1_000,
    });
    server.use(http.post('http://127.0.0.1:1/', () => HttpResponse.error()));
    await expect(client.call('unreachable')).rejects.toBeInstanceOf(BtxNetworkError);
  });
});

describe('BtxChallengeClient.issue() — param ordering + truncation', () => {
  it('sends only purpose/resource/subject when no optionals set', async () => {
    let observed: unknown[] | null = null;
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        observed = ((await request.json()) as { params: unknown[] }).params;
        return HttpResponse.json({ result: stubChallenge, error: null, id: 1 });
      }),
    );
    await makeClient().issue({
      purpose: 'rate_limit',
      resource: 'r',
      subject: 's',
    });
    expect(observed).toEqual(['rate_limit', 'r', 's']);
  });

  it('truncates positional args at last-set (does not pad with defaults)', async () => {
    let observed: unknown[] | null = null;
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        observed = ((await request.json()) as { params: unknown[] }).params;
        return HttpResponse.json({ result: stubChallenge, error: null, id: 1 });
      }),
    );
    await makeClient().issue({
      purpose: 'rate_limit',
      resource: 'r',
      subject: 's',
      target_solve_time_s: 2,
      expires_in_s: 60,
    });
    // Sends 5 args, not all 13 — btxd applies its own defaults for the rest.
    expect(observed).toEqual(['rate_limit', 'r', 's', 2, 60]);
  });

  it('skips undefined slots between set values by including them as undefined-equivalent', async () => {
    let observed: unknown[] | null = null;
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        observed = ((await request.json()) as { params: unknown[] }).params;
        return HttpResponse.json({ result: stubChallenge, error: null, id: 1 });
      }),
    );
    await makeClient().issue({
      purpose: 'rate_limit',
      resource: 'r',
      subject: 's',
      max_solve_time_s: 10, // index 10
    });
    // Positions 3-9 are undefined; we still include them up to index 10.
    expect(Array.isArray(observed)).toBe(true);
    expect(observed).toHaveLength(11);
    expect((observed as unknown[])[10]).toBe(10);
  });
});

describe('BtxChallengeClient — batch size guard (audit M2)', () => {
  it('verifyBatch rejects empty array', async () => {
    await expect(makeClient().verifyBatch([])).rejects.toBeInstanceOf(RangeError);
  });

  it('redeemBatch rejects over-size array (>256)', async () => {
    const entries = Array.from({ length: 257 }, () => ({
      challenge: stubChallenge,
      nonce64_hex: '0'.repeat(16),
      digest_hex: '0'.repeat(64),
    }));
    await expect(makeClient().redeemBatch(entries)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('BtxChallengeClient — D-4 per-method timeout (audit D-4)', () => {
  it('methodTimeouts[method] overrides client-wide timeoutMs', async () => {
    let timedOut = false;
    server.use(
      http.post(RPC_URL, async () => {
        // Hold past the per-method budget (50ms) but well under client-wide (5000ms)
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json({ result: stubChallenge, error: null, id: 1 });
      }),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 5_000,
      methodTimeouts: { getmatmulservicechallenge: 50 },
    });
    try {
      await client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' });
    } catch (err) {
      timedOut = err instanceof BtxTimeoutError;
    }
    expect(timedOut).toBe(true);
  });

  it('falls back to client-wide timeoutMs when method has no override', async () => {
    server.use(
      http.post(RPC_URL, () =>
        HttpResponse.json({ result: stubChallenge, error: null, id: 1 }),
      ),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 5_000,
      methodTimeouts: { verifymatmulserviceproof: 50 }, // not the method we'll call
    });
    // issue → getmatmulservicechallenge → no override → uses 5000ms
    const c = await client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' });
    expect(c.challenge_id).toBe('test-cid');
  });

  it('falls back to 30s default when neither override nor timeoutMs is set', async () => {
    // Only assert the option resolves cleanly. We don't want to actually wait 30s
    // to confirm the default; covered by code review of client.ts:62.
    server.use(
      http.post(RPC_URL, () =>
        HttpResponse.json({ result: stubChallenge, error: null, id: 1 }),
      ),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      // no timeoutMs, no methodTimeouts
    });
    const c = await client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' });
    expect(c.challenge_id).toBe('test-cid');
  });

  it('per-method long timeout enables a slow solve without bloating client-wide', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = (await request.json()) as { method: string };
        // Short delay for getmatmulservicechallenge (issue), longer for solve
        if (body.method === 'solvematmulservicechallenge') {
          await new Promise((r) => setTimeout(r, 150));
        }
        return HttpResponse.json({
          result: body.method === 'getmatmulservicechallenge'
            ? stubChallenge
            : { nonce64_hex: '0'.repeat(16), digest_hex: '0'.repeat(64), proof: {} },
          error: null,
          id: 1,
        });
      }),
    );
    // Client-wide is 50ms (would kill solve), but we set 500ms specifically for solve
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 50,
      methodTimeouts: {
        getmatmulservicechallenge: 5_000,
        solvematmulservicechallenge: 500,
      },
    });
    // Both calls should succeed because each has a per-method budget that fits its work.
    const c = await client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' });
    expect(c.challenge_id).toBe('test-cid');
    const p = await client.solve(c);
    expect(p.nonce64_hex).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('BtxChallengeClient — D-3 retry/backoff (audit D-3)', () => {
  it('default behavior: retry: { max: 0 } means single attempt', async () => {
    let attempts = 0;
    server.use(
      http.post(RPC_URL, () => {
        attempts++;
        return HttpResponse.text('boom', { status: 502 });
      }),
    );
    await expect(
      makeClient().issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }),
    ).rejects.toBeInstanceOf(BtxHttpError);
    expect(attempts).toBe(1);
  });

  it('retries on 5xx HTTP responses up to max', async () => {
    let attempts = 0;
    server.use(
      http.post(RPC_URL, () => {
        attempts++;
        return HttpResponse.text('boom', { status: 503 });
      }),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      retry: { max: 2, baseDelayMs: 1 },
    });
    await expect(
      client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }),
    ).rejects.toBeInstanceOf(BtxHttpError);
    // 1 initial + 2 retries = 3 attempts
    expect(attempts).toBe(3);
  });

  it('succeeds after transient 5xx if the next attempt is 200', async () => {
    let attempts = 0;
    server.use(
      http.post(RPC_URL, () => {
        attempts++;
        if (attempts < 3) return HttpResponse.text('flap', { status: 502 });
        return HttpResponse.json({ result: stubChallenge, error: null, id: 1 });
      }),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      retry: { max: 3, baseDelayMs: 1 },
    });
    const c = await client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' });
    expect(c.challenge_id).toBe('test-cid');
    expect(attempts).toBe(3);
  });

  it('does NOT retry on 4xx HTTP responses', async () => {
    let attempts = 0;
    server.use(
      http.post(RPC_URL, () => {
        attempts++;
        return HttpResponse.text('nope', { status: 401 });
      }),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      retry: { max: 5, baseDelayMs: 1 },
    });
    await expect(
      client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }),
    ).rejects.toBeInstanceOf(BtxHttpError);
    expect(attempts).toBe(1);
  });

  it('does NOT retry on JSON-RPC error envelope (deterministic)', async () => {
    let attempts = 0;
    server.use(
      http.post(RPC_URL, () => {
        attempts++;
        return HttpResponse.json({
          result: null,
          error: { code: -32601, message: 'method not found' },
          id: 1,
        });
      }),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      retry: { max: 5, baseDelayMs: 1 },
    });
    await expect(
      client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }),
    ).rejects.toBeInstanceOf(BtxRpcError);
    expect(attempts).toBe(1);
  });

  it('does NOT retry on timeout (TimeoutError is final)', async () => {
    let attempts = 0;
    server.use(
      http.post(RPC_URL, async () => {
        attempts++;
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json({ result: stubChallenge, error: null, id: 1 });
      }),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 50,
      retry: { max: 5, baseDelayMs: 1 },
    });
    await expect(
      client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }),
    ).rejects.toBeInstanceOf(BtxTimeoutError);
    expect(attempts).toBe(1);
  });
});
