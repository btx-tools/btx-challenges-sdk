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
  type SolverOutput,
  type VerifyResult,
} from './types.js';

interface JsonRpcResponse<T> {
  result: T;
  error: { code: number; message: string } | null;
  id: number | string;
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
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const retry = this.opts.retry ?? { max: 0 };
    const baseDelayMs = retry.baseDelayMs ?? 500;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= retry.max; attempt++) {
      if (attempt > 0) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        const jittered = retry.jitter ? delay + Math.random() * baseDelayMs : delay;
        await new Promise((resolve) => setTimeout(resolve, jittered));
      }
      try {
        return await this.callOnce<T>(method, params);
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
  private async callOnce<T>(method: string, params: unknown[]): Promise<T> {
    const id = nextRequestId();
    const auth = 'Basic ' + base64Utf8(`${this.opts.rpcAuth.user}:${this.opts.rpcAuth.pass}`);
    // JSON-RPC "1.0" is correct for Bitcoin-family btxd (NOT 2.0 as Ethereum-style uses).
    // See btxd src/rpc/server.cpp + httprpc.cpp. Do not "fix" to 2.0 — btxd will reject.
    const body = JSON.stringify({ jsonrpc: '1.0', id, method, params });

    const ctrl = new AbortController();
    // D-4: per-method override → client-wide → 30s default
    const timeoutMs = this.opts.methodTimeouts?.[method] ?? this.opts.timeoutMs ?? 30_000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

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
      // AbortError on timeout vs everything else (DNS, TCP reset, TLS, etc.)
      if (err instanceof Error && err.name === 'AbortError') {
        throw new BtxTimeoutError(timeoutMs, method);
      }
      throw new BtxNetworkError(err, method);
    } finally {
      clearTimeout(timer);
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

  /** Issue a fresh challenge bound to (purpose, resource, subject). */
  async issue(params: IssueParams): Promise<Challenge> {
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
    return this.call<Challenge>('getmatmulservicechallenge', args);
  }

  /**
   * Verify a proof statelessly. Does NOT consume the challenge.
   * Use this for diagnostic / monitoring paths.
   * For admission control, use {@link redeem} instead — verification alone
   * does not prevent replay.
   */
  async verify(
    challenge: Challenge,
    nonce64_hex: string,
    digest_hex: string,
    lookup_local_status = true,
  ): Promise<VerifyResult> {
    return this.call<VerifyResult>('verifymatmulserviceproof', [
      challenge,
      nonce64_hex,
      digest_hex,
      lookup_local_status,
    ]);
  }

  /**
   * Verify-and-consume atomically. THIS is the admission control entry point.
   * On success, the challenge is marked redeemed and cannot be replayed.
   */
  async redeem(
    challenge: Challenge,
    nonce64_hex: string,
    digest_hex: string,
  ): Promise<VerifyResult> {
    return this.call<VerifyResult>('redeemmatmulserviceproof', [
      challenge,
      nonce64_hex,
      digest_hex,
    ]);
  }

  /** Batch verify. Spec range 1–256 (audit M2). No consumption. */
  async verifyBatch(entries: BatchEntry[]): Promise<BatchResult> {
    this.assertBatchSize(entries);
    return this.call<BatchResult>('verifymatmulserviceproofs', [entries]);
  }

  /** Batch verify + consume. Sequential per-entry. Spec range 1–256 (audit M2). */
  async redeemBatch(entries: BatchEntry[]): Promise<BatchResult> {
    this.assertBatchSize(entries);
    return this.call<BatchResult>('redeemmatmulserviceproofs', [entries]);
  }

  /**
   * Server-side local solver. Useful when generating fixtures or pre-computing
   * for tests. For production browser-side solving, ship the WASM solver —
   * RPC-based solving puts compute load on YOUR node, defeating the point.
   */
  async solve(challenge: Challenge): Promise<SolverOutput> {
    return this.call<SolverOutput>('solvematmulservicechallenge', [challenge]);
  }

  private assertBatchSize(entries: BatchEntry[]): void {
    if (entries.length < 1 || entries.length > 256) {
      throw new RangeError(
        `Batch size must be between 1 and 256 (per BTX RPC spec), got ${entries.length}`,
      );
    }
  }
}
