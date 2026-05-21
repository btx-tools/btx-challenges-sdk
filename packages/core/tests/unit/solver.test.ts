/**
 * Solver unit tests — verifies the Day-2 mode-dispatch logic.
 *
 * Mocks the BtxChallengeClient at the HTTP layer with msw so we exercise
 * the real client.solve() call path under Solver's hood (not stubbed-out
 * function references).
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BtxChallengeClient, Solver } from '../../src/index.js';
import type { Challenge, SolverOutput } from '../../src/index.js';

const RPC_URL = 'http://127.0.0.1:19332/';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const makeClient = () =>
  new BtxChallengeClient({
    rpcUrl: RPC_URL,
    rpcAuth: { user: 'rpcuser', pass: 'rpcpass' },
    timeoutMs: 5_000,
  });

const stubChallenge: Challenge = {
  kind: 'matmul_service_challenge_v1',
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

const stubSolverOutput: SolverOutput = {
  nonce64_hex: 'abcdef0123456789',
  digest_hex: '00'.repeat(32),
  proof: { ok: true },
};

/**
 * A valid-hex challenge usable by the pure-JS solver. Uses tiny matrix dims
 * (n=4, b=2, r=1) and a maximally-lax target so the solver completes in
 * roughly one attempt.
 */
const pureJsChallenge: Challenge = {
  ...stubChallenge,
  challenge: {
    ...stubChallenge.challenge,
    target: 'ff'.repeat(32),
    header_context: {
      ...stubChallenge.challenge.header_context,
      previousblockhash: '11'.repeat(32),
      merkleroot: '22'.repeat(32),
      matmul_dim: 4,
      seed_a: '33'.repeat(32),
      seed_b: '44'.repeat(32),
    },
    matmul: {
      ...stubChallenge.challenge.matmul,
      n: 4,
      b: 2,
      r: 1,
      seed_a: '33'.repeat(32),
      seed_b: '44'.repeat(32),
    },
  },
};

/** Install an RPC handler that returns `stubSolverOutput` for solvematmulservicechallenge. */
function mockSolvematmulRpc(): void {
  server.use(
    http.post(RPC_URL, async ({ request }) => {
      const body = (await request.json()) as { method: string; params: unknown[] };
      if (body.method === 'solvematmulservicechallenge') {
        return HttpResponse.json({ result: stubSolverOutput, error: null, id: 1 });
      }
      return HttpResponse.json(
        { result: null, error: { code: -32601, message: 'unexpected method' }, id: 1 },
        { status: 200 },
      );
    }),
  );
}

// =============================================================================

describe('Solver.solve — mode dispatch (Day 2 RPC-only)', () => {
  describe('mode: "rpc"', () => {
    it('delegates to rpcClient.solve() and returns its result', async () => {
      mockSolvematmulRpc();
      const client = makeClient();
      const out = await Solver.solve(stubChallenge, { mode: 'rpc', rpcClient: client });
      expect(out).toEqual(stubSolverOutput);
    });

    it('throws if rpcClient is not provided', async () => {
      await expect(Solver.solve(stubChallenge, { mode: 'rpc' })).rejects.toThrow(
        /requires opts\.rpcClient/i,
      );
    });

    it('passes the actual challenge to btxd (not a placeholder)', async () => {
      let observedParams: unknown[] | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          const body = (await request.json()) as { method: string; params: unknown[] };
          observedParams = body.params;
          return HttpResponse.json({ result: stubSolverOutput, error: null, id: 1 });
        }),
      );
      await Solver.solve(stubChallenge, { mode: 'rpc', rpcClient: makeClient() });
      // solvematmulservicechallenge takes [challenge] as positional arg
      expect(observedParams).toEqual([stubChallenge]);
    });

    it('propagates RPC errors (no swallowing)', async () => {
      server.use(
        http.post(RPC_URL, () =>
          HttpResponse.json({
            result: null,
            error: { code: -8, message: 'mining paused by chain guard' },
            id: 1,
          }),
        ),
      );
      await expect(
        Solver.solve(stubChallenge, { mode: 'rpc', rpcClient: makeClient() }),
      ).rejects.toMatchObject({
        name: 'BtxRpcError',
        code: -8,
      });
    });
  });

  describe('mode: "pure-js"', () => {
    it('returns a SolverOutput on a trivially-solvable challenge', async () => {
      const out = await Solver.solve(pureJsChallenge, { mode: 'pure-js' });
      expect(out.nonce64_hex).toHaveLength(16);
      expect(out.digest_hex).toHaveLength(64);
      expect(out.proof).toMatchObject({
        challenge: pureJsChallenge,
        nonce64_hex: out.nonce64_hex,
        digest_hex: out.digest_hex,
      });
    });

    it('forwards pureJs options (maxTries) to the solver', async () => {
      // target=0 + maxTries=2 → exhausts without finding a proof
      const impossible: Challenge = {
        ...pureJsChallenge,
        challenge: {
          ...pureJsChallenge.challenge,
          target: '00'.repeat(32),
        },
      };
      await expect(
        Solver.solve(impossible, { mode: 'pure-js', pureJs: { maxTries: 2 } }),
      ).rejects.toThrow(/exhausted maxTries=2/);
    });

    it('propagates malformed-challenge errors', async () => {
      const bad: Challenge = {
        ...pureJsChallenge,
        challenge: { ...pureJsChallenge.challenge, target: 'nothex' },
      };
      await expect(Solver.solve(bad, { mode: 'pure-js' })).rejects.toThrow(
        /expected 64 hex chars/,
      );
    });
  });

  describe('mode: "auto" (default)', () => {
    it('picks rpc when rpcClient is provided', async () => {
      mockSolvematmulRpc();
      const out = await Solver.solve(stubChallenge, { mode: 'auto', rpcClient: makeClient() });
      expect(out).toEqual(stubSolverOutput);
    });

    it('falls back to pure-js when no rpcClient', async () => {
      const out = await Solver.solve(pureJsChallenge, { mode: 'auto' });
      expect(out.nonce64_hex).toHaveLength(16);
    });

    it('is the default when opts.mode is omitted', async () => {
      mockSolvematmulRpc();
      const out = await Solver.solve(stubChallenge, { rpcClient: makeClient() });
      expect(out).toEqual(stubSolverOutput);
    });

    it('is the default with empty options object (falls back to pure-js)', async () => {
      const out = await Solver.solve(pureJsChallenge);
      expect(out.nonce64_hex).toHaveLength(16);
    });
  });
});
