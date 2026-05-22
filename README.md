# BTX challenges SDK — monorepo

Workspace root for `@btx-tools/challenges-sdk` and companion middleware packages.

## Packages

| Package | Description | Latest |
|---|---|---|
| [`@btx-tools/challenges-sdk`](./packages/core) | Core RPC client + Solver (RPC + pure-JS modes) + algorithm port | **0.1.1** |
| [`@btx-tools/middleware-express`](./packages/middleware-express) | Express middleware adapter | **0.2.2** |
| [`@btx-tools/middleware-fastify`](./packages/middleware-fastify) | Fastify plugin adapter | **0.1.1** |
| [`@btx-tools/middleware-hono`](./packages/middleware-hono) | Hono middleware adapter (Node + edge: Cloudflare Workers, Deno, Bun) | **0.1.1** |

### Sibling packages (separate repos)

| Package | Description | Repo |
|---|---|---|
| [`@btx-tools/mcp-gateway`](https://www.npmjs.com/package/@btx-tools/mcp-gateway) | **MCP server framework** that gates every tool invocation behind a BTX service-challenge proof — for agentic AI admission control. Companion to this SDK. | [btx-tools/btx-mcp-gateway](https://github.com/btx-tools/btx-mcp-gateway) |

Roadmap to `1.0.0`: private — see internal `BTX/ecosystem/sdk-finishing-plan-2026-05-22.md`.

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

Three runnable end-to-end examples under [`examples/`](./examples/):

| Path | Stack | What it shows | Status |
|---|---|---|---|
| [`examples/01-basic-roundtrip`](./examples/01-basic-roundtrip) | Node + tsx | Minimal `issue → Solver.solve → redeem` walk-through, both pure-JS and RPC modes | ✅ Adopter-ready (server-side) |
| [`examples/02-express-gate`](./examples/02-express-gate) | Node + Express + tsx | Full Express server with `btxAdmission` on `POST /v1/generate`, plus a Node client driving the 402 → solve → 200 → 403-replay flow | ✅ Adopter-ready (server-side) |
| [`examples/03-browser-solver`](./examples/03-browser-solver) | Vite + TypeScript + Web Worker | **Demonstrates the wire protocol** from a browser. **NOT a production captcha** — see [USE-CASES.md](./USE-CASES.md). | ⚠️ Reference only |

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

- Spec: [`BTX/ecosystem/btx-challenges-sdk-spec-2026-05-20.md`](../../Documents/BTX/ecosystem/btx-challenges-sdk-spec-2026-05-20.md) (private)
- BTX dev portal: [btx.dev/develop](https://btx.dev/develop/)
- RPC reference: [btx.dev/docs/rpc/service-challenges](https://btx.dev/docs/rpc/service-challenges)

## License

MIT — see [LICENSE](./LICENSE).
