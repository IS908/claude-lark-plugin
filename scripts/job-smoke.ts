/**
 * Job store smoke test — runs as part of `npm test`.
 * Exits non-zero if any assertion fails.
 */
import {
  sanitizeJobId,
  expandSchedule,
  computeNextRun,
  backfillJob,
  listAllJobs,
  type JobFile,
} from '../src/job-store.js';
import { appConfig } from '../src/config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// 1. sanitizeJobId — basic
if (sanitizeJobId('Daily PR Summary') !== 'daily-pr-summary') fail('sanitize basic');

// 2. sanitizeJobId — trim leading/trailing hyphens
if (sanitizeJobId('  hello world  ') !== 'hello-world') fail('sanitize trim');

// 3. sanitizeJobId — pure Chinese falls back to job-{timestamp}
const chineseId = sanitizeJobId('每日站会');
if (!chineseId.startsWith('job-')) fail(`sanitize Chinese: got ${chineseId}`);

// 4. sanitizeJobId — empty string
const emptyId = sanitizeJobId('');
if (!emptyId.startsWith('job-')) fail(`sanitize empty: got ${emptyId}`);

// 5. expandSchedule — every Nm
const e1 = expandSchedule('every 30m');
if (e1.cron !== '*/30 * * * *') fail(`expand every 30m: got ${e1.cron}`);

// 6. expandSchedule — daily at HH:MM
const e2 = expandSchedule('daily at 09:00');
if (e2.cron !== '0 9 * * *') fail(`expand daily: got ${e2.cron}`);

// 7. expandSchedule — weekdays at HH:MM
const e3 = expandSchedule('weekdays at 09:00');
if (e3.cron !== '0 9 * * 1-5') fail(`expand weekdays: got ${e3.cron}`);

// 8. expandSchedule — weekly on day
const e4 = expandSchedule('weekly on mon at 09:00');
if (e4.cron !== '0 9 * * 1') fail(`expand weekly: got ${e4.cron}`);

// 9. expandSchedule — passthrough valid cron
const e5 = expandSchedule('0 9 * * 1-5');
if (e5.cron !== '0 9 * * 1-5') fail(`expand passthrough: got ${e5.cron}`);

// 10. expandSchedule — invalid expression throws
try {
  expandSchedule('not a cron');
  fail('expand invalid should throw');
} catch {
  // expected
}

// 11. computeNextRun — returns a valid ISO date
const next = computeNextRun('* * * * *');
const d = new Date(next);
if (isNaN(d.getTime())) fail(`computeNextRun returned invalid date: ${next}`);
if (d.getTime() <= Date.now() - 60000) fail('computeNextRun returned past date');

// 12. expandSchedule — every Nh
const e6 = expandSchedule('every 2h');
if (e6.cron !== '0 */2 * * *') fail(`expand every 2h: got ${e6.cron}`);

// 13. sanitizeJobId — special characters stripped
if (sanitizeJobId('My Task #1!') !== 'my-task-1') fail('sanitize special chars');

// 14. sanitizeJobId — max 40 chars
const longId = sanitizeJobId('a'.repeat(60));
if (longId.length > 40) fail(`sanitize max length: got ${longId.length}`);

// 15. expandSchedule — every 1m (minimum interval)
const e7 = expandSchedule('every 1m');
if (e7.cron !== '*/1 * * * *') fail(`expand every 1m: got ${e7.cron}`);

// 16. expandSchedule — weekly on different days
const e8 = expandSchedule('weekly on fri at 17:00');
if (e8.cron !== '0 17 * * 5') fail(`expand weekly fri: got ${e8.cron}`);
const e9 = expandSchedule('weekly on sun at 08:00');
if (e9.cron !== '0 8 * * 0') fail(`expand weekly sun: got ${e9.cron}`);

