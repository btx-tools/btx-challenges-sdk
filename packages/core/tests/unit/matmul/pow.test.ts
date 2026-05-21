import { describe, expect, it } from 'vitest';

import { solveJs } from '../../../src/matmul/pow.js';
import type { Challenge } from '../../../src/types.js';

const ZERO_HASH = '00'.repeat(32);
const ALL_FF = 'ff'.repeat(32);
const SOME_HASH_A = '11'.repeat(32);
const SOME_HASH_B = '22'.repeat(32);
const SOME_HASH_C = '33'.repeat(32);

/** Build a synthetic challenge envelope for testing. */
function makeChallenge(
  overrides: {
    n?: number;
    b?: number;
    r?: number;
    target?: string;
    nonce64_start?: number;
    seed_a?: string;
    seed_b?: string;
  } = {},
): Challenge {
  return {
    challenge_id: 'test',
    issued_at: 0,
    expires_at: 0,
    expires_in_s: 300,
    binding: {
      chain: 'btx',
      purpose: 'test',
      resource: 'test',
      subject: 'test',
      resource_hash: ZERO_HASH,
      subject_hash: ZERO_HASH,
      salt: '00',
      anchor_height: 0,
      anchor_hash: ZERO_HASH,
    },
    proof_policy: {
      verification_rule: 'test',
      sigma_gate_applied: true,
      expiration_enforced: false,
      challenge_id_required: false,
      replay_protection: 'none',
      redeem_rpc: 'redeemmatmulservicechallenge',
      solve_rpc: 'solvematmulservicechallenge',
      locally_issued_required: false,
    },
    challenge: {
      chain: 'btx',
      algorithm: 'matmul-pow-v3',
      height: 0,
      previousblockhash: SOME_HASH_A,
      mintime: 0,
      bits: '1d00ffff',
      difficulty: 1,
      target: overrides.target ?? ALL_FF,
      noncerange: '00000000ffffffff',
      header_context: {
        version: 1,
        previousblockhash: SOME_HASH_A,
        merkleroot: SOME_HASH_B,
        time: 1700000000,
        bits: '1d00ffff',
        nonce64_start: overrides.nonce64_start ?? 0,
        matmul_dim: overrides.n ?? 4,
        seed_a: overrides.seed_a ?? SOME_HASH_A,
        seed_b: overrides.seed_b ?? SOME_HASH_B,
      },
      matmul: {
        n: overrides.n ?? 4,
        b: overrides.b ?? 2,
        r: overrides.r ?? 1,
        q: 2147483647,
        min_dimension: 4,
        max_dimension: 512,
        seed_a: overrides.seed_a ?? SOME_HASH_A,
        seed_b: overrides.seed_b ?? SOME_HASH_B,
      },
    },
  };
}

describe('matmul/pow — solveJs param validation', () => {
  it('rejects n=0', () => {
    expect(() => solveJs(makeChallenge({ n: 0 }))).toThrow('invalid matmul params');
  });

  it('rejects b=0', () => {
    expect(() => solveJs(makeChallenge({ b: 0 }))).toThrow('invalid matmul params');
  });

  it('rejects r=0', () => {
    expect(() => solveJs(makeChallenge({ r: 0 }))).toThrow('invalid matmul params');
  });

  it('rejects n not divisible by b', () => {
    expect(() => solveJs(makeChallenge({ n: 4, b: 3 }))).toThrow('not divisible');
  });

  it('rejects malformed seed_a', () => {
    expect(() => solveJs(makeChallenge({ seed_a: 'short' }))).toThrow('expected 64 hex chars');
  });

  it('rejects malformed target', () => {
    expect(() => solveJs(makeChallenge({ target: 'nothex' }))).toThrow('expected 64 hex chars');
  });
});

