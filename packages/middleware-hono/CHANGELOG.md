# Changelog — @btx-tools/middleware-hono

All notable changes documented here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) + [SemVer](https://semver.org/).

## [Unreleased]

(no entries yet)

## [0.1.0] - 2026-05-23

First public release. Hono-ecosystem peer of `@btx-tools/middleware-express` and `@btx-tools/middleware-fastify` — same stateless echo-the-challenge flow, ported to Hono's middleware model + `c.set()/c.get()` variables. Works on Node, Deno, Bun, **Cloudflare Workers**, and other edge runtimes Hono targets.

### Added

- `btxAdmission(opts)` factory returning a Hono `MiddlewareHandler`
- Header constants: `HEADER_CHALLENGE`, `HEADER_CHALLENGE_ID`, `HEADER_PROOF_NONCE`, `HEADER_PROOF_DIGEST` (lowercased per Web Headers conventions)
- `BtxAdmissionVariables` type — used as `new Hono<{ Variables: BtxAdmissionVariables }>()` for `c.get('btx')` type narrowing
- `BtxAdmissionOpts`:
  - `purpose` / `resource` / `subject` — static strings, sync resolvers, or async resolvers (supports `await c.req.json()` cases)
  - `issueParams` — extra options forwarded to `client.issue()`
  - `onAdmit(c, result)` — fires on successful admission
  - `onError(err, c)` — fires when `client.issue()` or `client.redeem()` throws (audit D-1 parity)
  - `isProofPresent(c)` — predicate override
- 16 unit tests via Hono's `app.request()` (Web fetch API)

### Peer dependencies

- `@btx-tools/challenges-sdk ^0.0.4`
- `hono ^4.0.0`

### Edge-runtime notes

- Works on Cloudflare Workers, Deno Deploy, Bun, Vercel Edge (with header-size caveat for large challenges — see README).
- `BtxChallengeClient` uses `fetch()` which is the native networking primitive on all targeted runtimes.

### Design notes

- Per-route registration via `app.post(path, btxAdmission(opts), handler)`.
- Stateless: server never stores issued challenges.
- Errors thrown from the middleware bubble through `app.onError()`.
