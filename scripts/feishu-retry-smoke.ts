/**
 * Feishu retry smoke test (v1.0.37, closes #112).
 *
 * Directly exercises `isRetryableError` (classification) + `withFeishuRetry`
 * (retry harness). The wired call sites in channel.ts / tools.ts are
 * trivial wrappers; their behavior follows from the helper's correctness.
 */
import {
  isRetryableError,
  withFeishuRetry,
  PERMANENT_TARGET_CODES,
  getFeishuApiCode,
  getFeishuApiMsg,
  HOT_PATH_RETRY_DELAYS_MS,
} from '../src/feishu-retry.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function feishuErr(code: number, msg = 'mock'): Error {
  const err: any = new Error(`Feishu API [${code}]: ${msg}`);
  err.response = { data: { code, msg } };
  return err;
}

let testNum = 0;

// ─── Part A: isRetryableError classification ───────────────────────

// 1. Rate-limit codes (99991400 / 99991663) → retry
{
  if (!isRetryableError(feishuErr(99991400))) fail(`1: 99991400 rate-limit should retry`);
  if (!isRetryableError(feishuErr(99991663))) fail(`1: 99991663 rate-limit should retry`);
  testNum++;
}

// 2. Permanent target codes → NO retry (caller should defer-and-give-up)
{
  for (const code of PERMANENT_TARGET_CODES) {
    if (code === 99991672) continue; // covered by explicit non-retryable check below
    if (isRetryableError(feishuErr(code))) {
      fail(`2: permanent target ${code} should NOT retry`);
    }
  }
  // 99991672 explicitly listed as non-retryable in the helper.
  if (isRetryableError(feishuErr(99991672))) fail(`2: 99991672 perm denied should NOT retry`);
  testNum++;
}

// 3. Param error 230001 → NO retry
{
  if (isRetryableError(feishuErr(230001))) fail(`3: 230001 param error should NOT retry`);
  testNum++;
}

// 4. HTTP 429 / 5xx → retry
{
  const make = (status: number) => {
    const e: any = new Error(`HTTP ${status}`);
    e.response = { status };
    return e;
  };
  for (const status of [429, 500, 502, 503, 504]) {
    if (!isRetryableError(make(status))) fail(`4: HTTP ${status} should retry`);
  }
  testNum++;
}

// 5. HTTP 4xx (non-429) → NO retry
{
  const make = (status: number) => {
    const e: any = new Error(`HTTP ${status}`);
    e.response = { status };
    return e;
  };
  for (const status of [400, 401, 403, 404, 422]) {
    if (isRetryableError(make(status))) fail(`5: HTTP ${status} should NOT retry`);
  }
  testNum++;
}

// 6. Network errors → retry (code on root + on cause)
{
  const make = (code: string) => Object.assign(new Error('socket'), { code });
  for (const code of ['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED']) {
    if (!isRetryableError(make(code))) fail(`6: ${code} should retry`);
  }
  // cause.code (wrapped error)
  const wrapped = Object.assign(new Error('wrapped'), {
    cause: Object.assign(new Error('inner'), { code: 'ETIMEDOUT' }),
  });
  if (!isRetryableError(wrapped)) fail(`6: cause.code ETIMEDOUT should retry`);
  testNum++;
}

// 7. Message heuristics — "timeout" / "enotfound" / "econnreset"
{
  if (!isRetryableError(new Error('Request timeout after 30s'))) {
    fail(`7: message containing 'timeout' should retry`);
  }
  if (!isRetryableError(new Error('ECONNRESET'))) {
    fail(`7: message containing 'ECONNRESET' should retry`);
  }
  testNum++;
}

// 8. Generic error (no code, no shape) → NO retry
{
  if (isRetryableError(new Error('something arbitrary'))) {
    fail(`8: unclassified error should NOT retry`);
  }
  if (isRetryableError({})) fail(`8: {} should NOT retry`);
  if (isRetryableError(null)) fail(`8: null should NOT retry`);
  testNum++;
}

// 9. Other 9999xxxx codes (not in non-retryable list) → retry
{
  if (!isRetryableError(feishuErr(99990001))) fail(`9: 99990001 should retry`);
  if (!isRetryableError(feishuErr(99995555))) fail(`9: 99995555 should retry`);
  if (!isRetryableError(feishuErr(99999999))) fail(`9: 99999999 should retry`);
  testNum++;
}

// ─── Part B: getFeishuApiCode / getFeishuApiMsg ────────────────────

// 10. getFeishuApiCode extracts numeric code, returns null otherwise
{
  if (getFeishuApiCode(feishuErr(230002)) !== 230002) fail(`10: extract 230002`);
  if (getFeishuApiCode(new Error('plain')) !== null) fail(`10: plain error → null`);
  if (getFeishuApiCode(null) !== null) fail(`10: null → null`);
  testNum++;
}

// 11. getFeishuApiMsg returns Feishu msg if present, falls back to message
{
  if (getFeishuApiMsg(feishuErr(230002, 'chat not found')) !== 'chat not found') {
    fail(`11: extract Feishu msg`);
  }
  if (getFeishuApiMsg(new Error('socket EPIPE')) !== 'socket EPIPE') {
    fail(`11: fallback to .message`);
  }
  testNum++;
}

// ─── Part C: withFeishuRetry harness ───────────────────────────────

