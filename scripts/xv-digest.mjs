// Compute pure-JS transcript_hash for (challenge, nonce) by walking the full
// canonical solve path manually. Outputs (nonce_hex, digest_hex_BE) so we can
// hand them to btxd's verifymatmulserviceproof and check transcript_valid.

import { readFileSync } from 'node:fs';
import { deriveSigma, headerInputForNonce } from '../packages/core/src/matmul/header.ts';
import { fromSeedRect, matAdd, matMul } from '../packages/core/src/matmul/matrix.ts';
import { generate as generateNoise } from '../packages/core/src/matmul/noise.ts';
import { canonicalMatMul } from '../packages/core/src/matmul/transcript.ts';

const file = process.argv[2];
const nonce = BigInt(process.argv[3] ?? '0');
if (!file) {
  console.error('usage: node scripts/xv-digest.mjs <challenge.json> [nonce]');
  process.exit(1);
}
const challenge = JSON.parse(readFileSync(file, 'utf8'));
const payload = challenge.challenge;
const ctx = payload.header_context;
const { n, b, r } = payload.matmul;

const parseHex32 = (hex) => {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const t0 = Date.now();
const seedA = parseHex32(payload.matmul.seed_a);
const seedB = parseHex32(payload.matmul.seed_b);

console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] generating A (${n}x${n})...`);
const A = fromSeedRect(seedA, n, n);
console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] generating B (${n}x${n})...`);
const B = fromSeedRect(seedB, n, n);

const header = headerInputForNonce(ctx, nonce);
console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] deriving sigma for nonce=${nonce}...`);
const sigma = deriveSigma(header);

console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] generating noise (n=${n}, r=${r})...`);
const noise = generateNoise(sigma, n, r);

console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] computing E = E_L*E_R...`);
const E = matMul(noise.E_L, noise.E_R);
console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] computing F = F_L*F_R...`);
const F = matMul(noise.F_L, noise.F_R);

console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] A' = A + E ...`);
const aPrime = matAdd(A, E);
console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] B' = B + F ...`);
const bPrime = matAdd(B, F);

console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] canonicalMatMul (b=${b}, N=${n / b})...`);
const result = canonicalMatMul(aPrime, bPrime, b, sigma);
console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] DONE.`);

// transcriptHash is LE storage; format as BE display hex.
const hexBE = Array.from(result.transcriptHash).slice().reverse().map((x) => x.toString(16).padStart(2, '0')).join('');
const hexLE = Array.from(result.transcriptHash).map((x) => x.toString(16).padStart(2, '0')).join('');

console.log('nonce64_hex: ' + nonce.toString(16).padStart(16, '0'));
console.log('digest_hex_BE: ' + hexBE);
console.log('digest_hex_LE: ' + hexLE);
