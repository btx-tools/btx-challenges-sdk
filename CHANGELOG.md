# Changelog

All notable changes to packages in this workspace are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) + [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **`examples/` directory** — three runnable adopter examples at workspace root:
  - `examples/01-basic-roundtrip` — Node script: `client.issue() → Solver.solve() → client.redeem()`, RPC mode primary, pure-JS fallback
  - `examples/02-express-gate` — Express server gating `POST /v1/generate` with `btxAdmission`, plus a Node client that walks the 402→solve→200→403-replay flow
  - `examples/03-browser-solver` — Vite browser page **demonstrating the wire protocol** from a browser. **Reference only, not a production captcha** — see `USE-CASES.md`.
- **`USE-CASES.md`** — workspace-root decision tree mapping deployment scenarios to recommended SDK modes. Required reading before integration. Explicitly carves out "browser captcha widget" as **not viable** with the current matmul proof primitive.
- **`BROWSER-PERF-FINDINGS-2026-05-23.md`** — findings doc recording the WASM spike results (`~/code/btx-challenges-wasm/`, byte-equal cross-validation, 24.5× WASM speedup on the dot-product hot loop). Concludes: browser captcha at 1-4s is **not achievable** with the current proof — no combination of WASM + SIMD + multi-worker closes the ~1000× gap. Browser-friendly proof primitive is an upstream BTX protocol question, tracked separately.
- **`TROUBLESHOOTING.md`** — three new entries: `examples-need-service-challenge-rpcs`, `browser-pure-js-perf`, and `cors-x-btx-challenge-hidden`
- **Workspace `pnpm-workspace.yaml`** — `examples/*` glob added so example workspaces resolve SDK packages via symlink
- **Per-middleware READMEs** — cross-links to `examples/02-express-gate`

### Repositioning (important)

The workspace README + `USE-CASES.md` reframe the SDK as **server-side admission middleware**. The 0.x and 1.0.0 releases serve adopters who run a btxd alongside their gate (`mode: 'rpc'` for sub-second solves). Browser-side solving is a reference implementation, not a captcha widget. This is a deliberate scope tightening based on the 2026-05-23 WASM spike measurement.

No package version bumps — examples are not published to npm.

## [0.1.1] - 2026-05-23

Patch release addressing all findings from the **2026-05-23 deep audit** (see `BTX/audits/btx-challenges-sdk-audit-2026-05-23.md`). 3 HIGH + 7 MEDIUM + 5 LOW closed; 2 LOW deferred to `0.2.0` (additive API features); 4 findings explicitly declined with rationale.

Backwards-compatible: no API removals, no signature changes. Recommended upgrade for all `0.1.0` consumers.

### @btx-tools/challenges-sdk (0.1.0 → 0.1.1)

#### Bug fixes
- **H-1**: `retry.max` is now clamped via `Math.max(0, Math.floor(Number(retry.max) || 0))`. Previously, a negative or `NaN` `max` value caused the retry loop to skip entirely, throwing `undefined` (not a `BtxError`). Now the call always runs at least once and throws a real `BtxError` on failure.
- **M-1**: `methodTimeouts[method] ≤ 0` and `timeoutMs ≤ 0` now fall through to the next layer (per-method → client-wide → 30 s default) instead of being treated as "instant abort." Previously, `methodTimeouts: { x: 0 }` would abort the request immediately on first tick, almost certainly not what the caller intended.
- **M-2**: retry delay is now capped at `MAX_RETRY_DELAY_MS = 60_000` (60 s). Previously, a high `retry.max` with large `baseDelayMs` could schedule individual retry delays in the hours/days range.

#### Documentation
- **M-3**: inline comment on `Math.random()` jitter — non-security context (matches A-3 convention from the 2026-05-22 audit).
- **M-1 + M-2**: JSDoc on `BtxClientOpts.timeoutMs` / `methodTimeouts` / `RetryOptions.max` / `RetryOptions.baseDelayMs` updated with new clamp + cap semantics.

#### Tests
- 6 new unit tests for the H-1, M-2, M-5, M-6 cases. Core test count: 152 → 158.

#### Deferred to `0.2.0` (additive feature work)
- **L-3**: `onRetry?: (attempt, err, nextDelayMs) => void` observability callback
- **L-4**: semantic shortcut keys for `methodTimeouts` (e.g., `{ solve: ... }` in addition to raw RPC names)

### @btx-tools/middleware-express (0.2.1 → 0.2.2)

- **L-5**: new "CORS" subsection in README — explicit guidance on `allowedHeaders` + `exposedHeaders` for browser-originated fetches with the custom BTX headers.

### @btx-tools/middleware-fastify (0.1.0 → 0.1.1)

- **M-7**: inline comment on `headerValue` helper confirming first-occurrence selection on duplicate headers is intentional (matches standard proxy behavior).
- **L-5**: new "CORS" subsection in README — `@fastify/cors` configuration.

### @btx-tools/middleware-hono (0.1.0 → 0.1.1)

- **H-2**: new "⚠️ Body consumption" subsection in README — explicit warning about Hono's one-shot `c.req.json()`, with concrete failure example + two safe patterns (cache-body-in-context, derive-from-headers).
- **H-3**: rewrote "Edge-runtime notes" → adds new "Network reachability" subsection: explicit note that edge runtimes can't reach `127.0.0.1` and need Cloudflare Tunnel / public RPC proxy / public-IP relay. Per-runtime notes also tightened (no specific header-size number; cite "consult your platform's docs" instead).
- **L-2**: removed inaccurate Vercel Edge "16 KB cap" claim — replaced with neutral "limits vary across edge platforms" guidance.
- **L-5**: new "CORS" subsection in README — `hono/cors` configuration.

### F-5 honesty pass (M-4)

The F-5 gate added in `0.1.0` is a **ceiling gate**, not a true regression gate (no baseline tracking). This was implicit in the bench comments but not stated outright. The 2026-05-23 audit calls this out as M-4; CHANGELOG now records it explicitly. Upgrading to baseline-tracking (commit `tests/perf/baseline.json`, fail PR on >20 % drift) is queued for `0.1.2` or `0.2.0`.

### Findings explicitly declined (with rationale, full detail in audit doc)

- **M-8** middleware peer-floor tightness (`^0.0.4` instead of `^0.0.1`) — cosmetic; current range works
- **M-9** source maps without source files in tarball — standard npm convention
- **L-6** `as unknown as BtxChallengeClient` in test mocks — standard test idiom
- **L-7** Middleware `kind` field validation — would BREAK on future btxd `kind` evolution; defensive validation is the wrong move

## [0.1.0] - 2026-05-23

Phase 2 release per `BTX/ecosystem/sdk-finishing-plan-2026-05-22.md`. Adds two new framework adapters, closes the remaining 0.1.x audit items, and ships the perf-regression CI gate. Backward-compatible with `0.0.4`: existing consumers of `@btx-tools/challenges-sdk` need no code changes.

### @btx-tools/challenges-sdk (0.0.4 → 0.1.0)

- **D-4: per-method timeout** — new `methodTimeouts?: Record<string, number>` option on `BtxClientOpts`. Falls back to client-wide `timeoutMs`, then 30 s default. Useful for the `solvematmulservicechallenge` RPC which can take 15+ minutes on mining-loaded btxd ([[btxd-solver-mining-contention]]) vs ~50 ms for `getmatmulservicechallenge`. 4 new tests.
- **D-3: retry/backoff** — new `retry?: RetryOptions` option on `BtxClientOpts`. Opt-in (default `{ max: 0 }`). Exponential backoff with optional jitter. Retries only on transient failures (`BtxNetworkError`, `BtxHttpError` ≥ 500); never on 4xx, JSON-RPC errors, parse errors, or timeouts. 6 new tests.
- **F-5: perf-regression CI gate** — new `tests/perf/bench.test.ts` benchmarks `canonicalMatMul(n=64, b=8)` and `deriveCompressionVector(b=8)` against generous ceilings (~5× local M-series baseline) to absorb GitHub Actions runner variance. New `test:perf` script + CI step gated to Node 22 for baseline consistency.
- `RetryOptions` interface exported from package root.
- Test count: 142 → 152 unit + 2 perf bench.

### @btx-tools/middleware-fastify (NEW: 0.1.0)

First Fastify adapter. Mirrors the behavior of `@btx-tools/middleware-express` for Fastify's preHandler hook + reply API. See [`packages/middleware-fastify/CHANGELOG.md`](packages/middleware-fastify/CHANGELOG.md). 11 unit tests via Fastify's built-in `inject` (light-my-request).

### @btx-tools/middleware-hono (NEW: 0.1.0)

First Hono adapter. Works on Node, Deno, Bun, **Cloudflare Workers**, Vercel Edge, etc. Same stateless echo-the-challenge flow, ported to Hono's middleware model + `c.set('btx', ...)` variables. See [`packages/middleware-hono/CHANGELOG.md`](packages/middleware-hono/CHANGELOG.md). 11 unit tests via Hono's `app.request()` (Web fetch API).

### @btx-tools/middleware-express (0.2.0 → 0.2.1)

Peer-dep widening only. Now compatible with both `@btx-tools/challenges-sdk ^0.0.1` AND `^0.1.0`. No behavioral changes. Existing 0.2.0 installs continue to work unchanged.

## [0.0.4] - 2026-05-23

### @btx-tools/challenges-sdk

- **B-3 / risk 6 CLOSED**: pure-JS proof-shape live roundtrip validated end-to-end against a live btxd. The existing pure-JS lifecycle test in `packages/core/tests/integration/solve-redeem.test.ts:145-178` ran against btx-iowa (mine-loop paused, RPC tunneled to Mac, btxd floor difficulty `target_solve_time_s=0.001 + min_solve_time_s=0.001`) and passed in 421 s: `issue → Solver.solve({ mode: 'pure-js' }) → client.redeem` returns `valid: true, reason: 'ok', redeemed: true`. Confirms btxd's `verifymatmulserviceproof` accepts the pure-TS-generated proof shape that we derived from reading btxd's RPC handler source in 0.0.1. Closes the only remaining algorithm-correctness gap from the `[0.0.2] § Still deferred` carry-over and audit `B-3` in `BTX/audits/btx-challenges-sdk-audit-2026-05-22.md`.

  **Auxiliary tests (replay-rejection + auto-mode-fallback) attempted but did not complete cleanly** in this run window: test 2 hit the 75-min `PURE_JS_TIMEOUT_MS` per-test ceiling (random-variance attempt count exceeded budget at floor difficulty); test 3 fetch-failed when the SSH tunnel to the target btxd dropped despite keepalive after ~2 h NAT pressure. **Both failures are infrastructure, not algorithm.** Re-running on a dedicated DO droplet target (per `[[btxd-solver-mining-contention]]`) instead of an iowa-paused tunnel is the suggested follow-up for full 3/3 coverage; the lifecycle test alone is the canonical B-3 closure.

  No code changes in this entry — the algorithm was already locked at unit level via 5 byte-equal goldens in `tests/unit/matmul/btxd-vectors.test.ts` (0.0.1); this is purely the live validation that was deferred from `[0.0.2] § Still deferred`.

## [0.0.3] - 2026-05-22

Audit-resolution release. All non-breaking findings from the 2026-05-22 deep audit (`BTX/audits/btx-challenges-sdk-audit-2026-05-22.md`) addressed at this version. Middleware breaking change ships as a parallel `middleware-express 0.2.0`.

### @btx-tools/challenges-sdk

- **G-1**: `package.json` declares `"sideEffects": false` so bundlers can tree-shake unused exports.
- **A-3**: inline comment on `Math.random` fallback in `client.ts:66` documenting that it's NOT a security context (request-id correlation only).
- **B-5**: new tests cover the nonce-overflow branch in `pow.ts` (start at `MAX_U64`, start at `MAX_U64 - 2n` with wraparound budget).
- **B-6**: `attemptInterval` callback test parameterized across `[1, 2, 5, 10]`.
- **B-4 / F-3**: parameterized `canonicalMatMul` sweep across (n=16,b=2,r=1), (n=16,b=4,r=2), (n=16,b=2,r=4), (n=32,b=4,r=2), (n=32,b=8,r=4), (n=64,b=8,r=4) — locks regression coverage on non-default matmul shapes.
- Net unit test count: 130 → 142.

## [middleware-express 0.2.0] - 2026-05-22 (BREAKING)

⚠️ **Breaking change**: `Express.Request.btxResult` → `req.btx.result`. Migration:

```diff
- console.log(req.btxResult?.reason);
+ console.log(req.btx?.result.reason);
```

### Added

- **D-1**: `BtxAdmissionOpts.onError?: (err: unknown, req: Request) => void` — observability hook fired once when `client.issue()` or `client.redeem()` throws, before `next(err)` runs. Includes 3 new unit tests (issue throws → fires; redeem throws → fires; 403 reject → does NOT fire).
- **G-1**: `package.json` declares `"sideEffects": false`.
- **C-2**: README API table now documents `isProofPresent`.
- **A-5**: README has a new "Error handling" section recommending a custom Express error handler that doesn't leak server-side details.

### Changed (breaking)

- **C-3**: `req.btxResult: VerifyResult` → `req.btx: { result: VerifyResult }`. Reduces global `Express.Request` augmentation pollution and groups future BTX middleware state under a single namespace.

### Migration

Regex-replace across your codebase:

| Before (0.1.x) | After (0.2.0) |
|---|---|
| `req.btxResult` | `req.btx?.result` |
| `req.btxResult?.reason` | `req.btx?.result.reason` |
| `req.btxResult!.redeemed` | `req.btx!.result.redeemed` |

If you don't read `req.btxResult` in your handlers, no migration needed.

### Tests

15 → 18 unit tests (3 new for `onError` hook + namespace updates throughout).

## [0.0.2] - 2026-05-22

Closes 2 of 3 deferred risks from `[0.0.1]`. Risk 6 (pure-JS proof-shape live roundtrip) stays open — closure deferred to 0.0.3.

### Verified live

- **Risk 1 closed**: `tests/integration/solve-redeem.test.ts` RPC-mode lifecycle test ran end-to-end against a live btxd (issue → `Solver.solve({ mode: 'rpc' })` → `client.redeem` → `result.valid: true`). Full HTTP/JSON-RPC contract + Basic auth + redeem path now empirically validated, not just msw-mocked.
- **Risk 2 closed**: cross-engine perf bench captured for Node 22 / V8 (4.6 s/attempt — baseline), Deno 2.7 / V8 (4.2 s/attempt — within noise), Bun 1.3 / JavaScriptCore (9.8 s/attempt — **2.1× slower than V8** for BigInt-heavy M31 arithmetic). README § Performance updated with a cross-engine table + per-engine expected solve times at floor difficulty.

### Still deferred

- **Risk 6**: live roundtrip of a pure-JS-generated proof through `client.redeem` (~1 hr Mac wall-clock per attempt; deferred to 0.0.3). Algorithm correctness is already locked at unit level via 5 byte-equal golden vectors lifted from btxd's own test suite; the live roundtrip would prove the proof field shape we derived from btxd's source is also accepted by the live verifier.

### Test infrastructure changes

- RPC suite tests now use `target_solve_time_s: 0.001 + min_solve_time_s: 0.001` (btxd's floor difficulty) instead of `target_solve_time_s: 1` — keeps iowa-class CPU-only solve under ~10 min for the test pause window. `expires_in_s: 120 → 1800` so the challenge doesn't expire during slow solves. Per-test timeout 360s → 1_200_000ms. Client timeout 300_000ms → 900_000ms with comment.

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

- **Live HTTP-loop integration tests** (`tests/integration/solve-redeem.test.ts`) are present and gated on `BTX_INTEGRATION_URL/AUTH/NODE_DEDICATED`, but have NOT been run end-to-end against a live dedicated btxd before this release. Algorithm correctness is instead validated via 5 byte-equal golden vectors lifted from btxd's own test suite (`tests/unit/matmul/btxd-vectors.test.ts`) + a live sigma cross-check against btx-iowa. HTTP + auth paths are exercised by 14 msw-mocked unit tests + the Day 1 smoke test. The live HTTP-loop run is queued for 0.0.2 once a dedicated non-mining btxd is provisioned.
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
- Plus a live sigma cross-check against btx-iowa's `verifymatmulserviceproof` for two nonces — byte-equal.
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

btxd's `solvematmulservicechallenge` RPC shares matmul backend with block mining. On any mining-loaded node (our entire fleet), the solve RPC takes 15+ minutes — direct SSH-piped measurement on btx-iowa 2026-05-20 ran 900s before btx-cli's own transient-error timeout fired. Solver users MUST point at a dedicated non-mining btxd (e.g., $5/mo DO droplet with `gen=0`). Documented in README. Day 2.5 pure-JS solver removes this constraint for browser clients.

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

*See `~/Documents/BTX/audits/btx-challenges-sdk-day1-audit-2026-05-20.md` for the full audit report.*
