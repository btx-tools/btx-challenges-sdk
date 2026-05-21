# Changelog

All notable changes to `@btx-tools/middleware-express` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) + [SemVer](https://semver.org/).

## [Unreleased]

(no entries yet)

## [0.2.0] - 2026-05-22 (BREAKING)

Audit-resolution release. Resolves findings C-2, C-3, D-1, A-5, G-1 from `BTX/audits/btx-challenges-sdk-audit-2026-05-22.md`.

### ⚠️ Breaking change (C-3)

`Express.Request.btxResult` → `req.btx.result`. The 0.1.x flat field augmented `Express.Request` globally; the 0.2.0 namespaced version is scoped to `req.btx` and won't collide with other middleware.

```diff
- console.log(req.btxResult?.reason);
+ console.log(req.btx?.result.reason);
```

If you don't read `req.btxResult` in your handlers, no migration needed.

### Added

- **D-1**: `BtxAdmissionOpts.onError?: (err: unknown, req: Request) => void` — observability hook fired once when `client.issue()` or `client.redeem()` throws, before `next(err)` runs. Use for logging/APM. 3 new unit tests cover the hook.
- **G-1**: `"sideEffects": false` in package.json for better bundler tree-shaking.
- **C-2**: README API table documents `isProofPresent`.
- **A-5**: README "Error handling" section warns about exposing server-internal error details via Express's default error handler; recommends a custom sanitized handler.

### Tests

15 → 18 unit tests (3 new for `onError` hook + namespace updates throughout).

## [0.1.0] - 2026-05-22

First usable release of the Express adapter for `@btx-tools/challenges-sdk`.

### Added

- `btxAdmission(opts)` — Express `RequestHandler` factory that issues + redeems BTX service challenges around any route. Stateless echo-the-challenge flow (`X-BTX-Challenge` header carries the challenge JSON on retry).
- Exported header constants: `HEADER_CHALLENGE`, `HEADER_CHALLENGE_ID`, `HEADER_PROOF_NONCE`, `HEADER_PROOF_DIGEST`.
- `BtxAdmissionOpts` interface with `client`, `purpose`, `resource`, `subject` (string or callable), `issueParams`, `onAdmit`, `isProofPresent`.
- `Express.Request.btxResult` type augmentation — downstream handlers get the redeem `VerifyResult`.
- Unit tests (~16) covering: 402 issue path, 200 admit path, 403 reject paths (`invalid_proof` + `already_redeemed`), 400 bad-request paths (missing/malformed challenge header, id mismatch), error propagation via `next(err)`, `isProofPresent` override, callable opts, `issueParams` forwarding, `onAdmit` hook.
- Tested against Express 5 + supertest; peer-dep range `^4 || ^5`.

### Notes

- Stateful challenge-store variant (`btxAdmission({ store })`) deferred to a future minor.
- Fastify + Hono adapters tracked as `@btx-tools/middleware-fastify@0.1.x` + `@btx-tools/middleware-hono@0.1.x`.
