/**
 * Companion client for `server.ts`. Walks the full admission flow:
 *
 *   1. POST /v1/generate with no proof headers → expect 402 + a challenge
 *   2. Solver.solve(challenge, { mode: 'pure-js' }) → produces nonce + digest
 *   3. POST /v1/generate again with the three proof headers → expect 200
 *   4. POST a 3rd time with the SAME proof → expect 403 already_redeemed
 *      (proves replay protection)
 *
 * Run: `pnpm start:client` (after `start:server` is up)
 */

import { Solver, type Challenge } from '@btx-tools/challenges-sdk';
import {
  HEADER_CHALLENGE,
  HEADER_PROOF_DIGEST,
  HEADER_PROOF_NONCE,
} from '@btx-tools/middleware-express';

const GATE_URL = process.env.GATE_URL ?? 'http://127.0.0.1:3000/v1/generate';

function ms(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(2)}s`;
}

async function postWithoutProof(): Promise<{ challenge: Challenge; raw: string }> {
  const res = await fetch(GATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'demo', tenant_id: 'local' }),
  });
  if (res.status !== 402) {
    throw new Error(`expected 402 on first POST, got ${res.status}: ${await res.text()}`);
  }
  // The middleware sets the challenge in BOTH the response body AND the
  // X-BTX-Challenge header. Either source is fine; we use the header here
  // because it's what browser clients use (the body is convenient for Node
  // but adds a JSON parse round-trip).
  const raw = res.headers.get(HEADER_CHALLENGE.toLowerCase());
  if (!raw) {
    throw new Error(`402 response missing ${HEADER_CHALLENGE} header`);
  }
  const challenge = JSON.parse(raw) as Challenge;
  return { challenge, raw };
}

async function postWithProof(
  challengeRaw: string,
  nonce: string,
  digest: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(GATE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [HEADER_CHALLENGE]: challengeRaw,
      [HEADER_PROOF_NONCE]: nonce,
      [HEADER_PROOF_DIGEST]: digest,
    },
    body: JSON.stringify({ model: 'demo', tenant_id: 'local' }),
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log(`[POST 1] ${GATE_URL} (no proof)`);
  const t0 = Date.now();
  const { challenge, raw } = await postWithoutProof();
  console.log(
    `[POST 1] 402 received in ${ms(t0)} — challenge_id=${challenge.challenge_id.slice(0, 16)}...`,
  );

  console.log('[solve] starting pure-JS solve (this can take 7-10 min on an M-series Mac)...');
  const t1 = Date.now();
  const proof = await Solver.solve(challenge, { mode: 'pure-js' });
  console.log(`[solve] nonce=${proof.nonce64_hex} digest=${proof.digest_hex.slice(0, 16)}... in ${ms(t1)}`);

  console.log('[POST 2] retrying with proof headers');
  const t2 = Date.now();
  const r2 = await postWithProof(raw, proof.nonce64_hex, proof.digest_hex);
  console.log(`[POST 2] ${r2.status} in ${ms(t2)} body=${JSON.stringify(r2.body)}`);
  if (r2.status !== 200) {
    process.exitCode = 2;
    return;
  }

  console.log('[POST 3] replaying same proof (expect 403 already_redeemed)');
  const t3 = Date.now();
  const r3 = await postWithProof(raw, proof.nonce64_hex, proof.digest_hex);
  console.log(`[POST 3] ${r3.status} in ${ms(t3)} body=${JSON.stringify(r3.body)}`);
  if (r3.status !== 403) {
    console.warn(`expected 403 on replay, got ${r3.status} — replay protection may be misconfigured`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('client failed:', err);
  process.exit(1);
});
