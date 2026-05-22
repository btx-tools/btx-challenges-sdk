# 01-basic-roundtrip

Minimal Node example showing the full BTX service-challenge lifecycle, end-to-end:

```
client.issue() → Solver.solve() → client.redeem() → VerifyResult { valid: true, reason: 'ok' }
```

Demonstrates both solving modes:

- **pure-JS** — works against any reachable btxd, including mining-loaded ones. Slow (~7-10 min on an M-series Mac at floor difficulty) because BigInt-backed matmul is several orders of magnitude slower than btxd's native solver.
- **RPC** — delegates solving to btxd via `solvematmulservicechallenge`. Fast (~3s on a dedicated non-mining btxd). Skipped unless `BTX_RPC_URL_DEDICATED` is set.

## Prereqs

- Node ≥ 18.17
- A reachable btxd with the service-challenge RPCs (`v0.30.1`+). If your own btxd doesn't expose them, point at any other one over an SSH tunnel: `ssh -L 19334:127.0.0.1:19334 <host>`.

## Install + run

```bash
pnpm install                # at the repo root, once
cp .env.example .env        # then edit BTX_RPC_URL and BTX_RPC_AUTH
pnpm start
```

## What you'll see

```
--- RPC mode SKIPPED (BTX_RPC_URL_DEDICATED unset) ---
--- pure-JS mode ---
[issue] challenge_id=2a4b1c8e9d7f3a01... in 0.42s
[solve] starting pure-JS solve (this can take 7-10 min on an M-series Mac)...
[solve] nonce=0123456789abcdef digest=fedcba9876543210... in ~3850s (mean)
[redeem] valid=true reason=ok redeemed=true
[redeem] completed in 0.18s
```

If `BTX_RPC_URL_DEDICATED` is set, you'll see an RPC-mode section run first (~3s on a dedicated non-mining btxd) followed by the pure-JS section. You can Ctrl+C after RPC if you don't want to wait for pure-JS.

**Pure-JS perf reality**: at btxd's floor difficulty, expected attempts to find a valid nonce ≈ 770. Each attempt is ~5s on an M-series Mac (BigInt-bound). Mean wall-clock ≈ **~1 hour** (geometric distribution; observed range 7 min to 2 hr in audit runs). See [`../../BROWSER-PERF-FINDINGS-2026-05-23.md`](../../BROWSER-PERF-FINDINGS-2026-05-23.md) for the full perf breakdown + WASM-defer decision.

## How it works

1. `client.issue(...)` calls btxd's `getmatmulservicechallenge` RPC. The result is a `Challenge` envelope binding the challenge to a `(purpose, resource, subject)` trio plus a chain anchor.
2. `Solver.solve(challenge, { mode })` does the matmul proof-of-work. In `'pure-js'` mode, it runs locally in TypeScript; in `'rpc'` mode, it delegates to btxd. Either way it returns `{ nonce64_hex, digest_hex, proof }`.
3. `client.redeem(challenge, nonce, digest)` calls `redeemmatmulserviceproof`, which atomically verifies AND consumes the challenge. Replay-protection is built in — a second `redeem()` of the same proof returns `valid: false, reason: 'already_redeemed'`.

## Why floor difficulty?

The example sets `target_solve_time_s: 0.001 + min_solve_time_s: 0.001` so the demo completes in a reasonable wall-clock. Production deployments should pick a `target_solve_time_s` that matches their compute budget (1.0s is a common starting point) and rely on btxd's adaptive difficulty.

## Next

- See [`../02-express-gate`](../02-express-gate) for the same lifecycle wrapped in an Express middleware (`btxAdmission`).
- See [`../03-browser-solver`](../03-browser-solver) for a browser-side variant using a Web Worker.

## Troubleshooting

If `pnpm start` errors with `help: unknown command: getmatmulservicechallenge`, your btxd predates the service-challenge RPCs — upgrade to v0.30.1+.

If the pure-JS solve never returns, the matmul work is CPU-bound — confirm the process is actually using a core (`top` shows ~100% on Node) rather than hung on RPC I/O.

More entries in [`../../TROUBLESHOOTING.md`](../../TROUBLESHOOTING.md).
