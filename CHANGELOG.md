# Changelog

All notable changes to packages in this workspace are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) + [SemVer](https://semver.org/).

## [Unreleased]

### @btx/challenges-sdk

#### Day 2 — Solver class (RPC mode)

- `Solver` class with mode dispatch (`'rpc' | 'pure-js' | 'auto'`)
  - **`mode: 'rpc'`** — delegates to `BtxChallengeClient.solve()` → btxd's `solvematmulservicechallenge`. **Server-side / Node only.** Ships v0.0.1.
  - **`mode: 'pure-js'`** — placeholder; throws `not_implemented` with pointer to Day 2.5 work.
  - **`mode: 'auto'`** (default) — picks `'rpc'` if `opts.rpcClient` provided, else `'pure-js'`.
- 10 unit tests cover dispatch (rpc / pure-js / auto), error propagation, default mode behavior
- Integration test for full `issue → Solver.solve(rpc) → redeem` lifecycle — **gated on `BTX_INTEGRATION_NODE_DEDICATED=1`** (see "deployment note" below)

#### Day 2 deployment finding

btxd's `solvematmulservicechallenge` RPC shares matmul backend with block mining. On any mining-loaded node (our entire fleet), the solve RPC takes 15+ minutes — direct SSH-piped measurement on btx-iowa 2026-05-20 ran 900s before btx-cli's own transient-error timeout fired. Solver users MUST point at a dedicated non-mining btxd (e.g., $5/mo DO droplet with `gen=0`). Documented in README. Day 2.5 pure-JS solver removes this constraint for browser clients.

#### Added (Day 1 + Wave A/B/C)

- `BtxChallengeClient` wrapping 6 service-challenges RPCs (`issue`, `verify`, `redeem`, `verifyBatch`, `redeemBatch`, `solve`) + low-level `call()` escape hatch
- Typed envelope shapes: `Challenge`, `ChallengeBinding`, `ChallengeMatmul`, `ChallengePayload`, `ChallengeProofPolicy`
- Error taxonomy: `BtxRpcError`, `BtxHttpError`, `BtxParseError`, `BtxTimeoutError`, `BtxNetworkError`
- `Solver` namespace stub (throws `not_implemented`; real impl Day 2)
- pnpm workspace structure: `packages/core` ships as `@btx/challenges-sdk`
- Dual ESM + CJS build via tsup with proper conditional `exports` ordering (types-first per modern resolver spec)
- Unit tests (msw-mocked HTTP) + integration tests (SSH-to-btxd)
- GitHub Actions CI matrix: Node 18 / 20 / 22

#### Fixed (Day 1 audit findings — addressed all C/H/M-severity items except M4)

- **C1**: replaced `btoa()` with universal `Buffer.from(..., 'utf8').toString('base64')` path; non-ASCII rpcauth credentials no longer crash on every call
- **C2**: added unit-test layer that actually exercises `BtxChallengeClient` (Day 1 only tested btxd-via-SSH, coverage of shipped code was 0%)
- **H1**: `exports` block re-ordered so `types` resolves first; added per-condition `types.import` / `types.require` + `.d.cts` for proper CJS-under-nodenext consumer support
- **H2**: error bodies redact `Authorization: Basic ...` patterns before storage
- **H3**: `res.json()` parse failures normalized to `BtxParseError`
- **H4**: fetch timeout/network errors normalized to `BtxTimeoutError` / `BtxNetworkError`
- **H5**: code comment explaining JSON-RPC `"1.0"` is correct for Bitcoin-family btxd (not `"2.0"` as Ethereum-style)
- **M1**: `Challenge` envelope properly typed (binding, proof_policy, challenge sub-shapes) — needed for Day 2 solver
- **M2**: batch RPCs guard `entries.length` to spec-required 1–256
- **M3**: `IssueParams` no longer hard-codes btxd defaults — unset params are omitted from the call so btxd's own defaults apply (positional args truncated at last set)
- **M5**: README + JSDoc add HTTPS deployment guidance
- **M6**: request IDs use `crypto.randomUUID()` instead of process-local `++counter`
- **M7**: `Solver` export stub added (closes spec drift; Day 2 implements)

#### Deferred

- **M4** (functional companion for tree-shaking) → v0.1 work

### @btx/mcp-gateway

- Scaffold only (Day 1) — real implementation Day 5-6

---

*See `~/Documents/BTX/audits/btx-challenges-sdk-day1-audit-2026-05-20.md` for the full audit report.*
