# @btx-tools/middleware-fastify

Drop-in **Fastify** admission gate backed by BTX service challenges. Same flow + ergonomics as [`@btx-tools/middleware-express`](https://www.npmjs.com/package/@btx-tools/middleware-express), tailored to Fastify's preHandler hook + reply API.

> **End-to-end example**: a runnable adopter example is in [`examples/02-express-gate`](../../examples/02-express-gate) (Express-based; the wiring shape is identical for Fastify — swap `app.post(path, btxAdmission(...))` for `fastify.post(path, { preHandler: btxAdmission(...) })`). A Fastify-native parity example is queued for the SDK Phase 3.5 roadmap.

```bash
pnpm add @btx-tools/middleware-fastify @btx-tools/challenges-sdk fastify
```

## Quickstart

```ts
import Fastify from 'fastify';
import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
import { btxAdmission } from '@btx-tools/middleware-fastify';

const client = new BtxChallengeClient({
  rpcUrl: 'http://127.0.0.1:19334',
  rpcAuth: { user: 'rpcuser', pass: 'rpcpass' },
});

const fastify = Fastify();

fastify.post('/v1/generate', {
  preHandler: btxAdmission({
    client,
    purpose: 'ai_inference_gate',
    resource: (req) => `model:${(req.body as any).model}|route:${req.url}`,
    subject: (req) => `tenant:${(req.body as any).tenant_id}`,
    issueParams: { target_solve_time_s: 1.0, expires_in_s: 60 },
    onError: (err, req) => req.log.error({ err }, 'btx admission error'),
  }),
}, async (request, reply) => {
  // request.btx?.result is populated with the redeem VerifyResult
  return { ok: true, generated: '...' };
});

await fastify.listen({ port: 3000 });
```

## How it works

Stateless **echo-the-challenge** flow:

1. **First request** has no proof headers → middleware calls `client.issue()` → replies `402 Payment Required` with `X-BTX-Challenge` header containing the challenge JSON + a body listing the headers the client should add on retry.
2. **Client solves** the challenge (locally or via RPC) and **retries** with `X-BTX-Challenge` (echoed), `X-BTX-Proof-Nonce`, `X-BTX-Proof-Digest`.
3. Middleware calls `client.redeem()` → if `result.valid === true`, sets `request.btx = { result }` and runs the route handler. Else replies `403`.

No server-side challenge store; the client echoes the challenge back. Scales horizontally. Cons: the challenge JSON (~3-5 KB) lives in an HTTP header, so check your reverse proxy's `large_client_header_buffers` / equivalent.

## API

### `btxAdmission(opts): preHandlerAsyncHookHandler`

Returns a Fastify preHandler hook to attach per-route.

#### Options

| Field | Type | Notes |
|---|---|---|
| `client` | `BtxChallengeClient` | required. Construct once at boot. |
| `purpose` | `string \| (req) => string` | required. Logical purpose label. |
| `resource` | `string \| (req) => string` | required. Resource identifier. |
| `subject` | `string \| (req) => string` | required. Subject identifier. |
| `issueParams` | `Partial<IssueParams>` | optional. Extra params forwarded to `client.issue()`. |
| `onAdmit` | `(req, result) => void` | optional. Fires on successful admission. |
| `onError` | `(err, req) => void` | optional. Fires when `client.issue()` or `client.redeem()` throws, exactly once before the preHandler re-throws. Use for logging. Audit ref: D-1. |
| `isProofPresent` | `(req) => boolean` | optional. Override the default `headers[x-btx-challenge] && headers[x-btx-proof-nonce] && headers[x-btx-proof-digest]` check. |

### Header constants

| Constant | Value |
|---|---|
| `HEADER_CHALLENGE` | `'x-btx-challenge'` |
| `HEADER_CHALLENGE_ID` | `'x-btx-challenge-id'` |
| `HEADER_PROOF_NONCE` | `'x-btx-proof-nonce'` |
| `HEADER_PROOF_DIGEST` | `'x-btx-proof-digest'` |

(Fastify lowercases incoming header names, hence the lowercase form here. Outgoing `reply.header()` accepts any case.)

## Error handling

When `client.issue()` or `client.redeem()` throws (e.g., btxd RPC down, network error), the middleware:
1. Calls `opts.onError(err, req)` if provided
2. Re-throws — Fastify's standard error-handling pipeline kicks in (default 500, or whatever your error handler returns)

For HTTPS / production deployments, terminate TLS at a reverse proxy (Caddy, nginx, Cloudflare) in front of btxd. **Do NOT expose btxd's RPC port directly to the public internet.**

## CORS

The `X-BTX-Challenge`, `X-BTX-Proof-Nonce`, and `X-BTX-Proof-Digest` headers are **custom**, which triggers a CORS preflight for any browser-originated fetch. Configure `@fastify/cors`:

```ts
import cors from '@fastify/cors';
await fastify.register(cors, {
  origin: 'https://your-frontend.example',
  allowedHeaders: [
    'content-type',
    'x-btx-challenge',
    'x-btx-challenge-id',
    'x-btx-proof-nonce',
    'x-btx-proof-digest',
  ],
  exposedHeaders: [
    'x-btx-challenge', // so the browser can READ the 402's challenge header
  ],
});
```

Without `exposedHeaders` including `x-btx-challenge`, the browser sees the 402 status but **cannot** read the challenge JSON from the response header.

## Requirements

- **Node.js** ≥ 18.17
- **Fastify** ^4.0.0 or ^5.0.0 (peer dep)
- **@btx-tools/challenges-sdk** ^0.0.4 (peer dep)

## License

MIT. See [LICENSE](./LICENSE).
