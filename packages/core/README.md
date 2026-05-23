# @btx-tools/challenges-sdk

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@btx-tools/challenges-sdk)](https://www.npmjs.com/package/@btx-tools/challenges-sdk)

TypeScript SDK for **BTX service challenges** — chain-anchored proof-of-work admission control for APIs, agent gateways, and form submissions.

📖 **[API Reference](https://btx-tools.github.io/btx-challenges-sdk/)** — full TypeDoc for this package and the middleware adapters.

> **Status**: 🟢 **`1.0.0` — stable** (API frozen under SemVer). RPC + pure-JS solver cross-validated byte-equal against btxd's own pinned test vectors; opt-in retry/backoff (`onRetry` hook) + per-method timeouts (raw or semantic keys) + `AbortSignal` plumbing. All audit findings closed. See [CHANGELOG](https://github.com/btx-tools/btx-challenges-sdk/blob/main/CHANGELOG.md).

## What is this?

[BTX](https://btx.dev) is a post-quantum settlement chain that exposes a unique admission-control primitive: domain-bound MatMul work proofs that you can use to gate any HTTP endpoint, MCP tool call, or anonymous form submission.

Issue a challenge → client solves a ~1–4 second matrix-multiplication puzzle → server redeems the proof atomically (no replays). The work is anchored to the BTX chain — tamper-proof, no centralized issuer needed.

**Use cases**:

- 🤖 Gate AI inference APIs without a CAPTCHA
- 🛡️ Per-tool-call proof-of-work for MCP / agent gateways
- 📝 Anonymous form submission rate-limiting
- 🚦 Replace hCaptcha / reCAPTCHA with chain-anchored proof

## Install

```bash
npm install @btx-tools/challenges-sdk
# or
pnpm add @btx-tools/challenges-sdk
```

## Quickstart

```typescript
import { BtxChallengeClient } from '@btx-tools/challenges-sdk';

const client = new BtxChallengeClient({
  rpcUrl: 'http://127.0.0.1:19332',
  rpcAuth: { user: 'rpcuser', pass: 'rpcpass' },
});

// Server: issue a challenge bound to the requested resource
const challenge = await client.issue({
  purpose: 'ai_inference_gate',
  resource: 'model:gpt-x|route:/v1/generate',
  subject: 'tenant:abc123',
  target_solve_time_s: 2,
  expires_in_s: 60,
});

// ... ship challenge to client; client solves locally and returns (nonce, digest) ...

// Server: verify-and-consume atomically (anti-replay admission)
const result = await client.redeem(challenge, nonce64_hex, digest_hex);

if (result.valid && result.reason === 'ok') {
  // Run the expensive action
}
```

## Security

### HTTPS / TLS

Basic-auth credentials are sent on every RPC call. **Use HTTPS** (or a localhost-only deployment) when btxd's RPC port is exposed beyond `127.0.0.1`.

Recommended terminations:

- **stunnel**, **nginx**, or **Caddy** in front of btxd
- **Cloudflare Tunnel** for remote operator access
- Never expose btxd's RPC port (default `19332`) directly to the public internet

The SDK does NOT enforce HTTPS — that's a deployment concern. If you set `rpcUrl: 'http://example.com:19332'` from a production service, the SDK will happily transmit your credentials in plaintext.

### Error handling

```typescript
import {
  BtxError, // base class — all SDK errors extend this
  BtxRpcError, // btxd returned a JSON-RPC error envelope
  BtxHttpError, // non-2xx HTTP status
  BtxParseError, // 2xx but body wasn't valid JSON
  BtxTimeoutError, // request exceeded timeoutMs
  BtxNetworkError, // DNS/TCP/TLS-level failure
} from '@btx-tools/challenges-sdk';

try {
  await client.redeem(challenge, nonce, digest);
} catch (err) {
  if (err instanceof BtxRpcError && err.code === -8) {
    // btxd rejected the request shape
  } else if (err instanceof BtxTimeoutError) {
    // user took too long to solve
  } else if (err instanceof BtxError) {
    // any other SDK-originated error
  }
}
```

Error response bodies are scanned and `Authorization: Basic <token>` patterns are redacted before storage — safe to log.

## API

### `BtxChallengeClient`

| Method                 | RPC                           | Description                                                    |
| ---------------------- | ----------------------------- | -------------------------------------------------------------- |
| `issue(params)`        | `getmatmulservicechallenge`   | Issue a fresh challenge bound to (purpose, resource, subject). |
| `verify(...)`          | `verifymatmulserviceproof`    | Stateless verify. Does NOT consume the challenge.              |
| `redeem(...)`          | `redeemmatmulserviceproof`    | **Atomic verify + consume**. Use for admission control.        |
| `verifyBatch(entries)` | `verifymatmulserviceproofs`   | Batch (1–256) verify. No consumption.                          |
| `redeemBatch(entries)` | `redeemmatmulserviceproofs`   | Batch verify + consume, sequential.                            |
| `solve(challenge)`     | `solvematmulservicechallenge` | Server-side solver (fixtures + tests).                         |
| `call(method, params)` | (any)                         | Low-level escape hatch.                                        |

### `Solver`

Three modes:

- **`'rpc'`** — delegates to btxd's `solvematmulservicechallenge` RPC. Server-side / Node only. Fast (sub-second to a few seconds) on a dedicated non-mining node — see the deployment note below.
- **`'pure-js'`** — solves locally in pure TypeScript with `@noble/hashes` SHA-256. Browser-compatible. Slow at production difficulty (see the performance section); calibrate via `target_solve_time_s` for browser use.
- **`'auto'`** (default) — picks `'rpc'` if `opts.rpcClient` is provided, else `'pure-js'`.

```typescript
import { BtxChallengeClient, Solver } from '@btx-tools/challenges-sdk';

// Server-side (RPC mode): delegates the solve to btxd
const client = new BtxChallengeClient({ rpcUrl: '...', rpcAuth: { ... } });
const proof = await Solver.solve(challenge, { mode: 'rpc', rpcClient: client });

// Browser / no-RPC (pure-JS mode): solves locally, no node required
const proof = await Solver.solve(challenge, {
  mode: 'pure-js',
  pureJs: { maxTries: 5_000 },   // cap on attempts before giving up
});

// 'auto' (default) — picks rpc if a client is passed, else pure-js
const proof = await Solver.solve(challenge, { rpcClient: client });
```

#### Algorithm correctness

The pure-JS solver is a direct port of the canonical CPU path from `btxd v0.29.7 src/matmul/`. We cross-validate against 5 pinned golden vectors lifted from btxd's own test suite — see `tests/unit/matmul/btxd-vectors.test.ts`. Match is byte-equal for:

- `fromSeedRect(zero, 8)` — `matrix_from_seed_deterministic`
- `deriveNoiseSeed(TAG_EL, zero_sigma)` — `noise_derived_seed_pinned_EL`
- `noise.generate(zero_sigma, 4, 2)` E_L + E_R — `noise_EL_pinned_elements` / `noise_ER_pinned_elements`
- `canonicalMatMul(n=8, b=4)` transcript_hash — `canonical_matmul_n8_b4_pinned_transcript`
- Live `deriveSigma` (2 nonces) — `verifymatmulserviceproof.proof.sigma` from a real btxd

Plus 125 internal unit tests covering field arithmetic, matrix ops, header serialization, and solver dispatch.

#### ⚠️ Deployment note — RPC mode against a mining btxd

btxd's service-challenge solver shares the matmul backend with block-template mining. On a node that's actively mining, `solvematmulservicechallenge` queues behind block work and can take **15+ minutes** per call — measured 2026-05-20 on a production mining rental, where the solve RPC didn't return even after `btx-cli`'s own 15-minute transient-error timeout fired.

For RPC mode at advertised latency (~1–4 seconds), point it at a **dedicated btxd** that is NOT mining (e.g., a $5/mo DO droplet with `gen=0` in `btx.conf`). The SDK itself works fine — the bottleneck is the upstream solver service-sharing.

## Performance

Pure-JS solver bench at production matmul shape (n=512, b=16, r=8) on M-series Mac arm64 (2026-05-22, 5-sample mean):

| Engine                   | Mean / attempt | vs Node 22                            |
| ------------------------ | -------------- | ------------------------------------- |
| **Node 22.20 / V8**      | **4.6 s**      | 1.0× (baseline)                       |
| Deno 2.7 / V8            | 4.2 s          | 0.92× (slightly faster, within noise) |
| Bun 1.3 / JavaScriptCore | 9.8 s          | **2.1× slower**                       |
| Firefox SpiderMonkey     | untested       | —                                     |
| Safari JavaScriptCore    | untested       | —                                     |

`mul` and the `dot` accumulator use `bigint` because the worst-case M31 product (`(2^31-1)^2 ≈ 2^62`) exceeds `Number`'s 2^53 precision. The `bigint`-bounded inner loop is the dominant cost. **Bun's JavaScriptCore engine is ~2× slower than V8 for `bigint`-heavy workloads** — if Bun is your runtime, factor that into your `target_solve_time_s` calibration.

Expected end-to-end solve time depends on challenge difficulty. At btxd's lowest service-challenge difficulty (`target_solve_time_s = min_solve_time_s = 0.001`), per-attempt success ≈ 1.3·10⁻³, so expected ≈ 770 attempts:

| Engine        | Expected solve at floor difficulty |
| ------------- | ---------------------------------- |
| Node 22 / V8  | ~59 min                            |
| Deno 2.7 / V8 | ~54 min                            |
| Bun 1.3 / JSC | ~2.1 hr                            |

**Default difficulty is too slow for online browser use.** Workable today for:

- Server-side gating where you control difficulty (calibrate via `target_solve_time_s` for your target user wait)
- Backend cron / batch jobs
- Examples + demos with manually-issued low-difficulty challenges

Day 2.6 will add a WASM port of the matmul kernel + the `field.mul`/`field.dot` hot loops, targeting a 10× speed-up.

Reproduce the bench:

```bash
npx tsx packages/core/tests/perf/solver-bench.ts 10                              # Node
deno run --allow-all --unstable-sloppy-imports tests/perf/solver-bench.ts 10     # Deno
bun tests/perf/solver-bench.ts 10                                                # Bun
```

## Drop-in middleware

For Express apps, install the companion package:

```bash
npm install @btx-tools/middleware-express
```

```typescript
import express from 'express';
import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
import { btxAdmission } from '@btx-tools/middleware-express';

const client = new BtxChallengeClient({ rpcUrl: '...', rpcAuth: { ... } });
const app = express();

app.post(
  '/v1/generate',
  btxAdmission({
    client,
    purpose: 'ai_inference_gate',
    resource: (req) => `model:${req.body.model}|route:${req.path}`,
    subject: (req) => `tenant:${req.body.tenant_id}`,
  }),
  (req, res) => res.json({ ok: true, generated: '...' }),
);
```

That's it — one line, your route is gated by a BTX service challenge. Full docs at [`@btx-tools/middleware-express`](https://www.npmjs.com/package/@btx-tools/middleware-express) or in the [package README](https://github.com/btx-tools/btx-challenges-sdk/tree/main/packages/middleware-express#readme).

Fastify + Hono adapters queued as `@btx-tools/middleware-fastify` + `@btx-tools/middleware-hono`.

## Roadmap

| Status | Item                                                                        |
| ------ | --------------------------------------------------------------------------- |
| ✅     | Day 1: RPC client + types + audit Wave A/B/C fixes                          |
| ✅     | Day 2: Solver class with mode dispatch (RPC mode ships)                     |
| ✅     | Day 2.5: Pure-JS MatMul solver port, cross-validated against btxd goldens   |
| ✅     | Day 3 (partial): Express middleware → `@btx-tools/middleware-express@0.1.0` |
| ⏳     | Day 2.6: WASM port of matmul kernel (perf)                                  |
| ⏳     | Day 3 (rest): Fastify + Hono adapters (separate sub-packages)               |
| ⏳     | Day 4: Browser demo + Node examples                                         |
| ⏳     | Day 5-6: `@btx-tools/mcp-gateway` companion package                         |
| ⏳     | Day 7-8: Docs + announce                                                    |
| ⏳     | Day 9: Findings + handoff                                                   |

## Testing

```bash
pnpm test                # all tests
pnpm test:unit           # msw-mocked HTTP only (fast)
pnpm test:integration    # live btxd via SSH (requires fleet access)
```

The integration test target is `btx-node` by default — change `SSH_TARGET` in `tests/integration/smoke.test.ts` to retarget any healthy at-tip BTX node.

## Links

- [BTX dev portal](https://btx.dev/develop/)
- [Service-challenges RPC reference](https://btx.dev/docs/rpc/service-challenges)
- [Service-challenges integration guide](https://btx.dev/docs/guides/service-challenges)
- [BTX node source](https://github.com/btxchain/btx)

## License

MIT
