# Use cases — which mode for what?

> **TL;DR**: this SDK is for **server-side admission control** that gates HTTP routes behind chain-anchored proof-of-work. Browser-side solving is a reference implementation, **not** a deployable captcha. If you're trying to put a "click this captcha" widget in front of users, this SDK is not (yet) the right tool — see the table below.

## Decision tree

| Your situation | Recommended mode | Notes |
|---|---|---|
| **Server-side API gate** (AI inference platform, MCP gateway, B2B API admission, L2/sidechain admission) — your server runs alongside a btxd | **`mode: 'rpc'`** against a dedicated non-mining btxd | The documented btx.dev path. Sub-second solves. ✅ Use [`@btx-tools/middleware-express` / `-fastify` / `-hono`](packages/middleware-express). |
| **Server-side gate** but you can't run btxd nearby — you receive proofs from callers who already have one | **Just `client.redeem`** in your gate | The middleware adapters handle this automatically. No solving on your end. ✅ Production-ready. |
| **CLI / Node-script tool** that needs to solve a challenge for a one-shot operation (e.g., burning admission for an L2 deposit) | `mode: 'pure-js'` in Node | ~7-60 min wall-clock at floor difficulty. ✅ Works; plan for the wait. |
| **Test fixture / CI** that needs a deterministic solve | `mode: 'pure-js'` | Used by our own `tests/integration/solve-redeem.test.ts`. Algorithm correctness is locked vs 5 byte-equal goldens from btxd. ✅ Reference implementation. |
| **Browser captcha** — you want a "click to admit" widget in front of users at `target_solve_time_s: 1-4s` | **❌ Don't use this SDK.** | Pure-JS browser solving is ~1000× over the 1-4s budget at production difficulty. WASM + SIMD + worker parallelism narrows the gap but doesn't close it. See [`BROWSER-PERF-FINDINGS-2026-05-23.md`](./BROWSER-PERF-FINDINGS-2026-05-23.md) for the measurement. Use hCaptcha, Cloudflare Turnstile, or Friendly Captcha until BTX ships a browser-friendly proof primitive. |
| **High-value, low-frequency one-shot admission in a browser** (e.g., account creation, KYC alternative, agent registration) — willing to accept 1-5 minutes of solve time | `mode: 'pure-js'` in a Web Worker | Tractable for high-friction flows where 1-5 min isn't deal-breaking. Not a UX-friendly captcha. ⚠️ Niche. |
| **Edge runtime** (Cloudflare Workers, Vercel Edge, Deno Deploy) | `mode: 'pure-js'` for verification only — **DO NOT solve on edge** | Most edge platforms have strict CPU-time caps (Cloudflare Free: 50 ms). Solving will timeout. Use these for `redeem` / `verify` only, with a non-edge backend for issue + solve. |

## Why browser pure-JS isn't a captcha

The BTX matmul proof-of-work was designed for **GPU-fast native mining**, not browser execution. Per our 2026-05-23 WASM spike (`~/code/btx-challenges-wasm/`):

- Pure-JS BigInt M31 multiplication: 14.7 Mops/s (Node 22, M-series Mac)
- WASM (Rust + i32 + manual Mersenne reduction): 879 Mops/s (24.5× faster)
- A single matmul attempt at `n=512` requires ~134M field operations
- At BTX's documented production target `target_solve_time_s: 1.0`, expected ~770,000 attempts per solve (linear scale from the integration test's "~770 at floor difficulty")

Even with the full WASM+SIMD+8-worker stack, browser solve at production difficulty projects to ~1 hour — **1000× over the 1-4s captcha UX budget**.

The 1-4s targets btx.dev recommends assume a **native solver** (btxd's NEON/CUDA path). Browser callers don't have access to that.

## What changes this picture

Only one of these would change the recommendation table:

1. **BTX ships a browser-friendly proof primitive** (Argon2-style memory-hard, smaller-n matmul variant, VDF, etc.) designed for sub-millisecond verification AND sub-second browser solving. This is an upstream protocol change; we're engaged with the BTX team on it.
2. **WebGPU compute shader implementation** with massive parallelism could narrow the gap further — but the matmul primitive at `n=512` with BigInt-class arithmetic isn't a natural fit for compute shaders. ~3-4 weeks effort with uncertain outcome.
3. **A trusted public solver service** (`solver.btx.dev`) that solves on behalf of slow devices. **Rejected as a primary path** because it breaks the defender→attacker asymmetry. Could work as a tier-2 fallback in a two-tier system.

Tracking: [`internal notes`](https://github.com/btx-tools/btx-challenges-sdk/tree/main).

## Summary

| Mode | Use case | Status |
|---|---|---|
| `mode: 'rpc'` server-side | Production admission gates | ✅ Recommended path |
| `mode: 'pure-js'` Node/CLI | One-shot scripts, CI fixtures | ✅ Works (~7-60 min/solve) |
| `mode: 'pure-js'` browser | Reference / wire-protocol demo | ⚠️ Not a captcha |
| `mode: 'pure-js'` Web Worker | High-value low-frequency admission | ⚠️ Niche, 1-5 min wall-clock |
| Browser captcha widget | Click-to-admit UX | ❌ Not viable with current protocol |
