// Self-contained reference work source (no btxd). Synthesizes service-challenge
// "jobs" with an easy share-target, rotates them periodically, and verifies
// submitted shares locally by re-solving a 1-nonce window via the public Solver.
//
// SWAPPABLE SEAM: a real pool implements the same MiningPoolAdapter over HTTP
// (`fetch` getJob/submitShare) or btxd `issue`/`redeem`, and verifies shares
// cheaply via Freivalds (O(n²)) server-side rather than the full re-solve below.
import { targetForExpectedAttempts, type MiningJob, type MiningPoolAdapter, type ShareResult, type ShareSubmission } from '@btx-tools/browser-miner';
import { Solver, type Challenge } from '@btx-tools/challenges-sdk';

const PREV = '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210';
const MERK = 'fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef';
const SEED_A = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const SEED_B = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

function makeChallenge(target: string, time: number): Challenge {
  return {
    kind: 'matmul_service_challenge_v1',
    challenge_id: 'demo',
    issued_at: 0,
    expires_at: 0,
    expires_in_s: 300,
    binding: { chain: 'main', purpose: 'mining', resource: 'pool:demo', subject: 'browser', resource_hash: '00', subject_hash: '00', salt: '00', anchor_height: 0, anchor_hash: '00' },
    proof_policy: { verification_rule: 'r', sigma_gate_applied: false, expiration_enforced: false, challenge_id_required: false, replay_protection: 'none', redeem_rpc: 'redeemmatmulservicechallenge', solve_rpc: 'solvematmulservicechallenge', locally_issued_required: false },
    challenge: {
      chain: 'main', algorithm: 'matmul', height: 0, previousblockhash: PREV, mintime: 0, bits: '1d00ffff', difficulty: 1, target, noncerange: '00000000ffffffff',
      // `time` varies per job → different sigma → a fresh search space each rotation.
      header_context: { version: 1, previousblockhash: PREV, merkleroot: MERK, time, bits: '1d00ffff', nonce64_start: 0, matmul_dim: 64, seed_a: SEED_A, seed_b: SEED_B },
      matmul: { n: 64, b: 8, r: 4, q: 2147483647, min_dimension: 4, max_dimension: 512, seed_a: SEED_A, seed_b: SEED_B },
    },
  };
}

export interface ReferenceWorkSourceOptions {
  /** Easier = more frequent shares. Default ~8 expected nonce attempts per share. */
  expectedAttempts?: number;
  /** Rotate to a fresh job this often (ms). Default 20s. */
  rotateMs?: number;
}

export class ReferenceWorkSource implements MiningPoolAdapter {
  private readonly shareTarget: string;
  private jobId = '';
  private readonly history = new Map<string, Challenge>(); // jobId → challenge (last few)
  readonly counts = new Map<string, number>();

  constructor(opts: ReferenceWorkSourceOptions = {}) {
    this.shareTarget = targetForExpectedAttempts(opts.expectedAttempts ?? 8);
    this.rotate();
    setInterval(() => this.rotate(), opts.rotateMs ?? 20_000);
  }

  private rotate(): void {
    this.jobId = 'job-' + Date.now().toString(36);
    this.history.set(this.jobId, makeChallenge(this.shareTarget, 1_700_000_000 + (Date.now() & 0xffff)));
    // keep the map small (recent jobs only)
    if (this.history.size > 4) {
      const oldest = this.history.keys().next().value;
      if (oldest !== undefined) this.history.delete(oldest);
    }
  }

  async getJob(): Promise<MiningJob> {
    const challenge = this.history.get(this.jobId)!;
    return { jobId: this.jobId, challenge };
  }

  async submitShare(s: ShareSubmission): Promise<ShareResult> {
    const challenge = this.history.get(s.jobId);
    if (!challenge) return { accepted: false, reason: 'stale' }; // job rotated out
    try {
      const out = await Solver.solve(challenge, { mode: 'pure-js', pureJs: { nonceStart: BigInt('0x' + s.nonce64_hex), maxTries: 1 } });
      const ok = out.nonce64_hex === s.nonce64_hex && out.digest_hex === s.digest_hex;
      if (ok) {
        const id = s.workerId ?? 'anon';
        this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
      }
      return { accepted: ok, reason: ok ? 'ok' : 'invalid' };
    } catch {
      return { accepted: false, reason: 'invalid' };
    }
  }
}
