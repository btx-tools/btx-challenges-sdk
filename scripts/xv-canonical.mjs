// Cross-validate canonicalMatMul against btxd's pinned golden:
//   seed_a (BE) = 376d8f3e225ed14f5614a884f822920360a7b021684bd74600aa5f88dbd32a27
//   seed_b (BE) = 3609c5eaeae940efb3035712cd65b09f0330d77fdf852128a89069b3ac02f586
//   sigma  (BE) = ffc381ccd5e78ab52348ec8ba82f51d5feb0e857d7969ab0df9a5891c68cdf15
//   A = FromSeed(seed_a, 8)  // 8x8
//   B = FromSeed(seed_b, 8)
//   result.transcript_hash (raw bytes hex BE) = b134b59bfdd28f3bf566e35a4d44b0af8e9530dce8047125a59d308ed22c17b8

import { fromSeedRect } from '../packages/core/src/matmul/matrix.ts';
import { canonicalMatMul } from '../packages/core/src/matmul/transcript.ts';

const parseHex32 = (hex) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const seedA_BE = parseHex32('376d8f3e225ed14f5614a884f822920360a7b021684bd74600aa5f88dbd32a27');
const seedB_BE = parseHex32('3609c5eaeae940efb3035712cd65b09f0330d77fdf852128a89069b3ac02f586');
const sigma_BE = parseHex32('ffc381ccd5e78ab52348ec8ba82f51d5feb0e857d7969ab0df9a5891c68cdf15');

// Note: btxd uses ParseUint256 (BE hex → LE storage). But our fromSeedRect
// expects BE-order bytes (= the bytes from_oracle ends up hashing). Since
// from_oracle reverses LE storage before hashing, and our BE matches that
// reversed form, we should pass these hex-parsed-BE bytes directly.
//
// HOWEVER: the test source has ParseUint256 (not Raw), so seed_a as stored
// in btxd's uint256 has data() = REVERSE(hex bytes). from_oracle reverses
// AGAIN to get back the hex bytes for hashing. So btxd hashes (seed_a_HEX
// bytes) which is what we have in seedA_BE. ✓

const A = fromSeedRect(seedA_BE, 8, 8);
const B = fromSeedRect(seedB_BE, 8, 8);

// For sigma: btxd stores sigma via ParseUint256 too. from_oracle (inside
// transcript helpers) reverses sigma.data() = REVERSE(REVERSE(hex)) = hex.
// So btxd hashes sigma_HEX. We pass sigmaBE = hex bytes directly.

const result = canonicalMatMul(A, B, 4, sigma_BE);
const hexRaw = Array.from(result.transcriptHash).map((b) => b.toString(16).padStart(2, '0')).join('');
const expected = 'b134b59bfdd28f3bf566e35a4d44b0af8e9530dce8047125a59d308ed22c17b8';
console.log('transcript_hash (raw):');
console.log('  ours:     ' + hexRaw);
console.log('  expected: ' + expected);
console.log('  match:    ' + (hexRaw === expected));