describe('matmul/pow — solveJs trivial target (digest ≤ 2^256-1)', () => {
  it('solves on first attempt with target = all-ones', () => {
    const result = solveJs(makeChallenge({ target: ALL_FF }));
    expect(result).not.toBeNull();
    expect(result!.nonce64_hex).toHaveLength(16);
    expect(result!.digest_hex).toHaveLength(64);
    expect(result!.proof).toMatchObject({
      nonce64_hex: result!.nonce64_hex,
      digest_hex: result!.digest_hex,
    });
  });

  it('respects nonceStart', () => {
    const result = solveJs(makeChallenge({ target: ALL_FF }), { nonceStart: 42n });
    expect(result).not.toBeNull();
    expect(result!.nonce64_hex).toBe('000000000000002a'); // 42 in hex
  });

  it('default nonceStart is header_context.nonce64_start', () => {
    const result = solveJs(makeChallenge({ target: ALL_FF, nonce64_start: 7 }));
    expect(result).not.toBeNull();
    expect(result!.nonce64_hex).toBe('0000000000000007');
  });

  it('maxTries 0 returns null', () => {
    const result = solveJs(makeChallenge({ target: ALL_FF }), { maxTries: 0 });
    expect(result).toBeNull();
  });
});

describe('matmul/pow — solveJs impossible target', () => {
  it('returns null when target = 0 and maxTries is small (with overwhelming probability)', () => {
    // target = 0 means digest must equal 0 exactly. Random 256-bit digest has
    // probability 2^-256 of being zero. Trying 5 nonces is effectively impossible.
    const result = solveJs(makeChallenge({ target: ZERO_HASH }), { maxTries: 5 });
    expect(result).toBeNull();
  });
});

describe('matmul/pow — solveJs determinism', () => {
  it('returns the same nonce + digest for the same challenge + start', () => {
    const c = makeChallenge({ target: ALL_FF, nonce64_start: 100 });
    const a = solveJs(c, { nonceStart: 100n });
    const b = solveJs(c, { nonceStart: 100n });
    expect(a).toEqual(b);
  });

  it('different challenges yield different digests', () => {
    const a = solveJs(makeChallenge({ target: ALL_FF, seed_a: SOME_HASH_A }));
    const b = solveJs(makeChallenge({ target: ALL_FF, seed_a: SOME_HASH_C }));
    expect(a!.digest_hex).not.toBe(b!.digest_hex);
  });
});

describe('matmul/pow — solveJs onAttempt callback', () => {
  it('fires for each attempt by default', () => {
    const attempts: Array<{ idx: number; nonce: bigint }> = [];
    // Use ZERO target so we keep looping until maxTries.
    solveJs(makeChallenge({ target: ZERO_HASH }), {
      maxTries: 3,
      onAttempt: (idx, nonce) => attempts.push({ idx, nonce }),
    });
    expect(attempts).toEqual([
      { idx: 0, nonce: 0n },
      { idx: 1, nonce: 1n },
      { idx: 2, nonce: 2n },
    ]);
  });

  it('respects attemptInterval', () => {
    const attempts: number[] = [];
    solveJs(makeChallenge({ target: ZERO_HASH }), {
      maxTries: 6,
      attemptInterval: 2,
      onAttempt: (idx) => attempts.push(idx),
    });
    expect(attempts).toEqual([0, 2, 4]);
  });

  it.each([1, 2, 5, 10])(
    'attemptInterval=%i fires the callback at the right indices',
    (interval) => {
      const attempts: number[] = [];
      const N = 30;
      solveJs(makeChallenge({ target: ZERO_HASH }), {
        maxTries: N,
        attemptInterval: interval,
        onAttempt: (idx) => attempts.push(idx),
      });
      const expected = Array.from({ length: Math.ceil(N / interval) }, (_, i) => i * interval);
      expect(attempts).toEqual(expected);
    },
  );
});

describe('matmul/pow — solveJs nonce overflow', () => {
  // The Solve loop checks `if (nonce === MAX_U64) return null` to mirror
  // btxd's `state.nonce == std::numeric_limits<uint64_t>::max() ? break`.
  // Audit finding B-5: this branch was not test-covered.
  it('returns null when starting at MAX_U64 with impossible target', () => {
    const MAX_U64 = (1n << 64n) - 1n;
    const result = solveJs(makeChallenge({ target: ZERO_HASH }), {
      maxTries: 3,
      nonceStart: MAX_U64,
    });
    // ZERO target = never solves. nonceStart=MAX_U64 → first attempt at MAX_U64,
    // doesn't satisfy target, hits the overflow check, returns null.
    expect(result).toBeNull();
  });

  it('returns null when wrapping past MAX_U64 within the maxTries window', () => {
    const MAX_U64 = (1n << 64n) - 1n;
    const result = solveJs(makeChallenge({ target: ZERO_HASH }), {
      maxTries: 10,
      nonceStart: MAX_U64 - 2n,
    });
    expect(result).toBeNull();
  });
});
