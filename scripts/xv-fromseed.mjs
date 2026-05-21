// Cross-validate fromSeedRect against btxd's matrix_from_seed_deterministic
// golden vector: FromSeed(all-zero seed, n=8) → m[0..3] = [1432335981, 1134348657, 428617384]

import { fromSeedRect } from '../packages/core/src/matmul/matrix.ts';

const zeroSeed = new Uint8Array(32);
const m = fromSeedRect(zeroSeed, 8, 8);

console.log('m[0,0]:', m.data[0], '(expected 1432335981)');
console.log('m[0,1]:', m.data[1], '(expected 1134348657)');
console.log('m[0,2]:', m.data[2], '(expected  428617384)');
console.log('m[0,3]:', m.data[3]);
console.log('m[0,4]:', m.data[4]);
console.log();
console.log('match[0,0]:', m.data[0] === 1432335981);
console.log('match[0,1]:', m.data[1] === 1134348657);
console.log('match[0,2]:', m.data[2] === 428617384);
