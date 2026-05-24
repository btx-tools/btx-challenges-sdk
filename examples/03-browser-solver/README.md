# 03-browser-solver

> ## ⚠️ A wire-protocol + WASM-perf demonstration, NOT a casual captcha
>
> Two pages: `index.html` solves with the **pure-JS** solver (~7-10 min per **solve** at floor difficulty on an M-series Mac); `bench.html` solves with the shipped **WASM** kernel ([`@btx-tools/matmul-wasm`](https://www.npmjs.com/package/@btx-tools/matmul-wasm)) across a Web Worker pool. Both demonstrate the issue → 402 → solve → 200 protocol end-to-end from a browser.
>
> **The WASM kernel is ~24× pure-JS and byte-identical — but a browser is still not a casual captcha at the live `n=512`.** A floor-difficulty solve is ~16 s on an 8-worker pool (128 ms/attempt V8 · 165 ms Firefox), and SIMD's 2–4× doesn't close the ~100× browser-vs-native gap. See [`../../USE-CASES.md`](../../USE-CASES.md) and [`../../BROWSER-PERF-FINDINGS-2026-05-23.md`](../../BROWSER-PERF-FINDINGS-2026-05-23.md) for the full measurement.
>
> WASM is great for **fast no-node solving** (server/edge/CLI) and **high-friction one-shot gates** (signup / KYC-alt, where ~16 s is acceptable). For a sub-second click-to-admit widget, use hCaptcha / Cloudflare Turnstile / Friendly Captcha until BTX ships a browser-friendly proof primitive.

Vite app that drives the BTX admission flow from the browser. Uses Web Workers so the matmul proof-of-work runs off the main thread and the page stays responsive.

## Prereqs

- Node ≥ 18.17
- [`../02-express-gate`](../02-express-gate) running locally on `http://localhost:3000` (the browser needs a server to issue + redeem against)
- A modern browser (Chrome 90+, Safari 15+, Firefox 89+)

## Install + run

```bash
pnpm install       # at the repo root, once

# in another terminal: start the example 02 gate first
cd ../02-express-gate && pnpm start:server

# then back here
pnpm dev
```

Open the URL Vite prints (default `http://localhost:5173`), set the gate URL + cycle count, click **Run cycles**.

## What you'll see

- A table appears under the button, one row per cycle: `402 (ms)`, `solve (ms)`, `200 (ms)`, `total (ms)`, `status`.
- The status line above the table shows live progress.
- A single solve cycle takes ~7-10 minutes on an M-series Mac at floor difficulty. Run 3+ cycles for a useful perf measurement.

## How it works

**`index.html` (pure-JS flow):**

1. **`src/main.ts` (UI thread)** — POSTs to the gate URL, reads the 402 challenge from the `X-BTX-Challenge` response header.
2. **`src/solver.worker.ts` (Web Worker)** — receives the challenge via `postMessage`, calls `Solver.solve(challenge, { mode: 'pure-js' })`, posts back `{ nonce, digest, msElapsed }`.
3. **`src/main.ts`** — POSTs again with the three proof headers (`X-BTX-Challenge`, `X-BTX-Proof-Nonce`, `X-BTX-Proof-Digest`), expects 200, records the timing.
4. Repeat for N cycles.

**`bench.html` (WASM worker-pool flow):**

- **`src/bench.ts`** spawns N workers (`navigator.hardwareConcurrency`), each a **`src/wasm-solver.worker.ts`** running the `@btx-tools/matmul-wasm` `WasmSolver` over a **strided** nonce range (worker `k` of `N` scans `k, k+N, k+2N, …`); first to find a proof wins and the rest are terminated.
- The WASM kernel is the **`@btx-tools/matmul-wasm`** dependency (resolved from npm); Vite bundles its `.js` + `.wasm` asset for the worker — no separate build step.
- Includes a `[correctness]` check that solves the n=8 fixture in-browser and asserts the proof is byte-identical to the pure-JS reference.

## CORS

The 402 response header is custom (`X-BTX-Challenge`); browsers hide non-CORS-safelisted response headers from JS unless the server lists them in `Access-Control-Expose-Headers`. The example 02 server is preconfigured with both `allowedHeaders` and `exposedHeaders` covering all four BTX headers — if you fork the gate or front it with a different proxy, mirror that config. See [middleware-express README § CORS](../../packages/middleware-express/README.md#cors).

## Build for static hosting

```bash
pnpm build       # emits dist/ — drop it in any static host
pnpm preview     # serve the built bundle locally
```

The build is a fully static `index.html` + JS bundle + worker chunk. Nothing else server-side — though of course it still needs a reachable gate URL to talk to.

## Perf notes (pure-JS vs WASM)

Browser pure-JS solve dominates total request time by orders of magnitude — the matmul kernel is BigInt-bound. The shipped WASM kernel is **~24× faster** (128 ms/attempt V8 · 165 ms Firefox at the live `n=512`), byte-identical proof:

- **`mode: 'wasm'`** (`bench.html`) — fast no-node solving; an 8-worker pool reaches a floor-difficulty solve in ~16 s. Recommended whenever there's no nearby btxd.
- **`mode: 'pure-js'`** (`index.html`) — no optional dependency; ~7-10 min/solve at floor difficulty. Fine for demos and tolerant flows.
- Neither is a sub-second casual captcha at `n=512`. See [`../../BROWSER-PERF-FINDINGS-2026-05-23.md`](../../BROWSER-PERF-FINDINGS-2026-05-23.md) for the full measurement and the upstream-primitive path.

## Troubleshooting

- **`Failed to fetch`** or CORS errors → the gate URL is unreachable, or the server's CORS config doesn't include this page's origin. Update `CORS_ORIGIN` in `../02-express-gate/.env`.
- **`402 received but X-BTX-Challenge header is absent`** → the gate returned 402 but the browser can't read the challenge header. This is a CORS `exposedHeaders` issue. See `../02-express-gate/src/server.ts` for the working config.
- **Worker error / `403 expired`** → if a solve takes longer than `expires_in_s` (default 1800s = 30 min), the redeem will fail. Bump `issueParams.expires_in_s` server-side.
- **Page locks up** → the solver is in the worker, so the UI should stay responsive. If it doesn't, your browser may not support module workers — try Chrome.

More entries in [`../../TROUBLESHOOTING.md`](../../TROUBLESHOOTING.md).
