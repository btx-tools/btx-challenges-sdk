# Changelog

All notable changes to packages in this workspace are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) + [SemVer](https://semver.org/).

## [Unreleased]

## [1.1.0] - `@btx-tools/challenges-sdk` (WASM solver mode) — pending publish

Adds an optional **WASM solver mode** backed by
[`@btx-tools/matmul-wasm`](https://github.com/btx-tools/btx-challenges-wasm) — a
byte-exact Rust→WASM port of btxd's matmul PoW. **Backward-compatible** (additive
mode + optional dependency); existing consumers are unaffected unless they opt in.

> **Honest framing:** the WASM kernel is the **fastest JS-environment solver**
> (~24× the pure-JS path) for **server / edge / Node** solving without a btxd. It
> is **not** a casual browser captcha — at the live `n=512` a browser pool floor
> is ~16 s. See the kernel's README for the measured perf.

### Added

- **`mode: 'wasm'`** on `Solver.solve` + `WasmSolveOptions` (`maxTries`,
  `nonceStart`). Produces a proof byte-identical to `'pure-js'`. Throws a clear,
  catchable error if the optional `@btx-tools/matmul-wasm` package isn't installed.
- `@btx-tools/matmul-wasm` as an **`optionalDependency`** (`^0.1.0`).

### Changed

- **`mode: 'auto'` now prefers the WASM kernel when installed** — cascade is
  `rpc` (if `rpcClient`) → `wasm` (if `@btx-tools/matmul-wasm` resolves) → `pure-js`.
  Previously `auto` with no client went straight to pure-js. RPC / explicit
  pure-js outcomes are unchanged; proofs are identical, just faster. The optional
  import is probed at most once per process.

### Notes

- The published `@btx-tools/matmul-wasm` build targets **browsers/bundlers**
  (Vite, Next, Workers). In **plain Node**, its `init()` can't fetch the `.wasm`
  via `import.meta.url` — `mode: 'wasm'` then throws a distinct
  "found but couldn't initialize here" error (vs the "not installed" error), and
  `mode: 'auto'` quietly falls through to pure-js. Plain-Node consumers should
  build the package's `nodejs` target from source or solve via `mode: 'rpc'`.

## [1.0.3] - 2026-05-23 — `@btx-tools/challenges-sdk` (code docs)

Source-doc clarity; no behavior change. Republished so the `.d.ts` (IDE hover) carries it.

- **`BtxChallengeClient` JSDoc** now states the **node prerequisite** + who needs one: the service provider always (for `issue`/`verify`/`redeem`); callers only for fast `rpc` solving (else slow pure-JS). `rpcUrl` doc notes it's a `btxd` you run (no hosted endpoint), non-mining for `rpc` solves.
- **`SolverMode` JSDoc** de-stale'd: dropped "WASM/SIMD acceleration planned" (the 2026-05 spike concluded browser solving isn't viable) → now points to `rpc` server-side solving as the production path.
- Example `02-express-gate` prereqs note the non-mining requirement + link to core Prerequisites.

## 2026-05-23 — docs clarity pass (core → `1.0.2`, middleware-\* → `1.0.1`)

Docs-only across the family; no code or API change. Republished so the npm package pages carry the clarity.

- **`@btx-tools/challenges-sdk` (1.0.1 → 1.0.2)** — added a **"Prerequisites: you need a BTX node"** section: this SDK requires a reachable `btxd` (non-mining for ~1–4 s solves), there is no hosted/public endpoint, and pure-JS solving is minutes-to-hours at production difficulty. Makes the node requirement explicit up front.
- **`@btx-tools/middleware-express` (1.0.0 → 1.0.1), `-fastify` (1.0.0 → 1.0.1), `-hono` (1.0.0 → 1.0.1)** — each adapter README gained a "New to BTX service challenges?" intro + a Prerequisites note (linking to the core README), so each npm page is self-explanatory. Fixed a stale `middleware-express` Status line (was "0.2.0 / peer ^0.0.1"); hono notes the edge-runtime `127.0.0.1` reachability caveat.

## [1.0.1] - 2026-05-23 — `@btx-tools/challenges-sdk` (docs only)

README rewrite for npm-page clarity — **no code, no API change.** Republished so the improved README reaches the npm package page.

