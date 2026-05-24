# Browser solver performance

> How fast a BTX service-challenge can be solved in a browser, and what that means for where this
> SDK fits. **Short version:** with the CPU/WASM solver, an in-browser solve at the live `n=512`
> difficulty is seconds-to-minutes (difficulty-dependent) — great for server-side gating and
> high-friction one-shot flows, not for a sub-second per-request captcha widget. The new WebGPU
> kernel changes this materially (below).

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

`@btx-tools/matmul-webgpu@0.1.0` (`Solver` `mode: 'webgpu'`) runs the matmul on the GPU and is
**~50× the WASM matmul per attempt** (~2.6 ms at `n=512` on a discrete/Metal GPU vs ~128 ms WASM); at
devnet `n=64` an attempt is sub-millisecond-class. A full in-browser solve is correspondingly faster
than the WASM numbers above. An end-to-end browser wall-clock at the live `n=512` is being
benchmarked — until that lands we don't claim a specific casual-captcha-grade number. This is the path
toward a viable browser-side gate; see [`USE-CASES.md`](./USE-CASES.md) for the current recommendation.

## Where the SDK fits today

| Use case | Recommended approach |
|---|---|
| Server-side admission gate | `mode: 'rpc'` against a dedicated non-mining btxd. Sub-second. |
| No-node solving (server / edge / CLI) | `mode: 'wasm'` (~24× pure-JS), byte-identical proof. |
| Browser one-shot / high-friction gate | `mode: 'wasm'` (or `'webgpu'`) in a Web Worker. Seconds — deliberate friction. |
| Browser per-request widget, production difficulty | Not with WASM. WebGPU under evaluation. Until then, solve server-side or hold a per-session challenge behind a proxy. |
| Test fixture / CI | `mode: 'pure-js'` — reference path, byte-equal to btxd's golden vectors. |

> **Why the proof is heavy in a browser:** the matmul primitive at `n=512` is BigInt-class arithmetic
> tuned for native (NEON/CUDA) mining throughput. WASM closes a chunk of the native gap (~24×) and
> WebGPU much more (~50× on the matmul), but the design target is verifiable *work*, so a browser
> solve is intentionally non-trivial. A casual sub-second widget at production difficulty would need a
> browser-friendly proof primitive at the protocol level (e.g. memory-hard or a smaller-`n` variant) —
> tracked upstream, independent of this SDK.
