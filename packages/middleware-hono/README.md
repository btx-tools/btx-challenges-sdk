# @btx-tools/middleware-hono

Drop-in **Hono** admission gate backed by BTX service challenges. Works on Node, Deno, Bun, **Cloudflare Workers**, and other edge runtimes Hono targets. Same flow + ergonomics as [`@btx-tools/middleware-express`](https://www.npmjs.com/package/@btx-tools/middleware-express) and [`@btx-tools/middleware-fastify`](https://www.npmjs.com/package/@btx-tools/middleware-fastify), tailored to Hono's middleware model + `c.set('btx', ...)` variables.

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

app.post('/v1/generate',
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

| Field | Type | Notes |
|---|---|---|
| `client` | `BtxChallengeClient` | required. Construct once at boot. |
| `purpose` | `string \| (c) => string \| (c) => Promise<string>` | required. Logical purpose label. Async resolver supported so you can `await c.req.json()`. |
| `resource` | `string \| (c) => string \| (c) => Promise<string>` | required. |
| `subject` | `string \| (c) => string \| (c) => Promise<string>` | required. |
| `issueParams` | `Partial<IssueParams>` | optional. |
| `onAdmit` | `(c, result) => void` | optional. Fires on successful admission. |
| `onError` | `(err, c) => void` | optional. Fires when `client.issue()` or `client.redeem()` throws. Re-thrown to Hono's `onError`. Audit ref: D-1. |
| `isProofPresent` | `(c) => boolean` | optional. Predicate override. |

### `BtxAdmissionVariables`

Type the Hono instance with this for `c.get('btx')` type narrowing:

```ts
const app = new Hono<{ Variables: BtxAdmissionVariables }>();
```

After admission, `c.get('btx')` is `{ result: VerifyResult } | undefined`.

### Header constants

| Constant | Value |
|---|---|
| `HEADER_CHALLENGE` | `'x-btx-challenge'` |
| `HEADER_CHALLENGE_ID` | `'x-btx-challenge-id'` |
| `HEADER_PROOF_NONCE` | `'x-btx-proof-nonce'` |
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

- **Cloudflare Workers / Pages**: works out of the box. `BtxChallengeClient` uses `fetch()` which is the native Workers networking primitive.
- **Deno Deploy**: same — `fetch()` is standard.
- **Bun**: same.
- **Vercel Edge**: works, but check max header size (Vercel Edge caps incoming headers around 16 KB). For high-difficulty challenges the JSON envelope might exceed this — consider switching to a stateful challenge-store middleware variant if you hit this.

## Requirements

- **Node.js** ≥ 18.17 (when running on Node)
- **Hono** ^4.0.0 (peer dep)
- **@btx-tools/challenges-sdk** ^0.0.4 (peer dep)

## License

MIT. See [LICENSE](./LICENSE).
