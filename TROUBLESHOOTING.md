# `@btx-tools/challenges-sdk` — troubleshooting cookbook

> **Format**: flat list of symptom → fix. Find your error message, jump to the fix. Each entry has an anchor ID (the heading slug) so external docs (like `QUICKSTART-CLAUDE-PACKET.md`) can deep-link.
>
> **Scope**: `@btx-tools/challenges-sdk@0.0.3` + `@btx-tools/middleware-express@0.2.0` (current). When a fix retires (audit item closes in a future version), the entry is amended in place with a "Resolved in X.Y" note rather than deleted, so old StackOverflow links still resolve.

---

## scope-typo — `Cannot find module @btx-tools/challenges-sdk` (or `@btx/...`)

**Symptom**: `npm install @btx/challenges-sdk` fails with "Not Found", or `import` errors with "Cannot find module".

**Root cause**: package was scoped under `@btx-tools/`, NOT `@btx/`. Common typo from older docs.

**Fix**:
```bash
npm uninstall @btx/challenges-sdk @btx/middleware-express 2>/dev/null
npm install @btx-tools/challenges-sdk @btx-tools/middleware-express
```
Update all `import` paths to `@btx-tools/...`.

---

## solver-hangs-on-mining-btxd — `Solver.solve` hangs ~15 min

**Symptom**: `Solver.solve(..., { mode: 'rpc' })` (or `mode: 'auto'` with an rpcClient supplied) returns nothing for 15+ minutes; eventually times out.

**Root cause**: `solvematmulservicechallenge` RPC shares the matmul backend with btxd's block-template solver. On a mining-loaded btxd, your solve call queues behind block work.

**Fix**: either
- (preferred) Point the SDK at a dedicated non-mining btxd (set `gen=0` in btx.conf, or spin a $5/mo DigitalOcean droplet just for this), OR
- Use `mode: 'pure-js'` — solves locally in Node, no btxd-side compute. ~5s per attempt on M-series Mac. No contention.

Memory ref: `feedback_btxd_solver_mining_contention`.

---

## req-btx-result-namespace — `req.btxResult` is `undefined` in 0.2.0

**Symptom**: existing handler that worked in `middleware-express@0.1.x` now sees `req.btxResult` as undefined.

**Root cause**: audit C-3 closed in 0.2.0 as a breaking namespace refactor: `Express.Request.btxResult` → `req.btx.result` (namespaced container avoids global Request-augmentation pollution).

**Fix** (regex-replace across your codebase):
```
req\.btxResult       →  req.btx?.result
req\.btxResult\.foo  →  req.btx?.result?.foo
```
Bump dep to `^0.2.0`. Update typings if you have a custom Express.Request augmentation.

---

## body-parser-ordering — `Cannot read property 'X' of undefined` in `resource(req)` / `subject(req)`

**Symptom**: middleware crashes with "Cannot read property of undefined" inside your `resource: (req) => ...` or `subject: (req) => ...` callback.

**Root cause**: `express.json()` (or `body-parser`) is registered AFTER `btxAdmission`. By the time your callback runs, `req.body` is still unset.

**Fix**: mount `express.json()` first:
```javascript
app.use(express.json());            // ← FIRST
app.post('/v1/generate', btxAdmission({ ... }), handler);
```

---

## reverse-proxy-header-strip — `X-BTX-Challenge` header missing from response

**Symptom**: the 402 response body has `"challenge": {...}` but the `X-BTX-Challenge` response header is empty / stripped.

**Root cause**: your reverse proxy is stripping large response headers. The `X-BTX-Challenge` header carries the full challenge envelope (~3-5 KB). Common defaults are too small.

**Fix**:
- **nginx**: `large_client_header_buffers 4 8k;` in http/server block
- **Caddy**: `header_up Content-Length 8192` (or use a higher `max_request_header_size`)
- **CloudFlare**: free-plan caps response headers at ~16 KB; usually fine. If on a Worker, beware their own limits.
- **AWS ALB**: increase `routing.http.response_header_size_limit` (default 8192 bytes)

