# @btx/challenges-sdk

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

TypeScript SDK for **BTX service challenges** — chain-anchored proof-of-work admission control for APIs, agent gateways, and form submissions.

> ⚠️ **Status**: 0.0.1 pre-release. Day 2.5 shipped: RPC + pure-JS solver, cross-validated byte-equal against btxd's own pinned test vectors. See [CHANGELOG](../../CHANGELOG.md).

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
npm install @btx/challenges-sdk
# or
pnpm add @btx/challenges-sdk
```

## Quickstart

```typescript
import { BtxChallengeClient } from '@btx/challenges-sdk';

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
  BtxError,        // base class — all SDK errors extend this
  BtxRpcError,     // btxd returned a JSON-RPC error envelope
  BtxHttpError,    // non-2xx HTTP status
  BtxParseError,   // 2xx but body wasn't valid JSON
  BtxTimeoutError, // request exceeded timeoutMs
  BtxNetworkError, // DNS/TCP/TLS-level failure
} from '@btx/challenges-sdk';

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

| Method | RPC | Description |
|---|---|---|
| `issue(params)` | `getmatmulservicechallenge` | Issue a fresh challenge bound to (purpose, resource, subject). |
| `verify(...)` | `verifymatmulserviceproof` | Stateless verify. Does NOT consume the challenge. |
| `redeem(...)` | `redeemmatmulserviceproof` | **Atomic verify + consume**. Use for admission control. |
| `verifyBatch(entries)` | `verifymatmulserviceproofs` | Batch (1–256) verify. No consumption. |
| `redeemBatch(entries)` | `redeemmatmulserviceproofs` | Batch verify + consume, sequential. |
| `solve(challenge)` | `solvematmulservicechallenge` | Server-side solver (fixtures + tests). |
| `call(method, params)` | (any) | Low-level escape hatch. |

### `Solver`

Three modes:

- **`'rpc'`** — delegates to btxd's `solvematmulservicechallenge` RPC. Server-side / Node only. Fast (sub-second to a few seconds) on a dedicated non-mining node — see the deployment note below.
- **`'pure-js'`** — solves locally in pure TypeScript with `@noble/hashes` SHA-256. Browser-compatible. Slow at production difficulty (see the performance section); calibrate via `target_solve_time_s` for browser use.
- **`'auto'`** (default) — picks `'rpc'` if `opts.rpcClient` is provided, else `'pure-js'`.

```typescript
import { BtxChallengeClient, Solver } from '@btx/challenges-sdk';

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

Pure-JS solver bench at production matmul shape (n=512, b=16, r=8) on M-series Mac / Node 22 (2026-05-21):

| Statistic | Wall-clock per attempt |
|---|---|
| mean | **4.6 s** |
| median | 4.6 s |
| min / max | 4.6 / 4.7 s |

`mul` and the `dot` accumulator use `bigint` because the worst-case M31 product (`(2^31-1)^2 ≈ 2^62`) exceeds `Number`'s 2^53 precision. The `bigint`-bounded inner loop is the dominant cost.

Expected end-to-end solve time depends on challenge difficulty. At btxd's lowest service-challenge difficulty (`target_solve_time_s = min_solve_time_s = 0.001`), per-attempt success ≈ 1.3·10⁻³, so expected ≈ 770 attempts ≈ **1 hour** wall-clock. **Default difficulty is too slow for online browser use.** Workable today for:

- Server-side gating where you control difficulty (calibrate via `target_solve_time_s` for your target user wait)
- Backend cron / batch jobs
- Examples + demos with manually-issued low-difficulty challenges

Day 2.6 will add a WASM port of the matmul kernel + the `field.mul`/`field.dot` hot loops, targeting a 10× speed-up.

Reproduce the bench:

```bash
npx tsx packages/core/tests/perf/solver-bench.ts 10   # 10 attempts
```

## Roadmap

| Status | Item |
|---|---|
| ✅ | Day 1: RPC client + types + audit Wave A/B/C fixes |
| ✅ | Day 2: Solver class with mode dispatch (RPC mode ships) |
| ✅ | Day 2.5: Pure-JS MatMul solver port, cross-validated against btxd goldens |
| ⏳ | Day 2.6: WASM port of matmul kernel (perf) |
| ⏳ | Day 3: Express / Fastify / Hono middleware (separate sub-packages) |
| ⏳ | Day 4: Browser demo + Node examples |
| ⏳ | Day 5-6: `@btx/mcp-gateway` companion package |
| ⏳ | Day 7-8: Docs + npm publish |
| ⏳ | Day 9: Findings + handoff |

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