// 12. Success on first attempt → returned value, no delay observed
{
  let calls = 0;
  const r = await withFeishuRetry(async () => {
    calls++;
    return 'ok';
  });
  if (r !== 'ok') fail(`12: return value`);
  if (calls !== 1) fail(`12: only 1 attempt expected, got ${calls}`);
  testNum++;
}

// 13. Permanent error on first attempt → throws immediately, no retry
{
  let calls = 0;
  let threw = false;
  try {
    await withFeishuRetry(async () => {
      calls++;
      throw feishuErr(230002, 'chat not found');
    });
  } catch (e: any) {
    threw = true;
    if (!e.response?.data?.code) fail(`13: original error must propagate`);
  }
  if (!threw) fail(`13: must throw on permanent error`);
  if (calls !== 1) fail(`13: permanent error should not retry, got ${calls} calls`);
  testNum++;
}

// 14. Transient → eventually succeeds → returns value
{
  let calls = 0;
  const r = await withFeishuRetry(
    async () => {
      calls++;
      if (calls < 3) throw feishuErr(99991400, 'rate limit');
      return 'eventually-ok';
    },
    { delays: [1, 1, 1] }, // ~3ms total — keep test fast
  );
  if (r !== 'eventually-ok') fail(`14: should return after retries succeeded`);
  if (calls !== 3) fail(`14: expected 3 calls (initial + 2 retries), got ${calls}`);
  testNum++;
}

// 15. Transient → exhausts retries → throws LAST error
{
  let calls = 0;
  let threw: any = null;
  try {
    await withFeishuRetry(
      async () => {
        calls++;
        throw feishuErr(99991400, `attempt ${calls}`);
      },
      { delays: [1, 1, 1] },
    );
  } catch (e) {
    threw = e;
  }
  if (!threw) fail(`15: must throw after exhausting`);
  if (calls !== 4) fail(`15: expected 4 calls (1 initial + 3 retries), got ${calls}`);
  if (getFeishuApiMsg(threw) !== 'attempt 4') {
    fail(`15: last error should propagate, got ${getFeishuApiMsg(threw)}`);
  }
  testNum++;
}

// 16. onRetry callback fires for each retry with attempt + delay + err
{
  const breadcrumbs: { attempt: number; delayMs: number }[] = [];
  let calls = 0;
  await withFeishuRetry(
    async () => {
      calls++;
      if (calls < 3) throw feishuErr(99991400);
      return 'ok';
    },
    {
      delays: [10, 20, 30],
      onRetry: (attempt, delayMs) => breadcrumbs.push({ attempt, delayMs }),
    },
  );
  if (breadcrumbs.length !== 2) fail(`16: expected 2 retry breadcrumbs, got ${breadcrumbs.length}`);
  if (breadcrumbs[0].attempt !== 1 || breadcrumbs[0].delayMs !== 10) {
    fail(`16: first breadcrumb wrong: ${JSON.stringify(breadcrumbs[0])}`);
  }
  if (breadcrumbs[1].attempt !== 2 || breadcrumbs[1].delayMs !== 20) {
    fail(`16: second breadcrumb wrong: ${JSON.stringify(breadcrumbs[1])}`);
  }
  testNum++;
}

// 17. Transient → mixed errors → permanent in the middle short-circuits
//     (any permanent error in the chain aborts further retries)
{
  let calls = 0;
  let threw: any = null;
  try {
    await withFeishuRetry(
      async () => {
        calls++;
        if (calls === 1) throw feishuErr(99991400, 'transient first');
        // 2nd call: permanent → should abort here
        throw feishuErr(230002, 'permanent then');
      },
      { delays: [1, 1, 1] },
    );
  } catch (e) {
    threw = e;
  }
  if (!threw) fail(`17: must throw`);
  if (calls !== 2) fail(`17: should abort on permanent (got ${calls} calls)`);
  if (getFeishuApiMsg(threw) !== 'permanent then') {
    fail(`17: permanent error should propagate, got ${getFeishuApiMsg(threw)}`);
  }
  testNum++;
}

// 18. HOT_PATH_RETRY_DELAYS_MS defaults are short — 500/1500/5000
{
  if (HOT_PATH_RETRY_DELAYS_MS.length !== 3) {
    fail(`18: expected 3 retries default, got ${HOT_PATH_RETRY_DELAYS_MS.length}`);
  }
  if (HOT_PATH_RETRY_DELAYS_MS[0] !== 500) fail(`18: first delay should be 500ms`);
  // Total bounded ≈ 7s
  const total = HOT_PATH_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  if (total > 10_000) fail(`18: total hot-path retry budget should be ≤ 10s, got ${total}ms`);
  testNum++;
}

// 19. Empty delays → max 0 retries → permanent thrown on first attempt
//     (no retries possible without delay schedule)
{
  let calls = 0;
  let threw = false;
  try {
    await withFeishuRetry(
      async () => {
        calls++;
        throw feishuErr(99991400);
      },
      { delays: [] },
    );
  } catch {
    threw = true;
  }
  if (!threw) fail(`19: must throw`);
  if (calls !== 1) fail(`19: empty delays → 1 call only, got ${calls}`);
  testNum++;
}

console.log(`feishu-retry smoke: ${testNum}/${testNum} PASS`);
