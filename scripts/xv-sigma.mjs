// Ad-hoc cross-validation: compute pure-JS sigma for (challenge, nonce=0)
// against the locally-saved iowa challenge envelope.
//
// Usage: node scripts/xv-sigma.mjs /path/to/challenge.json [nonce]

import { readFileSync } from 'node:fs';
import { deriveSigma, headerInputForNonce } from '../packages/core/src/matmul/header.ts';

const file = process.argv[2];
const nonce = BigInt(process.argv[3] ?? '0');
if (!file) {
  console.error('usage: node scripts/xv-sigma.mjs <challenge.json> [nonce]');
  process.exit(1);
}
const challenge = JSON.parse(readFileSync(file, 'utf8'));
const ctx = challenge.challenge.header_context;
const header = headerInputForNonce(ctx, nonce);
const sigmaBE = deriveSigma(header);
const hex = Array.from(sigmaBE).map((b) => b.toString(16).padStart(2, '0')).join('');
console.log('nonce: ' + nonce.toString());
console.log('sigma_be_hex: ' + hex);
