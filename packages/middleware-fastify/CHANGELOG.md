# Changelog — @btx-tools/middleware-fastify

All notable changes documented here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) + [SemVer](https://semver.org/).

## [Unreleased]

(no entries yet)

## [0.1.0] - 2026-05-23

First public release. Fastify-ecosystem peer of `@btx-tools/middleware-express` — same stateless echo-the-challenge flow, ported to Fastify's preHandler hook + reply API.

### Added

- `btxAdmission(opts)` factory returning a Fastify `preHandlerAsyncHookHandler`
- Header constants: `HEADER_CHALLENGE`, `HEADER_CHALLENGE_ID`, `HEADER_PROOF_NONCE`, `HEADER_PROOF_DIGEST` (lowercased, per Fastify normalization)
- `FastifyRequest.btx?.result: VerifyResult` type augmentation via `declare module 'fastify'`
- `BtxAdmissionOpts`:
  - `purpose` / `resource` / `subject` — static strings or `(req) => string` resolvers
  - `issueParams` — extra options forwarded to `client.issue()` (e.g., `target_solve_time_s`)
  - `onAdmit(req, result)` — fires on successful admission
  - `onError(err, req)` — fires when `client.issue()` or `client.redeem()` throws (audit D-1 parity with middleware-express 0.2.0)
  - `isProofPresent(req)` — predicate override
- 16 unit tests via Fastify's built-in `inject` (light-my-request)

### Peer dependencies

- `@btx-tools/challenges-sdk ^0.0.4`
- `fastify ^4.0.0 || ^5.0.0`

### Design notes

- Per-route registration via `{ preHandler: btxAdmission(opts) }` (not a global plugin) — keeps the admission scope explicit at each gated route.
- Header names normalized to lowercase to match Fastify's incoming-header conventions.
- Stateless: server never stores issued challenges. The challenge JSON (~3-5 KB) rides in the `X-BTX-Challenge` header on retry. Check your reverse-proxy header-size limits.
- Errors thrown from the preHandler bubble through Fastify's standard error-handling pipeline.
