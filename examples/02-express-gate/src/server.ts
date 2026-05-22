/**
 * Express app with one BTX-gated route.
 *
 * `POST /v1/generate` is fronted by `btxAdmission` from
 * `@btx-tools/middleware-express`. First request without proof headers gets a
 * 402 + a challenge envelope; the client solves it and retries with proof
 * headers; the gate calls `redeem` and admits the second request.
 *
 * CORS is configured so the companion browser example (03-browser-solver)
 * can fetch this gate from a different origin. The `X-BTX-Challenge`
 * response header is in `exposedHeaders` so the browser can read it back.
 *
 * Run: `pnpm start:server` (after editing .env)
 */

import cors from 'cors';
import express from 'express';
import type { ErrorRequestHandler } from 'express';

import { BtxChallengeClient } from '@btx-tools/challenges-sdk';
import { btxAdmission, HEADER_CHALLENGE } from '@btx-tools/middleware-express';

const RPC_URL = process.env.BTX_RPC_URL ?? 'http://127.0.0.1:19334';
const RPC_AUTH = process.env.BTX_RPC_AUTH ?? '';
const PORT = Number(process.env.PORT ?? 3000);
const CORS_ORIGIN = (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',');

const [user, pass] = RPC_AUTH.split(':');
if (!user || !pass) {
  console.error('error: BTX_RPC_AUTH must be of the form "user:pass" (see .env.example)');
  process.exit(1);
}

const client = new BtxChallengeClient({
  rpcUrl: RPC_URL,
  rpcAuth: { user, pass },
  timeoutMs: 60_000,
});

const app = express();

// CORS must come BEFORE the JSON parser so preflight (OPTIONS) responds with
// the right headers. The BTX headers are custom, so allowedHeaders + exposed-
// Headers are both required for browser callers to see them.
app.use(
  cors({
    origin: CORS_ORIGIN,
    allowedHeaders: [
      'content-type',
      'x-btx-challenge',
      'x-btx-challenge-id',
      'x-btx-proof-nonce',
      'x-btx-proof-digest',
    ],
    exposedHeaders: ['x-btx-challenge'],
  }),
);
app.use(express.json());

app.post(
  '/v1/generate',
  btxAdmission({
    client,
    purpose: 'ai_inference_gate',
    resource: (req) =>
      `model:${(req.body?.model as string | undefined) ?? 'unknown'}|route:${req.path}`,
    subject: (req) =>
      `tenant:${(req.body?.tenant_id as string | undefined) ?? 'anonymous'}`,
    issueParams: {
      // Floor difficulty so the example completes in ~7-10 min pure-JS.
      target_solve_time_s: 0.001,
      min_solve_time_s: 0.001,
      expires_in_s: 1800,
    },
    onAdmit: (req, result) => {
      console.log(
        `[ADMIT] ${req.method} ${req.path} reason=${result.reason} redeemed=${result.redeemed ?? '-'}`,
      );
    },
    onError: (err, req) => {
      console.error(
        `[ERROR] ${req.method} ${req.path}:`,
        err instanceof Error ? err.message : err,
      );
    },
  }),
  (req, res) => {
    // Admitted. req.btx.result is the redeem VerifyResult.
    res.json({
      ok: true,
      generated: 'pretend this is the model output',
      admitted_via: req.btx?.result.reason,
    });
  },
);

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    routes: ['POST /v1/generate (BTX-gated)'],
    challenge_header: HEADER_CHALLENGE,
  });
});

// Sanitized error handler. NEVER expose `err.message` directly — BTX errors
// can carry the btxd RPC URL or other server-internal details that you don't
// want leaking to clients. Log them server-side, return an opaque 500.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[500] internal error:', err instanceof Error ? err.stack : err);
  res.status(500).json({ error: 'internal_error' });
};
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`gate listening on http://127.0.0.1:${PORT}`);
  console.log(`POST http://127.0.0.1:${PORT}/v1/generate to trigger the BTX challenge flow`);
});
