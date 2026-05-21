// Cross-validate noise against btxd golden vectors:
//   sigma = all-zero uint256
//   DeriveNoiseSeed(TAG_EL, sigma) = 993a427eeb3dc053000d570842d2e7f0f093393c00e8e729155c48719118b386
//   Generate(sigma, 4, 2):
//     E_L = [[1931902215, 129748845], [505403935, 538008036],
//            [1006343602, 1697202758], [2128262120, 942473671]]
//     E_R = [[962405871, 1142251768, 505582893, 443901062],
//            [858057583, 2082571321, 70698889, 1087797252]]

import { NOISE_TAG_EL } from '../packages/core/src/matmul/constants.ts';
import { deriveNoiseSeed, generate } from '../packages/core/src/matmul/noise.ts';

const zeroSigma = new Uint8Array(32);

const seedEL = deriveNoiseSeed(NOISE_TAG_EL, zeroSigma);
const seedHex = Array.from(seedEL).map((b) => b.toString(16).padStart(2, '0')).join('');
const expectedSeed = '993a427eeb3dc053000d570842d2e7f0f093393c00e8e729155c48719118b386';
console.log('deriveNoiseSeed(TAG_EL, 0):');
console.log('  ours:     ' + seedHex);
console.log('  expected: ' + expectedSeed);
console.log('  match:    ' + (seedHex === expectedSeed));
console.log();

const np = generate(zeroSigma, 4, 2);
console.log('E_L (4×2):');
for (let r = 0; r < 4; r++) {
  const row = [];
  for (let c = 0; c < 2; c++) row.push(np.E_L.data[r * 2 + c]);
  console.log('  row ' + r + ':', row.join(', '));
}
const expectedEL = [
  [1931902215, 129748845],
  [505403935, 538008036],
  [1006343602, 1697202758],
  [2128262120, 942473671],
];
let elMatch = true;
for (let r = 0; r < 4; r++) {
  for (let c = 0; c < 2; c++) {
    if (np.E_L.data[r * 2 + c] !== expectedEL[r][c]) {
      elMatch = false;
      console.log(`  ✗ E_L[${r}][${c}]: ours=${np.E_L.data[r * 2 + c]}, expected=${expectedEL[r][c]}`);
    }
  }
}
console.log('E_L match: ' + elMatch);

console.log();
console.log('E_R (2×4):');
for (let r = 0; r < 2; r++) {
  const row = [];
  for (let c = 0; c < 4; c++) row.push(np.E_R.data[r * 4 + c]);
  console.log('  row ' + r + ':', row.join(', '));
}
const expectedER = [
  [962405871, 1142251768, 505582893, 443901062],
  [858057583, 2082571321, 70698889, 1087797252],
];
let erMatch = true;
for (let r = 0; r < 2; r++) {
  for (let c = 0; c < 4; c++) {
    if (np.E_R.data[r * 4 + c] !== expectedER[r][c]) {
      erMatch = false;
      console.log(`  ✗ E_R[${r}][${c}]: ours=${np.E_R.data[r * 4 + c]}, expected=${expectedER[r][c]}`);
    }
  }
}
console.log('E_R match: ' + erMatch);