- New "What is this?" intro: the problem (vs CAPTCHA / accounts / hosted anti-bot), an `issue → solve → redeem` ASCII flow diagram, and use cases — mirrors the monorepo README.
- Removed stale claims that misrepresented shipped state: the "Day 2.6 WASM kernel coming (10×)" line (the WASM spike concluded browser solving isn't viable — solve server-side via `rpc`), "Fastify + Hono adapters queued" (both shipped + stable), and the day-by-day roadmap table (replaced with a "shipped & stable at 1.0.0" status + post-1.0 pointer).
- Test-count + perf framing refreshed.

(Other packages unchanged at `1.0.0`; core peer range on middleware is `^1.0.0`, so `1.0.1` is in-range.)

## [1.0.0] - 2026-05-23

**Stable API freeze.** All four `@btx-tools/*` SDK packages move to `1.0.0` together. The public API is now under [SemVer](https://semver.org/) — breaking changes require a `2.0.0`. **No code changes from `0.3.1`/`0.2.3`/`0.1.2`** — this release promotes the existing, audit-clean surface to a stability commitment.

### Packages

| Package                         | 1.0.0 from |
| ------------------------------- | ---------- |
| `@btx-tools/challenges-sdk`     | 0.3.1      |
| `@btx-tools/middleware-express` | 0.2.3      |
| `@btx-tools/middleware-fastify` | 0.1.2      |
| `@btx-tools/middleware-hono`    | 0.1.2      |

### Frozen public surface

- **core** — `BtxChallengeClient` (`call`/`issue`/`verify`/`redeem`/`verifyBatch`/`redeemBatch`/`solve`, all with optional trailing `RpcCallOpts`), `Solver`, the six `Btx*Error` classes, and the option/challenge/result types (`BtxClientOpts`, `RetryOptions`, `RpcCallOpts`, `IssueParams`, the `Challenge*` type family, `SolverOptions`/`SolverMode`/`SolveJsOptions`, `SolverOutput`, `VerifyResult`/`VerifyReason`, `BatchEntry`/`BatchResult`). Verified: no internal symbols leak (e.g. `CallerAbortError` stays private).
- **middleware (express / fastify / hono)** — `btxAdmission`, `BtxAdmissionOpts`, `StringOrFn`, the `HEADER_*` constants (+ hono's `BtxAdmissionVariables`). Peer dependency pinned to `@btx-tools/challenges-sdk@^1.0.0`.

### Stability notes

- Backwards-compatible with `0.3.x` consumers — no signature or behavior changes; upgrading is a version bump.
- All findings across every SDK audit + the `mcp-gateway` audit are closed.
- API reference: https://btx-tools.github.io/btx-challenges-sdk/

## [0.3.1] - 2026-05-23

Audit-resolution release (deep audit of `0.3.0` + Phase 5 docs). All fixes are backwards-compatible; no behavior change for existing code beyond a stricter retry-delay cap.

### Fixed — `@btx-tools/challenges-sdk` (0.3.0 → 0.3.1)

- **M-1: API-reference docs shipped a broken install scope.** Source JSDoc in `src/index.ts` + `src/solver.ts` still referenced the old, non-existent `@btx/challenges-sdk` scope — which TypeDoc rendered into the published API reference (an uninstallable `npm install`). Corrected to `@btx-tools/challenges-sdk`.
- **M-2: `SolverOptions` now exported.** It was referenced by `Solver.solve` but not re-exported, so it was dropped from the generated docs and unavailable to consumers. Now `export`ed from the package root.
- **L-1: `SEMANTIC_TIMEOUT_ALIAS` is now a null-prototype object.** A `methodTimeouts` lookup keyed by an inherited name (`__proto__`, `constructor`, …) previously returned an `Object.prototype` member instead of `undefined`. Not exploitable (method names come from caller code, not request data), but a soundness wart — fixed with `Object.create(null)`.
- **L-2: retry-delay cap now applied after jitter.** With `jitter: true`, the delay (and the value reported to `onRetry`) could reach `60s + baseDelayMs`. The 60s cap is now applied last, so the slept delay never exceeds it — matching the documented behavior.

### Fixed — middleware (`-express` 0.2.2 → 0.2.3, `-fastify`/`-hono` 0.1.1 → 0.1.2)

- **M-2: `StringOrFn` now exported** from each adapter — it's the type of the `purpose`/`resource`/`subject` resolver options but was previously package-private (undocumented).
- **L-4: peer-dependency range widened** to `… || ^0.2.0 || ^0.3.0` so installing alongside core `0.2.x`/`0.3.x` no longer emits an unmet-peer warning.

### Tooling

- **M-3: CI prettier check made structurally robust.** The `pnpm -r exec prettier --check "src/**/*.ts" "tests/**/*.ts"` form exited 2 ("no files matching") for any workspace member lacking one of those dirs (e.g. `examples/*`, or a future package without `tests/`). Replaced with a single `prettier --check "packages/**/*.ts"` glob + a new `.prettierignore` (excludes `dist`/`node_modules`/`docs-site`).
- **L-3: added a regression test** pinning the documented "an error thrown inside `onRetry` propagates out of the client call" behavior.

## [0.3.0] - 2026-05-23

Minor release — lands the two additive API features deferred from the `0.1.1`/`0.2.0` audits (L-3 + L-4). Backwards-compatible with `0.2.0`: both are optional, no signature changes, no behavior change for code that doesn't opt in.

### Added — `@btx-tools/challenges-sdk` (0.2.0 → 0.3.0)

- **`RetryOptions.onRetry?: (attempt, error, nextDelayMs) => void`** (audit L-3) — observability hook fired once per scheduled retry, **before** the backoff sleep, with:
  - `attempt` — 1-indexed retry number (1 = first retry after the initial call)
  - `error` — the retryable error from the just-failed attempt (`BtxNetworkError` or a 5xx `BtxHttpError`)
  - `nextDelayMs` — the exact delay (post-jitter) about to be slept

  Fires only for retryable failures (non-retryable errors throw before another attempt is scheduled). If the caller's `AbortSignal` fires during the subsequent sleep, the retry is still abandoned — the hook reports intent-to-retry, not success. A throw inside the callback propagates out of the client call; keep it cheap.

- **Semantic shortcut keys for `methodTimeouts`** (audit L-4) — in addition to raw btxd RPC method names, `methodTimeouts` now accepts semantic aliases:

  | semantic      | raw RPC method                |
  | ------------- | ----------------------------- |
  | `issue`       | `getmatmulservicechallenge`   |
  | `verify`      | `verifymatmulserviceproof`    |
  | `redeem`      | `redeemmatmulserviceproof`    |
  | `verifyBatch` | `verifymatmulserviceproofs`   |
  | `redeemBatch` | `redeemmatmulserviceproofs`   |
  | `solve`       | `solvematmulservicechallenge` |

  e.g. `{ solve: 1_000_000 }` instead of `{ solvematmulservicechallenge: 1_000_000 }`. A raw-method key always wins over its semantic alias (more specific). The existing `≤ 0 = no override` rule (audit M-1) is preserved at every resolution level.

### Test delta

168 → 176 tests (+8): four for `onRetry` (fires per-retry with 1-indexed attempt + retryable error; not called when `max: 0`; exact post-backoff delay series; never fires on a 4xx), four for semantic aliases (`solve` alias applies; raw key beats alias; alias `≤ 0` falls through; `issue` alias applies).

### Notes

- Both features close the last two deferred audit items; no remaining audit findings block a `1.0.0` API freeze.
- Only `@btx-tools/challenges-sdk` changes — middleware (express/fastify/hono) + `mcp-gateway` are unaffected (the new options are additive and read inside core).

## [0.2.0] - 2026-05-23

Minor release — adds AbortSignal plumbing across the public client surface. Backwards-compatible with `0.1.1` (all new args are optional and trailing).

### Added — `@btx-tools/challenges-sdk` (0.1.1 → 0.2.0)

- **`RpcCallOpts`** — new exported type. Currently has one field: `signal?: AbortSignal`. Open-shape so future per-call options (per-call header overrides, per-call timeout overrides) can land additively without another version bump.
- **`signal?: AbortSignal` plumbed end-to-end** through every public client method:
  - `client.call<T>(method, params?, opts?)`
  - `client.issue(params, opts?)`
  - `client.verify(challenge, nonce, digest, lookup?, opts?)`
  - `client.redeem(challenge, nonce, digest, opts?)`
  - `client.verifyBatch(entries, opts?)`
  - `client.redeemBatch(entries, opts?)`
  - `client.solve(challenge, opts?)`

  Behavior: external signal is composed with the internal timeout AbortController. If the external signal fires:
  - **Before fetch starts** (or before call enters retry loop) → throws `BtxNetworkError` immediately, no request sent
  - **During fetch** → underlying fetch is aborted, throws `BtxNetworkError` (distinguishable from `BtxTimeoutError` — the cause is a `CallerAbortError` not an internal timer)
  - **During retry backoff sleep** → backoff is interrupted, retry loop exits, throws `BtxNetworkError`. No further requests sent.

  Caveat for `redeem` / `redeemBatch`: if the abort fires AFTER btxd has consumed the challenge (RPC completed server-side before the local fetch was aborted), the redemption stands. Callers handling cancellation should verify via a separate `verify()` if post-abort state matters.

### Motivation

Closes audit MED-8 from `internal notes`. The MCP gateway needed to forward its `extra.signal` from agent client tool-call cancellations into the BTX RPC client; before this change, the SDK had no way to accept an external signal. Now the gateway can plumb cancellation end-to-end.

### Test delta

161 → 168 tests (+7 new abort-specific tests covering: pre-aborted signal fast-path, mid-fetch abort, internal-timeout vs external-abort disambiguation, abort during retry backoff, no-abort regression, signal propagation through `issue()` + `redeem()`).

### Deferred (still queued for a later minor)

- `RetryOptions.onRetry?: (attempt, err, nextDelayMs) => void` observability callback (L-3 from 0.1.1 audit)
- Semantic shortcut keys for `methodTimeouts` (e.g. `{ solve: ... }`) (L-4 from 0.1.1 audit)

Both can land in a `0.2.x` patch or `0.3.0` minor without breaking 0.2.0 consumers.

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

- **D-4: per-method timeout** — new `methodTimeouts?: Record<string, number>` option on `BtxClientOpts`. Falls back to client-wide `timeoutMs`, then 30 s default. Useful for the `solvematmulservicechallenge` RPC which can take 15+ minutes on mining-loaded btxd ((internal reference)) vs ~50 ms for `getmatmulservicechallenge`. 4 new tests.
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

- **B-3 / risk 6 CLOSED**: pure-JS proof-shape live roundtrip validated end-to-end against a live btxd. The existing pure-JS lifecycle test in `packages/core/tests/integration/solve-redeem.test.ts:145-178` ran against btx-node (mine-loop paused, RPC tunneled to Mac, btxd floor difficulty `target_solve_time_s=0.001 + min_solve_time_s=0.001`) and passed in 421 s: `issue → Solver.solve({ mode: 'pure-js' }) → client.redeem` returns `valid: true, reason: 'ok', redeemed: true`. Confirms btxd's `verifymatmulserviceproof` accepts the pure-TS-generated proof shape that we derived from reading btxd's RPC handler source in 0.0.1. Closes the only remaining algorithm-correctness gap from the `[0.0.2] § Still deferred` carry-over and audit `B-3` in `BTX/audits/btx-challenges-sdk-audit-2026-05-22.md`.

  **Auxiliary tests (replay-rejection + auto-mode-fallback) attempted but did not complete cleanly** in this run window: test 2 hit the 75-min `PURE_JS_TIMEOUT_MS` per-test ceiling (random-variance attempt count exceeded budget at floor difficulty); test 3 fetch-failed when the SSH tunnel to the target btxd dropped despite keepalive after ~2 h NAT pressure. **Both failures are infrastructure, not algorithm.** Re-running on a dedicated DO droplet target (per `(internal reference)`) instead of an a paused-mining node is the suggested follow-up for full 3/3 coverage; the lifecycle test alone is the canonical B-3 closure.

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

| Before (0.1.x)            | After (0.2.0)              |
| ------------------------- | -------------------------- |
| `req.btxResult`           | `req.btx?.result`          |
| `req.btxResult?.reason`   | `req.btx?.result.reason`   |
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

- RPC suite tests now use `target_solve_time_s: 0.001 + min_solve_time_s: 0.001` (btxd's floor difficulty) instead of `target_solve_time_s: 1` — keeps CPU-only CPU-only solve under ~10 min for the test pause window. `expires_in_s: 120 → 1800` so the challenge doesn't expire during slow solves. Per-test timeout 360s → 1_200_000ms. Client timeout 300_000ms → 900_000ms with comment.

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

_See `internal notes` for the full audit report._
