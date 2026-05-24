# Browser solver performance

> How fast a BTX service-challenge can be solved in a browser, and what that means for where this
> SDK fits. **Short version:** with the CPU/WASM solver, an in-browser solve at the live `n=512`
> difficulty is seconds-to-minutes (difficulty-dependent) — great for server-side gating and
> high-friction one-shot flows, not for a sub-second per-request captcha widget. The new WebGPU
> kernel helps only at small `n` — at the live `n=512` it's actually *slower* than WASM end-to-end (below).

## CPU / WASM

The matmul proof is dominated by M31 field multiplication. Measured speedups, pure-JS (BigInt) →
WASM (Rust + i32), cross-validated byte-equal on 20 random mul pairs + 5 length-512 dot arrays:

| Bench | Pure-JS BigInt | WASM (Rust + i32) | Speedup |
|---|---|---|---|
| `M31::mul` (isolated) | 14.7 Mops/s | 417 Mops/s | **28.4×** |
| `M31::dot(len=512)` (the hot loop) | 35.8 Mops/s | 879 Mops/s | **24.5×** |

**Per-attempt wall-clock at the live `n=512`:** ~128 ms (V8) / ~165 ms (Firefox) with the WASM
kernel; ~5 s with pure-JS. A full solve searches many nonces (geometric distribution): at BTX
**floor difficulty** a WASM 8-worker browser pool lands ~16 s; at **production difficulty**
(`target_solve_time_s = 1.0`) it is hours-class — far beyond a 1–4 s widget budget. Pure-JS at floor
is ~7 min–2 hr.

**Verdict (CPU/WASM):** excellent for **no-node solving** (server / edge / CLI) and **high-friction
one-shot gates** (signup, KYC-alternative, agent registration); **not** a casual per-request browser
captcha at production difficulty. For production gating, solve server-side via `mode: 'rpc'` against a
dedicated non-mining btxd (sub-second).

## WebGPU (new)

`@btx-tools/matmul-webgpu@0.1.0` (`Solver` `mode: 'webgpu'`) runs the matmul on the GPU and is byte-exact.
A *single* matmul is ~50× the WASM matmul (~2.6 ms at `n=512` on a Metal GPU). **But a full proof
attempt at `n=512` is hundreds of matmuls** (`b=16, r=8`), and `n=512` buffers (`n²·4` = 1 MiB/nonce)
cap GPU batching — so the end-to-end solve does **not** inherit the microbenchmark speedup. Measured
(Deno/Metal): **~860 ms/attempt at `n=512` — ~6–7× slower than WASM's ~128 ms** (≈ 11 min floor solve
vs WASM's ~16 s on an 8-worker pool). WebGPU's advantage is real only at small/devnet `n` (sub-ms at
`n=64`). **At the live params, WASM remains the fastest in-browser solver.** A fused/batched WebGPU
kernel, or a smaller-`n` protocol primitive, would be needed to change this — see [`USE-CASES.md`](./USE-CASES.md).

## Where the SDK fits today

| Use case | Recommended approach |
|---|---|
| Server-side admission gate | `mode: 'rpc'` against a dedicated non-mining btxd. Sub-second. |
| No-node solving (server / edge / CLI) | `mode: 'wasm'` (~24× pure-JS), byte-identical proof. |
| Browser one-shot / high-friction gate | `mode: 'wasm'` (or `'webgpu'`) in a Web Worker. Seconds — deliberate friction. |
| Browser per-request widget, production difficulty | Not viable — WASM ~128 ms/attempt, WebGPU ~860 ms/attempt at `n=512`. Solve server-side or hold a per-session challenge behind a proxy. |
| Test fixture / CI | `mode: 'pure-js'` — reference path, byte-equal to btxd's golden vectors. |

> **Why the proof is heavy in a browser:** the matmul primitive at `n=512` is BigInt-class arithmetic
> tuned for native (NEON/CUDA) mining throughput. WASM closes a chunk of the native gap (~24×) and
> WebGPU is ~50× faster on a *single* matmul (but slower per full proof at `n=512`); the design target is verifiable *work*, so a browser
> solve is intentionally non-trivial. A casual sub-second widget at production difficulty would need a
> browser-friendly proof primitive at the protocol level (e.g. memory-hard or a smaller-`n` variant) —
> tracked upstream, independent of this SDK.
