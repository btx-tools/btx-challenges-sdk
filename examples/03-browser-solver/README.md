# 03-browser-solver

> ## ⚠️ This is a wire-protocol demonstration, NOT a production captcha
>
> The pure-JS solver in this example takes **~7-60 minutes per attempt** at BTX's floor difficulty on an M-series Mac, and **~hours at production difficulty**. It is here to demonstrate that the issue → 402 → solve → 200 protocol works end-to-end from a browser, NOT to be deployed as a captcha widget.
>
> **Browser captcha is not currently a viable product with the BTX matmul proof.** Per our 2026-05-23 WASM spike (`~/code/btx-challenges-wasm/`), no combination of WASM + SIMD + multi-worker parallelism closes the 1000× gap to the 1-4s budget btx.dev recommends. See [`../../USE-CASES.md`](../../USE-CASES.md) and [`../../BROWSER-PERF-FINDINGS-2026-05-23.md`](../../BROWSER-PERF-FINDINGS-2026-05-23.md) for the full analysis.
>
> If you need a browser captcha: use hCaptcha, Cloudflare Turnstile, or Friendly Captcha. Watch for upstream BTX changes (new proof primitive) before adopting this for browser use.

Single-page Vite app that drives the BTX admission flow from the browser. Uses a Web Worker so the matmul proof-of-work runs off the main thread and the page stays responsive.

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

1. **`src/main.ts` (UI thread)** — POSTs to the gate URL, reads the 402 challenge from the `X-BTX-Challenge` response header.
2. **`src/solver.worker.ts` (Web Worker)** — receives the challenge via `postMessage`, calls `Solver.solve(challenge, { mode: 'pure-js' })`, posts back `{ nonce, digest, msElapsed }`.
3. **`src/main.ts`** — POSTs again with the three proof headers (`X-BTX-Challenge`, `X-BTX-Proof-Nonce`, `X-BTX-Proof-Digest`), expects 200, records the timing.
4. Repeat for N cycles.

## CORS

The 402 response header is custom (`X-BTX-Challenge`); browsers hide non-CORS-safelisted response headers from JS unless the server lists them in `Access-Control-Expose-Headers`. The example 02 server is preconfigured with both `allowedHeaders` and `exposedHeaders` covering all four BTX headers — if you fork the gate or front it with a different proxy, mirror that config. See [middleware-express README § CORS](../../packages/middleware-express/README.md#cors).

## Build for static hosting

```bash
pnpm build       # emits dist/ — drop it in any static host
pnpm preview     # serve the built bundle locally
```

The build is a fully static `index.html` + JS bundle + worker chunk. Nothing else server-side — though of course it still needs a reachable gate URL to talk to.

## Perf notes (decision point for WASM)

Browser pure-JS solve dominates total request time by orders of magnitude. The matmul kernel is BigInt-bound, which V8/JavaScriptCore optimize aggressively but can't match a native or WASM implementation.

- If your adopters can tolerate 7-10 min/attempt at floor difficulty, pure-JS is fine.
- If they can't, ship a WASM kernel — see [`../../BROWSER-PERF-FINDINGS-2026-05-23.md`](../../BROWSER-PERF-FINDINGS-2026-05-23.md) for the decision rationale and current path.

## Troubleshooting

- **`Failed to fetch`** or CORS errors → the gate URL is unreachable, or the server's CORS config doesn't include this page's origin. Update `CORS_ORIGIN` in `../02-express-gate/.env`.
- **`402 received but X-BTX-Challenge header is absent`** → the gate returned 402 but the browser can't read the challenge header. This is a CORS `exposedHeaders` issue. See `../02-express-gate/src/server.ts` for the working config.
- **Worker error / `403 expired`** → if a solve takes longer than `expires_in_s` (default 1800s = 30 min), the redeem will fail. Bump `issueParams.expires_in_s` server-side.
- **Page locks up** → the solver is in the worker, so the UI should stay responsive. If it doesn't, your browser may not support module workers — try Chrome.

More entries in [`../../TROUBLESHOOTING.md`](../../TROUBLESHOOTING.md).
