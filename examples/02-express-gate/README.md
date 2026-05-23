# 02-express-gate

A two-file Express app demonstrating the BTX admission gate end-to-end:

- **`src/server.ts`** — Express server with one route, `POST /v1/generate`, gated by `btxAdmission` from `@btx-tools/middleware-express`. CORS is preconfigured for the browser example.
- **`src/client.ts`** — Node script that walks the full 402 → solve → 200 → replay-rejected (403) flow against the running server.

Together they show the stateless echo-the-challenge pattern: the server never persists issued challenges; the client echoes them back in a header for the redeem call.

## Prereqs

- Node ≥ 18.17
- A reachable **btxd** node with the service-challenge RPCs (v0.30.1+) — **non-mining** if you want fast (~1–4 s) `rpc`-mode solves. There is no hosted endpoint; you point at a node you run. See `.env.example` and [core → Prerequisites: you need a BTX node](../../packages/core#prerequisites-you-need-a-btx-node).
- Two terminals (one for the server, one for the client)

## Install + run

```bash
pnpm install                # at the repo root, once
cp .env.example .env        # edit BTX_RPC_URL + BTX_RPC_AUTH

# terminal A — start the gate
pnpm start:server

# terminal B — drive it with the client
pnpm start:client
```

## What you'll see

**Server (terminal A):**

```
gate listening on http://127.0.0.1:3000
POST http://127.0.0.1:3000/v1/generate to trigger the BTX challenge flow
[ADMIT] POST /v1/generate reason=ok redeemed=true
```

**Client (terminal B):**

```
[POST 1] http://127.0.0.1:3000/v1/generate (no proof)
[POST 1] 402 received in 0.45s — challenge_id=2a4b1c8e9d7f3a01...
[solve] starting pure-JS solve (this can take 7-10 min on an M-series Mac)...
[solve] nonce=0123456789abcdef digest=fedcba9876543210... in 421.30s
[POST 2] retrying with proof headers
[POST 2] 200 in 0.21s body={"ok":true,"generated":"pretend this is the model output","admitted_via":"ok"}
[POST 3] replaying same proof (expect 403 already_redeemed)
[POST 3] 403 in 0.14s body={"valid":false,"reason":"already_redeemed"}
```

## How it works

1. **First POST, no proof headers** — `btxAdmission` sees the proof is missing and calls `client.issue()`. Responds 402 with the challenge in both `X-BTX-Challenge` (header) and the JSON body. The middleware doesn't store anything server-side.
2. **Client solves locally** — `Solver.solve(challenge, { mode: 'pure-js' })` runs the matmul proof-of-work. The client could also delegate to a dedicated non-mining btxd via `{ mode: 'rpc', rpcClient }` — see [`../01-basic-roundtrip`](../01-basic-roundtrip).
3. **Retry with proof headers** — client posts the same body plus three headers: `X-BTX-Challenge` (echoed back, byte-equal), `X-BTX-Proof-Nonce`, `X-BTX-Proof-Digest`. `btxAdmission` parses the challenge from the header, calls `client.redeem()`, and (on `valid: true`) hands off to the downstream handler with `req.btx.result` populated.
4. **Third POST replays** — same proof, same challenge → `redeem` returns `valid: false, reason: 'already_redeemed'` → `btxAdmission` responds 403.

## Production notes

- **Reverse proxies**: the `X-BTX-Challenge` header is ~3-5 KB. Standard HTTP header limits (8 KB) cover this, but nginx/Caddy/Cloudflare/ALB tuning may be needed. See the [middleware-express README § Header size](../../packages/middleware-express/README.md#header-size).
- **CORS**: the `X-BTX-*` headers are custom; browser callers trigger preflight. Both `allowedHeaders` and `exposedHeaders` need the four BTX header names. The server here ships a working `cors` config you can copy.
- **Error handler**: never expose `err.message` from `next(err)` — `BtxRpcError` and friends carry server-internal details (RPC URL, method names). The server here returns an opaque `{ error: 'internal_error' }` and logs the full stack server-side.
- **Don't point at a mining btxd**: `client.redeem()` itself is cheap, but if you ever set `Solver.solve({ mode: 'rpc' })` you'll queue behind block mining for 15+ min. Always use a dedicated non-mining btxd for server-side solving.

## Next

- [`../03-browser-solver`](../03-browser-solver) — a browser-side variant that hits this same server from a Vite page using a Web Worker.

## Troubleshooting

- `ECONNREFUSED 127.0.0.1:3000` from the client → the server isn't running, or `PORT` differs between the two.
- `400 missing_challenge_header` on retry → the second POST didn't include the `X-BTX-Challenge` header (echo-back is mandatory).
- `403 expired` → the challenge lifetime is `expires_in_s: 1800` (30 min); if your pure-JS solve takes longer, the challenge expired before redeem. Either bump `expires_in_s` or use RPC-mode solving.
- `500 internal_error` → check the server log for the underlying `BtxRpcError` / network issue.

More entries in [`../../TROUBLESHOOTING.md`](../../TROUBLESHOOTING.md).