Alternative: read `challenge` from the response BODY instead of the header (it's there too).

---

## digest-mismatch-byte-order — proof rejected with `valid:false reason:digest_mismatch`

**Symptom**: live roundtrip with pure-JS solver returns `valid: false, reason: 'digest_mismatch'` even though the test goldens pass.

**Root cause #1**: SDK pre-0.0.2 had a byte-order bug in the noise step (Day 2.5 Step 10). Closed in 0.0.2.

**Fix**: upgrade to `@btx-tools/challenges-sdk@^0.0.2` (or current 0.0.3). Confirm with `npm ls @btx-tools/challenges-sdk`.

**Root cause #2** (still open as audit B-3 / risk 6 at 0.0.3): pure-JS proof shape was algorithm-cross-validated against btxd's pinned goldens (byte-equal) but the full live HTTP roundtrip was characterized in deferred test runs. **If you're hitting this in production on 0.0.3+ and the goldens pass**, you likely have a real bug — file an issue with `challenge_id` and we'll investigate.

Memory ref: `reference_btx_challenges_sdk_repo` Day 2.5 byte-order fix.

---

## help-text-bug — `Internal bug detected: Unreachable code reached`

**Symptom**: `btx-cli help getmatmulservicechallenge` (or any service-challenge RPC `help`) returns an "Unreachable code" panic.

**Root cause**: known btxd v0.29.7 bug in the help-text rendering. The RPC itself works fine — only the `help` shim is broken.

**Fix**: don't use `help` for service-challenge RPCs. Refer to the SDK's TypeScript types in `packages/core/src/types.ts` or the live RPC at btx.dev/docs/rpc/service-challenges. Wait for upstream btxd fix.

---

## client-no-retry — single RPC error breaks `client.issue()` / `.redeem()`

**Symptom**: `BtxChallengeClient.issue()` or `.redeem()` throws on first network blip; no retry.

**Root cause**: audit D-3 open at 0.0.3 — client has no built-in retry/backoff. Will ship in 0.1.x.

**Fix** (until 0.1.x): wrap in caller-side retry with exponential backoff. `p-retry` works well:
```javascript
import pRetry from 'p-retry';
const result = await pRetry(
  () => client.redeem(challenge, nonce, digest),
  { retries: 3, factor: 2, minTimeout: 500 }
);
```

When 0.1.x ships: remove the wrapper; pass `retry: { ... }` to the client constructor.

---

## client-no-per-method-timeout — `Solver.solve` times out before slow methods finish

**Symptom**: `timeoutMs: 30_000` is fine for `issue` (~3 s) but kills slow `solve` calls (~15 s+) prematurely.

**Root cause**: audit D-4 open at 0.0.3 — `timeoutMs` is client-wide, not per-method. Will ship in 0.1.x.

**Fix** (until 0.1.x): set the client-wide timeout to the worst case. Conservative:
- Dedicated non-mining btxd: `timeoutMs: 30_000` (30 s)
- Mining-loaded btxd (RPC mode — avoid if possible): `timeoutMs: 900_000` (15 min)
- Pure-JS solver only: `timeoutMs: 60_000` (60 s) — solve runs locally, no RPC budget needed

When 0.1.x ships: per-method override e.g. `client.solve({ ..., timeoutMs: 60_000 })`.

---

## bun-2x-slower — Bun benchmarks ~2× slower than Node on solve

**Symptom**: same workload runs ~2× slower under Bun than under Node (e.g., 9.8 s vs 4.6 s mean per attempt).

**Root cause**: M31 BigInt-heavy ops are dominated by V8's JIT optimization for BigInt; Bun's JavaScriptCore-derived runtime is slower here. Measured per-attempt mean (0.0.2 cross-engine bench):
- Node 20: **4.6 s**
- Deno: **4.2 s** (~10% faster than Node)
- Bun: **9.8 s** (2.1× slower than Node)

**Fix**: expected. For solver-heavy workloads, prefer Node 20+. Use Bun for the rest of your app if you like; just keep solve workers on Node.

Memory ref: 0.0.2 cross-engine perf characterization.

---

## rpc-auth-401 — `401 Unauthorized` from btxd

**Symptom**: any RPC call returns HTTP 401.

**Root cause**: `rpcAuth.user` / `rpcAuth.pass` don't match btxd's `rpcuser=` / `rpcpassword=` (or `rpcauth=` salted-hash form).

**Fix**:
1. SSH to the btxd host, `grep -E "^rpcuser|^rpcpassword|^rpcauth" /root/.btx/btx.conf`
2. If `rpcauth=user:salt$hash`, the SDK can't authenticate directly with the salted form — you need the original plaintext password. Use `rpcuser` + `rpcpassword` instead during dev.
3. Confirm via `curl`: `curl -u user:pass http://btxd-host:19334/ --data-binary '{"jsonrpc":"1.0","id":"t","method":"getblockcount","params":[]}'` should return JSON.

---

## rpc-econnrefused — `ECONNREFUSED` / `connect: connection refused`

**Symptom**: any RPC call fails with ECONNREFUSED.

**Root cause** (one of):
- btxd not running on the target host
- Wrong port (default RPC is `19334`; do not confuse with P2P `19335`)
- btxd's `rpcbind=` is `127.0.0.1` only and you're trying to connect from off-host
- Firewall / NAT blocking the port
- (vast.ai / container) RPC port not exposed in the container config

**Fix**:
1. `ssh btxd-host 'pgrep -x btxd && ss -tln | grep 19334'` — confirm btxd listening
2. If `rpcbind=127.0.0.1`, either run the SDK on the same host, OR add `rpcbind=0.0.0.0` + `rpcallowip=` lines (with auth), OR set up an SSH tunnel: `ssh -fN -L 19334:127.0.0.1:19334 btxd-host` then point SDK at `http://127.0.0.1:19334/`
3. Verify with curl after the network path works (see rpc-auth-401 entry)

---

## live-integration-skipped — integration tests skipped silently

**Symptom**: `pnpm test:integration` runs but most/all tests show as "skipped".

**Root cause**: integration tests are triple-gated to avoid hammering shared infrastructure or mining-loaded nodes. Required env vars:
- `BTX_INTEGRATION_URL` — e.g. `http://127.0.0.1:19334/`
- `BTX_INTEGRATION_AUTH` — `"user:pass"` format
- `BTX_INTEGRATION_NODE_DEDICATED=1` — explicit ack that the target is a non-mining btxd

**Fix**:
```bash
export BTX_INTEGRATION_URL='http://127.0.0.1:19334/'
export BTX_INTEGRATION_AUTH='miner:your_rpc_password'
export BTX_INTEGRATION_NODE_DEDICATED=1
pnpm test:integration
```

The pure-JS suite takes ~1 hour wall-clock per case at floor difficulty (~770 expected attempts × ~5 s each). Per-test timeout is 75 min. Plan accordingly.

---

## node-version-too-low — engine requirement error

**Symptom**: `npm install` or runtime errors mentioning Node version, e.g. "engine ... required: node >=18.0.0".

**Fix**: upgrade Node to ≥18.0.0. SDK is tested on 18, 20, 22. Use `nvm install 20 && nvm use 20` (or your platform's installer).

---

## See also

- [`QUICKSTART-CLAUDE-PACKET.md`](./QUICKSTART-CLAUDE-PACKET.md) — 30-min onboarding with these entries called out in each phase's Known-issues block
- [`packages/core/README.md`](./packages/core/README.md) — full API reference
- Open audit findings (will retire matching cookbook entries when closed): see `BTX/audits/btx-challenges-sdk-audit-2026-05-22.md`
- GitHub issues: https://github.com/btx-tools/btx-challenges-sdk/issues

## Status of open audit items (entries that will retire)

| Entry | Audit ID | Retires when |
|---|---|---|
| digest-mismatch-byte-order (root cause #2) | B-3 / risk 6 | 0.0.4 ships the live-roundtrip closure validation |
| client-no-retry | D-3 | 0.1.x ships retry/backoff |
| client-no-per-method-timeout | D-4 | 0.1.x ships per-method `timeoutMs` |

**D-1 (middleware no onError hook) was previously listed here** — **closed in `middleware-express@0.2.0`**. Use the `onError(err, req)` hook in `btxAdmission({ onError, ... })`. No workaround needed.
