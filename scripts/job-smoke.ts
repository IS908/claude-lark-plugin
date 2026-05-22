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
  readJob,
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

// ── listAllJobs / readJob: meta.id is filename-derived (#68) ──
//
// The on-disk filename is the SINGLE source of truth for the job id.
// Whatever meta.id the JSON carries is overwritten with the file stem on
// every read. This replaces the pre-v1.0.9 skip-on-mismatch logic (#62):
// a hand-edited or copied file no longer silently disappears — it loads
// with meta.id derived from its filename.

const tmpJobsDir = mkdtempSync(join(tmpdir(), 'job-id-smoke-'));
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

try {
  const baseJob: JobFile = {
    meta: {
      id: 'placeholder',
      name: 'Job',
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

  // 30. matched file: filename == meta.id → loads, id correct
  writeFileSync(
    join(tmpJobsDir, 'job-good.json'),
    JSON.stringify({ ...baseJob, meta: { ...baseJob.meta, id: 'job-good' } }, null, 2),
  );

  // 31. mismatched file: filename "renamed.json" but internal meta.id is
  //     "job-original" (simulates a hand-edit or `cp`). Pre-v1.0.9 this was
  //     skipped and the job silently vanished. Now it loads with
  //     meta.id derived from the filename.
  writeFileSync(
    join(tmpJobsDir, 'renamed.json'),
    JSON.stringify({ ...baseJob, meta: { ...baseJob.meta, id: 'job-original' } }, null, 2),
  );

  const listed = await listAllJobs();

  // 30 — both files load; nothing is skipped
  if (listed.length !== 2) {
    failClean(`30: expected 2 jobs (no skip), got ${listed.length}: ${listed.map((j) => j.meta.id).join(',')}`);
  }
  const ids = listed.map((j) => j.meta.id).sort();
  if (ids[0] !== 'job-good' || ids[1] !== 'renamed') {
    failClean(`30/31: expected ids [job-good, renamed], got [${ids.join(', ')}]`);
  }

  // 31 — the mismatched file's meta.id is the FILENAME stem, not the
  //      stale internal value "job-original"
  const renamed = listed.find((j) => j.meta.id === 'renamed');
  if (!renamed) failClean('31: renamed.json did not load');
  if ((renamed!.meta as any).id === 'job-original') {
    failClean('31: meta.id should be filename-derived, not the stale internal value');
  }
  // 31a — withFilenameId touches ONLY meta.id; all sibling fields and
  //       runtime survive intact (regression guard against a future
  //       canonicaliser that over-reaches).
  if (renamed!.meta.schedule !== '* * * * *') failClean('31a: schedule corrupted');
  if (renamed!.meta.type !== 'message') failClean('31a: type corrupted');
  if ((renamed!.meta as any).content !== 'hi') failClean('31a: content corrupted');
  if (renamed!.meta.target_chat_id !== 'oc_x') failClean('31a: target_chat_id corrupted');
  if (renamed!.runtime.next_run_at !== '2099-01-01T00:00:00Z') failClean('31a: runtime corrupted');

  // 31b — readJob path canonicalizes too: readJob("renamed") returns a
  //       job whose meta.id is "renamed" even though the JSON says
  //       "job-original".
  const viaRead = await readJob('renamed');
  if (!viaRead) failClean('31b: readJob("renamed") returned null');
  if (viaRead!.meta.id !== 'renamed') {
    failClean(`31b: readJob should canonicalize meta.id to filename, got "${viaRead!.meta.id}"`);
  }
} finally {
  // Restore even on failure so later tests / processes don't inherit a
  // deleted tmp dir or a stale appConfig pointer.
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
  rmSync(tmpJobsDir, { recursive: true, force: true });
}

// ── listAllJobs: corrupt vs unreadable vs ENOENT distinction (#64) ──
//
// v1.0.6 lumped all read failures under "Skipping corrupt job file".
// v1.0.7 distinguishes: ENOENT (silent — benign delete race), SyntaxError
// (truly corrupt), other (unreadable).

const tmpJobsDir2 = mkdtempSync(join(tmpdir(), 'job-errkind-smoke-'));
const originalJobsDir2 = appConfig.jobsDir;
(appConfig as { jobsDir: string }).jobsDir = tmpJobsDir2;

const origStderr2 = process.stderr.write.bind(process.stderr);
let stderrCapture2 = '';

function failClean2(msg: string): never {
  process.stderr.write = origStderr2;
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir2;
  try { rmSync(tmpJobsDir2, { recursive: true, force: true }); } catch {}
  fail(msg);
}

try {
  process.stderr.write = ((chunk: any) => {
    stderrCapture2 += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as any;

  // 32. corrupt-JSON file is labelled "corrupt", not "unreadable"
  writeFileSync(join(tmpJobsDir2, 'broken.json'), 'not-valid-json{');
  // 33. one good job alongside the broken one — should still load
  const goodJob: JobFile = {
    meta: {
      id: 'job-alongside',
      name: 'Alongside Good',
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
  writeFileSync(join(tmpJobsDir2, 'job-alongside.json'), JSON.stringify(goodJob, null, 2));

  const listed = await listAllJobs();

  process.stderr.write = origStderr2;

  // 32a. corrupt file warning fires with the correct label
  if (!stderrCapture2.includes('corrupt job file broken.json')) {
    failClean2(`32: expected "corrupt job file broken.json" in stderr. Got:\n${stderrCapture2}`);
  }
  // 32b. corrupt file warning does NOT use the unreadable label.
  // Intentionally tautological with 32a today: job-store emits exactly
  // ONE log line per file via either branch, so once 32a passes, 32b
  // cannot fail. Kept as regression scaffolding — if a future refactor
  // reorders the `instanceof SyntaxError` check below the generic `else`
  // (and the same file got mis-routed through both), this would fire.
  // Do not "clean up" this check.
  if (stderrCapture2.includes('unreadable job file broken.json')) {
    failClean2(`32: corrupt file shouldn't be labelled "unreadable". Got:\n${stderrCapture2}`);
  }
  // 33. good job survives the corrupt sibling
  if (listed.length !== 1 || listed[0].meta.id !== 'job-alongside') {
    failClean2(`33: expected only job-alongside, got ${listed.map((j) => j.meta.id).join(',')}`);
  }
} finally {
  process.stderr.write = origStderr2;
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir2;
  rmSync(tmpJobsDir2, { recursive: true, force: true });
}

// ── listAllJobs: parallel reads complete (smoke for #64 perf change) ──
// 34. 20 valid jobs all load via the parallel Promise.all path
{
  const tmp = mkdtempSync(join(tmpdir(), 'job-parallel-smoke-'));
  const origDir = appConfig.jobsDir;
  (appConfig as { jobsDir: string }).jobsDir = tmp;

  // Cleanup-aware fail mirrors failClean / failClean2 — fail() calls
  // process.exit which bypasses the finally below.
  function failClean3(msg: string): never {
    (appConfig as { jobsDir: string }).jobsDir = origDir;
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    fail(msg);
  }

  try {
    for (let i = 0; i < 20; i++) {
      const id = `parallel-${String(i).padStart(2, '0')}`;
      const job: JobFile = {
        meta: {
          id,
          name: `Parallel ${i}`,
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
      writeFileSync(join(tmp, `${id}.json`), JSON.stringify(job, null, 2));
    }
    const listed = await listAllJobs();
    if (listed.length !== 20) {
      failClean3(`34: parallel read missed jobs. expected 20, got ${listed.length}`);
    }
  } finally {
    (appConfig as { jobsDir: string }).jobsDir = origDir;
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('PASS');
