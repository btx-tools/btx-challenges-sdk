# `@btx-tools/challenges-sdk` quickstart — Claude-driven onboarding packet

> **For the LLM (Claude or similar) reading this**: this document is structured for you to drive a developer through a 30-minute end-to-end integration. Follow the phases in order. Read the **Tone** and **Audience** blocks before responding to anything.

---

## Audience

You are talking to a **developer integrating BTX service challenges into a Node.js app**. They have:

- npm and a Mac/Linux terminal
- General familiarity with Express middleware
- **Possibly NOT** a BTX node running locally — you'll help them point at a remote one or skip

What they don't necessarily have:
- Crypto/blockchain background — don't assume they know what "shielded address" or "matmul backend" means; explain in passing if relevant
- A BTX wallet, miner setup, or any other BTX context — service challenges are server-side, no wallet needed

## Goal

`npm install` → **first successful challenge solve + verify against a live btxd** in **30 minutes**, with an Express server that gates one route on a BTX service challenge.

**Time budget**: 30 minutes across 5 phases. If a phase blows past 2× its budget, see "Escalate to a human" at the bottom.

## Tone (instructions for Claude)

- **Terse + technical + paste-friendly**. This is a developer, not a layperson. No fluff, no analogies, no "great question!" preamble.
- **Confirm at phase boundaries**. After each phase completes, ask the user "phase N done, ready for phase N+1?" — but no narration during a phase.
- **Use the embedded paste-blocks verbatim**. They are version-pinned and tested. Don't rewrite from scratch; if the user needs a variant, edit the block in-place and explain the diff.
- **When the user pastes an error**, first check the Known-issues block of the current phase. Don't speculate.
- **Surface known caveats inline** — don't wait for the user to hit them. e.g. "Phase 3 will hang if your btxd is mining; switch targets first."

## Versions this packet targets

- `@btx-tools/challenges-sdk@0.0.3`
- `@btx-tools/middleware-express@0.2.0`
- btxd `v0.29.7` (the pinned upstream version with the matmul service-challenge RPCs)
- Node ≥18 (CI tested on 18, 20, 22)

If the user is on different SDK versions, **upgrade them first** — earlier versions had the breaking `req.btxResult → req.btx.result` rename (0.1.x → 0.2.0, audit finding C-3) and a byte-order bug in the matmul solver (closed 0.0.2 Day 2.5). The cookbook at [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) entry "scope-typo" handles the `@btx/` → `@btx-tools/` mistake explicitly.

---

## Phase 0 — Prereqs (5 min)

### What we're checking

```bash
node --version          # expect v18.x or higher
npm --version           # expect 9.x or higher (or pnpm 8+, yarn 1+)
```

### btxd target

The SDK talks to a btxd over HTTP-RPC. Three viable target shapes:

