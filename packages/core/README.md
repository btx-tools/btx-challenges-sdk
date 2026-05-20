# @btx/challenges-sdk

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

TypeScript SDK for **BTX service challenges** — chain-anchored proof-of-work admission control for APIs, agent gateways, and form submissions.

> ⚠️ **Status**: 0.0.1 pre-release. Day 1 of a 9-day ship plan. See [CHANGELOG](../../CHANGELOG.md).

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

```typescript
import { Solver } from '@btx/challenges-sdk';

// DAY 1 STUB — throws not_implemented. Real impl ships Day 2.
const proof = await Solver.solve(challenge);
```

Browser-side / client-side MatMul solver. Day 1 ships the type signature; Day 2 ports the actual solver from btxd source.

## Roadmap

| Status | Item |
|---|---|
| ✅ | Day 1: RPC client + types + audit Wave A/B/C fixes |
| ⏳ | Day 2: MatMul solver port to TypeScript (browser-safe) |
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
