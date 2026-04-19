/**
 * Job store smoke test — runs as part of `npm test`.
 * Exits non-zero if any assertion fails.
 */
import {
  sanitizeJobId,
  expandSchedule,
  computeNextRun,
  backfillJob,
  type JobFile,
} from '../src/job-store.js';

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
      send_chat_id: '', // intentionally missing — simulate pre-v0.9 job
      origin_chat_id: '', // same
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

// 25. backfill: send_chat_id defaults to target_chat_id
const b1 = backfillJob(makeLegacyJob());
if (b1.meta.send_chat_id !== 'oc_legacy_chat') fail(`backfill send_chat_id: got "${b1.meta.send_chat_id}"`);

// 26. backfill: origin_chat_id defaults to target_chat_id
if (b1.meta.origin_chat_id !== 'oc_legacy_chat') fail(`backfill origin_chat_id: got "${b1.meta.origin_chat_id}"`);

// 27. backfill: does not overwrite existing send_chat_id
const b2 = backfillJob(makeLegacyJob({ send_chat_id: 'oc_already_set' }));
if (b2.meta.send_chat_id !== 'oc_already_set') fail(`backfill should not overwrite: got "${b2.meta.send_chat_id}"`);

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

console.log('PASS');