| Setup | When to use | Risk |
|---|---|---|
| **A. Dedicated btxd you control** (DigitalOcean droplet, local Docker, etc.) | Production / serious dev | None |
| **B. Shared dev btxd from someone else** | Quick eval, no infra | Rate-limited; check with operator |
| **C. Mining-loaded btxd** (e.g. an actual mining rental's btxd) | **AVOID for Phase 3** | RPC mode `solve` queues 15+ min behind the mining solver |

**Critical**: if the user only has option C available, push them to switch to A. Pure-JS solve mode in Phase 3 works on a mining btxd, but RPC mode does NOT.

### Known issues — Phase 0

- **Node 16 EOL**: not supported. CI dropped 16 in 0.0.2. Force upgrade.
- **WSL**: works but `node --version` sometimes reports the Windows-side node; verify with `which node`.
- **Corporate proxy**: if `npm install` fails with ECONNRESET, set `npm config set proxy http://...`.

---

## Phase 1 — Install + smoke test (5 min)

### Install

```bash
mkdir my-btx-app && cd my-btx-app
npm init -y
npm install @btx-tools/challenges-sdk@^0.0.3 @btx-tools/middleware-express@^0.2.0 express
```

**Watch for**:
- If they paste a command with `@btx/challenges-sdk` (missing `-tools`): the package was renamed. Correct to `@btx-tools/challenges-sdk`. See cookbook entry **scope-typo**.

### Smoke test the RPC client

Create `smoke.mjs`:

```javascript
import { BtxChallengeClient } from '@btx-tools/challenges-sdk';

const client = new BtxChallengeClient({
  rpcUrl: process.env.BTX_RPC_URL || 'http://127.0.0.1:19334/',
  rpcAuth: {
    user: process.env.BTX_RPC_USER || 'rpcuser',
    pass: process.env.BTX_RPC_PASS || 'rpcpass',
  },
  timeoutMs: 30_000,
});

const challenge = await client.issue({
  purpose: 'rate_limit',
  resource: 'smoke:/v1/test',
  subject: 'tenant:smoke',
  target_solve_time_s: 0.001,
  min_solve_time_s: 0.001,
  expires_in_s: 120,
});

console.log('challenge_id:', challenge.challenge_id);
console.log('purpose:', challenge.binding.purpose);
console.log('expires_in_s:', challenge.expires_in_s);
```

Run:

```bash
BTX_RPC_URL='http://YOUR-BTXD:19334/' \
BTX_RPC_USER='YOUR_USER' \
BTX_RPC_PASS='YOUR_PASS' \
node smoke.mjs
```

**Success state**: you see a `challenge_id` printed in <5s.

### Known issues — Phase 1

- **401 Unauthorized**: rpcauth mismatch. Confirm `rpcuser=` and `rpcpassword=` in the btxd's `btx.conf`. Cookbook entry **rpc-auth-401**.
- **ECONNREFUSED**: btxd not running, wrong port, or firewalled. btxd's default RPC port is `19334`. Cookbook entry **rpc-econnrefused**.
- **`getmatmulservicechallenge` returns "Internal bug detected: Unreachable"** ONLY when calling `btx-cli help getmatmulservicechallenge` — known btxd v0.29.7 bug. The actual RPC works fine. Ignore.

---

## Phase 2 — Hook `middleware-express` into a sample app (10 min)

### App scaffold

```javascript
// app.mjs
import express from 'express';
import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
import { btxAdmission } from '@btx-tools/middleware-express';

const client = new BtxChallengeClient({
  rpcUrl: process.env.BTX_RPC_URL,
  rpcAuth: {
    user: process.env.BTX_RPC_USER,
    pass: process.env.BTX_RPC_PASS,
  },
  timeoutMs: 30_000,
});

const app = express();
app.use(express.json());        // ← MUST be BEFORE btxAdmission if you use req.body in resource()/subject()

app.post('/v1/generate',
  btxAdmission({
    client,
    purpose: 'ai_inference_gate',
    resource: (req) => `model:${req.body?.model ?? 'unknown'}|route:${req.path}`,
    subject: (req) => `tenant:${req.body?.tenant_id ?? 'anon'}`,
    issueParams: { target_solve_time_s: 0.5, expires_in_s: 60 },
    onError: (err, req) => {
      // 0.2.0 — observability hook. Don't mutate err or res. Just log.
      console.error('[btx admission error]', err.message, 'on', req.path);
    },
    onAdmit: (req, result) => {
      console.log('[btx admitted]', result.reason, 'for', req.path);
    },
  }),
  (req, res) => {
    // 0.2.0 namespace: req.btx.result (was req.btxResult in 0.1.x)
    res.json({ ok: true, admitted_by: req.btx?.result?.reason });
  },
);

app.listen(3000, () => console.log('listening on http://127.0.0.1:3000'));
```

```bash
node app.mjs
```

### First-request behavior

A first POST returns 402 Payment Required with the challenge in a response header. The client is expected to solve it and retry. We'll do that in Phase 3.

Test it:

```bash
curl -i -X POST http://127.0.0.1:3000/v1/generate \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-test","tenant_id":"alice"}'
```

**Success state**: status `402`, body contains `"challenge"`, response header `X-BTX-Challenge` is present.

### Known issues — Phase 2

- **`req.btxResult` is undefined**: this was renamed to **`req.btx.result`** in 0.2.0 (audit finding C-3). Upgrade existing code with a global regex replace. Cookbook entry **req-btx-result-namespace**.
- **`Cannot read property 'model' of undefined`** in `resource(req)`: `express.json()` is registered AFTER `btxAdmission`. Move it before. Cookbook entry **body-parser-ordering**.
- **`X-BTX-Challenge` header missing in response**: reverse proxy (nginx/Caddy/CF) is stripping it. The header carries the full ~3-5 KB challenge envelope; the proxy must allow large response headers. Cookbook entry **reverse-proxy-header-strip**.
- **Errors disappear into Express's default handler**: use the `onError` hook (0.2.0+) to observe `client.issue()`/`.redeem()` failures. Logger of your choice goes in there.

---

## Phase 3 — Solve a challenge end-to-end (5 min)

### Add a client-side solver

`client.mjs`:

```javascript
import { BtxChallengeClient, Solver } from '@btx-tools/challenges-sdk';

const URL = 'http://127.0.0.1:3000/v1/generate';
const body = JSON.stringify({ model: 'gpt-test', tenant_id: 'alice' });

// Step 1: initial request → expect 402
const r1 = await fetch(URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
});
if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}`);

const { challenge } = await r1.json();
console.log('got challenge:', challenge.challenge_id);

// Step 2: solve locally (pure-JS — no btxd needed on the client side)
const proof = await Solver.solve(challenge, { mode: 'pure-js', pureJs: { maxTries: 5000 } });
console.log('solved: nonce=', proof.nonce64_hex.slice(0, 8) + '...');

// Step 3: retry with proof headers
const r2 = await fetch(URL, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'X-BTX-Challenge': JSON.stringify(challenge),
    'X-BTX-Proof-Nonce': proof.nonce64_hex,
    'X-BTX-Proof-Digest': proof.digest_hex,
  },
  body,
});

