# @btx/challenges-sdk

[![npm version](https://img.shields.io/npm/v/@btx/challenges-sdk.svg)](https://www.npmjs.com/package/@btx/challenges-sdk)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

TypeScript SDK for **BTX service challenges** — chain-anchored proof-of-work admission control for APIs, agent gateways, and form submissions.

> ⚠️ **Status**: 0.0.1 — pre-release scaffold. Day-1 of a 2-week ship plan.

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

## API

### `BtxChallengeClient`

| Method | RPC | Description |
|---|---|---|
| `issue(params)` | `getmatmulservicechallenge` | Issue a fresh challenge bound to (purpose, resource, subject). |
| `verify(...)` | `verifymatmulserviceproof` | Stateless verify. Does NOT consume the challenge. |
| `redeem(...)` | `redeemmatmulserviceproof` | **Atomic verify + consume**. Use for admission control. |
| `verifyBatch(entries)` | `verifymatmulserviceproofs` | Batch (up to 256) verify. No consumption. |
| `redeemBatch(entries)` | `redeemmatmulserviceproofs` | Batch verify + consume, sequential. |
| `solve(challenge)` | `solvematmulservicechallenge` | Server-side solver (use for fixtures; ship WASM solver to browsers). |
| `call(method, params)` | (any) | Low-level escape hatch. |

## Roadmap

| Status | Item |
|---|---|
| ✅ | Day 1: RPC client + types + smoke test |
| ⏳ | Day 2: Browser-side MatMul solver (WASM or pure JS) |
| ⏳ | Day 3: Express / Fastify / Hono middleware |
| ⏳ | Day 4: Browser demo + Node examples |
| ⏳ | Day 5-6: `@btx/mcp-gateway` companion package |
| ⏳ | Day 7-8: Docs + npm publish |

## Links

- [BTX dev portal](https://btx.dev/develop/)
- [Service-challenges RPC reference](https://btx.dev/docs/rpc/service-challenges)
- [Service-challenges integration guide](https://btx.dev/docs/guides/service-challenges)
- [BTX node source](https://github.com/btxchain/btx)

## License

MIT
