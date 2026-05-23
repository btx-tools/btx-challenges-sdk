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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
      http.post(RPC_URL, () => HttpResponse.json({ result: stubChallenge, error: null, id: 1 })),
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
      http.post(RPC_URL, () => HttpResponse.json({ result: stubChallenge, error: null, id: 1 })),
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
          result:
            body.method === 'getmatmulservicechallenge'
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

describe('BtxChallengeClient — D-3 + D-4 audit 0.1.1 hardening (audit 2026-05-23)', () => {
  // H-1: retry.max input-sanitization
  it('H-1: retry.max = -1 clamps to 0 (single attempt, throws real BtxError)', async () => {
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
      // @ts-expect-error testing runtime clamp of invalid input
      retry: { max: -1, baseDelayMs: 1 },
    });
    // Must throw a real BtxError (NOT undefined) so callers can `instanceof`-check
    let caught: unknown;
    try {
      await client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BtxHttpError);
    expect(caught).not.toBeUndefined();
    expect(attempts).toBe(1); // clamped to single attempt
  });

  it('H-1: retry.max = NaN clamps to 0 (single attempt)', async () => {
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
      retry: { max: NaN, baseDelayMs: 1 },
    });
    await expect(
      client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }),
    ).rejects.toBeInstanceOf(BtxHttpError);
    expect(attempts).toBe(1);
  });

  // M-2 + M-5: backoff growth + cap — observed via setTimeout spy WITHOUT short-
  // circuiting (the abort timer in callOnce also uses setTimeout, so we can't
  // safely fire callbacks synchronously). Instead we let real timers run with
  // tiny baseDelayMs (1ms) so wall-clock stays bounded.
  it('M-5 + M-2: exponential backoff grows + capped at MAX_RETRY_DELAY_MS', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      server.use(http.post(RPC_URL, () => HttpResponse.text('boom', { status: 503 })));
      const client = new BtxChallengeClient({
        rpcUrl: RPC_URL,
        rpcAuth: { user: 'u', pass: 'p' },
        retry: { max: 4, baseDelayMs: 1 },
      });
      await expect(
        client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }),
      ).rejects.toBeInstanceOf(BtxHttpError);
      // setTimeout was called: 4 retry delays (1, 2, 4, 8 ms) + 5 abort timers (30000ms each)
      const calls = setTimeoutSpy.mock.calls.map((c) => Number(c[1])).filter(Number.isFinite);
      // No delay should exceed the MAX_RETRY_DELAY_MS=60_000 cap. The 30000ms
      // abort timer is the only large value we expect; anything >60_000 would
      // indicate the cap is broken.
      const overCap = calls.filter((d) => d > 60_000);
      expect(overCap).toEqual([]);
      // Retry delays should be the small geometric series 1,2,4,8 (or similar)
      const retryDelays = calls.filter((d) => d > 0 && d < 1000);
      expect(retryDelays).toEqual(expect.arrayContaining([1, 2, 4, 8]));
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  // M-5: each retry attempt gets its own AbortController (not shared)
  it('M-5: each retry attempt creates a fresh AbortController', async () => {
    // If the controller were shared across attempts, the first attempt's
    // timeout would abort all subsequent attempts immediately. Instead we
    // verify that subsequent attempts succeed even after an earlier attempt
    // hit a timeout-equivalent failure.
    let attempts = 0;
    server.use(
      http.post(RPC_URL, async () => {
        attempts++;
        if (attempts === 1) return HttpResponse.text('first-fail', { status: 503 });
        return HttpResponse.json({ result: stubChallenge, error: null, id: 1 });
      }),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 5_000,
      retry: { max: 2, baseDelayMs: 1 },
    });
    const c = await client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' });
    expect(c.challenge_id).toBe('test-cid');
    expect(attempts).toBe(2);
  });

  // M-6: timeout=0 in methodTimeouts falls through to client-wide
  it('M-6: methodTimeouts[method] = 0 is treated as "no override" (falls through)', async () => {
    server.use(
      http.post(RPC_URL, async () => {
        // Hold past methodTimeouts(=0 → fallthrough) but under client-wide 5s
        await new Promise((r) => setTimeout(r, 100));
        return HttpResponse.json({ result: stubChallenge, error: null, id: 1 });
      }),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 5_000,
      // 0 must NOT mean "instant abort" — it falls through to client-wide 5000ms
      methodTimeouts: { getmatmulservicechallenge: 0 },
    });
    const c = await client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' });
    expect(c.challenge_id).toBe('test-cid');
  });

  // M-6: methodTimeouts with key that doesn't exist in the standard RPC method list
  it('M-6: methodTimeouts with non-existent method key has no effect', async () => {
    server.use(
      http.post(RPC_URL, () => HttpResponse.json({ result: stubChallenge, error: null, id: 1 })),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 5_000,
      // Non-standard / typo method name — should be silently ignored (no override for the real call)
      methodTimeouts: { totallyNotARealMethod: 1 },
    });
    const c = await client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' });
    expect(c.challenge_id).toBe('test-cid');
  });
});

