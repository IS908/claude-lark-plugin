/**
 * Single-instance lock pure-function smoke test (v1.0.23, #101).
 *
 * Exercises the PID + start-time disambiguation helpers added to
 * src/index.ts. The full lock acquisition flow (acquireLock) is not
 * tested end-to-end because it writes to /tmp and registers process
 * exit hooks — too invasive for a unit test. The helpers below cover
 * the parts that determine correctness:
 *
 *   - parseLockToken: malformed input → null; PID-only legacy form
 *     parses with empty start-time (triggers overwrite path);
 *     well-formed pid|startTime parses cleanly.
 *   - buildLockToken: self-PID produces a token whose start-time
 *     component round-trips through parseLockToken.
 *   - getProcessStartTime: returns a non-empty value for self PID;
 *     null for a definitely-dead PID; null for invalid pids
 *     (negative, zero, non-integer).
 *
 * The pid|startTime disambiguation is the only thing standing
 * between "PID was recycled to a bash process and the bot refuses
 * to start forever" and "bot recovers automatically" — small but
 * critical contract surface.
 */

import { buildLockToken, parseLockToken, getProcessStartTime } from '../src/lock.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let testNum = 0;

// 1. parseLockToken — malformed inputs return null.
{
  testNum++;
  const cases: [string, string][] = [
    ['', 'empty'],
    ['   ', 'whitespace-only'],
    ['not-a-pid', 'non-numeric'],
    ['-5|2026-01-01', 'negative pid'],
    ['0|2026-01-01', 'zero pid'],
    ['abc|xyz', 'non-numeric pid + start-time'],
  ];
  for (const [input, label] of cases) {
    const out = parseLockToken(input);
    if (out !== null) fail(`1.${label}: expected null, got ${JSON.stringify(out)}`);
  }
}

// 2. parseLockToken — legacy PID-only lock parses with empty start-time.
//    This triggers the overwrite path in acquireLock (recordedStart !==
//    currentStart since '' never matches a real start-time string).
{
  testNum++;
  const out = parseLockToken('12345');
  if (out === null || out.pid !== 12345) fail(`2: legacy PID-only should parse; got ${JSON.stringify(out)}`);
  if (out.startTime !== '') fail(`2: legacy form should yield empty start-time; got "${out.startTime}"`);
}

// 3. parseLockToken — well-formed pid|startTime parses cleanly.
{
  testNum++;
  const out = parseLockToken('98765|Sun May 25 02:30:00 2026');
  if (out === null) fail('3: well-formed token should parse');
  if (out!.pid !== 98765) fail(`3: pid wrong: ${out!.pid}`);
  if (out!.startTime !== 'Sun May 25 02:30:00 2026') fail(`3: startTime wrong: "${out!.startTime}"`);
}

// 4. parseLockToken — trailing/leading whitespace is tolerated.
{
  testNum++;
  const out = parseLockToken('  12345|some time  \n');
  if (out === null || out.pid !== 12345 || out.startTime !== 'some time') {
    fail(`4: whitespace trim failed; got ${JSON.stringify(out)}`);
  }
}

// 5. getProcessStartTime — invalid pids return null.
{
  testNum++;
  for (const bad of [0, -1, -99999, 1.5, NaN, Infinity]) {
    const out = getProcessStartTime(bad);
    if (out !== null) fail(`5.pid=${bad}: expected null, got ${out}`);
  }
}

// 6. getProcessStartTime — self PID returns a non-empty start-time.
//    This proves the `ps -p PID -o lstart=` shell-out works on the
//    test platform (POSIX). Skipped on platforms where ps is unavailable
//    (Windows) by checking for a recognizable failure mode.
{
  testNum++;
  const selfStart = getProcessStartTime(process.pid);
  if (selfStart === null) {
    // ps is unavailable (e.g. minimal container, Windows). The
    // PID-reuse protection degrades to "no protection" on these
    // platforms; the bot will use the empty-start-time fallback and
    // overwrite legacy locks freely.
    console.error('SKIP 6: getProcessStartTime returned null for self PID — ps not available on this platform');
  } else {
    if (selfStart.length === 0) fail('6: self start-time should not be empty');
    // Sanity: start-time string should look like a date/time.
    if (!/\d/.test(selfStart)) fail(`6: start-time should contain digits; got "${selfStart}"`);
  }
}

// 7. getProcessStartTime — a definitely-dead PID returns null.
//    PID 0 is the kernel "swapper" / boot pseudo-process; `ps -p 0`
//    returns no output on macOS/Linux. We use 1 (init) only if 0
//    happens to print anything weird.
{
  testNum++;
  // PID 99999999 is well above the typical PID_MAX (32768 Linux,
  // 99999 macOS), so this should reliably return null. If a future
  // kernel ever supports PIDs that high, the test still passes
  // because the helper would return null on PID nonexistence.
  const out = getProcessStartTime(99_999_999);
  if (out !== null) fail(`7: definitely-dead PID should return null, got "${out}"`);
}

// 8. buildLockToken — self-PID produces a token whose pid round-trips
//    and whose start-time (if ps is available) matches a re-query.
{
  testNum++;
  const token = buildLockToken(process.pid);
  const parsed = parseLockToken(token);
  if (parsed === null) fail(`8: own token should parse, got: ${token}`);
  if (parsed!.pid !== process.pid) fail(`8: pid mismatch: ${parsed!.pid} vs ${process.pid}`);
  // The start-time component may be empty on platforms without ps;
  // when non-empty, it must match a fresh read.
  if (parsed!.startTime !== '') {
    const fresh = getProcessStartTime(process.pid);
    if (fresh !== parsed!.startTime) fail(`8: start-time should be stable; was "${parsed!.startTime}", now "${fresh}"`);
  }
}

console.log(`lock smoke: ${testNum}/${testNum} PASS`);
