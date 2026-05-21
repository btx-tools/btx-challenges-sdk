# Changelog

All notable changes to packages in this workspace are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) + [SemVer](https://semver.org/).

## [Unreleased]

(no entries yet)

## [middleware-express 0.1.0] - 2026-05-22

First Express adapter for `@btx-tools/challenges-sdk`. See per-package CHANGELOG at `packages/middleware-express/CHANGELOG.md` for details.

- `btxAdmission(opts)` factory returning an Express `RequestHandler`
- Stateless echo-the-challenge flow (server never stores issued challenges)
- 15 supertest-based unit tests, all green
- CI workflow updated to run all workspace packages + reorder build-before-type-check (middleware deps on core's emitted .d.ts)
- Peer deps: `express ^4 || ^5`, `@btx-tools/challenges-sdk ^0.0.1`

## [0.0.1] - 2026-05-22

First npm publish under `@btx-tools/challenges-sdk`. Foundation release: RPC client + pure-JS solver + types. Spec days 1, 1.5, 2, 2.5 collapsed into this version.

### Known limitations (deferred to 0.0.2)

- **Live HTTP-loop integration tests** (`tests/integration/solve-redeem.test.ts`) are present and gated on `BTX_INTEGRATION_URL/AUTH/NODE_DEDICATED`, but have NOT been run end-to-end against a live dedicated btxd before this release. Algorithm correctness is instead validated via 5 byte-equal golden vectors lifted from btxd's own test suite (`tests/unit/matmul/btxd-vectors.test.ts`) + a live sigma cross-check against btx-node. HTTP + auth paths are exercised by 14 msw-mocked unit tests + the Day 1 smoke test. The live HTTP-loop run is queued for 0.0.2 once a dedicated non-mining btxd is provisioned.
- **Proof-shape live roundtrip**: `SolverOutput.proof = { challenge, nonce64_hex, digest_hex }` is derived by reading btxd's `solvematmulservicechallenge` RPC handler. Structure is verified statically; live roundtrip (pure-JS solve → `client.redeem` → `valid: true`) closes alongside the integration test run.
- **Pure-JS performance** is V8-specific (measured 4.6 s/attempt at n=512 on Node 22 / M-series Mac). Bun, Deno, Firefox, Safari untested.

### @btx-tools/challenges-sdk

#### Day 2.5 Steps 11-13 — Day 2.5 close

- **Integration tests** (`tests/integration/solve-redeem.test.ts`): added a parallel pure-JS suite alongside the existing RPC suite. Both stay triple-gated on `BTX_INTEGRATION_URL` + `BTX_INTEGRATION_AUTH` + `BTX_INTEGRATION_NODE_DEDICATED=1`. Pure-JS suite gets a 75-min timeout per test (n=512 at btxd's lowest difficulty ≈ 770 attempts × 4.6 s ≈ 1 hour expected).
- **Perf bench** (`tests/perf/solver-bench.ts`): runnable via `npx tsx packages/core/tests/perf/solver-bench.ts [N]`. Walks the full canonical solve for N synthetic attempts at n=512 / b=16 / r=8 and reports mean/median/min/max. Day 2.5 baseline on M-series Mac / Node 22: **4.6 s/attempt** (mean over 5 samples, tight ±0.05 s spread).
- **README**: updated `§ Solver` with a working pure-JS usage example (replaces the old "throws not_implemented" disclaimer), a § Algorithm correctness section listing the 5 byte-equal golden cross-checks, and a § Performance section with the bench numbers + per-difficulty wall-clock estimates. Roadmap now marks Day 2 + Day 2.5 ✅ and adds Day 2.6 (WASM port) as the next item.

#### Day 2.5 Step 10 — cross-validation against btxd golden vectors (+ noise byte-order fix)

- Cross-validated the pure-JS solver against pinned golden vectors lifted from btxd's own test suite (`src/test/matmul_*_tests.cpp`):
  - `matrix.fromSeedRect(zero, 8)` first 3 elements match `matrix_from_seed_deterministic`
  - `deriveNoiseSeed(TAG_EL, zero_sigma)` matches `noise_derived_seed_pinned_EL`
  - `noise.generate(zero_sigma, 4, 2)` E_L + E_R matrices match `noise_EL_pinned_elements` / `noise_ER_pinned_elements`
  - `canonicalMatMul(A=FromSeed(seed_a,8), B=FromSeed(seed_b,8), b=4, sigma)` transcript_hash matches `canonical_matmul_n8_b4_pinned_transcript`
- Plus a live sigma cross-check against btx-node's `verifymatmulserviceproof` for two nonces — byte-equal.
- New test file: `packages/core/tests/unit/matmul/btxd-vectors.test.ts` (5 tests) — locks the cross-validation in CI so a future port change can't silently break it.

##### Fixed (algorithm correctness)

- **Noise + compression seed byte-order**: `deriveNoiseSeed` (noise.ts) and `deriveCompressionSeed` (transcript.ts) were reversing the raw SHA-256 output before returning. Cause: btxd's C++ stores these uint256s via `CanonicalBytesToUint256` (reverse-storage), while `DeriveSigma` stores its uint256 direct — asymmetric storage that doesn't translate to a single "BE convention" in TS. `from_oracle`'s internal reverse-then-hash inverts each storage policy differently, so the bytes ACTUALLY HASHED end up: `REVERSE(raw_sigma)` for sigma, but `raw_noise` for noise/compression. The TS port was applying the same reverse to both. Fix: remove the reverse on the output of `deriveNoiseSeed` and `deriveCompressionSeed`; keep the reverse on `deriveSigma`. All 130 unit tests still green.
- Without this fix, every noise matrix entry and every compression-vector element was wrong, producing digests btxd would reject. Caught by the cross-validation script before any external user noticed.

#### Day 2.5 Steps 1-9 — pure-JS MatMul solver port (algorithm port complete; cross-validation pending)

- `Solver.solve(challenge, { mode: 'pure-js' })` now produces real proofs instead of throwing `not_implemented`. Browser-compatible, no btxd RPC required.
- Port of the canonical CPU path from `btxd v0.29.7 src/matmul/` (`field`, `noise`, `transcript`, `matmul_pow` — NEON/CUDA acceleration paths intentionally out of scope):
  - `src/matmul/constants.ts` — M31 modulus + 6 domain tags (4 noise, 2 transcript)
  - `src/matmul/field.ts` — M31 arithmetic (`add/sub/mul/neg/inv/dot/fromOracle`). `mul` and `dot` accumulator use `BigInt` because the worst-case product 2^62 exceeds Number's 2^53 precision; a Number-only split-multiplication path is queued as a perf optimization
  - `src/matmul/matrix.ts` — Matrix struct + `zeros/get/set/fromSeedRect/matAdd/matMul`
  - `src/matmul/header.ts` — `serializeMatMulHeader/computeMatMulHeaderHash/deriveSigma` matching btxd's 150-byte LE wire format
  - `src/matmul/noise.ts` — `deriveNoiseSeed/generate` → `NoisePair {E_L, E_R, F_L, F_R}`
  - `src/matmul/transcript.ts` — `deriveCompressionVector/compressBlock/TranscriptHasher/canonicalMatMul` (block-wise n×n product with SHA-256d transcript binding)
  - `src/matmul/pow.ts` — top-level `solveJs(challenge, options)` nonce search loop with `bigint` 256-bit target comparison
- `SolverOptions.pureJs?: SolveJsOptions` forwards `{ maxTries, nonceStart, onAttempt, attemptInterval }` to the pure-JS solver
- `SolverOutput.proof` populated with the same shape btxd's solve RPC returns: `{ challenge, nonce64_hex, digest_hex }`
- Adds `@noble/hashes ^2.2.0` runtime dep (~25 KB, zero sub-deps, audited)
- 100 new unit tests for the matmul submodules (field 22, header 14, matrix 13, noise 11, transcript 21, pow 15, constants 4). Existing solver dispatch tests updated for the new pure-js behavior; RPC tests untouched
- Build size delta: ESM 7.84 KB → 22.65 KB (well under the +30 KB budget)

**Internal correctness verified**: `canonicalMatMul`'s C' matches naive `matMul` on 4×4 / 8×8 cases; SHA-256d transcript is deterministic across instances; field invariants hold (a·inv(a)=1, MAX²=1, oracle determinism). **Cross-validation against btxd's actual digests still pending** — requires fixtures captured from a dedicated non-mining btxd. Until that lands, `Solver.solve({ mode: 'pure-js' })` outputs may or may not redeem against a live btxd. Documented as a known constraint in the SDK; the gate is Day 2.5 Step 10.

**Out of scope** (queued for Day 2.6+): WASM port of the matmul kernel, Web Worker parallel nonce search, replay/product-committed digest helpers (verifier optimizations), perf bench against M-series Mac.

#### Day 2 — Solver class (RPC mode)

- `Solver` class with mode dispatch (`'rpc' | 'pure-js' | 'auto'`)
  - **`mode: 'rpc'`** — delegates to `BtxChallengeClient.solve()` → btxd's `solvematmulservicechallenge`. **Server-side / Node only.** Ships v0.0.1.
  - **`mode: 'pure-js'`** — placeholder; throws `not_implemented` with pointer to Day 2.5 work.
  - **`mode: 'auto'`** (default) — picks `'rpc'` if `opts.rpcClient` provided, else `'pure-js'`.
- 10 unit tests cover dispatch (rpc / pure-js / auto), error propagation, default mode behavior
- Integration test for full `issue → Solver.solve(rpc) → redeem` lifecycle — **gated on `BTX_INTEGRATION_NODE_DEDICATED=1`** (see "deployment note" below)

#### Day 2 deployment finding

btxd's `solvematmulservicechallenge` RPC shares matmul backend with block mining. On any mining-loaded node (mining-loaded nodes), the solve RPC takes 15+ minutes — direct SSH-piped measurement on btx-node 2026-05-20 ran 900s before btx-cli's own transient-error timeout fired. Solver users MUST point at a dedicated non-mining btxd (e.g., $5/mo DO droplet with `gen=0`). Documented in README. Day 2.5 pure-JS solver removes this constraint for browser clients.

#### Added (Day 1 + Wave A/B/C)

- `BtxChallengeClient` wrapping 6 service-challenges RPCs (`issue`, `verify`, `redeem`, `verifyBatch`, `redeemBatch`, `solve`) + low-level `call()` escape hatch
- Typed envelope shapes: `Challenge`, `ChallengeBinding`, `ChallengeMatmul`, `ChallengePayload`, `ChallengeProofPolicy`
- Error taxonomy: `BtxRpcError`, `BtxHttpError`, `BtxParseError`, `BtxTimeoutError`, `BtxNetworkError`
- `Solver` namespace stub (throws `not_implemented`; real impl Day 2)
- pnpm workspace structure: `packages/core` ships as `@btx/challenges-sdk`
- Dual ESM + CJS build via tsup with proper conditional `exports` ordering (types-first per modern resolver spec)
- Unit tests (msw-mocked HTTP) + integration tests (SSH-to-btxd)
- GitHub Actions CI matrix: Node 18 / 20 / 22

#### Fixed (Day 1 audit findings — addressed all C/H/M-severity items except M4)

- **C1**: replaced `btoa()` with universal `Buffer.from(..., 'utf8').toString('base64')` path; non-ASCII rpcauth credentials no longer crash on every call
- **C2**: added unit-test layer that actually exercises `BtxChallengeClient` (Day 1 only tested btxd-via-SSH, coverage of shipped code was 0%)
- **H1**: `exports` block re-ordered so `types` resolves first; added per-condition `types.import` / `types.require` + `.d.cts` for proper CJS-under-nodenext consumer support
- **H2**: error bodies redact `Authorization: Basic ...` patterns before storage
- **H3**: `res.json()` parse failures normalized to `BtxParseError`
- **H4**: fetch timeout/network errors normalized to `BtxTimeoutError` / `BtxNetworkError`
- **H5**: code comment explaining JSON-RPC `"1.0"` is correct for Bitcoin-family btxd (not `"2.0"` as Ethereum-style)
- **M1**: `Challenge` envelope properly typed (binding, proof_policy, challenge sub-shapes) — needed for Day 2 solver
- **M2**: batch RPCs guard `entries.length` to spec-required 1–256
- **M3**: `IssueParams` no longer hard-codes btxd defaults — unset params are omitted from the call so btxd's own defaults apply (positional args truncated at last set)
- **M5**: README + JSDoc add HTTPS deployment guidance
- **M6**: request IDs use `crypto.randomUUID()` instead of process-local `++counter`
- **M7**: `Solver` export stub added (closes spec drift; Day 2 implements)

#### Deferred

- **M4** (functional companion for tree-shaking) → v0.1 work

### @btx-tools/mcp-gateway

- Scaffold only (Day 1) — real implementation Day 5-6

---

*See `internal notes` for the full audit report.*
