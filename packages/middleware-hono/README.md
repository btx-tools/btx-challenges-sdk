# @btx-tools/middleware-hono

Drop-in **Hono** admission gate backed by BTX service challenges. Works on Node, Deno, Bun, **Cloudflare Workers**, and other edge runtimes Hono targets. Same flow + ergonomics as [`@btx-tools/middleware-express`](https://www.npmjs.com/package/@btx-tools/middleware-express) and [`@btx-tools/middleware-fastify`](https://www.npmjs.com/package/@btx-tools/middleware-fastify), tailored to Hono's middleware model + `c.set('btx', ...)` variables.

📖 **[API Reference](https://btx-tools.github.io/btx-challenges-sdk/)** — TypeDoc for all `@btx-tools/*` SDK packages.

> **End-to-end example**: a runnable adopter example is in [`examples/02-express-gate`](https://github.com/btx-tools/btx-challenges-sdk/tree/main/examples/02-express-gate) (Express-based; the wiring shape is structurally identical for Hono — swap the route + middleware call). A Hono-native parity example covering both Node and edge deploy is queued for the SDK Phase 3.5 roadmap.

```bash
pnpm add @btx-tools/middleware-hono @btx-tools/challenges-sdk hono
```

## Quickstart

```ts
import { Hono } from 'hono';
import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
import { btxAdmission, type BtxAdmissionVariables } from '@btx-tools/middleware-hono';

const client = new BtxChallengeClient({
  rpcUrl: 'http://127.0.0.1:19334',
  rpcAuth: { user: 'rpcuser', pass: 'rpcpass' },
});

const app = new Hono<{ Variables: BtxAdmissionVariables }>();

app.post(
  '/v1/generate',
  btxAdmission({
    client,
    purpose: 'ai_inference_gate',
    resource: (c) => `route:${c.req.path}`,
    subject: async (c) => `tenant:${(await c.req.json()).tenant_id}`,
    issueParams: { target_solve_time_s: 1.0, expires_in_s: 60 },
    onError: (err, c) => c.var.logger?.error({ err }, 'btx admission error'),
  }),
  async (c) => {
    const admit = c.get('btx').result;
    return c.json({ ok: true, reason: admit.reason });
  },
);

export default app;
```

## ⚠️ Body consumption (read before async resolvers)

Hono's `c.req.json()` is **one-shot** — once consumed, the body stream is gone. If your `resource` / `subject` resolver does `await c.req.json()`, the route handler downstream **cannot read the body again** and will throw `BodyAlreadyUsedError`.

❌ **This breaks**:

```ts
(btxAdmission({
  // ...
  resource: async (c) => `model:${(await c.req.json()).model}`,
}),
  async (c) => {
    const body = await c.req.json(); // ← throws — body already consumed!
    return c.json({ ok: true });
  });
```

✅ **Two safe patterns**:

```ts
// Pattern 1: cache the body once at the top, pass through context
app.post('/v1/generate', async (c, next) => {
  c.set('body', await c.req.json());
  return next();
});
app.post('/v1/generate',
  btxAdmission({
    // ...
    resource: (c) => `model:${(c.get('body') as { model: string }).model}`,
  }),
  async (c) => {
    const body = c.get('body');
    return c.json({ ok: true, body });
  },
);

// Pattern 2: derive resolver inputs from headers, not body
btxAdmission({
  // ...
  resource: (c) => `model:${c.req.header('x-model') ?? 'default'}`,
}),
```

## How it works

Stateless **echo-the-challenge** flow:

1. **First request** has no proof headers → middleware calls `client.issue()` → replies `402 Payment Required` with `X-BTX-Challenge` header containing the challenge JSON + a body listing the headers the client should add on retry.
2. **Client solves** the challenge (locally or via RPC) and **retries** with `X-BTX-Challenge` (echoed), `X-BTX-Proof-Nonce`, `X-BTX-Proof-Digest`.
3. Middleware calls `client.redeem()` → if `result.valid === true`, sets `c.set('btx', { result })` and yields to `await next()` (route handler runs). Else replies `403`.

No server-side challenge store. Scales horizontally; the challenge JSON rides in the `X-BTX-Challenge` header on retry (~3-5 KB). Check edge-runtime header-size limits — Cloudflare Workers and Fastly accept large headers, but Vercel Edge caps at smaller sizes.

## API

### `btxAdmission(opts): MiddlewareHandler`

Returns a Hono middleware function to attach per-route.

#### Options

| Field            | Type                                                | Notes                                                                                                             |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `client`         | `BtxChallengeClient`                                | required. Construct once at boot.                                                                                 |
| `purpose`        | `string \| (c) => string \| (c) => Promise<string>` | required. Logical purpose label. Async resolver supported so you can `await c.req.json()`.                        |
| `resource`       | `string \| (c) => string \| (c) => Promise<string>` | required.                                                                                                         |
| `subject`        | `string \| (c) => string \| (c) => Promise<string>` | required.                                                                                                         |
| `issueParams`    | `Partial<IssueParams>`                              | optional.                                                                                                         |
| `onAdmit`        | `(c, result) => void`                               | optional. Fires on successful admission.                                                                          |
| `onError`        | `(err, c) => void`                                  | optional. Fires when `client.issue()` or `client.redeem()` throws. Re-thrown to Hono's `onError`. Audit ref: D-1. |
| `isProofPresent` | `(c) => boolean`                                    | optional. Predicate override.                                                                                     |

### `BtxAdmissionVariables`

Type the Hono instance with this for `c.get('btx')` type narrowing:

```ts
const app = new Hono<{ Variables: BtxAdmissionVariables }>();
```

After admission, `c.get('btx')` is `{ result: VerifyResult } | undefined`.

### Header constants

| Constant              | Value                  |
| --------------------- | ---------------------- |
| `HEADER_CHALLENGE`    | `'x-btx-challenge'`    |
| `HEADER_CHALLENGE_ID` | `'x-btx-challenge-id'` |
| `HEADER_PROOF_NONCE`  | `'x-btx-proof-nonce'`  |
| `HEADER_PROOF_DIGEST` | `'x-btx-proof-digest'` |

## Error handling

When `client.issue()` or `client.redeem()` throws (e.g., btxd RPC down, network error), the middleware:

1. Calls `opts.onError(err, c)` if provided
2. Re-throws — Hono's `app.onError()` handler kicks in

Use `app.onError()` to map BTX errors to your preferred response shape:

```ts
app.onError((err, c) => {
  if (err instanceof BtxNetworkError) return c.json({ error: 'btxd unreachable' }, 503);
  return c.json({ error: 'internal' }, 500);
});
```

## Edge-runtime notes

### Network reachability

`BtxChallengeClient` uses `fetch()` to reach btxd's JSON-RPC endpoint. **Edge runtimes cannot reach `127.0.0.1`** — they're sandboxed away from the host loopback. You need a **publicly reachable** btxd RPC URL:

- **Cloudflare Tunnel** (Argo Tunnel) — runs in front of your btxd, gives you a stable HTTPS URL the Worker can call
- **Public RPC proxy** — terminate TLS at Caddy/nginx in front of btxd, expose on a real DNS name
- **Self-hosted relay** with a public IP + Basic auth (verify `rpcallowip` in btx.conf permits the egress IP)

Do **not** put btxd's RPC port directly on the public internet without auth + TLS termination.

### Runtime-specific

- **Cloudflare Workers / Pages**: works once reachability is solved. `fetch()` is native; no Node polyfills needed.
- **Deno Deploy**: same — Web `fetch()` is standard.
- **Bun**: works natively (also accepts a Node btxd via localhost when self-hosting Bun on the same box).
- **Vercel Edge**: works for typical challenge sizes. **Header-size limits vary across edge platforms** — Vercel, Cloudflare, and Fastly all have different caps for incoming headers. The `X-BTX-Challenge` header is ~3-5 KB for default difficulty; check your platform's documentation if you set high `target_solve_time_s` or run into preflight errors. For very large challenges, consider a stateful challenge-store middleware variant.

## CORS

The `X-BTX-Challenge`, `X-BTX-Proof-Nonce`, and `X-BTX-Proof-Digest` headers are **custom**, which triggers a CORS preflight for any browser-originated fetch. Configure Hono's built-in `cors` middleware:

```ts
import { cors } from 'hono/cors';
app.use(
  '/v1/*',
  cors({
    origin: 'https://your-frontend.example',
    allowHeaders: [
      'content-type',
      'x-btx-challenge',
      'x-btx-challenge-id',
      'x-btx-proof-nonce',
      'x-btx-proof-digest',
    ],
    exposeHeaders: [
      'x-btx-challenge', // so the browser can READ the 402's challenge header
    ],
  }),
);
```

Without `exposeHeaders` including `x-btx-challenge`, the browser sees the 402 status but **cannot** read the challenge JSON from the response header (Web Fetch hides non-CORS-safelisted response headers by default).

## Requirements

- **Node.js** ≥ 18.17 (when running on Node)
- **Hono** ^4.0.0 (peer dep)
- **@btx-tools/challenges-sdk** ^0.0.4 (peer dep)

## License

MIT. See [LICENSE](./LICENSE).
