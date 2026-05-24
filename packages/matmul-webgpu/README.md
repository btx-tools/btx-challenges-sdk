# @btx-tools/matmul-webgpu

WebGPU/WGSL solver kernel for **BTX matmul service challenges** — a byte-exact,
clean-room port of [`@btx-tools/challenges-sdk`](https://www.npmjs.com/package/@btx-tools/challenges-sdk)'s
`core/src/matmul/*.ts` reference. Runs the M31 matmul proof-of-work entirely on
the GPU, in the browser, with **no node and no install**.

Two consumers share this one kernel:
- **admission / captcha** — the SDK's `Solver` `mode:'webgpu'` (solve a challenge client-side), and
- **browser mining** — a pool client that solves low-difficulty service-challenge "shares".

> **Honest framing.** Per-device browser hashrate is **far below native** (WGSL
> emulates 64-bit math, plus tab/throttle overhead) and BTX network hashrate is
> rising fast — so a browser solver earns **≈ nothing**. The value is
> **zero-install access, engagement, and decentralization**, never "earn money in
> your browser." Verification is also not free: pools must validate shares
> (Freivalds, O(n²)), not re-run the matmul.

## Status

`0.1.0` — **correct-at-scale**. Byte-exact vs the reference at **n=8** (single-block
transcript) and **n=64** (multi-block transcript, 32 SHA blocks); larger `n` runs the
same parameterized code path (an n=512 golden is a planned fast-follow). The
per-attempt kernel is unoptimized (one workgroup per nonce, lane-0 serial transcript)
— intra-nonce tiling and multi-shard striding are a documented perf follow-up.

**Release limits (fail-closed):** `stride` must be `1`; the searched nonce range must
lie within `[0, 2³²)` (the kernel patches only the low 32 nonce bits); and `n/b` must
be ≤ 1023 (the transcript byte counter is u32 — covers all `n ≤ 512` at any `b`). Each
throws clearly so a caller can fall back to `wasm`/`pure-js`/`rpc`.

## Install

```sh
npm i @btx-tools/matmul-webgpu
```

Requires a WebGPU runtime (`navigator.gpu`): modern Chrome/Edge/Safari, Deno
(`--unstable-webgpu`), or any environment where you pass your own `GPUDevice`.

## Usage

The constructor takes the **same positional arguments as `@btx-tools/matmul-wasm`'s
`WasmSolver`**, so it drops into the SDK's solver cascade unchanged:

```ts
import { createWebGpuSolver } from '@btx-tools/matmul-webgpu';

const solver = await createWebGpuSolver(
  version, prevhash, merkleroot, time, bits, // header fields
  n, b, r, seedA, seedB,                      // matmul params + seeds
  target,                                     // 64-hex BE
  // optional: { device, batchSize }
);

const hit = await solver.solveChunk(0n /* nonceStart */, 1n /* stride */, 100_000n /* maxTries */);
// hit: { nonce_hex, digest_hex } | undefined
solver.destroy();
```

`digest_hex` is the canonical display digest (`reverse(rawSHA256d)`), and a found
proof is accepted by btxd's `redeemmatmulservicechallenge` exactly like a
`pure-js`/`wasm`/`rpc` proof.

## How it works (byte-order map)

No native u64 in WGSL → 32×32 multiply via a 16-bit split + double-Mersenne fold.
The load-bearing byte-order, validated end-to-end against the reference:

- `sigma` = `reverse(SHA256d(header))`
- noise / compress seeds = `SHA256(tag18 ‖ sigmaBE)` **raw** (no reverse)
- `fromOracle` candidate = `byteswap(word0) & M31`
- transcript = `byteswap(LE32(compressBlock))` streamed → `SHA256d`
- accept = `uintLE(digest) ≤ uintBE(target)`

The kernel packs all small read-only inputs into one `params` buffer so it uses
only 5 storage buffers (≤ the spec-default limit of 8 — no `requiredLimits`).
Per-nonce `A'`/`B'` live in storage slabs; batch size auto-clamps from
`device.limits.maxStorageBufferBindingSize`.

## Testing

Two layers, because Node/vitest has no WebGPU:

```sh
pnpm test          # pure orchestration tests (param validation, params layout,
                   # batch clamp, shader codegen) — run in CI

pnpm build         # then the GPU byte-exact battery under Deno:
deno run --unstable-webgpu tests/gpu/solve.test.ts
```

The GPU battery asserts the n=8 and n=64 goldens (frozen KAT vectors generated
from `challenges-sdk`'s `Solver.solve({mode:'pure-js'})`, itself byte-validated
against btxd). GPU-in-CI (headless Chrome / Deno) is a planned follow-up.

## License

MIT OR Apache-2.0.