console.log('retry status:', r2.status);
console.log('body:', await r2.text());
```

Run:

```bash
node client.mjs
```

**Success state**: `retry status: 200` + body like `{"ok":true,"admitted_by":"ok"}`.

### Pure-JS vs RPC solve modes

| Mode | Where solving happens | When to use |
|---|---|---|
| `mode: 'pure-js'` | In the Node.js client process | Always for clients; works in browsers via Web Worker |
| `mode: 'rpc'` | btxd does the solving via `solvematmulservicechallenge` RPC | Server-side bulk, ONLY against a dedicated non-mining btxd |
| `mode: 'auto'` | pure-js if no rpcClient supplied, else rpc | Library default — leave alone unless you know |

### Known issues — Phase 3

- **`Solver.solve` hangs for 15+ minutes**: you used `mode: 'rpc'` against a mining-loaded btxd. The solver shares the matmul backend with mining; the call queues. Switch to `mode: 'pure-js'` or point at a dedicated btxd. Cookbook entry **solver-hangs-on-mining-btxd**.
- **No retry/backoff in client** (audit finding D-3, open until 0.1.x): if the btxd RPC blips, your `client.issue()` / `.redeem()` calls throw on first try. Wrap in your own retry until 0.1.x ships. Cookbook entry **client-no-retry**.
- **`timeoutMs` is client-wide, not per-method** (D-4, open until 0.1.x): solver calls (slow) share the same budget as issue/redeem (fast). Set generously (15 min) if you need RPC solve mode. Cookbook entry **client-no-per-method-timeout**.
- **Proof rejected with `digest_mismatch`**: pure-JS solver had a byte-order bug pre-0.0.2 Day 2.5; ensure you're on `>=0.0.2`. Cookbook entry **digest-mismatch-byte-order**.

---

## Phase 4 — Verify against btxd goldens (5 min)

The SDK ships 5 pinned golden test vectors lifted byte-equal from btxd's own `src/test/matmul_*_tests.cpp` (`tests/unit/matmul/btxd-vectors.test.ts`). These cross-validate the pure-JS matmul against the C++ reference.

```bash
cd node_modules/@btx-tools/challenges-sdk
npm test:unit -- -t 'matmul'    # or pnpm equivalent
```

**Success state**: golden vectors all pass.

**If a golden fails**: you're either (a) on a pre-0.0.2 SDK with the byte-order bug, or (b) someone (you?) modified the SDK locally. Reinstall from clean npm.

### Pure-JS proof-shape live roundtrip — current status

As of 0.0.3 (2026-05-22), the pure-JS solver's algorithm is **cross-validated byte-equal** against btxd's golden vectors but the **live HTTP roundtrip** with a JS-solved proof has been characterized in deferred test runs (~1 hr wall-clock per attempt; audit B-3 / risk 6). It WILL work — the algorithm is byte-equal — but if you're production-launching, do one cross-check yourself: issue a challenge, solve in pure-JS, submit to redeem, expect `valid: true`. The integration test at `packages/core/tests/integration/solve-redeem.test.ts` is the template.

If you hit `valid: false reason: digest_mismatch` on the live path despite golden vectors passing, ping us — that would be a real bug.

### Known issues — Phase 4

- **Golden vectors hang**: vitest worker pool. Run with `--pool=forks` if it doesn't terminate.
- **`Internal bug detected: Unreachable code reached`**: you called `btx-cli help getmatmulservicechallenge` on btxd 0.29.7. Known btxd bug; the RPC itself is fine. Cookbook entry **help-text-bug**.

---

## What success looks like

- ✅ Phase 1: smoke.mjs prints a `challenge_id` in <5s
- ✅ Phase 2: app responds 402 with `X-BTX-Challenge` header on first POST
- ✅ Phase 3: client.mjs second request returns 200 + `admitted_by: ok`
- ✅ Phase 4: golden vector tests pass

If all 4 are green, the user has a working BTX-gated Express route. From here:
- **Deploy** their app as usual; the SDK is stateless
- **Scale horizontally** without sticky routing (the SDK echoes the challenge back, no server-side store)
- **Tune** `target_solve_time_s` (current default 0.001 = floor; raise for higher unit cost per request)
- **Add their real handler** behind `btxAdmission(...)` — `req.btx.result` is populated with the redeem result

## Escalate to a human

Hand off if any of these fire:

- The user wants to deploy on a non-Node runtime (Bun is 2.1× slower on solve per the 0.0.2 cross-engine bench; Deno parity-ish; serverless TBD)
- They need WASM-accelerated solver (deferred to 1.0.x; currently pure-JS BigInt only)
- They need `mcp-gateway` integration (currently scaffolded at 0.0.1; production-ready in Phase 4 of the SDK roadmap)
- They hit a `valid: false reason: digest_mismatch` on the live roundtrip despite golden vectors passing — that's audit B-3 in action; file an issue with the challenge_id and we'll investigate

**Escalation channels**:
- GitHub issues: https://github.com/btx-tools/btx-challenges-sdk/issues
- Security: see SECURITY.md (`visitor@friction.market`)
- General BTX dev: https://btx.dev/develop/

## See also

- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — flat symptom→fix cookbook for the issues called out in each phase's Known-issues block
- [`packages/core/README.md`](./packages/core/README.md) — core API reference
- [`packages/middleware-express/README.md`](./packages/middleware-express/README.md) — middleware-specific docs
