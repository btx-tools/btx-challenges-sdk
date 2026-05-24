// Shared test helpers (not a *.test.ts → not collected as a suite).
import { Solver, type Challenge } from '@btx-tools/challenges-sdk';
import type {
  BackendName,
  MiningJob,
  MiningPoolAdapter,
  ShareResult,
  ShareSubmission,
  SolveBackend,
} from '../../src/index.js';

const PREV = '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210';
const MERK = 'fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef';
const SEED_A = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const SEED_B = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

/** A valid solvable n=8 challenge. `target` defaults to all-ones (every nonce passes). */
export function synthChallenge(target = 'ff'.repeat(32)): Challenge {
  return {
    kind: 'matmul_service_challenge_v1',
    challenge_id: 'mine',
    issued_at: 0,
    expires_at: 0,
    expires_in_s: 300,
    binding: {
      chain: 'main',
      purpose: 'mining',
      resource: 'pool',
      subject: 'w',
      resource_hash: '00',
      subject_hash: '00',
      salt: '00',
      anchor_height: 0,
      anchor_hash: '00',
    },
    proof_policy: {
      verification_rule: 'r',
      sigma_gate_applied: false,
      expiration_enforced: false,
      challenge_id_required: false,
      replay_protection: 'none',
      redeem_rpc: 'redeemmatmulservicechallenge',
      solve_rpc: 'solvematmulservicechallenge',
      locally_issued_required: false,
    },
    challenge: {
      chain: 'main',
      algorithm: 'matmul',
      height: 0,
      previousblockhash: PREV,
      mintime: 0,
      bits: '1d00ffff',
      difficulty: 1,
      target,
      noncerange: '00000000ffffffff',
      header_context: {
        version: 1,
        previousblockhash: PREV,
        merkleroot: MERK,
        time: 1700000000,
        bits: '1d00ffff',
        nonce64_start: 0,
        matmul_dim: 8,
        seed_a: SEED_A,
        seed_b: SEED_B,
      },
      matmul: {
        n: 8,
        b: 4,
        r: 2,
        q: 2147483647,
        min_dimension: 4,
        max_dimension: 512,
        seed_a: SEED_A,
        seed_b: SEED_B,
      },
    },
  };
}

export function synthJob(jobId: string, extra: Partial<MiningJob> = {}): MiningJob {
  return { jobId, challenge: synthChallenge(), ...extra };
}

/** Local share verify via the public Solver (re-solve a 1-nonce window). No btxd. */
export async function verifyShareLocal(
  challenge: Challenge,
  nonce_hex: string,
  digest_hex: string,
): Promise<boolean> {
  try {
    const out = await Solver.solve(challenge, {
      mode: 'pure-js',
      pureJs: { nonceStart: BigInt('0x' + nonce_hex), maxTries: 1 },
    });
    return out.nonce64_hex === nonce_hex && out.digest_hex === digest_hex;
  } catch {
    return false; // digest > target at that nonce
  }
}

/** A mock work source: serves jobs from a provider, records + accepts shares (configurable). */
export class MockPoolAdapter implements MiningPoolAdapter {
  readonly shares: ShareSubmission[] = [];
  getJobCalls = 0;
  constructor(
    private readonly jobProvider: () => MiningJob,
    private readonly acceptFn: (s: ShareSubmission) => boolean | Promise<boolean> = () => true,
  ) {}
  async getJob(): Promise<MiningJob> {
    this.getJobCalls++;
    return this.jobProvider();
  }
  async submitShare(share: ShareSubmission): Promise<ShareResult> {
    this.shares.push(share);
    const accepted = await this.acceptFn(share);
    return { accepted, reason: accepted ? 'ok' : 'invalid' };
  }
}

/** A deterministic backend for loop-logic tests (no real solving). */
export interface SpyBackend extends SolveBackend {
  state: { built: number; destroyed: number; disposed: number };
}
export function spyBackend(
  opts: { name?: BackendName; hit?: boolean; delayMs?: number; failForJob?: boolean } = {},
): SpyBackend {
  const state = { built: 0, destroyed: 0, disposed: 0 };
  return {
    name: opts.name ?? 'pure-js',
    state,
    async forJob() {
      if (opts.failForJob) throw new Error('forJob boom (simulated setup failure)');
      state.built++;
      return {
        suggestedChunk: 64,
        async searchChunk(start: bigint) {
          if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs)); // simulate work (dt > 0)
          if (opts.hit === false) return undefined;
          return { nonce_hex: start.toString(16).padStart(16, '0'), digest_hex: 'ab'.repeat(32) };
        },
        destroy() {
          state.destroyed++;
        },
      };
    },
    dispose() {
      state.disposed++;
    },
  };
}

/** A sleep that yields a real macrotask (so an injected-sleep miner loop stays cooperative in tests). */
export const yieldSleep = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Poll a predicate until true or timeout (drives the async miner loop forward). */
export async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}
