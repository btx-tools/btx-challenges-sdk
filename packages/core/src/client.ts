import {
  BtxHttpError,
  BtxNetworkError,
  BtxParseError,
  BtxRpcError,
  BtxTimeoutError,
  type BatchEntry,
  type BatchResult,
  type BtxClientOpts,
  type Challenge,
  type IssueParams,
  type RpcCallOpts,
  type SolverOutput,
  type VerifyResult,
} from './types.js';

interface JsonRpcResponse<T> {
  result: T;
  error: { code: number; message: string } | null;
  id: number | string;
}

/**
 * Upper bound for a single retry delay (per audit M-2, 2026-05-23). At
 * `attempt=N`, the raw exponential delay is `baseDelayMs * 2^(N-1)` — without
 * a cap, large `retry.max` values schedule delays past the process lifetime.
 * 60s gives ample time for transient server-side recovery without absurd
 * waits.
 */
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Consume-style RPCs that are NOT idempotent — retrying them after a *lost
 * response* (the proof was already consumed btxd-side) returns
 * `already_redeemed → valid:false` and would wrongly deny a caller who actually
 * solved (audit M-2). These methods never auto-retry, regardless of `retry.max`.
 */
const NON_IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  'redeemmatmulserviceproof',
  'redeemmatmulserviceproofs',
]);

/** Hard cap on an RPC response body (audit L-2). RPC responses are small (KB);
 * this bounds a hostile/buggy endpoint streaming a huge body. Best-effort via
 * Content-Length (absent on chunked → wall-clock timeout still bounds it). */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Semantic shortcut keys for {@link BtxClientOpts.methodTimeouts} → raw btxd RPC
 * method names (audit L-4, 0.3.0). Lets callers write `{ solve: 1_000_000 }`
 * instead of the verbose `{ solvematmulservicechallenge: 1_000_000 }`. A raw
 * method key always takes precedence over its semantic alias.
 */
// Null-prototype (audit L-1) so a lookup with an inherited key like
// `__proto__` / `constructor` returns `undefined`, not an Object.prototype
// member — keeps the `aliasKey !== undefined` guard sound for any method name.
const SEMANTIC_TIMEOUT_ALIAS: Readonly<Record<string, string>> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    getmatmulservicechallenge: 'issue',
    verifymatmulserviceproof: 'verify',
    redeemmatmulserviceproof: 'redeem',
    verifymatmulserviceproofs: 'verifyBatch',
    redeemmatmulserviceproofs: 'redeemBatch',
    solvematmulservicechallenge: 'solve',
  },
);

/**
 * Sentinel error thrown internally when an external AbortSignal fires. Caught
 * at the public-method boundary and rethrown as {@link BtxNetworkError} so
 * callers see a documented error type. Added 0.2.0.
 */
class CallerAbortError extends Error {
  constructor() {
    super('aborted by caller');
    this.name = 'CallerAbortError';
  }
}

/**
 * Abortable setTimeout. Resolves after `ms`; rejects with CallerAbortError
 * if `signal` fires during the wait. Added 0.2.0.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CallerAbortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new CallerAbortError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Universal UTF-8-safe base64 encoder.
 * Both Node 18.17+ and browsers expose `globalThis.crypto`, but `btoa()`
 * throws on any code point > 0xFF — so we route via TextEncoder for non-ASCII safety.
 * Per audit finding C1.
 */
function base64Utf8(input: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'utf8').toString('base64');
  }
  // Browser fallback: encode UTF-8 manually so btoa() only sees byte-clean Latin1.
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

/**
 * Redact sensitive header + credential patterns from error response bodies
 * before storing them on `BtxHttpError.body` (which callers commonly log).
 *
 * Covers:
 *   - Authorization header echoes from proxies / debug endpoints (H2)
 *   - JSON `"password"` / `"rpcpassword"` fields
 *   - Config-line `rpcuser=...` / `rpcpassword=...` from btxd's loadincludeconf
 *     error paths (re-audit N2 — added 2026-05-20)
 */
