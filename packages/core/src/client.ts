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
  return body
    .replace(/authorization\s*:\s*basic\s+[A-Za-z0-9+/=]+/gi, 'authorization: basic [REDACTED]')
    .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"[REDACTED]"')
    .replace(/"rpcpassword"\s*:\s*"[^"]*"/gi, '"rpcpassword":"[REDACTED]"')
    .replace(/\b(rpc(?:user|password|auth))\s*=\s*\S+/gi, '$1=[REDACTED]');
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
    params: unknown[] = [],
    opts?: RpcCallOpts,
  ): Promise<T> {
    const retry = this.opts.retry ?? { max: 0 };
    // H-1 (audit 2026-05-23): clamp non-integer / negative / NaN to ≥0 so the
    // loop runs at least once and `lastErr` is never thrown undefined.
    const maxRetries = Math.max(0, Math.floor(Number(retry.max) || 0));
    const baseDelayMs = retry.baseDelayMs ?? 500;
    let lastErr: unknown;

    // Fast-path: caller's signal already aborted before we did any work.
    // 0.2.0: AbortSignal plumbing per mcp-gateway audit MED-8.
    if (opts?.signal?.aborted) {
      throw new BtxNetworkError(new CallerAbortError(), method);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // M-2: cap exponential backoff at 60s so a high `max` doesn't schedule
        // a retry past the process lifetime.
        const rawDelay = baseDelayMs * Math.pow(2, attempt - 1);
        const delay = Math.min(rawDelay, MAX_RETRY_DELAY_MS);
        // M-3: jitter — not security-sensitive; Math.random is appropriate here
        // (matches the nextRequestId fallback convention per audit A-3).
        const jittered = retry.jitter ? delay + Math.random() * baseDelayMs : delay;
        try {
          // 0.2.0: backoff sleep honors external abort signal — caller-cancel
          // mid-retry exits the loop without sending another request.
          await abortableDelay(jittered, opts?.signal);
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
    params: unknown[],
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const id = nextRequestId();
    const auth = 'Basic ' + base64Utf8(`${this.opts.rpcAuth.user}:${this.opts.rpcAuth.pass}`);
    // JSON-RPC "1.0" is correct for Bitcoin-family btxd (NOT 2.0 as Ethereum-style uses).
    // See btxd src/rpc/server.cpp + httprpc.cpp. Do not "fix" to 2.0 — btxd will reject.
    const body = JSON.stringify({ jsonrpc: '1.0', id, method, params });

    const ctrl = new AbortController();
    // D-4: per-method override → client-wide → 30s default.
    // M-1 (audit 2026-05-23): values ≤ 0 are treated as "no override" — fall
    // through to the next layer. A literal 0 from methodTimeouts would
    // otherwise mean "instant abort", which is almost certainly not what the
    // caller wanted.
    const perMethod = this.opts.methodTimeouts?.[method];
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

    if (data.error) {
      throw new BtxRpcError(data.error.code, data.error.message, method);
    }
    return data.result;
  }

  /**
   * Issue a fresh challenge bound to (purpose, resource, subject).
   * `opts.signal` (added 0.2.0) cancels the request if the caller aborts.
   */
  async issue(params: IssueParams, opts?: RpcCallOpts): Promise<Challenge> {
    // Per audit M3: do NOT hardcode btxd defaults. Truncate positional args at
    // the last explicitly-set value so btxd applies its own defaults for omitted ones.
    const ordered: Array<[string, unknown]> = [
      ['purpose', params.purpose],
      ['resource', params.resource],
      ['subject', params.subject],
      ['target_solve_time_s', params.target_solve_time_s],
      ['expires_in_s', params.expires_in_s],
      ['validation_overhead_s', params.validation_overhead_s],
      ['propagation_overhead_s', params.propagation_overhead_s],
      ['difficulty_policy', params.difficulty_policy],
      ['difficulty_window_blocks', params.difficulty_window_blocks],
      ['min_solve_time_s', params.min_solve_time_s],
      ['max_solve_time_s', params.max_solve_time_s],
      ['solver_parallelism', params.solver_parallelism],
      ['solver_duty_cycle_pct', params.solver_duty_cycle_pct],
    ];
    let lastSet = 2; // purpose, resource, subject are required
    for (let i = ordered.length - 1; i > 2; i--) {
      if (ordered[i]![1] !== undefined) {
        lastSet = i;
        break;
      }
    }
    const args = ordered.slice(0, lastSet + 1).map(([, v]) => v);
    return this.call<Challenge>('getmatmulservicechallenge', args, opts);
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
