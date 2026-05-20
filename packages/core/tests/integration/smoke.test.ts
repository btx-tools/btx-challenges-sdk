/**
 * Day 1 smoke test — proves the RPC contract works end-to-end against a real btxd.
 *
 * Target: btx-iowa (healthy, at-tip producer).
 *   - btx-california is 25 blocks behind tip → chain-guard refuses to issue
 *     service challenges. Documented finding 2026-05-20.
 *   - btxd v0.29.7 has a bug in `help getmatmulservicechallenge` (returns
 *     "Internal bug detected: Unreachable code reached") — we skip help-text
 *     validation entirely and assert via the live RPC instead.
 *
 * For Day 3+ middleware testing, we'll move to a clean btxd target with public
 * RPC + Basic auth, exercising the HTTP client path inside BtxChallengeClient.
 */

import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Challenge, VerifyResult } from '../../src/types.js';

const SSH_TARGET = 'btx-iowa';
const BTX_CLI = '/root/btx-src/btx/build/bin/btx-cli';
const DATADIR = '/root/.btx';

function btxCli(...args: string[]): string {
  const cmd = [BTX_CLI, `-datadir=${DATADIR}`, ...args].join(' ');
  return execSync(`ssh -q -o LogLevel=ERROR ${SSH_TARGET} '${cmd}' 2>&1`, {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function btxRpc<T = unknown>(method: string, ...args: string[]): T {
  const out = btxCli(method, ...args).trim();
  return JSON.parse(out) as T;
}

describe('Day 1 — btxd service-challenges RPC contract', () => {
  it('issues a challenge with the envelope shape our types declare', () => {
    const challenge = btxRpc<Challenge>(
      'getmatmulservicechallenge',
      'rate_limit',
      'sdk-test:/v1/test',
      'tenant:smoke-test-day1',
      '1',
      '120',
    );

    // Top-level shape assertions matching our Challenge type
    expect(typeof challenge.challenge_id).toBe('string');
    expect(challenge.challenge_id.length).toBeGreaterThan(0);
    expect(typeof challenge.issued_at).toBe('number');
    expect(typeof challenge.expires_at).toBe('number');
    expect(typeof challenge.expires_in_s).toBe('number');
    expect(challenge.binding).toBeDefined();
    expect(challenge.binding.purpose).toBe('rate_limit');
    expect(challenge.binding.resource).toBe('sdk-test:/v1/test');
    expect(challenge.binding.subject).toBe('tenant:smoke-test-day1');
    expect(challenge.proof_policy).toBeDefined();
    expect(challenge.challenge).toBeDefined();

    // Time math sanity
    expect(challenge.expires_at).toBeGreaterThan(challenge.issued_at);
    expect(challenge.expires_in_s).toBeGreaterThan(0);
    expect(challenge.expires_in_s).toBeLessThanOrEqual(120);

    console.log('[smoke] challenge_id:', challenge.challenge_id);
    console.log('[smoke] binding.purpose:', challenge.binding.purpose);
    console.log('[smoke] expires_in_s:', challenge.expires_in_s);
  }, 30_000);

  // Day 1: deferred to Day 2.
  // The challenge envelope from btxd is a 4 KB JSON blob with deeply-nested
  // structure. Passing it through SSH-wrapped CLI args triggers shell-quoting
  // hell. btx-cli supports `-stdin` for sensitive args; the proper test is
  // either (a) pipe the envelope via stdin, or (b) move to HTTP-direct client
  // testing once we have RPC credentials. Both paths land in Day 2/3.
  it.skip('rejects a clearly-invalid proof with a parseable reason code', () => {
    // First, issue a fresh challenge so we have a real envelope.
    const challenge = btxRpc<Challenge>(
      'getmatmulservicechallenge',
      'rate_limit',
      'sdk-test:/v1/test',
      'tenant:invalid-proof-test',
      '1',
      '120',
    );

    // Submit a clearly-bogus proof — should fail validation cleanly.
    const bogusNonce = '0000000000000000'; // 16 hex (64-bit nonce)
    const bogusDigest = '0'.repeat(64); // 64 hex (256-bit digest)

    // verifymatmulserviceproof signature: (challenge, nonce_hex, digest_hex, lookup_local_status)
    // Pass the challenge envelope as a single JSON-encoded argument.
    const challengeJson = JSON.stringify(challenge).replace(/'/g, `'\\''`);
    const result = btxRpc<VerifyResult>(
      'verifymatmulserviceproof',
      `'${challengeJson}'`,
      bogusNonce,
      bogusDigest,
      'true',
    );

    expect(result.valid).toBe(false);
    expect(typeof result.reason).toBe('string');

    const acceptableReasons = new Set([
      'invalid_proof',
      'challenge_mismatch',
      'unknown_challenge',
      'expired',
    ]);
    expect(acceptableReasons.has(result.reason)).toBe(true);

    console.log('[smoke] verify-invalid reason:', result.reason);
    if (result.mismatch_field) {
      console.log('[smoke] mismatch_field:', result.mismatch_field);
    }
  }, 30_000);
});
