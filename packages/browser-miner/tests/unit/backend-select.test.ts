import { describe, expect, it } from 'vitest';
import { selectBackend, pureJsBackend, challengeToArgs } from '../../src/index.js';
import { synthChallenge } from './_helpers.js';

describe('challengeToArgs', () => {
  it('maps the envelope to the 11 positional kernel args', () => {
    const args = challengeToArgs(synthChallenge('ab'.repeat(32)));
    expect(args).toHaveLength(11);
    expect(args[0]).toBe(1); // version
    expect(args[5]).toBe(8); // n
    expect(args[6]).toBe(4); // b
    expect(args[7]).toBe(2); // r
    expect(args[10]).toBe('ab'.repeat(32)); // target
  });

  it('enforces the C-1 seed/dim guard (header must equal matmul)', () => {
    const c = synthChallenge();
    c.challenge.header_context.seed_a = '99'.repeat(32); // diverge from matmul.seed_a
    expect(() => challengeToArgs(c)).toThrow('un-redeemable');
  });
});

describe('selectBackend (in Node — no navigator.gpu)', () => {
  it('prefer:"pure-js" returns the pure-js backend', async () => {
    const b = await selectBackend({ prefer: 'pure-js' });
    expect(b.name).toBe('pure-js');
  });

  it('auto returns a usable backend (pure-js fallback in Node)', async () => {
    const b = await selectBackend();
    expect(['webgpu', 'wasm', 'pure-js']).toContain(b.name);
    const session = await b.forJob(synthChallenge());
    expect(typeof session.searchChunk).toBe('function');
    session.destroy();
    b.dispose?.();
  });

  it('pureJsBackend solves a trivial (all-ones target) chunk', async () => {
    const session = await pureJsBackend().forJob(synthChallenge('ff'.repeat(32)));
    const hit = await session.searchChunk(0n, 4);
    expect(hit).toBeDefined();
    expect(hit!.nonce_hex).toHaveLength(16);
    expect(hit!.digest_hex).toHaveLength(64);
    session.destroy();
  });
});