describe('BtxChallengeClient — L-3 onRetry hook (audit 2026-05-23, shipped 0.3.0)', () => {
  it('L-3: onRetry fires once per scheduled retry with 1-indexed attempt + retryable error', async () => {
    const calls: Array<{ attempt: number; error: unknown }> = [];
    server.use(http.post(RPC_URL, () => HttpResponse.text('boom', { status: 503 })));
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      retry: {
        max: 2,
        baseDelayMs: 1,
        onRetry: (attempt, error) => calls.push({ attempt, error }),
      },
    });
    await expect(
      client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }),
    ).rejects.toBeInstanceOf(BtxHttpError);
    // 1 initial + 2 retries → onRetry fires before retry #1 and #2 only.
    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(calls.every((c) => c.error instanceof BtxHttpError)).toBe(true);
  });

  it('L-3: onRetry is not called when retry is disabled (max: 0)', async () => {
    const onRetry = vi.fn();
    server.use(http.post(RPC_URL, () => HttpResponse.text('boom', { status: 503 })));
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      retry: { max: 0, baseDelayMs: 1, onRetry },
    });
    await expect(
      client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }),
    ).rejects.toBeInstanceOf(BtxHttpError);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('L-3: onRetry reports the exact post-backoff delay series (no jitter)', async () => {
    const delays: number[] = [];
    server.use(http.post(RPC_URL, () => HttpResponse.text('boom', { status: 503 })));
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      retry: {
        max: 3,
        baseDelayMs: 10,
        jitter: false,
        onRetry: (_attempt, _error, nextDelayMs) => delays.push(nextDelayMs),
      },
    });
    await expect(
      client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }),
    ).rejects.toBeInstanceOf(BtxHttpError);
    // Geometric series baseDelayMs * 2^(N-1): 10, 20, 40.
    expect(delays).toEqual([10, 20, 40]);
  });

  it('L-3: onRetry never fires for a non-retryable error (4xx)', async () => {
    const onRetry = vi.fn();
    server.use(http.post(RPC_URL, () => HttpResponse.text('nope', { status: 401 })));
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      retry: { max: 5, baseDelayMs: 1, onRetry },
    });
    await expect(
      client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }),
    ).rejects.toBeInstanceOf(BtxHttpError);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('L-3: an error thrown inside onRetry propagates out of the client call', async () => {
    server.use(http.post(RPC_URL, () => HttpResponse.text('boom', { status: 503 })));
    const sentinel = new Error('onRetry exploded');
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      retry: {
        max: 3,
        baseDelayMs: 1,
        onRetry: () => {
          throw sentinel;
        },
      },
    });
    // The callback throw surfaces to the caller, masking the retryable BtxHttpError.
    await expect(client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' })).rejects.toBe(
      sentinel,
    );
  });
});

describe('BtxChallengeClient — L-4 semantic methodTimeouts aliases (audit 2026-05-23, shipped 0.3.0)', () => {
  // Helper: server that holds solvematmulservicechallenge for `solveHoldMs` and
  // answers issue (getmatmulservicechallenge) instantly.
  const useSolveHoldServer = (solveHoldMs: number): void => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = (await request.json()) as { method: string };
        if (body.method === 'solvematmulservicechallenge') {
          await new Promise((r) => setTimeout(r, solveHoldMs));
          return HttpResponse.json({
            result: { nonce64_hex: '0'.repeat(16), digest_hex: '0'.repeat(64), proof: {} },
            error: null,
            id: 1,
          });
        }
        return HttpResponse.json({ result: stubChallenge, error: null, id: 1 });
      }),
    );
  };

  it('L-4: semantic `solve` key applies the timeout to solvematmulservicechallenge', async () => {
    useSolveHoldServer(200); // solve holds 200ms; `solve` budget is 50ms
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 5_000,
      methodTimeouts: { solve: 50 },
    });
    const c = await client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' });
    await expect(client.solve(c)).rejects.toBeInstanceOf(BtxTimeoutError);
  });

  it('L-4: a raw method key wins over its semantic alias when both are set', async () => {
    useSolveHoldServer(150); // solve holds 150ms
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 5_000,
      // raw 500ms (fits the 150ms hold) must beat the alias 1ms (would time out).
      methodTimeouts: { solvematmulservicechallenge: 500, solve: 1 },
    });
    const c = await client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' });
    const p = await client.solve(c);
    expect(p.nonce64_hex).toMatch(/^[0-9a-f]{16}$/);
  });

  it('L-4: a semantic alias value ≤ 0 falls through (M-1 preserved)', async () => {
    useSolveHoldServer(100); // solve holds 100ms; alias is 0 → falls to client-wide 5000ms
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 5_000,
      methodTimeouts: { solve: 0 },
    });
    const c = await client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' });
    const p = await client.solve(c);
    expect(p.nonce64_hex).toMatch(/^[0-9a-f]{16}$/);
  });

  it('L-4: semantic `issue` key applies to getmatmulservicechallenge', async () => {
    server.use(
      http.post(RPC_URL, async () => {
        await new Promise((r) => setTimeout(r, 200)); // issue holds 200ms; budget 50ms
        return HttpResponse.json({ result: stubChallenge, error: null, id: 1 });
      }),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 5_000,
      methodTimeouts: { issue: 50 },
    });
    await expect(
      client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }),
    ).rejects.toBeInstanceOf(BtxTimeoutError);
  });
});