function redactSensitive(body: string): string {
  return (
    body
      .replace(/authorization\s*:\s*basic\s+[A-Za-z0-9+/=]+/gi, 'authorization: basic [REDACTED]')
      // L-1 (audit 2026-05-24): also redact Bearer tokens (token-auth proxies).
      .replace(/authorization\s*:\s*bearer\s+[\w.\-+/=]+/gi, 'authorization: bearer [REDACTED]')
      .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"[REDACTED]"')
      .replace(/"rpcpassword"\s*:\s*"[^"]*"/gi, '"rpcpassword":"[REDACTED]"')
      // L-1: config-line secrets — match a quoted value ("a b") OR a bare token,
      // so a value with spaces (`rpcpassword="hunter2 with space"`) is fully
      // redacted (the old `\S+` stopped at the first space). Adds passphrase/authkey
      // (called out as secret patterns in the global instructions).
      .replace(
        /\b(rpc(?:user|password|auth)|passphrase|authkey|wallet_pass)\s*=\s*("[^"]*"|\S+)/gi,
        '$1=[REDACTED]',
      )
  );
}

/** Generate a stable-uniqueness request id without colliding across instances. */
function nextRequestId(): string {
  // Both Node 18.17+ and modern browsers expose globalThis.crypto.randomUUID.
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Last-resort fallback. NOT a security context — this id is sent as the
  // JSON-RPC `id` field, echoed by btxd, and used only for client-side
  // response correlation. `Math.random` is appropriate here (uniqueness, not
  // unpredictability). btxd doesn't authenticate against this value.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * JSON-RPC client for BTX service-challenges.
 *
 * **Prerequisite — this points at a reachable BTX node (`btxd`).** There is no
 * default or hosted endpoint; `rpcUrl` is a `btxd` you (or a shared operator)
 * run. Who needs a node:
 *   - **The service provider** (the gate) — for `issue` / `verify` / `redeem`.
 *     These are lightweight; any synced btxd serves them fast.
 *   - **Whoever solves** the challenge — for `solve` via `'rpc'` mode, that node
 *     must be **non-mining** (a mining node queues the solver behind block work,
 *     10+ min). The caller can instead solve in-process with the pure-JS
 *     {@link Solver} (no node, but minutes-to-hours at production difficulty).
 * In short: the *server* always needs node access; *callers* need it too only
 * for fast solving — which is why the strongest fit is server-to-server / agent
 * gating, where both ends are infrastructure. See {@link Solver}.
 *
 * Wraps the 5 core RPCs:
 *   - getmatmulservicechallenge   (issue)
 *   - verifymatmulserviceproof    (verify, stateless)
 *   - redeemmatmulserviceproof    (verify + consume, anti-replay)
 *   - verifymatmulserviceproofs   (batch verify)
 *   - redeemmatmulserviceproofs   (batch redeem)
 *
 * Plus helper RPCs:
 *   - solvematmulservicechallenge (server-side solver — for fixtures + tests)
 *
 * RPC reference: https://btx.dev/docs/rpc/service-challenges
 *
 * Error model:
 *   - {@link BtxRpcError}     — btxd returned a JSON-RPC error envelope
 *   - {@link BtxHttpError}    — non-2xx HTTP status
 *   - {@link BtxParseError}   — 2xx but body wasn't valid JSON
 *   - {@link BtxTimeoutError} — request exceeded `timeoutMs`
 *   - {@link BtxNetworkError} — DNS / TCP / TLS-level failure
 *   - All extend {@link BtxError}.
 */
export class BtxChallengeClient {
  constructor(private readonly opts: BtxClientOpts) {}

  /**
   * Low-level: raw JSON-RPC call. Exposed for forward compatibility.
   *
   * Honors {@link BtxClientOpts.methodTimeouts} (per-method override, audit D-4)
   * and {@link BtxClientOpts.retry} (exponential backoff on transient failures,
   * audit D-3). Both are opt-in via constructor options; default behavior is
   * unchanged from 0.0.4 (30s single-attempt).
   */
  async call<T = unknown>(
    method: string,
    // Array (positional) or object (named) JSON-RPC params. `issue()` uses the
    // named form (audit H-3) so omitted optional params are truly absent.
    params: unknown[] | Record<string, unknown> = [],
    opts?: RpcCallOpts,
  ): Promise<T> {
    const retry = this.opts.retry ?? { max: 0 };
    // H-1 (audit 2026-05-23): clamp non-integer / negative / NaN to ≥0 so the
    // loop runs at least once and `lastErr` is never thrown undefined.
    // M-2 (audit 2026-05-24): consume-style RPCs never auto-retry — a retry after
    // a lost response gets `already_redeemed` and would wrongly deny a payer.
    const maxRetries = NON_IDEMPOTENT_METHODS.has(method)
      ? 0
      : Math.max(0, Math.floor(Number(retry.max) || 0));
    const baseDelayMs = retry.baseDelayMs ?? 500;
    let lastErr: unknown;

    // Fast-path: caller's signal already aborted before we did any work.
    // 0.2.0: AbortSignal plumbing per mcp-gateway audit MED-8.
    if (opts?.signal?.aborted) {
      throw new BtxNetworkError(new CallerAbortError(), method);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // M-2: cap exponential backoff so a high `max` doesn't schedule a retry
        // past the process lifetime.
        const rawDelay = baseDelayMs * Math.pow(2, attempt - 1);
        const cappedBase = Math.min(rawDelay, MAX_RETRY_DELAY_MS);
        // M-3: jitter — not security-sensitive; Math.random is appropriate here
        // (matches the nextRequestId fallback convention per audit A-3).
        const jittered = retry.jitter ? cappedBase + Math.random() * baseDelayMs : cappedBase;
        // L-2 (0.3.1): cap AFTER jitter so the actual delay slept — and the value
        // reported to onRetry — never exceeds MAX_RETRY_DELAY_MS, matching the
        // documented "capped at 60s" (jitter previously could push it over).
        const delay = Math.min(jittered, MAX_RETRY_DELAY_MS);
        // L-3 (0.3.0): observability hook — fired before the backoff sleep with
        // the exact delay about to be slept and the retryable error that
        // triggered this retry. `attempt` is 1-indexed (1 = first retry).
        retry.onRetry?.(attempt, lastErr, delay);
        try {
          // 0.2.0: backoff sleep honors external abort signal — caller-cancel
          // mid-retry exits the loop without sending another request.
          await abortableDelay(delay, opts?.signal);
        } catch (err) {
          if (err instanceof CallerAbortError) {
            throw new BtxNetworkError(err, method);
          }
          throw err;
        }
      }
      try {
        return await this.callOnce<T>(method, params, opts?.signal);
      } catch (err) {
        lastErr = err;
        if (!this.isRetryable(err)) throw err;
      }
    }
    throw lastErr;
  }

  /**
   * Predicate: should this error trigger a retry?
   *
   * Retryable (transient):
   *   - {@link BtxNetworkError} — DNS / TCP / TLS / connection drop
   *   - {@link BtxHttpError} with status ≥ 500 — server overloaded / restarting
   *
   * NOT retryable (deterministic):
   *   - {@link BtxTimeoutError} — caller's per-attempt budget exceeded; another attempt won't help
   *   - {@link BtxRpcError} — btxd returned a structured JSON-RPC error envelope
   *   - {@link BtxParseError} — body was non-JSON; will be non-JSON again
   *   - {@link BtxHttpError} with status < 500 — 4xx is a client error
   */
  private isRetryable(err: unknown): boolean {
    if (err instanceof BtxNetworkError) return true;
    if (err instanceof BtxHttpError) return err.status >= 500;
    return false;
  }

  /** Single attempt of the JSON-RPC call (no retry wrapping). */
  private async callOnce<T>(
    method: string,
    params: unknown[] | Record<string, unknown>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const id = nextRequestId();
    const auth = 'Basic ' + base64Utf8(`${this.opts.rpcAuth.user}:${this.opts.rpcAuth.pass}`);
    // JSON-RPC "1.0" is correct for Bitcoin-family btxd (NOT 2.0 as Ethereum-style uses).
    // See btxd src/rpc/server.cpp + httprpc.cpp. Do not "fix" to 2.0 — btxd will reject.
    const body = JSON.stringify({ jsonrpc: '1.0', id, method, params });

    const ctrl = new AbortController();
    // D-4: per-method override → client-wide → 30s default.
    // L-4 (0.3.0): the override key may be the raw RPC method name OR a semantic
    // alias (e.g. `solve` for `solvematmulservicechallenge`). The raw method key
    // wins over the alias (more specific); each falls through if absent.
    // M-1 (audit 2026-05-23): values ≤ 0 are treated as "no override" — fall
    // through to the next layer. A literal 0 from methodTimeouts would
    // otherwise mean "instant abort", which is almost certainly not what the
    // caller wanted.
    const perMethodRaw = this.opts.methodTimeouts?.[method];
    const aliasKey = SEMANTIC_TIMEOUT_ALIAS[method];
    const perMethodAlias =
      aliasKey !== undefined ? this.opts.methodTimeouts?.[aliasKey] : undefined;
    const perMethod =
      perMethodRaw !== undefined && perMethodRaw > 0 ? perMethodRaw : perMethodAlias;
    const timeoutMs =
      perMethod !== undefined && perMethod > 0
        ? perMethod
        : this.opts.timeoutMs !== undefined && this.opts.timeoutMs > 0
          ? this.opts.timeoutMs
          : 30_000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    // 0.2.0: compose external caller signal with the internal timeout
    // controller. When EITHER fires, fetch aborts. Pre-check is for the case
    // where the caller aborted between `call()` entry and `callOnce()` — we
    // surface a CallerAbortError before paying for a fetch.
    let onExtAbort: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        throw new BtxNetworkError(new CallerAbortError(), method);
      }
      onExtAbort = (): void => ctrl.abort();
      externalSignal.addEventListener('abort', onExtAbort, { once: true });
    }

    let res: Response;
    try {
      res = await fetch(this.opts.rpcUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: auth,
        },
        body,
        signal: ctrl.signal,
        // V-2 (audit 2026-05-24): a legitimate btxd JSON-RPC POST never 3xx-
        // redirects; fail closed rather than chase an attacker-controlled redirect.
        redirect: 'error',
      });
    } catch (err) {
      clearTimeout(timer);
      if (onExtAbort && externalSignal) {
        externalSignal.removeEventListener('abort', onExtAbort);
      }
      // AbortError can be: (a) internal timeout fired, (b) external caller
      // signal fired. Disambiguate via externalSignal.aborted. Order matters:
      // check external first because both signals may be aborted by the time
      // we land here (timeout + caller-cancel both within the same tick).
      if (err instanceof Error && err.name === 'AbortError') {
        if (externalSignal?.aborted) {
          throw new BtxNetworkError(new CallerAbortError(), method);
        }
        throw new BtxTimeoutError(timeoutMs, method);
      }
      throw new BtxNetworkError(err, method);
    } finally {
      clearTimeout(timer);
      if (onExtAbort && externalSignal) {
        externalSignal.removeEventListener('abort', onExtAbort);
      }
    }

    // L-2 (audit 2026-05-24): reject an oversized body before reading it into
    // memory (best-effort — Content-Length is absent on chunked, where the
    // request timeout still bounds wall-clock).
    const contentLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new BtxParseError(
        new Error(`response too large: ${contentLength} bytes > ${MAX_RESPONSE_BYTES}`),
        '',
        method,
      );
    }

    if (!res.ok) {
      const rawBody = await res.text().catch(() => '');
      throw new BtxHttpError(res.status, redactSensitive(rawBody), method);
    }

    const rawBody = await res.text();
    let data: JsonRpcResponse<T>;
    try {
      data = JSON.parse(rawBody) as JsonRpcResponse<T>;
    } catch (err) {
      throw new BtxParseError(err, redactSensitive(rawBody), method);
    }

    // M-6 (audit 2026-05-24): validate the JSON-RPC error envelope defensively.
    // A truthy-but-malformed `error` (`true`, `"boom"`, `42`) would otherwise
    // throw BtxRpcError(undefined, undefined) and defeat callers branching on
    // `err.code`. A well-formed object → BtxRpcError; truthy-but-malformed →
    // BtxParseError. Entry stays a TRUTHY check (not `!== null`) so a falsy
    // `error` (`null`/absent/`false`/`0`/`""`) is treated as success exactly as
    // before — only a present, non-empty error is inspected (audit-pass LOW).
    if (data.error) {
      const e = data.error as { code?: unknown; message?: unknown };
      if (typeof e === 'object' && ('code' in e || 'message' in e)) {
        throw new BtxRpcError(
          typeof e.code === 'number' ? e.code : -1,
          typeof e.message === 'string' ? e.message : 'unknown rpc error',
          method,
        );
      }
      throw new BtxParseError(
        new Error('malformed JSON-RPC error envelope'),
        redactSensitive(rawBody),
        method,
      );
    }

    // V-1 (audit 2026-05-24): considered asserting `data.id === id` for
    // response correlation, but NOT enforced — JSON-RPC over HTTP is strictly
    // 1:1 (no realistic mismatch path), and btxd/proxies don't uniformly echo
    // the id verbatim (some normalize string→int or return null), so a hard
    // check would risk false-positives that break every call. The `id` is still
    // sent for server-side logging.
    return data.result;
  }

  /**
   * Issue a fresh challenge bound to (purpose, resource, subject).
   * `opts.signal` (added 0.2.0) cancels the request if the caller aborts.
   */
  async issue(params: IssueParams, opts?: RpcCallOpts): Promise<Challenge> {
    // Audit H-3: use NAMED (object) JSON-RPC params. The old positional form
    // serialized any *skipped middle* param as an explicit `null` (e.g. setting
    // max_solve_time_s but not target_solve_time_s), which btxd treats very
    // differently from an absent arg (type error / clobbered default). With
    // named params, only the keys actually set are sent — omitted ones are truly
    // absent, so btxd applies its own defaults (the original intent). Bitcoin-
    // family btxd accepts object params on JSON-RPC 1.0.
    const named: Record<string, unknown> = {
      purpose: params.purpose,
      resource: params.resource,
      subject: params.subject,
    };
    const optional: Array<keyof IssueParams> = [
      'target_solve_time_s',
      'expires_in_s',
      'validation_overhead_s',
      'propagation_overhead_s',
      'difficulty_policy',
      'difficulty_window_blocks',
      'min_solve_time_s',
      'max_solve_time_s',
      'solver_parallelism',
      'solver_duty_cycle_pct',
    ];
    for (const key of optional) {
      if (params[key] !== undefined) named[key] = params[key];
    }
    return this.call<Challenge>('getmatmulservicechallenge', named, opts);
  }

  /**
   * Verify a proof statelessly. Does NOT consume the challenge.
   * Use this for diagnostic / monitoring paths.
   * For admission control, use {@link redeem} instead — verification alone
   * does not prevent replay.
   *
   * `opts.signal` (added 0.2.0) cancels the request if the caller aborts.
   */
  async verify(
    challenge: Challenge,
    nonce64_hex: string,
    digest_hex: string,
    lookup_local_status = true,
    opts?: RpcCallOpts,
  ): Promise<VerifyResult> {
    return this.call<VerifyResult>(
      'verifymatmulserviceproof',
      [challenge, nonce64_hex, digest_hex, lookup_local_status],
      opts,
    );
  }

  /**
   * Verify-and-consume atomically. THIS is the admission control entry point.
   * On success, the challenge is marked redeemed and cannot be replayed.
   *
   * `opts.signal` (added 0.2.0) cancels the request if the caller aborts —
   * but note: if the abort fires AFTER btxd has consumed the challenge,
   * the redemption stands (atomic) even though the local promise rejects.
   * Callers handling cancellation must treat post-abort state as "may have
   * been consumed" and verify via a separate `verify()` call if needed.
   */
  async redeem(
    challenge: Challenge,
    nonce64_hex: string,
    digest_hex: string,
    opts?: RpcCallOpts,
  ): Promise<VerifyResult> {
    return this.call<VerifyResult>(
      'redeemmatmulserviceproof',
      [challenge, nonce64_hex, digest_hex],
      opts,
    );
  }

  /**
   * Batch verify. Spec range 1–256 (audit M2). No consumption.
   * `opts.signal` (added 0.2.0) cancels the request if the caller aborts.
   */
  async verifyBatch(entries: BatchEntry[], opts?: RpcCallOpts): Promise<BatchResult> {
    this.assertBatchSize(entries);
    return this.call<BatchResult>('verifymatmulserviceproofs', [entries], opts);
  }

  /**
   * Batch verify + consume. Sequential per-entry. Spec range 1–256 (audit M2).
   * `opts.signal` (added 0.2.0) cancels the request if the caller aborts.
   * Same post-abort caveat as {@link redeem} — partial batch may have been
   * consumed by btxd before the abort propagated.
   */
  async redeemBatch(entries: BatchEntry[], opts?: RpcCallOpts): Promise<BatchResult> {
    this.assertBatchSize(entries);
    return this.call<BatchResult>('redeemmatmulserviceproofs', [entries], opts);
  }

  /**
   * Server-side local solver. Useful when generating fixtures or pre-computing
   * for tests. For production browser-side solving, ship the WASM solver —
   * RPC-based solving puts compute load on YOUR node, defeating the point.
   *
   * `opts.signal` (added 0.2.0) cancels the request if the caller aborts.
   */
  async solve(challenge: Challenge, opts?: RpcCallOpts): Promise<SolverOutput> {
    return this.call<SolverOutput>('solvematmulservicechallenge', [challenge], opts);
  }

  private assertBatchSize(entries: BatchEntry[]): void {
    if (entries.length < 1 || entries.length > 256) {
      throw new RangeError(
        `Batch size must be between 1 and 256 (per BTX RPC spec), got ${entries.length}`,
      );
    }
  }
}
