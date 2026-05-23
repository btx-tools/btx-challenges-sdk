# @btx-tools/middleware-express

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@btx-tools/middleware-express)](https://www.npmjs.com/package/@btx-tools/middleware-express)

Drop-in Express admission gate backed by [BTX](https://btx.dev) service challenges. Turns an Express route into a chain-anchored proof-of-work checkpoint with one line.

📖 **[API Reference](https://btx-tools.github.io/btx-challenges-sdk/)** — TypeDoc for all `@btx-tools/*` SDK packages.

> **Status**: 0.2.0. Requires `@btx-tools/challenges-sdk@^0.0.1`. **Breaking change from 0.1.x**: `Express.Request.btxResult` was renamed to `req.btx.result` (see [CHANGELOG](./CHANGELOG.md#020---2026-05-22) for migration).

> **End-to-end example**: clone the repo and run [`examples/02-express-gate`](https://github.com/btx-tools/btx-challenges-sdk/tree/main/examples/02-express-gate) for a working server + client pair you can copy from. Walks the full 402 → solve → 200 → 403-replay flow against a live btxd.

## Install

```bash
npm install @btx-tools/middleware-express @btx-tools/challenges-sdk express
```

`express` is a peer dependency — bring your own version (`^4` or `^5`).

## Usage

```typescript
import express from 'express';
import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
import { btxAdmission } from '@btx-tools/middleware-express';

const client = new BtxChallengeClient({
  rpcUrl: 'http://127.0.0.1:19334', // dedicated NON-mining btxd
  rpcAuth: { user: 'rpcuser', pass: 'rpcpass' },
});

const app = express();
app.use(express.json());

app.post(
  '/v1/generate',
  btxAdmission({
    client,
    purpose: 'ai_inference_gate',
    resource: (req) => `model:${req.body.model}|route:${req.path}`,
    subject: (req) => `tenant:${req.body.tenant_id}`,
    issueParams: { target_solve_time_s: 1.0, expires_in_s: 60 },
  }),
  async (req, res) => {
    // req.btx?.result is the redeem VerifyResult — proof of admission
    res.json({ ok: true, generated: '...' });
  },
);

app.listen(3000);
```

That's it. The middleware does the full issue / redeem dance for you.

## How it works

**Stateless echo-the-challenge** flow. Server never stores issued challenges; the client echoes the challenge JSON back on retry.

```
Client → POST /v1/generate                            (no proof headers)
Server →   402 Payment Required
           X-BTX-Challenge: <stringified challenge JSON>
           { "challenge": {...}, "retry_with": [...] }

[client solves locally (Solver.solve from @btx-tools/challenges-sdk) or via RPC]

Client → POST /v1/generate
           X-BTX-Challenge:    <echoed challenge JSON>
           X-BTX-Proof-Nonce:  <hex>
           X-BTX-Proof-Digest: <hex>
Server →   200 OK   (req.btx?.result populated; your handler runs)
```

Failure cases (server-side, all return JSON):

| Code                        | When                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `400 Bad Request`           | retry missing `X-BTX-Challenge` echo, malformed JSON, or `X-BTX-Challenge-Id` mismatch                                            |
| `402 Payment Required`      | normal first-request response — client should solve and retry                                                                     |
| `403 Forbidden`             | redeem failed — `{ valid: false, reason }`. Possible reasons: `invalid_proof`, `expired`, `already_redeemed`, `unknown_challenge` |
| `500 Internal Server Error` | btxd RPC layer threw — surfaced via `next(err)`, handled by your Express error middleware                                         |

## API

### `btxAdmission(opts)`

Returns a standard Express `RequestHandler`.

| Option           | Type                        | Required | Description                                                                                                                                                                          |
| ---------------- | --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client`         | `BtxChallengeClient`        | ✅       | The RPC client constructed at boot                                                                                                                                                   |
| `purpose`        | `string \| (req) => string` | ✅       | Logical purpose label — `'ai_inference_gate'`, `'rate_limit'`, `'api_gate'`, or your own                                                                                             |
| `resource`       | `string \| (req) => string` | ✅       | Resource identifier — what's being gated                                                                                                                                             |
| `subject`        | `string \| (req) => string` | ✅       | Subject identifier — who's being challenged                                                                                                                                          |
| `issueParams`    | `Partial<IssueParams>`      |          | Forwarded to `client.issue()` (e.g. `target_solve_time_s`, `expires_in_s`)                                                                                                           |
| `onAdmit`        | `(req, result) => void`     |          | Hook fired on successful admission                                                                                                                                                   |
| `onError`        | `(err, req) => void`        |          | **New in 0.2.0** — hook fired exactly once when `client.issue()` or `client.redeem()` throws, before `next(err)` is invoked. Use for logging / observability; don't mutate the error |
| `isProofPresent` | `(req) => boolean`          |          | Override the default "all 3 proof headers set?" check                                                                                                                                |

### Constants

```typescript
import {
  HEADER_CHALLENGE, // 'X-BTX-Challenge'
  HEADER_CHALLENGE_ID, // 'X-BTX-Challenge-Id'
  HEADER_PROOF_NONCE, // 'X-BTX-Proof-Nonce'
  HEADER_PROOF_DIGEST, // 'X-BTX-Proof-Digest'
} from '@btx-tools/middleware-express';
```

### Type augmentation

The middleware augments `Express.Request` with `req.btx?: { result: VerifyResult }` so your handler can introspect the redemption outcome:

```typescript
app.post('/v1/gate', btxAdmission({ ... }), (req, res) => {
  console.log('admitted:', req.btx?.result.reason);  // 'ok' on success
});
```

> **Migration from 0.1.x**: rename `req.btxResult` → `req.btx?.result` in your handlers. The 0.1.x flat `btxResult` field polluted the global `Express.Request` type — the namespaced `btx` is scoped enough that it shouldn't collide with other middleware (audit finding C-3).

### Error handling

When `client.issue()` or `client.redeem()` throws, the middleware calls `next(err)` so Express's error pipeline handles it. **Be aware** that Express's default error handler in development mode includes the full stack trace in the HTTP response — a thrown `BtxRpcError` may carry server-internal details (btxd URL, RPC method names, response snippets) that you don't want exposed to clients. Configure a custom Express error handler that returns a sanitized response:

```typescript
app.use((err, req, res, next) => {
  // Optional: also log via your APM here
  res.status(500).json({ error: 'internal_error' }); // never err.message
});
```

For observability without an error handler, use the `onError` hook in `BtxAdmissionOpts` (added 0.2.0).

## Deployment notes

### Header size

The `X-BTX-Challenge` echo header carries a JSON-stringified challenge envelope (~3–5 KB). This sits within standard HTTP header limits (most servers default to 8 KB), but **check your reverse proxy** if you front Express with nginx, Caddy, Cloudflare, or AWS ALB. Specifically:

- nginx: `large_client_header_buffers 4 16k`
- Caddy: limits are looser by default; check `http.server.max_header_bytes`
- Cloudflare: tied to your plan
- AWS ALB: 16 KB headers, 60 KB total — fine
- AWS API Gateway: 10 KB per header, 16 KB total — fine

If header size becomes a constraint, the stateful variant (server-side `challenge_id` cache) is queued as a future enhancement: `btxAdmission({ store: new LruStore() })`.

### Multi-node deployments

Because the middleware is **stateless**, the issuing server and the redeeming server can be different instances. No sticky routing required.

(btxd's `proof_policy.locally_issued_required: true` means the redeem RPC must hit the same btxd that issued the challenge. The Express layer is stateless; the btxd layer downstream is what enforces the binding. If you run a multi-node btxd cluster, you'll want shared `issued_challenge_store` config — see the [btxd service-challenges docs](https://btx.dev/docs/rpc/service-challenges).)

### Don't point at a mining btxd

Same caveat as the core SDK: btxd's service-challenge solver shares the matmul backend with block mining. On a mining-loaded node, the `solvematmulservicechallenge` RPC (used by `Solver.solve({ mode: 'rpc' })` for server-side solving) queues behind block work for 10+ minutes. For production use, point `BtxChallengeClient` at a **dedicated non-mining btxd** (e.g. `gen=0` in `btx.conf`).

### CORS

The `X-BTX-Challenge`, `X-BTX-Proof-Nonce`, and `X-BTX-Proof-Digest` headers are **custom**, which means browser fetches to your gated route will trigger a CORS preflight. Make sure your CORS middleware allows them:

```ts
import cors from 'cors';
app.use(
  cors({
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
  }),
);
```

Without `exposedHeaders` including `x-btx-challenge`, the browser sees the 402 status but **cannot** read the challenge JSON from the response header (Web Fetch hides non-CORS-safelisted response headers by default).

## License

MIT — see [LICENSE](LICENSE).