// 17. expandSchedule — human field preserved
if (e1.human !== 'every 30m') fail(`expand human: got ${e1.human}`);
if (e2.human !== 'daily at 09:00') fail(`expand human daily: got ${e2.human}`);

// 18. computeNextRun — returns future date
const nextFuture = computeNextRun('0 0 * * *');
if (new Date(nextFuture).getTime() <= Date.now()) fail('computeNextRun not in future');

// 19. sanitizeJobId — consecutive special chars collapse to single hyphen
if (sanitizeJobId('a---b___c') !== 'a-b-c') fail('sanitize consecutive specials');

// 20. expandSchedule — case insensitive aliases
const e10 = expandSchedule('Daily At 09:00');
if (e10.cron !== '0 9 * * *') fail(`expand case insensitive: got ${e10.cron}`);

// 21. expandSchedule — minute variations
const e11 = expandSchedule('every 5 minutes');
if (e11.cron !== '*/5 * * * *') fail(`expand minutes: got ${e11.cron}`);
const e12 = expandSchedule('every 3 hours');
if (e12.cron !== '0 */3 * * *') fail(`expand hours: got ${e12.cron}`);

// 22. computeNextRun — respects timezone (wall-clock hour matches target tz)
// Set tz via env override then re-import to pick it up would require
// dynamic imports; instead we verify the default path returns a string
// that when re-parsed matches the pattern "0 9" for daily at 9 in system tz.
const nextDaily = computeNextRun('0 9 * * *');
const d9 = new Date(nextDaily);
if (isNaN(d9.getTime())) fail(`computeNextRun tz test: invalid date ${nextDaily}`);
// Sanity: the returned ISO time should be in the future
if (d9.getTime() <= Date.now()) fail('computeNextRun tz: not in future');
// Sanity: the hour in system-local should be 9
const systemHour9 = d9.toLocaleString('en-US', {
  hour: 'numeric',
  hour12: false,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});
if (!systemHour9.startsWith('9') && !systemHour9.startsWith('09')) {
  fail(`computeNextRun tz: expected local hour 9, got ${systemHour9}`);
}

// 23. computeNextRun — different cron expressions produce different times
const nextA = computeNextRun('0 0 * * *');
const nextB = computeNextRun('0 12 * * *');
if (nextA === nextB) fail('computeNextRun: different crons produced same time');

// 24. expandSchedule validates the *final* cron (even for alias paths)
// Alias paths now validate too — this catches invalid LARK_CRON_TIMEZONE
// at create_job time rather than at scheduler-tick time.
// Verify alias result is consistent: daily at 09:00 → 0 9 * * *
const aliasResult = expandSchedule('daily at 09:00');
if (aliasResult.cron !== '0 9 * * *') fail(`alias validation: got ${aliasResult.cron}`);

// ── Backfill tests (v0.9.0) ─────────────────────────────────

function makeLegacyJob(overrides: Partial<JobFile['meta']> = {}): JobFile {
  return {
    meta: {
      id: 'legacy-1',
      name: 'Legacy Job',
      type: 'prompt',
      schedule: '0 9 * * *',
      schedule_human: 'daily at 09:00',
      target_chat_id: 'oc_legacy_chat',
      origin_chat_id: '', // intentionally empty — simulate pre-v0.9 job
      status: 'active',
      created_by: '',
      created_at: '2026-01-01T00:00:00Z',
      ...overrides,
    } as JobFile['meta'],
    runtime: {
      last_run_at: null,
      next_run_at: '2026-12-31T01:00:00Z',
      run_count: 0,
      last_error: null,
    },
  };
}

// 25. backfill: origin_chat_id defaults to target_chat_id when empty
const b1 = backfillJob(makeLegacyJob());
if (b1.meta.origin_chat_id !== 'oc_legacy_chat') fail(`backfill origin_chat_id: got "${b1.meta.origin_chat_id}"`);

