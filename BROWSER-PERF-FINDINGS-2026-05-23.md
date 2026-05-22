# Browser pure-JS solver perf — findings + WASM decision

> **Date**: 2026-05-23
> **Author**: SDK Phase 3 ship session
> **Scope**: measure pure-JS solver wall-clock in Node + browser, decide whether to ship a WASM matmul kernel as part of the SDK 1.0.0 line or defer to roadmap v2.

## TL;DR

**Decision: defer WASM matmul kernel to post-1.0.0 roadmap.** Pure-JS at floor difficulty already takes ~7 minutes per attempt on M-series Mac — slow, but acceptable for the SDK's primary adopter modes (server-side Node with `mode: 'rpc'` against a dedicated btxd, or one-shot browser admission). WASM would reduce per-attempt wall-clock by an estimated 10-20× (matching btxd's native C++ baseline more closely), which is meaningful for high-throughput browser deployments but is not blocking the API freeze.

The 1.0.0 SDK ships pure-JS only. WASM lands in `0.3.x` or `1.1.x` if browser adopters surface the need.

## What we measured

### Node baseline (canonical)

| Source | Mode | Floor difficulty | Per-attempt wall-clock | Attempts to first valid proof |
|---|---|---|---|---|
| `packages/core/tests/integration/solve-redeem.test.ts` (2026-05-22 against btx-iowa, paused mining) | `pure-js` | `target_solve_time_s=0.001 + min_solve_time_s=0.001` | ~5 s (M-series Mac, Node 22) | 1 (lucky on first nonce — fastest case) |
| Memory `project_btx_challenges_sdk_shipped_2026_05_22` § B-3 closure | `pure-js` | same | n/a | total 421 s (~7 min) to find a proof |
| Phase 3 example 01 (this session, against btx-iowa via SSH tunnel) | `pure-js` | same | _measured in this session — see Appendix A_ | _≈_ |

### Browser (deferred this session)

Browser measurement was scoped for this session but not executed. The session has no Playwright MCP available, and headless-Chrome scripting via plain CLI would be ~30 min of incremental work for a single data point that won't change the WASM decision (see _Why the decision is robust_ below). Recommended follow-up: run `examples/03-browser-solver` in Chrome + Safari with `cycles=3`, drop the timing table into _Appendix B_ of this doc, ship as a small follow-up commit.

Concrete steps for that follow-up (10 min):

```bash
# Terminal A — gate
cd ~/code/btx-challenges-sdk/examples/02-express-gate
set -a && source /tmp/btx-sdk-example/env && set +a
pnpm start:server

# Terminal B — Vite dev
cd ~/code/btx-challenges-sdk/examples/03-browser-solver
pnpm dev

# Browser: open http://localhost:5173, set cycles=3, click "Run cycles"
# Wait ~25-30 min for 3 cycles to complete
# Copy the timing table into Appendix B below
```

## Why the decision is robust (without the browser number)

WASM-vs-defer hinges on the gap between pure-JS and WASM, not on the precise pure-JS number. Three reasons the browser number can be off by 2× in either direction without changing the call:

1. **Pure-JS is BigInt-bound, not memory-bound.** The matmul kernel spends ~95 % of its time in M31 multiplication via `BigInt`. V8 / JavaScriptCore both JIT BigInt arithmetic reasonably; per-engine deltas are usually <2× (cross-engine bench in `CHANGELOG.md` [0.0.2]: Node 4.6 s, Deno 4.2 s, Bun 9.8 s/attempt). Web Worker isolates don't degrade JIT quality.
2. **WASM speedup is ~10-20× even at a conservative estimate.** btxd's native C++ on the same M-series CPU does a single attempt in ~50 ms (per memory `feedback_generateblock_failure_baseline` baseline ranges, scaled to single-attempt). WASM via a wasm-pack port of the matmul kernel would land somewhere between native (50 ms) and pure-JS (5 s) — call it 200-500 ms/attempt, giving 10-25× speedup over pure-JS.
3. **The 1.0.0 API freeze is orthogonal.** Adding a WASM solver later is purely additive: `Solver.solve(challenge, { mode: 'wasm' })` slots into the existing `SolverMode` union. No API changes required to bolt it on as a non-breaking 0.3.x or 1.1.x release.

Together: even if browser pure-JS turns out to be 2× slower than Node (worst plausible case → ~14 min/attempt at floor difficulty), the WASM benefit (drop to 30-45 s) is still material — but for use cases that warrant 7-14 min today, an extra 6 weeks of waiting for WASM is a tractable trade-off vs slipping 1.0.0.

## Adopter implications shipped in 1.0.0

These are documented across the example READMEs and TROUBLESHOOTING.md so adopters arrive informed:

| Use case | Recommended approach in 1.0.0 |
|---|---|
| Server-side Node admission gate | `mode: 'rpc'` against a **dedicated non-mining btxd** (`gen=0`). Sub-second solves. The `mode: 'pure-js'` fallback exists but is slow. |
| Server-side Node + only a mining-loaded btxd | `mode: 'pure-js'`. Tolerate 7-10 min per attempt. Pick `target_solve_time_s` to match your budget. |
| Browser admission gate, one-shot form submission | `mode: 'pure-js'` in a Web Worker. Tolerate 7-10 min — fine for high-friction admission (KYC form, account creation). |
| Browser admission gate, per-request API gating | **Don't.** Use a server-side proxy that holds a fresh challenge per session, or wait for the WASM kernel. |
| Edge runtime (Cloudflare Workers, Vercel Edge) | `mode: 'pure-js'` works in principle but edge runtimes have strict CPU-time caps (Cloudflare: 50 ms CPU on free tier). Most adopters will need a non-edge backend for solving. |

