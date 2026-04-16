/**
 * Job store smoke test — runs as part of `npm test`.
 * Exits non-zero if any assertion fails.
 */
import {
  sanitizeJobId,
  expandSchedule,
  computeNextRun,
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

console.log('PASS');
