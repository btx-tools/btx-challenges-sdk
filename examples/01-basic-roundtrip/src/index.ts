/**
 * 01-basic-roundtrip
 *
 * Walk through the full BTX service-challenge lifecycle once, end-to-end:
 *   client.issue() → Solver.solve() → client.redeem()
 *
 * Two paths:
 *   - pure-JS solving (works against ANY btxd, including a mining-loaded one;
 *     slow — ~7-10 min wall-clock on M-series Mac at floor difficulty)
 *   - RPC solving (delegates the matmul work to btxd; fast — ~3s on a
 *     dedicated non-mining btxd; ~15 min if the btxd is mining-loaded)
 *
 * RPC mode runs only if BTX_RPC_URL_DEDICATED is set in the environment.
 */

import { BtxChallengeClient, Solver, type VerifyResult } from '@btx-tools/challenges-sdk';

const RPC_URL = process.env.BTX_RPC_URL;
const RPC_AUTH = process.env.BTX_RPC_AUTH;
const RPC_URL_DEDICATED = process.env.BTX_RPC_URL_DEDICATED;
const RPC_AUTH_DEDICATED = process.env.BTX_RPC_AUTH_DEDICATED;

function requireEnv(): { url: string; auth: { user: string; pass: string } } {
  if (!RPC_URL || !RPC_AUTH) {
    console.error('error: set BTX_RPC_URL and BTX_RPC_AUTH (see .env.example)');
    process.exit(1);
  }
  const [user, pass] = RPC_AUTH.split(':');
  if (!user || !pass) {
    console.error('error: BTX_RPC_AUTH must be of the form "user:pass"');
    process.exit(1);
  }
  return { url: RPC_URL, auth: { user, pass } };
}

function ms(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(2)}s`;
}

function logResult(label: string, r: VerifyResult): void {
  console.log(
    `[${label}] valid=${r.valid} reason=${r.reason}` +
      (r.redeemed !== undefined ? ` redeemed=${r.redeemed}` : '') +
      (r.expired !== undefined ? ` expired=${r.expired}` : ''),
  );
}

async function pureJsRoundtrip(): Promise<void> {
  const { url, auth } = requireEnv();
  const client = new BtxChallengeClient({
    rpcUrl: url,
    rpcAuth: auth,
    // pure-JS solving can take 7-10 min; the timeout is only for the RPC calls
    // (issue + redeem), not for the local Solver.solve() — which is CPU-bound
    // in Node and doesn't go through the client.
    timeoutMs: 60_000,
  });

  console.log('--- pure-JS mode ---');

  const t0 = Date.now();
  const challenge = await client.issue({
    purpose: 'rate_limit',
    resource: 'sdk-example:01-basic-roundtrip',
    subject: 'tenant:local-dev',
    // Floor difficulty so the example finishes within a reasonable wall-clock.
    // Production gates should target ~1.0s and let btxd adapt difficulty.
    target_solve_time_s: 0.001,
    min_solve_time_s: 0.001,
    expires_in_s: 1800,
  });
  console.log(`[issue] challenge_id=${challenge.challenge_id.slice(0, 16)}... in ${ms(t0)}`);

  console.log('[solve] starting pure-JS solve (this can take 7-10 min on an M-series Mac)...');
  const t1 = Date.now();
  const proof = await Solver.solve(challenge, { mode: 'pure-js' });
  console.log(`[solve] nonce=${proof.nonce64_hex} digest=${proof.digest_hex.slice(0, 16)}... in ${ms(t1)}`);

  const t2 = Date.now();
  const result = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
  logResult('redeem', result);
  console.log(`[redeem] completed in ${ms(t2)}`);

  if (!result.valid || result.reason !== 'ok') {
    process.exitCode = 2;
  }
}

async function rpcRoundtrip(): Promise<void> {
  if (!RPC_URL_DEDICATED || !RPC_AUTH_DEDICATED) {
    console.log('--- RPC mode SKIPPED (BTX_RPC_URL_DEDICATED unset) ---');
    return;
  }
  const [user, pass] = RPC_AUTH_DEDICATED.split(':');
  if (!user || !pass) {
    console.error('error: BTX_RPC_AUTH_DEDICATED must be of the form "user:pass"');
    process.exitCode = 1;
    return;
  }

  const client = new BtxChallengeClient({
    rpcUrl: RPC_URL_DEDICATED,
    rpcAuth: { user, pass },
    // RPC-mode solving can take 15+ min on a mining-loaded btxd; ample budget.
    methodTimeouts: { solvematmulservicechallenge: 1_200_000 },
  });

  console.log('--- RPC mode ---');

  const t0 = Date.now();
  const challenge = await client.issue({
    purpose: 'rate_limit',
    resource: 'sdk-example:01-basic-roundtrip',
    subject: 'tenant:local-dev',
    target_solve_time_s: 0.001,
    min_solve_time_s: 0.001,
    expires_in_s: 1800,
  });
  console.log(`[issue] challenge_id=${challenge.challenge_id.slice(0, 16)}... in ${ms(t0)}`);

  console.log('[solve] delegating to btxd via solvematmulservicechallenge...');
  const t1 = Date.now();
  const proof = await Solver.solve(challenge, { mode: 'rpc', rpcClient: client });
  console.log(`[solve] nonce=${proof.nonce64_hex} digest=${proof.digest_hex.slice(0, 16)}... in ${ms(t1)}`);

  const t2 = Date.now();
  const result = await client.redeem(challenge, proof.nonce64_hex, proof.digest_hex);
  logResult('redeem', result);
  console.log(`[redeem] completed in ${ms(t2)}`);

  if (!result.valid || result.reason !== 'ok') {
    process.exitCode = 2;
  }
}

async function main(): Promise<void> {
  // RPC mode first so the fast demo runs immediately when a dedicated btxd
  // is available. Pure-JS mode is the always-works fallback and takes ~1 hour
  // mean wall-clock at floor difficulty (Poisson search over ~770 expected
  // attempts × ~5s each on M-series Mac).
  await rpcRoundtrip();
  await pureJsRoundtrip();
}

main().catch((err) => {
  console.error('roundtrip failed:', err);
  process.exit(1);
});
