/**
 * Shared Feishu API retry helpers (#112). Pre-v1.0.37 the scheduler
 * had a proper retry-with-backoff for transient errors (rate-limit,
 * 5xx, network blips), but the HOT-PATH call sites (`reply`,
 * `edit_message`, `react`, ack-reaction `messageReaction.create`)
 * either silently `.catch(() => {})`d everything or threw raw —
 * meaning a Feishu rate-limit (codes 99991663 / 99991400, common
 * in a busy group chat) would either disappear (ack) or trigger
 * a Stop-hook retry storm (reply).
 *
 * This module consolidates the classification + retry logic so both
 * the scheduler and the hot paths share the same definition of
 * "transient" / "permanent" and the same retry harness. The
 * difference is just the delay schedule:
 *   - Scheduler (cronjob context): 30s / 60s / 120s — caller can wait.
 *   - Hot path (user-facing reply): 500ms / 1500ms / 5000ms — user
 *     is in real-time wait; total worst case ~7s.
 */

/** Network/transient error codes that warrant a retry. */
const RETRYABLE_NETWORK_ERRORS = new Set([
  'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
  'ECONNABORTED', 'EAI_AGAIN', 'EPIPE',
]);

/** HTTP status codes that warrant a retry. */
const RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Feishu API error codes indicating a TARGET-CHAT is permanently
 * unreachable from the bot's POV: kicked from group, chat dissolved/
 * archived, no permission to send. These are NOT transient — retrying
 * on the next tick would just fail again forever (#106).
 *
 * - 99991672 — permission denied (also marked non-retryable in isRetryableError)
 * - 230002 / 230020 — chat not found / no permission to message this chat
 * - 9499     — receive_id format invalid / target deactivated
 * - 190005   — chat archived/disabled
 */
export const PERMANENT_TARGET_CODES = new Set<number>([
  99991672,
  230002,
  230020,
  9499,
  190005,
]);

/** Extract a numeric Feishu API code from a thrown error, or null. */
export function getFeishuApiCode(err: any): number | null {
  const code = err?.response?.data?.code ?? err?.data?.code;
  return typeof code === 'number' ? code : null;
}

/** Extract a human-readable Feishu API message from a thrown error. */
export function getFeishuApiMsg(err: any): string {
  return err?.response?.data?.msg ?? err?.data?.msg ?? (err?.message ?? String(err));
}

/**
 * Classify an error as transient (worth retrying) vs permanent. This
 * is the single source of truth shared by the scheduler's retry loop
 * AND the hot-path `withFeishuRetry` wrapper. Behavior:
 *
 *   - Network errors (ENOTFOUND etc.) → retry
 *   - HTTP 429/5xx → retry
 *   - Feishu 99991672 (perm denied) / 230001 (param error) → NO retry
 *   - Feishu 99990000–99999999 generic 9999-class → retry (covers
 *     rate-limit 99991663 / 99991400 / etc.)
 *   - Message containing 'timeout' / 'enotfound' / 'econnreset' → retry
 *   - Anything else → NO retry
 */
export function isRetryableError(err: any): boolean {
  // Network-level errors (Node.js syscall errors)
  if (err?.code && RETRYABLE_NETWORK_ERRORS.has(err.code)) return true;
  if (err?.cause?.code && RETRYABLE_NETWORK_ERRORS.has(err.cause.code)) return true;

  // HTTP status from Feishu SDK (wrapped in response)
  const status = err?.response?.status ?? err?.status;
  if (status && RETRYABLE_HTTP_CODES.has(status)) return true;

  // Feishu API error codes — permission/param errors are NOT retryable.
  // R1-followup: use `!= null` instead of truthy `if (apiCode)` for
  // consistency with the typeof contract elsewhere. (Code 0 is Feishu's
  // success and never throws, but the truthy check would have skipped
  // it differently from a numeric typecheck — tighten regardless.)
  const apiCode = err?.response?.data?.code ?? err?.data?.code;
  if (apiCode != null) {
    // Known non-retryable Feishu codes
    if (apiCode === 99991672 || apiCode === 230001) return false;
    // Other Feishu codes starting with 9999 are usually transient
    if (apiCode >= 99990000 && apiCode < 100000000) return true;
  }

  // Error message heuristics
  const msg = (err?.message ?? '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('enotfound') || msg.includes('econnreset')) {
    return true;
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default delays for hot-path retries (#112). Short on purpose — the
 * user is waiting in real time for the reply to land. Total worst case
 * is 500 + 1500 + 5000 = 7000ms across 3 retries; if Feishu is still
 * rate-limiting after that, the throw propagates and the caller
 * surfaces the error.
 *
 * Scheduler keeps its own 30/60/120s schedule (cronjob async, can wait).
 *
 * **Aggregate budget note (R1-followup)**: this is the PER-CALL budget,
 * not per-tool-invocation. A multi-chunk reply (e.g. 5 text chunks)
 * makes 5 separate `withFeishuRetry` calls; if every chunk hits the
 * rate-limit, total wall-clock is 5 × 7s = 35s. Acceptable for the
 * pathological case (sustained rate-limit is rare; the operator's fix
 * is to slow inbound traffic or request a Feishu QPS bump). A
 * future optimization could share a budget across chunks via a
 * caller-supplied AbortController, but that adds complexity for a
 * corner case.
 */
export const HOT_PATH_RETRY_DELAYS_MS = [500, 1500, 5000];

export interface WithFeishuRetryOptions {
  /** Delay schedule in ms. One entry per retry attempt. */
  delays?: number[];
  /** Label for debug logs. */
  label?: string;
  /** Logger for retry breadcrumbs. Defaults to a no-op. */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/**
 * Retry harness for hot-path Feishu calls. Returns the operation's
 * resolved value on success; rethrows the LAST error on exhaustion or
 * the first permanent-classification error. Caller controls the
 * delay schedule (see {@link HOT_PATH_RETRY_DELAYS_MS} default).
 *
 * Number of attempts = `1 + delays.length` (initial + retries).
 *
 * Permanent errors short-circuit (no further attempts) so a `230002
 * chat not found` doesn't burn 3 retries.
 */
export async function withFeishuRetry<T>(
  op: () => Promise<T>,
  opts: WithFeishuRetryOptions = {},
): Promise<T> {
  const delays = opts.delays ?? HOT_PATH_RETRY_DELAYS_MS;
  const maxAttempts = delays.length;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryableError(err)) {
        throw err;
      }
      const delay = delays[attempt];
      // R1-followup: onRetry is a breadcrumb, not a circuit-breaker.
      // If a callback throws (e.g. operator-injected logger fails), it
      // must not abandon the retry loop — the API error is what the
      // caller cares about. Swallow callback failures silently; logging
      // them would risk recursion if the failing onRetry IS the logger.
      try {
        opts.onRetry?.(attempt + 1, delay, err);
      } catch {
        // ignore
      }
      await sleep(delay);
    }
  }
  // Unreachable — loop above either returns or throws.
  throw lastErr;
}
