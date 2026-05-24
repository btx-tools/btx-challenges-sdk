# Use cases — which mode for what?

> **TL;DR**: this SDK is for **server-side admission control** that gates HTTP routes behind chain-anchored proof-of-work. The optional [`@btx-tools/matmul-wasm`](https://www.npmjs.com/package/@btx-tools/matmul-wasm) kernel (`mode: 'wasm'`) makes no-node solving **~24× faster** — great for server/edge solving and high-friction one-shot gates — but it is **not** a casual click-to-admit captcha: at the live `n=512` a floor-difficulty browser solve is still ~16 s on an 8-worker pool. If you want a sub-second "click this captcha" widget, this SDK is not (yet) the right tool — see the table below.

## Decision tree

| Your situation | Recommended mode | Notes |
|---|---|---|
| **Server-side API gate** (AI inference platform, MCP gateway, B2B API admission, L2/sidechain admission) — your server runs alongside a btxd | **`mode: 'rpc'`** against a dedicated non-mining btxd | The documented btx.dev path. Sub-second solves. ✅ Use [`@btx-tools/middleware-express` / `-fastify` / `-hono`](packages/middleware-express). |
| **Server-side gate** but you can't run btxd nearby — you receive proofs from callers who already have one | **Just `client.redeem`** in your gate | The middleware adapters handle this automatically. No solving on your end. ✅ Production-ready. |
| **No-node solving, anywhere** — CLI, edge function, gateway-solves-for-caller, or any environment without a local btxd | **`mode: 'wasm'`** (install `@btx-tools/matmul-wasm`) | The fastest no-node path — **~24× pure-JS**, byte-identical proof. Published build targets browsers/bundlers (Vite, Next, Workers); in plain Node, build the package's `nodejs` target from source. ✅ Recommended when there's no nearby btxd. |
| **CLI / Node-script tool** that needs to solve a challenge for a one-shot operation (e.g., burning admission for an L2 deposit) | `mode: 'pure-js'` (or `'wasm'` for ~24×) | Pure-JS: ~7-60 min wall-clock at floor difficulty. ✅ Works; plan for the wait, or add the WASM kernel. |
| **Test fixture / CI** that needs a deterministic solve | `mode: 'pure-js'` | Used by our own `tests/integration/solve-redeem.test.ts`. Algorithm correctness is locked vs 5 byte-equal goldens from btxd (WASM is byte-identical). ✅ Reference implementation. |
| **Browser captcha** — you want a sub-second "click to admit" widget in front of users at `target_solve_time_s: 1-4s` | **❌ Not a casual captcha.** | Even with the WASM kernel, a floor-difficulty solve is ~16 s on an 8-worker browser pool at the live `n=512`; SIMD's 2–4× doesn't close the ~100× browser-vs-native gap. See [`BROWSER-PERF-FINDINGS-2026-05-23.md`](./BROWSER-PERF-FINDINGS-2026-05-23.md). Use hCaptcha, Cloudflare Turnstile, or Friendly Captcha until BTX ships a browser-friendly proof primitive. |
| **High-value, low-frequency one-shot admission in a browser** (e.g., account creation, KYC alternative, agent registration) — willing to accept a one-time wait | **`mode: 'wasm'` in a Web Worker** (or pool) | The WASM kernel makes this ~24× faster than pure-JS — ~16 s at floor on an 8-worker pool, deliberate friction by design. ⚠️ Niche but now practical. |
| **Edge runtime** (Cloudflare Workers, Vercel Edge, Deno Deploy) | `mode: 'wasm'` solves (the build targets edge/bundlers); or `'pure-js'` for verify only | Solving on edge is bounded by CPU-time caps (Cloudflare Free: 50 ms) — fine for `redeem`/`verify`, not for a synchronous full solve. For solving, prefer a non-edge backend or a high-friction async flow. |

## Why browser solving isn't a casual captcha (even with WASM)

The BTX matmul proof-of-work was designed for **GPU-fast native mining**, not browser execution. The WASM kernel ([`@btx-tools/matmul-wasm`](https://www.npmjs.com/package/@btx-tools/matmul-wasm)) is now shipped and is the fastest JS-environment solver, but it doesn't make the live proof a sub-second captcha. Measured at the live production params (`n=512, b=16, r=8`):

- Pure-JS BigInt: a single attempt is far too slow to pool usefully in a browser.
- WASM (Rust → byte-exact port): **~24× faster** than pure-JS — **128 ms/attempt** (V8/Node) / **165 ms/attempt** (Firefox), byte-identical proof.
- An 8-worker browser pool ≈ 48 attempts/s → a **floor-difficulty solve is ~16 s**; difficulty calibrates up from there.
- `n` is policy-fixed by the chain at 512 (the issue RPC controls only difficulty/time), so an issuer can't request a smaller, browser-friendly matrix.

SIMD's 2–4× doesn't bridge the ~100× browser-vs-native gap at `n=512`. The 1–4 s targets btx.dev recommends assume a **native solver** (btxd's NEON/CUDA path); browser callers don't have that. So WASM is excellent for **fast no-node solving** (server/edge/CLI) and **high-friction one-shot gates** (~16 s is acceptable for signup/KYC-alt), but not a casual per-request widget.

## What changes this picture

Only one of these would change the recommendation table:

1. **BTX ships a browser-friendly proof primitive** (Argon2-style memory-hard, smaller-n matmul variant, VDF, etc.) designed for sub-millisecond verification AND sub-second browser solving. This is an upstream protocol change; we're engaged with the BTX team on it.
2. **WebGPU compute shader implementation** with massive parallelism could narrow the gap further — but the matmul primitive at `n=512` with BigInt-class arithmetic isn't a natural fit for compute shaders. ~3-4 weeks effort with uncertain outcome.
3. **A trusted public solver service** (`solver.btx.dev`) that solves on behalf of slow devices. **Rejected as a primary path** because it breaks the defender→attacker asymmetry. Could work as a tier-2 fallback in a two-tier system.

Tracking: [`internal notes`](https://github.com/btx-tools/btx-challenges-sdk/tree/main).

## Summary

| Mode | Use case | Status |
|---|---|---|
| `mode: 'rpc'` server-side | Production admission gates | ✅ Recommended path (~1–4 s on a native non-mining node) |
| `mode: 'wasm'` (server/edge/CLI) | Fast no-node solving | ✅ ~24× pure-JS, byte-identical proof |
| `mode: 'wasm'` Web Worker (pool) | High-value low-frequency browser admission | ⚠️ Niche but practical (~16 s at floor, 8-worker pool) |
| `mode: 'pure-js'` Node/CLI | One-shot scripts, CI fixtures | ✅ Works (~7-60 min/solve; add the WASM kernel for ~24×) |
| `mode: 'pure-js'` browser | Reference / wire-protocol demo | ⚠️ Not a captcha |
| Casual click-to-admit captcha (1–4 s) | Sub-second widget UX | ❌ Not viable with current protocol (needs an upstream browser-friendly primitive) |
