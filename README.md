# BTX challenges SDK

> **Put a proof-of-work checkpoint in front of any endpoint — no CAPTCHA, no login, no API keys, no third-party service.**

A TypeScript SDK for **[BTX](https://btx.dev) service challenges**: your server asks a caller to burn a few seconds of _verifiable_ compute before you do something expensive or abusable. The work is defined and checked by the BTX chain — so there's no centralized issuer to trust, and a proof can't be replayed. Ships a typed RPC client, a solver, and **one-line middleware for Express, Fastify, and Hono**.

📖 **[API Reference](https://btx-tools.github.io/btx-challenges-sdk/)** · 🟢 **Stable `1.0.0`** ([SemVer](https://semver.org/) — breaking changes require `2.0.0`) · MIT

## What is this?

### Why it exists

You want to slow down bots, scraping, spam, or abuse on an endpoint — but the usual options each cost something:

- a **CAPTCHA** annoys real users and is increasingly solved by bots anyway,
- **accounts / API keys** add signup friction and a user database,
- a **hosted anti-bot service** means a third party, a monthly bill, and a privacy trade-off.

A BTX service challenge instead makes the _caller_ prove they spent a little real compute. It's **cheap to verify, costly to spam at scale, anchored to a public chain, and entirely self-hosted.**

### How it works — issue → solve → redeem

```
Client ── POST /expensive ─────────────────▶  Server
                                               │  no proof yet → issue a challenge
Client ◀── 402 Payment Required ───────────────┤  (challenge rides in the X-BTX-Challenge header)
   │
   │  solve the matmul work-proof
   │  (locally in JS, or — recommended — via a nearby non-mining btxd RPC)
   ▼
Client ── POST /expensive + proof headers ──▶  Server
                                               │  redeem: verify + consume (anti-replay)
Client ◀── 200 OK — your handler runs ─────────┘
```

The middleware runs this whole handshake for you. The server **never stores issued challenges** (the challenge echoes back in a header on retry), so it scales horizontally with no shared state.

### One line to gate a route (Express)

```ts
import express from 'express';
import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
import { btxAdmission } from '@btx-tools/middleware-express';

const client = new BtxChallengeClient({
  rpcUrl: 'http://127.0.0.1:19334', // a dedicated, NON-mining btxd
  rpcAuth: { user: 'rpcuser', pass: 'rpcpass' },
});

const app = express();
app.post(
  '/v1/generate',
  btxAdmission({
    client,
    purpose: 'ai_inference_gate',
    resource: (req) => req.path,
    subject: (req) => req.ip ?? 'anon',
  }),
  (req, res) => res.json({ ok: true }), // only runs after a valid proof is redeemed
);
```

### Who it's for

- **AI / inference APIs** gating expensive generations without a login wall.
- **Agent / MCP gateways** — per-tool-call admission (see the sibling [`@btx-tools/mcp-gateway`](https://github.com/btx-tools/btx-mcp-gateway)).
- **Anonymous forms / submission endpoints** that need rate-limiting without accounts.
- Anyone replacing hCaptcha / reCAPTCHA-style gating with **self-hosted, chain-anchored proof-of-work** on the server side.

> ℹ️ **Server-side, not a browser captcha.** See [What this SDK is (and isn't)](#what-this-sdk-is-and-isnt) below — the matmul proof is GPU-fast-mining-shaped, so production solving belongs on a server (or a nearby `btxd`), not a user's browser tab.

## Packages

This repo is a monorepo: the core SDK plus three framework adapters (install only the ones you need).

| Package                                                          | Description                                                          | Latest    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- | --------- |
| [`@btx-tools/challenges-sdk`](./packages/core)                   | Core RPC client + Solver (RPC + pure-JS modes) + algorithm port      | **1.0.0** |
| [`@btx-tools/middleware-express`](./packages/middleware-express) | Express middleware adapter                                           | **1.0.0** |
| [`@btx-tools/middleware-fastify`](./packages/middleware-fastify) | Fastify plugin adapter                                               | **1.0.0** |
| [`@btx-tools/middleware-hono`](./packages/middleware-hono)       | Hono middleware adapter (Node + edge: Cloudflare Workers, Deno, Bun) | **1.0.0** |

### Sibling packages (separate repos)

| Package                                                                          | Description                                                                                                                                               | Repo                                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`@btx-tools/mcp-gateway`](https://www.npmjs.com/package/@btx-tools/mcp-gateway) | **MCP server framework** that gates every tool invocation behind a BTX service-challenge proof — for agentic AI admission control. Companion to this SDK. | [btx-tools/btx-mcp-gateway](https://github.com/btx-tools/btx-mcp-gateway) |

### Post-1.0 roadmap

`1.0.0` froze the server-side admission-middleware API. Candidate additive work for `1.x`/beyond (none breaking):

- **`@btx-tools/mcp-gateway` `1.0.0`** — promote the agent-admission gateway to stable alongside this family.
- **Cloudflare Worker template** — deploy-ready edge gate using `middleware-hono`.
- **WordPress plugin** (`wp-btx-gate`) — form/login admission for the largest CMS surface.
- **Python SDK** (`btx-challenges-py`) — server-side parity for Python stacks.
- **LangChain / LlamaIndex bindings** — agent-tool admission for the popular orchestration frameworks.

Browser-side solving remains out of scope until the BTX protocol offers a browser-friendly proof primitive (see `USE-CASES.md`).

## Quickstart (for SDK consumers)

```bash
# Core only (RPC client + browser-compatible Solver)
npm install @btx-tools/challenges-sdk

# With an HTTP framework adapter — pick one
npm install @btx-tools/challenges-sdk @btx-tools/middleware-express express
npm install @btx-tools/challenges-sdk @btx-tools/middleware-fastify fastify
npm install @btx-tools/challenges-sdk @btx-tools/middleware-hono hono

# For agent / MCP admission gating (separate package, see https://github.com/btx-tools/btx-mcp-gateway)
npm install @btx-tools/challenges-sdk @btx-tools/mcp-gateway @modelcontextprotocol/sdk zod
```

Then see the per-package README:

- [packages/core/README.md](./packages/core/README.md)
- [packages/middleware-express/README.md](./packages/middleware-express/README.md)
- [packages/middleware-fastify/README.md](./packages/middleware-fastify/README.md)
- [packages/middleware-hono/README.md](./packages/middleware-hono/README.md)

## What this SDK is (and isn't)

> **Read [USE-CASES.md](./USE-CASES.md) before deciding to integrate.** This SDK is **server-side admission middleware** for chain-anchored proof-of-work gating. It is **not** a browser captcha library — per our 2026-05-23 WASM spike, browser pure-JS solving is ~1000× over the 1-4s captcha UX budget at production difficulty. Use the `mode: 'rpc'` path against a dedicated non-mining btxd for production deployments.

## Examples

Three runnable end-to-end examples under [`examples/`](https://github.com/btx-tools/btx-challenges-sdk/tree/main/examples/):

| Path                                                                                                                   | Stack                          | What it shows                                                                                                                      | Status                         |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [`examples/01-basic-roundtrip`](https://github.com/btx-tools/btx-challenges-sdk/tree/main/examples/01-basic-roundtrip) | Node + tsx                     | Minimal `issue → Solver.solve → redeem` walk-through, both pure-JS and RPC modes                                                   | ✅ Adopter-ready (server-side) |
| [`examples/02-express-gate`](https://github.com/btx-tools/btx-challenges-sdk/tree/main/examples/02-express-gate)       | Node + Express + tsx           | Full Express server with `btxAdmission` on `POST /v1/generate`, plus a Node client driving the 402 → solve → 200 → 403-replay flow | ✅ Adopter-ready (server-side) |
| [`examples/03-browser-solver`](https://github.com/btx-tools/btx-challenges-sdk/tree/main/examples/03-browser-solver)   | Vite + TypeScript + Web Worker | **Demonstrates the wire protocol** from a browser. **NOT a production captcha** — see [USE-CASES.md](./USE-CASES.md).              | ⚠️ Reference only              |

Each `examples/<n>/README.md` has install + run instructions.

> Heads-up: at floor difficulty, a pure-JS solve takes ~7-60 min wall-clock on an M-series Mac (BigInt-bound). Use `mode: 'rpc'` against a dedicated non-mining btxd for sub-second production solves.

## Quickstart (for contributors)

```bash
pnpm install           # at the workspace root
pnpm -r type-check     # all packages
pnpm -r build          # all packages
pnpm -r test           # unit + integration tests
```

## Project links

- Design spec: internal — not public.
- BTX dev portal: [btx.dev/develop](https://btx.dev/develop/)
- RPC reference: [btx.dev/docs/rpc/service-challenges](https://btx.dev/docs/rpc/service-challenges)

## License

MIT — see [LICENSE](./LICENSE).
