// Track 2 headless real-GPU gate — the full BrowserMiner loop over the REAL
// WebGPU backend + a self-contained work-source (synth job + local Solver-1-nonce
// verify, no btxd), under Deno. Asserts: backend auto-selects webgpu, shares are
// found, byte-exact-verified, accepted, and counted; the first n=64 share is the
// golden; duty-cycle throttling doesn't break correctness.
//
//   pnpm --filter @btx-tools/challenges-sdk build
//   pnpm --filter @btx-tools/matmul-webgpu build
//   pnpm --filter @btx-tools/browser-miner build
//   (from packages/browser-miner/) deno run --unstable-webgpu --allow-read \
//       --config tests/gpu/deno.json tests/gpu/miner.deno.ts
import {
  BrowserMiner,
  type MiningJob,
  type MiningPoolAdapter,
  type ShareResult,
  type ShareSubmission,
} from '../../dist/index.js';
import { Solver } from '@btx-tools/challenges-sdk';

const PREV = '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210';
const MERK = 'fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef';
const SEED_A = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const SEED_B = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
const TARGET = '03' + 'ff'.repeat(31); // n=64 golden target → first hit = nonce 12
const GOLDEN_NONCE = '000000000000000c';
const GOLDEN_DIGEST = '02bef301fabd558731b31c14cc6736854a4e4dd0408478090b7e8f7d26218c55';

// deno-lint-ignore no-explicit-any
function n64Challenge(): any {
  return {
    kind: 'matmul_service_challenge_v1',
    challenge_id: 'g',
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
      target: TARGET,
      noncerange: '00000000ffffffff',
      header_context: {
        version: 1,
        previousblockhash: PREV,
        merkleroot: MERK,
        time: 1700000000,
        bits: '1d00ffff',
        nonce64_start: 0,
        matmul_dim: 64,
        seed_a: SEED_A,
        seed_b: SEED_B,
      },
      matmul: {
        n: 64,
        b: 8,
        r: 4,
        q: 2147483647,
        min_dimension: 4,
        max_dimension: 512,
        seed_a: SEED_A,
        seed_b: SEED_B,
      },
    },
  };
}

/** Self-contained work source: one fixed n=64 job; verifies shares via Solver 1-nonce. */
class WorkSource implements MiningPoolAdapter {
  // deno-lint-ignore no-explicit-any
  private readonly challenge: any = n64Challenge();
  accepted = 0;
  async getJob(): Promise<MiningJob> {
    return { jobId: 'g', challenge: this.challenge };
  }
  async submitShare(s: ShareSubmission): Promise<ShareResult> {
    try {
      const out = await Solver.solve(this.challenge, {
        mode: 'pure-js',
        pureJs: { nonceStart: BigInt('0x' + s.nonce64_hex), maxTries: 1 },
      });
      const ok = out.nonce64_hex === s.nonce64_hex && out.digest_hex === s.digest_hex;
      if (ok) this.accepted++;
      return { accepted: ok, reason: ok ? 'ok' : 'invalid' };
    } catch {
      return { accepted: false, reason: 'invalid' };
    }
  }
}

const until = async (pred: () => boolean, ms = 20000): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const gpu = (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;
if (!gpu) {
  console.log(
    '⏭️  no navigator.gpu — skipping (run: deno run --unstable-webgpu --allow-read --config tests/gpu/deno.json …)',
  );
  Deno.exit(0);
}

const ws = new WorkSource();
const firstShares: ShareSubmission[] = [];
let rejected = 0;
const miner = new BrowserMiner({
  adapter: ws,
  prefer: 'webgpu',
  dutyCycle: 0.5, // throttle on — must still find/verify shares
  pollIntervalMs: 1e9,
  onShare: (s, r) => {
    firstShares.push(s);
    if (!r.accepted) rejected++;
  },
});
miner.start();
await until(() => ws.accepted >= 2);
await miner.stop();

const backend = miner.stats.backend;
const first = firstShares[0]!;
const firstGolden = first.nonce64_hex === GOLDEN_NONCE && first.digest_hex === GOLDEN_DIGEST;
const ok = backend === 'webgpu' && ws.accepted >= 2 && rejected === 0 && firstGolden;

console.log(`backend=${backend} accepted=${ws.accepted} rejected=${rejected}`);
console.log(
  `first share: nonce=${first.nonce64_hex} digest=${first.digest_hex.slice(0, 16)}…  golden=${firstGolden ? '✅' : '❌'}`,
);
console.log(
  ok
    ? '✅ T2 GPU GATE PASS — BrowserMiner(webgpu) shares found, byte-exact-verified, accepted, throttled'
    : '❌ T2 GPU GATE FAIL',
);
Deno.exit(ok ? 0 : 1);
