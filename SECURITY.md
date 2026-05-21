# Security policy

## Supported versions

This SDK is in 0.0.x — pre-release. **All 0.0.x versions are in active development**; please report vulnerabilities against any version. We will publish patches as 0.0.x or 0.1.x increments as appropriate.

| Version | Status |
|---|---|
| 0.0.x | Active development; report all findings |
| 0.1.x and later | Will be added here as released |

## Reporting a vulnerability

**Please do not file public GitHub issues for security findings.** Email reports to:

**`visitor@friction.market`**

Include:
- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept if available)
- Any suggested mitigation
- Whether you'd like credit in the disclosure

## Response process

- **Acknowledgement**: within 72 hours of report
- **Scoped triage** (severity + tentative fix timeline): within 1 week
- **Patch + coordinated disclosure**: timeline depends on severity; we'll work with reporters on responsible disclosure windows

## Scope

This SDK wraps btxd's service-challenge RPCs and implements a pure-JS matmul-pow solver. In-scope security findings include:

- Credential exposure (rpcauth handling, error redaction)
- Algorithm correctness bugs in the matmul-pow port (cross-validated against btxd goldens, but undiscovered bugs are possible)
- HTTP / JSON-RPC parsing vulnerabilities
- Supply-chain concerns (deps, build pipeline, npm publish flow)
- Replay-attack or proof-forgery vectors

**Out of scope** (report upstream):
- Vulnerabilities in btxd itself — report to `github.com/btxchain/btx`
- Vulnerabilities in `@noble/hashes` — report to `github.com/paulmillr/noble-hashes`
- General Node.js / TypeScript / npm ecosystem issues

## Known unverified surfaces (0.0.1)

Documented in `CHANGELOG.md` under `[0.0.1]` "Known limitations":

- Live HTTP-loop integration tests are present in `tests/integration/` but not yet run end-to-end against a dedicated non-mining btxd. Algorithm correctness is validated at the unit level via 5 byte-equal golden vectors lifted from btxd's own test suite.
- Pure-JS solver perf is V8-specific (measured on Node 22 / M-series Mac); other engines untested.

## PGP

PGP key not currently published. If you need encrypted reporting, contact the email above and request a PGP key out-of-band.