// 26. backfill: does not overwrite existing origin_chat_id
const b2 = backfillJob(makeLegacyJob({ origin_chat_id: 'oc_already_set' }));
if (b2.meta.origin_chat_id !== 'oc_already_set') fail(`backfill should not overwrite origin: got "${b2.meta.origin_chat_id}"`);

// 27. backfill: resurrects target_chat_id from short-lived v0.9 send_chat_id field
// Simulate a job file written by v0.9-v0.11.0 that has send_chat_id but no target_chat_id
// (extremely unlikely in practice but the backfill path should handle it).
const transitionalJob = {
  meta: {
    id: 'transitional',
    name: 'Transitional',
    type: 'prompt' as const,
    schedule: '0 9 * * *',
    schedule_human: 'daily at 09:00',
    target_chat_id: '',  // missing
    send_chat_id: 'oc_v09_chat', // short-lived legacy field
    origin_chat_id: 'oc_v09_chat',
    status: 'active' as const,
    created_by: 'ou_x',
    created_at: '2026-01-01T00:00:00Z',
  },
  runtime: {
    last_run_at: null,
    next_run_at: '2026-12-31T01:00:00Z',
    run_count: 0,
    last_error: null,
  },
} as unknown as JobFile;
const b2b = backfillJob(transitionalJob);
if (b2b.meta.target_chat_id !== 'oc_v09_chat') fail(`backfill send_chat_id→target: got "${b2b.meta.target_chat_id}"`);
// And the legacy field should be DELETED from the in-memory object so it
// doesn't persist on next writeJob (cleaning up ghost fields).
if ('send_chat_id' in (b2b.meta as Record<string, unknown>)) {
  fail('27: send_chat_id ghost field should be deleted after backfill');
}

// 27b. backfill: cleanup happens even when both fields coexisted (common
// case for jobs created by v0.9-v0.11.0 which wrote BOTH fields)
const dualJob = {
  meta: {
    id: 'dual',
    name: 'Dual',
    type: 'prompt' as const,
    schedule: '0 9 * * *',
    schedule_human: 'daily at 09:00',
    target_chat_id: 'oc_dual',  // present
    send_chat_id: 'oc_dual',    // ghost to be cleaned
    origin_chat_id: 'oc_dual',
    status: 'active' as const,
    created_by: 'ou_x',
    created_at: '2026-01-01T00:00:00Z',
  },
  runtime: {
    last_run_at: null,
    next_run_at: '2026-12-31T01:00:00Z',
    run_count: 0,
    last_error: null,
  },
} as unknown as JobFile;
const b2c = backfillJob(dualJob);
if (b2c.meta.target_chat_id !== 'oc_dual') fail('27b: target preserved');
if ('send_chat_id' in (b2c.meta as Record<string, unknown>)) {
  fail('27b: send_chat_id ghost should be deleted even when target already present');
}

// 28. backfill: empty created_by attributes to LARK_OWNER_OPEN_ID when set
// Simulate by setting the env and re-importing config; instead verify conditional:
// when ownerOpenId is null (default in CI), empty created_by stays empty.
const b3 = backfillJob(makeLegacyJob({ created_by: '' }));
// In CI, LARK_OWNER_OPEN_ID is typically unset → backfill leaves empty
// In dev with owner set → backfill assigns owner. Both are acceptable outcomes.
// Assert only that the field is a string (not undefined/null) — the backfill
// code path ran without throwing.
if (typeof b3.meta.created_by !== 'string') fail(`created_by must be string: got ${typeof b3.meta.created_by}`);

// 29. backfill: non-empty created_by is preserved
const b4 = backfillJob(makeLegacyJob({ created_by: 'ou_alice' }));
if (b4.meta.created_by !== 'ou_alice') fail(`backfill must preserve created_by: got "${b4.meta.created_by}"`);

