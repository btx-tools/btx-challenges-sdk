# BTX challenges SDK — monorepo

Workspace root for `@btx/challenges-sdk` and companion middleware packages.

## Packages

| Package | Description | Status |
|---|---|---|
| [`@btx/challenges-sdk`](./packages/core) | Core RPC client + Solver (stubbed; ships Day 2) | Day 1 of 9 |
| `@btx/challenges-sdk-express` | Express middleware adapter | Day 3 |
| `@btx/challenges-sdk-fastify` | Fastify middleware adapter | Day 3 |
| `@btx/challenges-sdk-hono` | Hono middleware adapter | Day 3 |

## Quickstart (for SDK consumers)

```bash
npm install @btx/challenges-sdk
```

Then see [packages/core/README.md](./packages/core/README.md).

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