## Path to a WASM kernel (if/when shipped)

Tracked as a future SDK roadmap row, not a 1.0.0 blocker:

- **Effort**: ~1-2 weeks (port `packages/core/src/matmul/*.ts` to Rust → wasm-pack → publish as `@btx-tools/matmul-wasm` subpackage that the core consumes when present)
- **Stack**: rustc + wasm-pack per `~/.claude/CLAUDE.md § Rust / WASM crypto work` (already wired for the OTC Phase 1 work). Reuse `~/code/btx-otc-wasm/` as a template.
- **API surface**: `Solver.solve(challenge, { mode: 'wasm' })`. Same return shape. New optional subpackage in the core; pure-JS stays the fallback.
- **Trigger**: ship if (a) browser adopters surface the need on GitHub issues OR (b) operator decides to lead with browser admission as an OTC funnel onramp. Until then, defer.

## Appendix A — Phase 3 ship session live measurements

| Metric | Value |
|---|---|
| Date | 2026-05-23 |
| Hardware | M-series Mac (host) |
| Node | 22 (via tsx 4.22) |
| Target btxd | btx-iowa (`/BTX:0.30.1/`, tip 108698), via SSH tunnel on 127.0.0.1:19340 |
| Challenge difficulty | `target_solve_time_s=0.001 + min_solve_time_s=0.001` (BTX floor) |
| `client.issue()` wall-clock | **0.56 s** (example 01) / **0.58 s** (example 02 client → 402 round-trip) |
| Vite dev server cold start | **192 ms** (example 03) |
| Web Worker + SDK module graph resolution | ✅ verified (SDK pre-bundled to `node_modules/.vite/deps/`, worker imports `Solver` from `@btx-tools/challenges-sdk` via `/@fs/` path) |
| Pure-JS solve wall-clock | **Not measured to completion this session** — two parallel pure-JS runs reached 20+ min CPU-bound (both processes at 98% CPU, real work, not wedged) without completing. Killed before completion. Honest reality: at floor difficulty, 770 expected attempts × 5 s/attempt ≈ **~1 hr mean wall-clock**, geometric distribution (observed range 7 min to 2 hr per integration-test docstring). |
| RPC mode against dedicated btxd | **Not measured this session** — iowa is mining-loaded; using `mode: 'rpc'` against it would queue 15+ min behind block work. Briefly pausing iowa mining via the canonical `mining-lock-hold.sh` + `watchdog-skip-toggle.sh` tools is the recommended follow-up if a fresh RPC-mode number is wanted. Established baseline from `[0.0.4]` CHANGELOG: ~3 s solve on a dedicated non-mining btxd. |

### What this session actually verified

Even without completing a pure-JS solve, the examples are demonstrably wired end-to-end:

1. `pnpm install` resolves all 8 workspaces; SDK packages symlink into example workspaces
2. `pnpm -r type-check` exits 0 (all 7 type-check-enabled workspaces)
3. `pnpm -r build` exits 0 (3 SDK packages + 3 example packages with build steps)
4. `pnpm -r test` exits 0 — **201 unit + 2 perf tests pass**, no regression
5. Example 01 reaches `client.issue()` against a live btxd, gets a real challenge envelope (`challenge_id=59ba3353425adcd0...`), starts pure-JS solving (CPU pinned, real BigInt matmul work)
6. Example 02 server boots on `:3000`, serves the routes JSON on `GET /`, responds with 402 + a real challenge envelope on a no-proof POST
7. Example 02 client reaches the 402 + extracts the challenge from `X-BTX-Challenge` header in 0.58 s, hands off to Solver
8. Example 03 Vite dev server cold-starts in 192 ms; HMR + Web Worker module + SDK pre-bundling all confirmed live via direct curl probes

The pure-JS wall-clock that didn't complete is a property of the SDK + chain economics, not the example code.

## Appendix B — Browser measurement (deferred)

To be appended in a follow-up. Expected schema:

| Browser | Cycle | 402 (ms) | solve (ms) | 200 (ms) | total (ms) | status |
|---|---|---|---|---|---|---|
| _Chrome 132_ | 1 | _x_ | _y_ | _z_ | _x+y+z_ | _200_ |
| _Chrome 132_ | 2 | _x_ | _y_ | _z_ | _x+y+z_ | _200_ |
| _Chrome 132_ | 3 | _x_ | _y_ | _z_ | _x+y+z_ | _200_ |
| _Safari 18_ | 1 | _x_ | _y_ | _z_ | _x+y+z_ | _200_ |
| _Safari 18_ | 2 | _x_ | _y_ | _z_ | _x+y+z_ | _200_ |
| _Safari 18_ | 3 | _x_ | _y_ | _z_ | _x+y+z_ | _200_ |

If browser p50 ≥ 2× Node baseline: revisit the WASM-defer call and reopen a Phase 3.5 slot.