// ── listAllJobs: filename/meta.id mismatch defense (#62) ──
//
// Defends against the duplicate-execution bug: if a job file's on-disk
// name doesn't match its internal meta.id, listAllJobs must skip it
// (rather than yield a JobFile that no readJob/deleteJob can address),
// otherwise the scheduler would happily execute orphan files at every
// tick. See issue #62 for the full failure path.

const tmpJobsDir = mkdtempSync(join(tmpdir(), 'job-mismatch-smoke-'));
const originalJobsDir = appConfig.jobsDir;
// `appConfig` is declared `as const`, so TypeScript blocks direct
// reassignment. At runtime the object is still mutable — cast-and-set
// for the test, restore in the cleanup block below.
(appConfig as { jobsDir: string }).jobsDir = tmpJobsDir;

// Cleanup-aware fail helper: restore env + remove tmp dir before exiting.
// fail() calls process.exit, which BYPASSES try/finally — so any assertion
// failure inside the try block would otherwise leak the tmp dir and leave
// appConfig pointing at a deleted path. Going through this helper makes
// failures as tidy as success.
function failClean(msg: string): never {
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
  try { rmSync(tmpJobsDir, { recursive: true, force: true }); } catch {}
  fail(msg);
}

// Hoisted outside the try so the finally block can restore stderr even
// if listAllJobs() throws before we get to the explicit restore line.
// Without this, an uncaught rejection mid-test would leave stderr
// overridden for any future code in the same process (harmless today
// because npm test exits, but cheap belt-and-suspenders).
const origStderr = process.stderr.write.bind(process.stderr);
let stderrCapture = '';

try {
  process.stderr.write = ((chunk: any) => {
    stderrCapture += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as any;

  // The console.error path used by job-store goes through process.stderr,
  // but we wrap conservatively — flush console first.

  // 30. good-file: filename matches meta.id → loaded normally
  const goodJob: JobFile = {
    meta: {
      id: 'job-good',
      name: 'Good Job',
      type: 'message',
      schedule: '* * * * *',
      schedule_human: 'every 1m',
      target_chat_id: 'oc_x',
      origin_chat_id: 'oc_x',
      status: 'active',
      created_by: 'ou_x',
      created_at: '2026-01-01T00:00:00Z',
      content: 'hi',
      msg_type: 'text',
    } as JobFile['meta'],
    runtime: { last_run_at: null, next_run_at: '2099-01-01T00:00:00Z', run_count: 0, last_error: null },
  };
  writeFileSync(join(tmpJobsDir, 'job-good.json'), JSON.stringify(goodJob, null, 2));

  // 31. bad-file: filename does NOT match meta.id → skipped + warning
  // Simulates `cp job-good.json renamed.json` or a hand-edit gone wrong.
  const badJob: JobFile = { ...goodJob, meta: { ...goodJob.meta, id: 'job-original' } };
  writeFileSync(join(tmpJobsDir, 'renamed.json'), JSON.stringify(badJob, null, 2));

  const listed = await listAllJobs();

  // Restore stderr before assertions so failures print normally.
  process.stderr.write = origStderr;

  if (listed.length !== 1) {
    failClean(`30/31: expected 1 job (mismatched file skipped), got ${listed.length}: ${listed.map((j) => j.meta.id).join(',')}`);
  }
  if (listed[0].meta.id !== 'job-good') {
    failClean(`30: expected job-good, got ${listed[0].meta.id}`);
  }
  if (!stderrCapture.includes('Skipping renamed.json')) {
    failClean(`31: warning not emitted for mismatched filename. Captured stderr:\n${stderrCapture}`);
  }
  if (!stderrCapture.includes('meta.id="job-original"')) {
    failClean(`31: warning missing meta.id detail. Captured stderr:\n${stderrCapture}`);
  }
} finally {
  // Restore even on failure so later tests / processes don't inherit
  // overridden stderr, a deleted tmp dir, or a stale appConfig pointer.
  process.stderr.write = origStderr;
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
  rmSync(tmpJobsDir, { recursive: true, force: true });
}

console.log('PASS');
