/**
 * Share-target (vardiff) helpers. The compare is `uintLE(digest) ≤ uintBE(target)`
 * over 256-bit integers, so a *larger* target = easier = more nonces pass. The
 * expected number of nonce attempts to find one share is `2²⁵⁶ / target`.
 */

const TWO_256 = 1n << 256n;

/**
 * 32-byte big-endian hex `target` such that ~`expectedAttempts` nonces are tried
 * per share on average (`target = floor(2²⁵⁶ / expectedAttempts)`, clamped to
 * `2²⁵⁶−1`). A work source uses this to set an easy share-target; the miner just
 * solves the resulting envelope.
 *
 * @throws if `expectedAttempts` is not a positive finite number.
 */
export function targetForExpectedAttempts(expectedAttempts: number): string {
  if (!Number.isFinite(expectedAttempts) || expectedAttempts < 1) {
    throw new Error(`expectedAttempts must be a finite number ≥ 1 (got ${expectedAttempts})`);
  }
  let target = TWO_256 / BigInt(Math.floor(expectedAttempts));
  if (target >= TWO_256) target = TWO_256 - 1n;
  if (target < 1n) target = 1n;
  return target.toString(16).padStart(64, '0');
}

/**
 * Rough inverse: expected attempts per share for a given 32-byte BE hex `target`
 * (`2²⁵⁶ / target`). Useful for reporting effective difficulty.
 */
export function expectedAttemptsForTarget(target: string): number {
  const hex = target.startsWith('0x') || target.startsWith('0X') ? target.slice(2) : target;
  const t = BigInt('0x' + hex);
  if (t <= 0n) return Infinity;
  return Number(TWO_256 / t);
}
