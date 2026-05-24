# @btx-tools/browser-miner

A **pool-agnostic browser mining client** for BTX matmul service-challenge shares.
It drives the SDK's solver cascade (**WebGPU → WASM → pure-JS**) over a small
adapter interface, with vardiff, GPU duty-cycle throttling, and new-job preemption.

> ## ⚠️ This is not a money-maker
> A browser solves **far slower** than native hardware, and BTX's network hashrate
> is large — so a browser miner earns **≈ $0** (`stats.estimatedEarnings` is always
> 0). The value is **zero-install access, engagement, and decentralization** —
> "donate spare cycles," gamified access — **never** "earn money in your browser."
> Mining must be **consent-based**: opt-in, visible, pausable, throttled. Silent
> background mining is malware (cryptojacking) — don't ship it.

## Install

```sh
npm i @btx-tools/browser-miner @btx-tools/challenges-sdk
# optional, for the fast paths:
npm i @btx-tools/matmul-webgpu @btx-tools/matmul-wasm
```

## Usage

```ts
import { BrowserMiner } from '@btx-tools/browser-miner';

const miner = new BrowserMiner({
  adapter: myPool,            // your MiningPoolAdapter (see below)
  workerId: 'browser-1',
  dutyCycle: 0.5,             // use ~50% of the GPU; rest yielded to the page
  onStats: (s) => render(s), // { backend, hashrate, sharesAccepted, ... estimatedEarnings: 0 }
  onShare: (share, result) => log(share, result),
});

startButton.onclick = () => miner.start(); // explicit consent
stopButton.onclick = () => miner.stop();    // graceful; releases the GPU
```

The miner auto-selects the best backend (`webgpu → wasm → pure-js`), builds **one
solver per job**, searches it in small chunks (the preemption + throttle point),
submits hits, and preempts on a new `jobId`/`cleanJobs`.

## The adapter (the only thing a pool implements)

A "job" is a service-challenge envelope whose `target` is the **share-target**; a
"share" is a nonce whose matmul digest ≤ that target — the exact shape the SDK
`Solver` / `@btx-tools/matmul-webgpu` already consume.

```ts
interface MiningPoolAdapter {
  getJob(): Promise<MiningJob>;                          // { jobId, challenge, cleanJobs?, expiresAt? }
  submitShare(s: ShareSubmission): Promise<ShareResult>; // { accepted, reason? }
}
```

Drop in any transport: HTTP (`fetch` getJob/submitShare), WebSocket (stratum-lite),
or a btxd `issue`/`redeem` adapter. A production pool should **rate-limit + verify
shares cheaply (Freivalds, O(n²))** server-side and run vardiff — browsers are
untrusted. `examples/04-browser-miner` ships a self-contained in-page reference
work source (synth jobs + local verify, no btxd) so the client is demoable standalone.

## Backends

| Backend | When | Source |
|---|---|---|
| `webgpu` | `navigator.gpu` + `@btx-tools/matmul-webgpu` installed | reused solver per job; one device |
| `wasm` | `@btx-tools/matmul-wasm` installed + initializes here | per-job `WasmSolver` |
| `pure-js` | always (fallback) | SDK `Solver` `mode:'pure-js'` |

Selection happens **once** at startup (`selectBackend`); inject your own via
`new BrowserMiner({ backend })` for tests or an explicit choice.

`targetForExpectedAttempts(n)` helps a work source pick an easy share-target
(`target = 2²⁵⁶ / n`).

## Testing

```sh
pnpm test   # headless unit tests (mock adapter + pure-js) — loop, preemption,
            # pause/resume, duty-cycle, stop cleanup, vardiff — run in CI

pnpm build  # then the real-GPU end-to-end gate under Deno:
deno run --unstable-webgpu --allow-read --config tests/gpu/deno.json tests/gpu/miner.deno.ts
```

The GPU gate runs the full loop over the real WebGPU backend against a synth work
source and asserts shares are found, **byte-exact-verified (Solver 1-nonce)**,
accepted, and counted, with duty-cycle throttling on.

## License

MIT.
