# Cross-validation scripts

Ad-hoc Node scripts used during Day 2.5 Step 10 to validate the pure-JS solver
against btxd's reference implementation.

Run with `npx tsx scripts/<name>.mjs`.

| Script | Validates |
|---|---|
| `xv-sigma.mjs <challenge.json> [nonce]` | `deriveSigma` for a given challenge envelope + nonce. Compare against `verifymatmulserviceproof.proof.sigma` from a live btxd. |
| `xv-fromseed.mjs` | `fromSeedRect(zero_seed, 8, 8)` first elements vs btxd's `matrix_from_seed_deterministic` golden. |
| `xv-noise.mjs` | `deriveNoiseSeed(TAG_EL, zero_sigma)` + `generate(zero_sigma, 4, 2)` E_L/E_R vs btxd's `noise_*_pinned_*` goldens. |
| `xv-canonical.mjs` | `canonicalMatMul(n=8, b=4)` transcript_hash vs btxd's `canonical_matmul_n8_b4_pinned_transcript` golden. |
| `xv-digest.mjs <challenge.json> [nonce]` | Full end-to-end pipeline — computes the transcript_hash for a real challenge + nonce, prints both BE and LE-storage hex forms. |

The btxd-vectors.test.ts unit test locks the cross-validation in CI; these
scripts exist for one-off debugging and for cross-validation against a live
btxd RPC.