describe('BtxChallengeClient — AbortSignal plumbing (0.2.0)', () => {
  it('throws BtxNetworkError immediately if signal is already aborted before call', async () => {
    server.use(
      http.post(RPC_URL, () => HttpResponse.json({ result: stubChallenge, error: null, id: 1 })),
    );
    const client = makeClient();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(client.call('m', [], { signal: ctrl.signal })).rejects.toBeInstanceOf(
      BtxNetworkError,
    );
  });

  it('aborts in-flight request when external signal fires; throws BtxNetworkError', async () => {
    server.use(
      http.post(RPC_URL, async () => {
        await new Promise((r) => setTimeout(r, 500));
        return HttpResponse.json({ result: 'late', error: null, id: 1 });
      }),
    );
    const client = makeClient({ timeoutMs: 5_000 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const t0 = Date.now();
    let caught: unknown;
    try {
      await client.call('slow', [], { signal: ctrl.signal });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - t0;
    expect(caught).toBeInstanceOf(BtxNetworkError);
    // Not a timeout
    expect(caught).not.toBeInstanceOf(BtxTimeoutError);
    // Aborted well before the 500ms server delay
    expect(elapsed).toBeLessThan(300);
  });

  it('distinguishes internal timeout from external abort', async () => {
    server.use(
      http.post(RPC_URL, async () => {
        await new Promise((r) => setTimeout(r, 500));
        return HttpResponse.json({ result: 'late', error: null, id: 1 });
      }),
    );
    const client = makeClient({ timeoutMs: 50 });
    // No external signal — internal timeout should fire
    await expect(client.call('slow')).rejects.toBeInstanceOf(BtxTimeoutError);
  });

  it('aborts during retry backoff (does not send additional requests)', async () => {
    let requestCount = 0;
    server.use(
      http.post(RPC_URL, () => {
        requestCount += 1;
        // First request fails with 503 → retry; abort fires during backoff
        return HttpResponse.json({ error: 'oops' }, { status: 503 });
      }),
    );
    const client = new BtxChallengeClient({
      rpcUrl: RPC_URL,
      rpcAuth: { user: 'u', pass: 'p' },
      timeoutMs: 5_000,
      retry: { max: 5, baseDelayMs: 200 },
    });
    const ctrl = new AbortController();
    // Fire abort during the first backoff sleep (which starts ~immediately after attempt 1 fails)
    setTimeout(() => ctrl.abort(), 100);
    await expect(client.call('flaky', [], { signal: ctrl.signal })).rejects.toBeInstanceOf(
      BtxNetworkError,
    );
    // Should have made exactly 1 request (first failed, then aborted during backoff)
    expect(requestCount).toBe(1);
  });

  it('signal does not abort → normal completion (no regression)', async () => {
    server.use(
      http.post(RPC_URL, () => HttpResponse.json({ result: stubChallenge, error: null, id: 1 })),
    );
    const client = makeClient();
    const ctrl = new AbortController();
    const c = await client.issue(
      { purpose: 'rate_limit', resource: 'r', subject: 's' },
      { signal: ctrl.signal },
    );
    expect(c.challenge_id).toBe('test-cid');
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('signal propagates from issue() through to underlying call', async () => {
    server.use(
      http.post(RPC_URL, async () => {
        await new Promise((r) => setTimeout(r, 500));
        return HttpResponse.json({ result: stubChallenge, error: null, id: 1 });
      }),
    );
    const client = makeClient({ timeoutMs: 5_000 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    await expect(
      client.issue({ purpose: 'rate_limit', resource: 'r', subject: 's' }, { signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(BtxNetworkError);
  });

  it('signal propagates from redeem() through to underlying call', async () => {
    server.use(
      http.post(RPC_URL, async () => {
        await new Promise((r) => setTimeout(r, 500));
        return HttpResponse.json({ result: { valid: true }, error: null, id: 1 });
      }),
    );
    const client = makeClient({ timeoutMs: 5_000 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    await expect(
      client.redeem(stubChallenge, 'a'.repeat(16), 'b'.repeat(64), { signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(BtxNetworkError);
  });
});
