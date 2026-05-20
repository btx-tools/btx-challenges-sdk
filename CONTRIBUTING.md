# Contributing

Thanks for considering a contribution. The SDK is early — every issue, doc improvement, or PR helps.

## Setup

```bash
git clone https://github.com/visitor-code/btx-challenges-sdk
cd btx-challenges-sdk
pnpm install
pnpm -r type-check
pnpm -r build
pnpm -r test         # runs unit + integration suites
```

Workspace: pnpm workspaces. Each publishable package lives under `packages/*` with its own `package.json` and version. Integration tests SSH into a healthy at-tip BTX node — see `packages/core/tests/integration/smoke.test.ts` for the target convention.

## Testing layers

- **`packages/*/tests/unit/`** — msw-mocked HTTP. Fast. Default for CI.
- **`packages/*/tests/integration/`** — live `btxd` via SSH. Requires SSH access to a healthy at-tip BTX node. Tagged so CI can skip.

A change to `BtxChallengeClient` should add or update unit tests. A change to the RPC contract should also touch integration tests.

## Code style

- TypeScript strict mode (already on)
- Prettier configured at workspace root
- `pnpm format` before committing
- No `any` escape hatches without a comment justifying it
- Public API surfaces require JSDoc

## PR checklist

- [ ] `pnpm -r type-check` passes
- [ ] `pnpm -r build` clean
- [ ] `pnpm -r test` passes (unit at minimum; integration if you have SSH access)
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] If you added a public API: README + JSDoc
- [ ] If you closed an audit finding: reference the audit doc + finding ID

## What's out of scope (for now)

- Multi-node deployment helpers (sticky routing, shared registry)
- Pre-built Docker images
- Languages other than TypeScript (separate repos planned for Python, Go, Rust)
- Functional API redesign (deferred to v0.1 per audit M4)

## License

MIT.
