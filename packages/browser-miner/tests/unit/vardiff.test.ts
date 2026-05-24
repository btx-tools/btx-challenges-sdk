import { describe, expect, it } from 'vitest';
import { targetForExpectedAttempts, expectedAttemptsForTarget } from '../../src/index.js';

describe('targetForExpectedAttempts', () => {
  it('emits a 64-hex (32-byte) BE target', () => {
    expect(targetForExpectedAttempts(256)).toHaveLength(64);
  });

  it('expectedAttempts=1 → ~all-ones (every nonce passes)', () => {
    expect(targetForExpectedAttempts(1)).toBe('f'.repeat(64));
  });

  it('larger expectedAttempts → smaller (harder) target', () => {
    const easy = BigInt('0x' + targetForExpectedAttempts(16));
    const hard = BigInt('0x' + targetForExpectedAttempts(1_000_000));
    expect(hard).toBeLessThan(easy);
  });

  it('round-trips approximately through expectedAttemptsForTarget', () => {
    const t = targetForExpectedAttempts(1024);
    const n = expectedAttemptsForTarget(t);
    expect(n).toBeGreaterThanOrEqual(1023);
    expect(n).toBeLessThanOrEqual(1025);
  });

  it('rejects non-positive / non-finite input', () => {
    expect(() => targetForExpectedAttempts(0)).toThrow('≥ 1');
    expect(() => targetForExpectedAttempts(-5)).toThrow('≥ 1');
    expect(() => targetForExpectedAttempts(Infinity)).toThrow('finite');
  });
});
