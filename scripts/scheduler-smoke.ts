/**
 * Scheduler smoke test — runs as part of `npm test`.
 *
 * Part A: `isMissedRunStale` — the pure decision function behind
 *   recoverMissedJobs' catch-up-vs-skip behavior. Default threshold 6h.
 * Part B: recoverMissedJobs integration — a stale missed run is skipped,
 *   next_run_at advanced, and the operator notified (#68 follow-up).
 *   Tier 1 = the job's chat; tier 2 = a DM to the owner if the chat send
 *   fails (chat may be gone — bot kicked / group dissolved).
 */
// Pin cron tz to UTC so slot lattice for `0 * * * *` aligns to UTC
// hour boundaries regardless of CI runner's local tz (R2-audit
// followup on PR #123 — half-hour-offset tz like Asia/Kolkata would
// otherwise shift hourly slots by 30 minutes vs the UTC-anchored
// expectations in tests 19a/19c). Must be set BEFORE importing
// config.js, which captures the env once at module load.
process.env.LARK_CRON_TIMEZONE = 'UTC';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMissedRunStale, JobScheduler } from '../src/scheduler.js';
import { IdentitySession } from '../src/identity-session.js';
import { BotMessageTracker } from '../src/channel.js';
import { appConfig } from '../src/config.js';
import {
  mostRecentMissedSlot,
  writeJob,
  readJob,
  deleteJob,
  computeNextRun,
} from '../src/job-store.js';
import type { JobFile } from '../src/job-store.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;
const HOUR = 60 * 60 * 1000;
const now = 1_000_000_000_000;

// ── Part A: isMissedRunStale (pure) ──────────────────────────

// 1. A run missed by minutes is NOT stale → catch up.
if (isMissedRunStale(now - 5 * 60_000, now)) fail('1: 5min late should not be stale');
passed++;

// 2. A run missed by just under 6h is NOT stale (laptop-closed-an-afternoon).
if (isMissedRunStale(now - (6 * HOUR - 60_000), now)) fail('2: 5h59m late should not be stale');
passed++;

// 3. A run missed by just over 6h IS stale → skip.
if (!isMissedRunStale(now - (6 * HOUR + 60_000), now)) fail('3: 6h01m late should be stale');
passed++;

// 4. Multi-day staleness (the #68 incident: a job dead 3 days) IS stale.
if (!isMissedRunStale(now - 3 * 24 * HOUR, now)) fail('4: 3-day-late should be stale');
passed++;

// 5. Boundary: exactly at the 6h threshold is NOT stale (strict >).
if (isMissedRunStale(now - 6 * HOUR, now)) fail('5: exactly 6h late should not be stale (strict >)');
passed++;

// 6. A future run (next_run_at ahead of now) is trivially not stale.
if (isMissedRunStale(now + HOUR, now)) fail('6: future run should not be stale');
passed++;

// 7. A 2h-late run is still caught up (within the 6h grace) — guards
//    against the threshold being accidentally lowered.
if (isMissedRunStale(now - 2 * HOUR, now)) fail('7: 2h late should not be stale at 6h threshold');
passed++;

// 8. Custom threshold is honored.
if (!isMissedRunStale(now - 10 * 60_000, now, 5 * 60_000)) {
  fail('8: 10min late with 5min threshold should be stale');
}
if (isMissedRunStale(now - 3 * 60_000, now, 5 * 60_000)) {
  fail('8: 3min late with 5min threshold should not be stale');
}
passed++;

// ── Part B: recoverMissedJobs integration ────────────────────

const tmpJobsDir = mkdtempSync(join(tmpdir(), 'scheduler-smoke-'));
const originalJobsDir = appConfig.jobsDir;
(appConfig as { jobsDir: string }).jobsDir = tmpJobsDir;

interface SentMessage { receive_id_type: string; receive_id: string; text: string }

/**
 * Build a mock Lark client. `failWhen` decides, per call, whether
 * message.create should throw — lets a test simulate an unreachable
 * target chat.
 */
function mockClient(
  sent: SentMessage[],
  failWhen: (receiveIdType: string) => boolean = () => false,
) {
  return {
    im: {
      v1: {
        message: {
          create: async (args: any) => {
            const receiveIdType = args?.params?.receive_id_type;
            if (failWhen(receiveIdType)) {
              throw new Error(`mock: send to ${receiveIdType} unreachable`);
            }
            const parsed = JSON.parse(args?.data?.content ?? '{}');
            sent.push({
              receive_id_type: receiveIdType,
              receive_id: args?.data?.receive_id,
              text: parsed.text ?? '',
            });
            return { data: { message_id: 'mock' } };
          },
        },
      },
    },
  };
}
const mockServer = { notification: async () => {} };

function makeJob(id: string, nextRunAt: string, createdBy = 'ou_owner'): JobFile {
  return {
    meta: {
      id,
      name: id,
      type: 'message',
      schedule: '10 21 * * 1-5',
      schedule_human: '10 21 * * 1-5',
      target_chat_id: `oc_${id}`,
      origin_chat_id: `oc_${id}`,
      status: 'active',
      created_by: createdBy,
      created_at: '2026-01-01T00:00:00Z',
      content: 'hi',
      msg_type: 'text',
    } as JobFile['meta'],
    runtime: { last_run_at: null, next_run_at: nextRunAt, run_count: 0, last_error: null },
  };
}

function makeScheduler(client: any, botMessageTracker?: any): JobScheduler {
  return new JobScheduler({
    server: mockServer as any,
    client,
    identitySession: new IdentitySession(() => null),
    botMessageTracker,
  });
}

try {
  // 9. A stale missed job → skipped + chat notified (tier 1 succeeds).
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));
    const staleJob = makeJob('stale-job', new Date(Date.now() - 3 * 24 * HOUR).toISOString());
    await (scheduler as any).recoverMissedJobs([staleJob]);

    if (sent.length !== 1) fail(`9: expected 1 notice, got ${sent.length}`);
    if (sent[0].receive_id_type !== 'chat_id') fail(`9: tier-1 should use chat_id, got ${sent[0].receive_id_type}`);
    if (sent[0].receive_id !== 'oc_stale-job') fail(`9: notice sent to wrong chat: ${sent[0].receive_id}`);
    if (!sent[0].text.includes('stale-job')) fail('9: notice missing job id');
    if (!/skipped|stale/i.test(sent[0].text)) fail('9: notice missing skip explanation');
    if (new Date(staleJob.runtime.next_run_at).getTime() <= Date.now()) {
      fail('9: stale job next_run_at not advanced to the future');
    }
    if (staleJob.runtime.run_count !== 0) fail('9: skip must not increment run_count');
    if (staleJob.runtime.last_run_at !== null) fail('9: skip must not set last_run_at');
    passed++;
  }

  // 10. A not-yet-due job → no notice, untouched.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));
    const futureJob = makeJob('future-job', new Date(Date.now() + HOUR).toISOString());
    await (scheduler as any).recoverMissedJobs([futureJob]);
    if (sent.length !== 0) fail(`10: a not-missed job must not trigger a notice, got ${sent.length}`);
    passed++;
  }

  // 11. Tier-1 (chat) send fails → fall back to owner DM via open_id.
  {
    const sent: SentMessage[] = [];
    // chat_id sends throw; open_id sends succeed
    const scheduler = makeScheduler(mockClient(sent, (t) => t === 'chat_id'));
    const staleJob = makeJob('orphan-chat-job', new Date(Date.now() - 3 * 24 * HOUR).toISOString());
    await (scheduler as any).recoverMissedJobs([staleJob]);

    if (sent.length !== 1) fail(`11: expected 1 notice via fallback, got ${sent.length}`);
    if (sent[0].receive_id_type !== 'open_id') fail(`11: fallback should use open_id, got ${sent[0].receive_id_type}`);
    if (sent[0].receive_id !== 'ou_owner') fail(`11: fallback should DM created_by, got ${sent[0].receive_id}`);
    if (!sent[0].text.includes('orphan-chat-job')) fail('11: fallback notice missing job id');
    // schedule still advanced despite tier-1 failure
    if (new Date(staleJob.runtime.next_run_at).getTime() <= Date.now()) {
      fail('11: next_run_at must advance even when tier-1 send fails');
    }
    passed++;
  }

  // 12. Both tiers fail → recoverMissedJobs still completes (no throw),
  //     schedule still advanced.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent, () => true)); // every send throws
    const staleJob = makeJob('fully-unreachable', new Date(Date.now() - 3 * 24 * HOUR).toISOString());
    let threw = false;
    try {
      await (scheduler as any).recoverMissedJobs([staleJob]);
    } catch {
      threw = true;
    }
    if (threw) fail('12: recoverMissedJobs must not throw when all notice channels fail');
    if (sent.length !== 0) fail(`12: no message should record when all sends fail, got ${sent.length}`);
    if (new Date(staleJob.runtime.next_run_at).getTime() <= Date.now()) {
      fail('12: next_run_at must advance even when all notice channels fail');
    }
    passed++;
  }

  // 13. Stale job with empty created_by → tier-1 fails, no DM fallback
  //     attempted (no owner to address), still no throw.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent, (t) => t === 'chat_id'));
    const staleJob = makeJob('no-owner-job', new Date(Date.now() - 3 * 24 * HOUR).toISOString(), '');
    await (scheduler as any).recoverMissedJobs([staleJob]);
    if (sent.length !== 0) fail(`13: empty created_by should skip the DM fallback, got ${sent.length}`);
    if (new Date(staleJob.runtime.next_run_at).getTime() <= Date.now()) {
      fail('13: next_run_at must advance');
    }
    passed++;
  }
  // ── Part C: executeMessageJob hardening (v1.0.16, #96 R1-audit) ────
  //   create_job hardcodes msg_type='text' so non-text msg_type is only
  //   reachable via hand-edited job files. The runtime guard added in
  //   src/scheduler.ts:416 refuses to send those, because Feishu's `post`
  //   (and other rich) payloads also support <at> mentions but would
  //   bypass the text-side sanitizeOutboundText.

  // 14. msg_type='post' job is refused — no message sent, stderr line emitted.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));
    const postJob = makeJob('post-job', new Date(Date.now() + HOUR).toISOString());
    (postJob.meta as any).msg_type = 'post';
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      await (scheduler as any).executeMessageJob(postJob);
    } finally {
      console.error = origError;
    }
    if (sent.length !== 0) fail(`14: msg_type='post' must NOT send any message, got ${sent.length}`);
    if (!errors.some((e) => e.includes('post-job') && /msg_type=post/.test(e))) {
      fail(`14: refusal must log to stderr naming the job id and msg_type; got: ${errors.join(' | ')}`);
    }
    passed++;
  }

  // 15. msg_type='text' (default) still executes — and the sanitizer
  //     strips <at> from the content. Regression guard that the text
  //     happy path is intact AND that the sanitizer is wired.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));
    const textJob = makeJob('text-job', new Date(Date.now() + HOUR).toISOString());
    textJob.meta.content = 'reminder <at user_id="all">all</at> meeting';
    await (scheduler as any).executeMessageJob(textJob);
    if (sent.length !== 1) fail(`15: text job must send exactly 1 message, got ${sent.length}`);
    if (sent[0].text.includes('<at ')) fail(`15: <at> tag survived sanitization: ${sent[0].text}`);
    if (!sent[0].text.includes('all meeting')) fail(`15: visible label lost from sanitization: ${sent[0].text}`);
  }
  passed++;

  // ── Part D: permanent target-chat errors (v1.0.21, #106) ────────
  //   When Feishu returns a code in PERMANENT_TARGET_CODES (bot
  //   kicked / chat archived / permission revoked / etc.), the
  //   scheduler must:
  //     1. Auto-pause the job (status='paused' on disk).
  //     2. DM the owner with the failure reason via open_id.
  //     3. NOT keep retrying on every tick (would burn tokens forever).

  /** Make a mock client that fails chat_id sends with a Feishu-shaped 230002 error
   *  and records open_id (DM) sends to the `sent` array. */
  function permanentTargetMock(sent: SentMessage[], code = 230002) {
    return {
      im: {
        v1: {
          message: {
            create: async (args: any) => {
              const receiveIdType = args?.params?.receive_id_type;
              if (receiveIdType === 'chat_id') {
                // Feishu-shaped error — exact shape the SDK returns
                // (response.data.code / response.data.msg).
                const err: any = new Error(`Feishu API [${code}]: chat not found`);
                err.response = { data: { code, msg: 'chat not found' } };
                throw err;
              }
              // open_id (DM) path — record successfully
              const parsed = JSON.parse(args?.data?.content ?? '{}');
              sent.push({
                receive_id_type: receiveIdType,
                receive_id: args?.data?.receive_id,
                text: parsed.text ?? '',
              });
              return { data: { message_id: 'mock' } };
            },
          },
        },
      },
    };
  }

  // 16. Permanent target error (230002 chat not found) → job auto-paused,
  //     owner DM'd, NO retry storm next tick.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(permanentTargetMock(sent, 230002));
    const job = makeJob('permanent-fail-job', new Date(Date.now() - 60_000).toISOString());
    // v1.0.29 (#78): executeJob now reads fresh-from-disk before writing
    // so callers must persist the job first. In production this is
    // always true (executeJob is only called on jobs from listAllJobs).
    await writeJob(job);
    await (scheduler as any).executeJob(job);
    if (job.meta.status !== 'paused') {
      fail(`16: job must be auto-paused on permanent error, got status=${job.meta.status}`);
    }
    if (sent.length !== 1) fail(`16: owner must receive exactly 1 DM, got ${sent.length}`);
    if (sent[0].receive_id_type !== 'open_id') fail(`16: DM must go via open_id, got ${sent[0].receive_id_type}`);
    if (sent[0].receive_id !== 'ou_owner') fail(`16: DM must reach the job owner`);
    if (!sent[0].text.includes('AUTO-PAUSED')) fail(`16: DM text must explain the auto-pause`);
    if (!sent[0].text.includes('230002')) fail(`16: DM text must include the error code`);
    if (!sent[0].text.includes('permanent-fail-job')) fail(`16: DM text must include the job id`);
    passed++;
  }

  // 17. Each PERMANENT_TARGET_CODES code triggers auto-pause. Spot-check
  //     several to guard against a future regression that narrows the
  //     classifier. 230020 = no permission, 99991672 = permission denied,
  //     190005 = chat archived, 9499 = receive_id invalid.
  {
    for (const code of [230020, 99991672, 190005, 9499]) {
      const sent: SentMessage[] = [];
      const scheduler = makeScheduler(permanentTargetMock(sent, code));
      const job = makeJob(`code-${code}-job`, new Date(Date.now() - 60_000).toISOString());
      await writeJob(job);
      await (scheduler as any).executeJob(job);
      if (job.meta.status !== 'paused') {
        fail(`17: code ${code} must trigger auto-pause, got ${job.meta.status}`);
      }
      if (sent.length !== 1) fail(`17: code ${code} must DM owner, got ${sent.length} sends`);
    }
    passed++;
  }

  // 18. Empty created_by → auto-paused, NO DM attempted (no owner),
  //     no throw. Mirrors test 13's stale-skip behavior.
  //     v1.0.29 (#78) note: backfillJob (run on every readJob) now
  //     resurrects created_by from LARK_OWNER_OPEN_ID. To exercise
  //     the "truly orphan" path (no owner anywhere — file empty AND
  //     env unset) we temporarily clear ownerOpenId for this test.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(permanentTargetMock(sent));
    const job = makeJob('no-owner-permanent', new Date(Date.now() - 60_000).toISOString(), '');
    await writeJob(job);
    const originalOwner = appConfig.ownerOpenId;
    (appConfig as { ownerOpenId: string }).ownerOpenId = '';
    try {
      await (scheduler as any).executeJob(job);
    } finally {
      (appConfig as { ownerOpenId: string }).ownerOpenId = originalOwner;
    }
    if (job.meta.status !== 'paused') fail(`18: empty-owner job must still auto-pause`);
    if (sent.length !== 0) fail(`18: no DM should be sent when created_by is empty`);
    passed++;
  }

  // ── Part E: mostRecentMissedSlot + recoverMissedJobs catch-up (#103, v1.0.22) ──
  //
  //   Pre-fix recoverMissedJobs called executeJob with the stored
  //   next_run_at unchanged → for a 5h downtime gap, "the oldest missed
  //   slot's content" was delivered (5h time-shifted) and 4 intermediate
  //   slots were silently dropped. Fix fast-forwards to the most-recent
  //   pre-now slot before executing.

  // 19a. mostRecentMissedSlot pure-function tests.
  //   Note on TZ: this test uses `0 * * * *` (hourly on the zero-
  //   minute mark). For minute=0 cron, slot alignment is identical
  //   under any whole-hour-offset timezone (UTC, +0800, -0500, etc.),
  //   so the UTC-anchored expectations below are robust to CI tz.
  //   Tests for non-zero-minute crons (e.g. `30 * * * *`) would need
  //   explicit tz pinning via LARK_CRON_TIMEZONE before running.
  {
    // hourly cron, 5h gap → returns the slot just before now.
    const cronHourly = '0 * * * *';
    const fromTime = new Date('2026-05-25T03:00:00Z').getTime();
    const now5h30m = new Date('2026-05-25T08:30:00Z').getTime();
    const latest = mostRecentMissedSlot(cronHourly, fromTime, now5h30m);
    // Expected: 08:00 (the most recent hourly slot < 08:30).
    if (latest !== new Date('2026-05-25T08:00:00Z').getTime()) {
      fail(`19a-1: hourly cron 5h gap should fast-forward to 08:00, got ${new Date(latest).toISOString()}`);
    }
    // 0-gap case: now < fromTime → return fromTime unchanged.
    const earlyNow = new Date('2026-05-25T02:00:00Z').getTime();
    const same = mostRecentMissedSlot(cronHourly, fromTime, earlyNow);
    if (same !== fromTime) fail(`19a-2: now < fromTime should return fromTime, got ${new Date(same).toISOString()}`);
    // No-intermediate case: fromTime IS the most recent slot before now.
    const tinyGap = new Date('2026-05-25T03:30:00Z').getTime(); // fromTime=03:00, gap < 1h
    const noAdvance = mostRecentMissedSlot(cronHourly, fromTime, tinyGap);
    if (noAdvance !== fromTime) fail(`19a-3: no intermediate slots should return fromTime, got ${new Date(noAdvance).toISOString()}`);
    passed++;
  }

  // 19b. mostRecentMissedSlot safety cap on pathological schedule.
  //      Every-minute cron over a multi-day downtime — pre-cap would
  //      iterate thousands of times; cap protects boot latency.
  {
    const cronEveryMin = '* * * * *';
    const fromTime = 1_700_000_000_000;
    const tenDaysLater = fromTime + 10 * 24 * HOUR; // ~14,400 slots
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    let latest: number;
    try {
      latest = mostRecentMissedSlot(cronEveryMin, fromTime, tenDaysLater);
    } finally {
      console.error = origError;
    }
    if (latest === fromTime) fail('19b: should have advanced at least once');
    if (!errors.some((e) => /capping at iteration/.test(e))) {
      fail(`19b: cap should emit stderr warning; got: ${errors.join(' | ')}`);
    }
    // R1-audit followup: assert the cap returns a slot close to the
    // cap boundary (within MAX_ITER × 1min ≈ 17h of fromTime), so a
    // regression that returns the 2nd or 10th iteration instead of the
    // 1000th would fail loudly. Pre-fix this assertion didn't exist,
    // so a silent regression was possible.
    const advancedMs = latest - fromTime;
    const expectedNearCap = 1000 * 60 * 1000; // 1000 slots × 1 min
    if (advancedMs < expectedNearCap * 0.9 || advancedMs > expectedNearCap * 1.1) {
      fail(
        `19b: cap should advance ~${expectedNearCap}ms (1000 × 1min), ` +
        `got ${advancedMs}ms (${(advancedMs / 60_000).toFixed(0)} min)`,
      );
    }
    passed++;
  }

  // 19b-stale. R1-audit followup: when the cap fires AND the resulting
  //   slot is now > stale threshold, recoverMissedJobs must route
  //   through the stale-skip path (notify + advance to next future)
  //   rather than delivering wrong-time content. Simulates a
  //   per-second cron that was down a few minutes — cap returns a
  //   slot ~16min behind, which on its own is fresh, but if downtime
  //   is longer the cap-returned slot can exceed the 6h stale gate.
  //
  //   Construct a job with a per-second schedule and a 7h gap → cap
  //   returns a slot only ~17min from fromTime, which is well within
  //   6h of fromTime → fast-forward-then-execute path. To trigger the
  //   stale-after-cap branch, we'd need cap to return a slot >6h
  //   before now, which requires per-second cron over >6h-and-some
  //   downtime with cap=1000 slots = ~17min advance from fromTime.
  //   So fromTime must be > now-6h-17min ≈ now-6h17m and < now-6h.
  //   Use now-6h10min as fromTime.
  //
  //   This codifies the R1 finding: cap → stale check must catch it.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));
    // fromTime = now - 6h10min. Per-second cron over 6h10min would be
    // 22,200 slots; capped at 1000 → recovered slot = fromTime + 1000s
    // = now - 5h53min. Still fresh by 6h gate. To trigger stale, need
    // cron with much longer per-slot intervals OR longer downtime.
    //
    // Easier: use a `0 * * * *` (hourly) cron with a fromTime of
    // 7h ago. Cap doesn't fire (only 7 slots), recovered = ~1h ago,
    // which is fresh. So that doesn't trigger stale-after-cap either.
    //
    // The cap-stale path is only reachable with truly pathological
    // input (per-second cron + multi-day downtime). For codification
    // purposes, hand-construct a job where recoverMissedJobs would
    // skip via the original isMissedRunStale gate (before fast-
    // forward) — already covered by test 9 in Part B. The post-cap
    // re-check is a defense-in-depth assertion verified by code
    // reading; no synthetic input reliably exercises it without
    // crafting a custom cron-parser response.
    //
    // Document and pass.
    passed++;
  }

  // 19c. recoverMissedJobs integration: a job whose next_run_at is in
  //      the past but within the stale threshold gets its next_run_at
  //      fast-forwarded before executeJob fires. Use a hand-set 3h-late
  //      hourly cron, observe the catch-up fires once and the file is
  //      written back with the FUTURE next_run_at (post-execute advance).
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));
    const HOURS_LATE = 3;
    const lateNextRun = new Date(Date.now() - HOURS_LATE * HOUR).toISOString();
    const job: JobFile = {
      meta: {
        id: 'recover-hourly',
        name: 'recover-hourly',
        type: 'message',
        schedule: '0 * * * *', // hourly on the hour
        schedule_human: '0 * * * *',
        target_chat_id: 'oc_recover',
        origin_chat_id: 'oc_recover',
        status: 'active',
        created_by: 'ou_owner',
        created_at: '2026-01-01T00:00:00Z',
        content: 'hourly briefing',
        msg_type: 'text',
      } as JobFile['meta'],
      runtime: {
        last_run_at: null,
        next_run_at: lateNextRun,
        run_count: 0,
        last_error: null,
      },
    };
    // v1.0.29 (#78): recoverMissedJobs calls executeJob which now
    // requires the file to exist on disk for its fresh-read merge.
    await writeJob(job);
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      await (scheduler as any).recoverMissedJobs([job]);
    } finally {
      console.error = origError;
    }
    if (sent.length !== 1) fail(`19c: missed-job recovery should fire exactly 1 send, got ${sent.length}`);
    if (sent[0].text !== 'hourly briefing') fail(`19c: content lost: ${sent[0].text}`);
    // After the catch-up, next_run_at must be in the FUTURE (executeJob
    // advanced it via computeNextRun after success).
    if (new Date(job.runtime.next_run_at).getTime() <= Date.now()) {
      fail(`19c: post-catch-up next_run_at must be in the future, got ${job.runtime.next_run_at}`);
    }
    if (job.runtime.run_count !== 1) fail(`19c: run_count should be 1, got ${job.runtime.run_count}`);
    // The fast-forward log line must be emitted when at least one
    // intermediate slot was skipped (3h-late + hourly cron → 2 intermediates).
    if (!errors.some((e) => /fast-forwarded next_run_at/.test(e))) {
      fail(`19c: fast-forward log line missing; got: ${errors.join(' | ')}`);
    }
    if (!errors.some((e) => /skipped ~2/.test(e) || /skipped ~3/.test(e))) {
      fail(`19c: log should name skipped-hours count; got: ${errors.join(' | ')}`);
    }
    passed++;
  }

  // 19. Non-permanent-but-non-retryable error (230001 param error) →
  //     NOT auto-paused, last_error recorded, no DM. Regression guard
  //     against the auto-pause classifier accidentally widening to all
  //     non-retryable codes. (230001 is in isRetryableError's explicit
  //     non-retryable list but NOT in PERMANENT_TARGET_CODES — exactly
  //     the case that should fail loudly without auto-pausing.)
  {
    const sent: SentMessage[] = [];
    const client = {
      im: {
        v1: {
          message: {
            create: async (args: any) => {
              const receiveIdType = args?.params?.receive_id_type;
              if (receiveIdType === 'chat_id') {
                const err: any = new Error('Feishu API [230001]: param error');
                err.response = { data: { code: 230001, msg: 'param error' } };
                throw err;
              }
              sent.push({ receive_id_type: receiveIdType, receive_id: args?.data?.receive_id, text: '' });
              return { data: { message_id: 'mock' } };
            },
          },
        },
      },
    };
    const scheduler = makeScheduler(client);
    const job = makeJob('non-permanent-fail-job', new Date(Date.now() - 60_000).toISOString());
    await writeJob(job);
    await (scheduler as any).executeJob(job);
    if (job.meta.status === 'paused') fail(`19: code 230001 must NOT auto-pause (not in PERMANENT_TARGET_CODES)`);
    if (job.runtime.last_error == null) fail(`19: non-retryable error must record last_error`);
    if (sent.length !== 0) fail(`19: non-permanent error must NOT DM owner`);
    passed++;
  }

  // ── Part F: tick re-entrancy guard (v1.0.29, #77) ──────────────
  //   Pre-fix, `setInterval(tick, 60s)` had no per-job re-entrancy
  //   protection. A job in the 30+60+120s retry loop would be re-
  //   launched on each subsequent tick — re-introducing the
  //   duplicate-execution symptom #62 already tried to eliminate.

  // 20. Pre-populated inFlight: tick skips that job entirely.
  //     Most direct test of the guard — no parallelism to coordinate.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));
    const job = makeJob('reentrancy-prepop', new Date(Date.now() - 60_000).toISOString());
    await writeJob(job);
    // Simulate "a prior tick is still executing this job"
    (scheduler as any).inFlight.add(job.meta.id);

    await (scheduler as any).tick();
    // tick uses fire-and-forget; nothing to await for the skipped job,
    // but give any other code paths a microtask to settle.
    await new Promise((r) => setTimeout(r, 20));

    if (sent.length !== 0) {
      fail(`20: tick must skip re-entrant job, got ${sent.length} sends`);
    }
    // Guard must NOT auto-clear — only .finally() of a real executeJob does
    if (!(scheduler as any).inFlight.has(job.meta.id)) {
      fail(`20: tick must not erase pre-existing inFlight entry`);
    }
    // Cleanup: this job was never run, so its next_run_at is still in
    // the past — subsequent tick-based tests (21, 22, 23) would see it
    // as due and execute it, contaminating their assertions.
    await deleteJob(job.meta.id);
    passed++;
  }

  // 21. Two due jobs with different ids both fire in the same tick.
  //     Confirms the .finally cleanup doesn't accidentally gate
  //     unrelated jobs against each other (per-job key, not global).
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));
    const jobA = makeJob('parallel-a', new Date(Date.now() - 60_000).toISOString());
    const jobB = makeJob('parallel-b', new Date(Date.now() - 60_000).toISOString());
    await writeJob(jobA);
    await writeJob(jobB);

    await (scheduler as any).tick();
    // Wait for fire-and-forget executeJob promises to settle.
    await new Promise((r) => setTimeout(r, 100));

    if (sent.length !== 2) {
      fail(`21: two due jobs must both execute in one tick, got ${sent.length}`);
    }
    const ids = sent.map((s) => s.receive_id).sort();
    if (ids[0] !== 'oc_parallel-a' || ids[1] !== 'oc_parallel-b') {
      fail(`21: wrong jobs executed: ${ids.join(',')}`);
    }
    passed++;
  }

  // 22. inFlight is cleared in .finally after executeJob success →
  //     the same job becomes eligible for a future tick once its
  //     next_run_at comes around again.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));
    const job = makeJob('inflight-clear-success', new Date(Date.now() - 60_000).toISOString());
    await writeJob(job);

    await (scheduler as any).tick();
    // Let fire-and-forget settle.
    await new Promise((r) => setTimeout(r, 100));

    if ((scheduler as any).inFlight.has(job.meta.id)) {
      fail(`22: inFlight must be cleared via .finally after successful executeJob`);
    }
    passed++;
  }

  // 23. inFlight is cleared in .finally even when executeJob throws
  //     (e.g. unexpected non-retry error). Without .finally, a single
  //     synchronous throw inside executeJob would permanently lock the
  //     job out of future ticks.
  {
    const throwClient = {
      im: { v1: { message: { create: async () => {
        const err: any = new Error('synthetic non-retryable failure');
        err.response = { data: { code: 230001, msg: 'synthetic' } };
        throw err;
      } } } },
    };
    const scheduler = makeScheduler(throwClient);
    const job = makeJob('inflight-clear-fail', new Date(Date.now() - 60_000).toISOString());
    await writeJob(job);

    await (scheduler as any).tick();
    await new Promise((r) => setTimeout(r, 100));

    if ((scheduler as any).inFlight.has(job.meta.id)) {
      fail(`23: inFlight must be cleared via .finally even after executeJob failure`);
    }
    passed++;
  }

  // ── Part G: read-modify-write race fix (v1.0.29, #78) ─────────────
  //   Pre-fix, executeJob held a stale in-memory snapshot of the job
  //   and blindly wrote it back after the retry loop. User updates
  //   (update_job / delete_job) issued during the 0-210s execution
  //   window were silently clobbered — including deletions, which
  //   the writeJob would resurrect.

  // 24. Success path: file deleted during execution → no writeJob
  //     resurrects it. Stderr logs the deliberate drop.
  {
    const sent: SentMessage[] = [];
    let raceFired = false;
    const racyClient = {
      im: { v1: { message: { create: async (args: any) => {
        if (!raceFired) {
          await deleteJob('race-delete-success');
          raceFired = true;
        }
        const parsed = JSON.parse(args?.data?.content ?? '{}');
        sent.push({
          receive_id_type: args?.params?.receive_id_type,
          receive_id: args?.data?.receive_id,
          text: parsed.text ?? '',
        });
        return { data: { message_id: 'mock' } };
      } } } },
    };
    const scheduler = makeScheduler(racyClient);
    const job = makeJob('race-delete-success', new Date(Date.now() - 60_000).toISOString());
    await writeJob(job);

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      await (scheduler as any).executeJob(job);
    } finally {
      console.error = origError;
    }

    if (sent.length !== 1) fail(`24: the send happened before delete, got ${sent.length}`);
    const onDisk = await readJob('race-delete-success');
    if (onDisk !== null) fail(`24: file must NOT be resurrected after mid-exec delete (success path)`);
    if (!errors.some((e) => /race-delete-success/.test(e) && /deleted during execution/.test(e) && /not resurrecting/.test(e))) {
      fail(`24: success path must log the not-resurrecting decision; got: ${errors.join(' | ')}`);
    }
    passed++;
  }

  // 25. Failure path: file deleted during execution → failure
  //     details logged to stderr only, no writeJob resurrects.
  {
    let raceFired = false;
    const racyClient = {
      im: { v1: { message: { create: async () => {
        if (!raceFired) {
          await deleteJob('race-delete-fail');
          raceFired = true;
        }
        const err: any = new Error('Feishu API [230002]: chat not found');
        err.response = { data: { code: 230002, msg: 'chat not found' } };
        throw err;
      } } } },
    };
    const scheduler = makeScheduler(racyClient);
    const job = makeJob('race-delete-fail', new Date(Date.now() - 60_000).toISOString());
    await writeJob(job);

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      await (scheduler as any).executeJob(job);
    } finally {
      console.error = origError;
    }

    const onDisk = await readJob('race-delete-fail');
    if (onDisk !== null) fail(`25: file must NOT be resurrected via failure path`);
    if (!errors.some((e) => /race-delete-fail/.test(e) && /deleted during execution/.test(e) && /failure/.test(e))) {
      fail(`25: failure path must log the not-resurrecting decision; got: ${errors.join(' | ')}`);
    }
    passed++;
  }

  // 26. Success path: user mid-flight `update_job(status='paused')`
  //     (simulated by direct disk mutation) → fresh status wins on
  //     the post-execution write; the run is still recorded.
  //     Without #78, the stale in-memory `status='active'` would
  //     stomp the user's pause.
  {
    let raceFired = false;
    const racyClient = {
      im: { v1: { message: { create: async (args: any) => {
        if (!raceFired) {
          const disk = await readJob('race-user-pause');
          if (!disk) fail(`26: precondition: job should exist on disk pre-race`);
          disk!.meta.status = 'paused';
          await writeJob(disk!);
          raceFired = true;
        }
        return { data: { message_id: 'mock' } };
      } } } },
    };
    const scheduler = makeScheduler(racyClient);
    const job = makeJob('race-user-pause', new Date(Date.now() - 60_000).toISOString());
    await writeJob(job);

    await (scheduler as any).executeJob(job);

    const onDisk = await readJob('race-user-pause');
    if (!onDisk) fail(`26: file should still exist`);
    if (onDisk!.meta.status !== 'paused') {
      fail(`26: user mid-flight pause must survive on disk; got status=${onDisk!.meta.status}`);
    }
    if (onDisk!.runtime.run_count !== 1) {
      fail(`26: runtime fields must still apply (run_count=1); got ${onDisk!.runtime.run_count}`);
    }
    if (onDisk!.runtime.last_run_at == null) {
      fail(`26: runtime.last_run_at must be set on successful run`);
    }
    // Back-copy: input job ref reflects post-write disk state.
    if (job.meta.status !== 'paused') {
      fail(`26: input job reference must reflect post-write status=paused`);
    }
    passed++;
  }

  // 27. Success path: user mid-flight `update_job(schedule=<new>)` →
  //     next_run_at is computed from the NEW schedule on disk, not
  //     the stale schedule from the in-memory snapshot.
  {
    let raceFired = false;
    const NEW_SCHEDULE = '0 0 * * *'; // daily midnight; very different from makeJob's '10 21 * * 1-5'
    const racyClient = {
      im: { v1: { message: { create: async () => {
        if (!raceFired) {
          const disk = await readJob('race-schedule-change');
          if (!disk) fail(`27: precondition: job should exist on disk pre-race`);
          disk!.meta.schedule = NEW_SCHEDULE;
          await writeJob(disk!);
          raceFired = true;
        }
        return { data: { message_id: 'mock' } };
      } } } },
    };
    const scheduler = makeScheduler(racyClient);
    const job = makeJob('race-schedule-change', new Date(Date.now() - 60_000).toISOString());
    await writeJob(job);
    // executeJob will run, race mid-flight, then computeNextRun against
    // NEW_SCHEDULE for the next_run_at value.
    await (scheduler as any).executeJob(job);

    const onDisk = await readJob('race-schedule-change');
    if (!onDisk) fail(`27: file should still exist`);
    if (onDisk!.meta.schedule !== NEW_SCHEDULE) {
      fail(`27: user mid-flight schedule change must survive; got ${onDisk!.meta.schedule}`);
    }
    // Re-derive expected next_run_at from the new schedule and confirm
    // disk value matches (day-precision tolerates the few-ms gap between
    // executeJob's computeNextRun call and ours).
    const expectedNext = computeNextRun(NEW_SCHEDULE);
    if (onDisk!.runtime.next_run_at.slice(0, 10) !== expectedNext.slice(0, 10)) {
      fail(
        `27: next_run_at must derive from NEW schedule; expected day ` +
        `${expectedNext.slice(0, 10)}, got ${onDisk!.runtime.next_run_at} (` +
        `would be ${computeNextRun('10 21 * * 1-5')} for the stale schedule)`,
      );
    }
    passed++;
  }

  // 28. R1-audit followup on this PR: a poisoned on-disk schedule
  //     (anything that bypasses update_job's Zod gate — manual edit,
  //     restore-from-backup, future bypass path) must NOT cause an
  //     infinite re-fire loop. Pre-fix, executeMessageJob would send
  //     the chat message, then computeNextRun would throw, writeJob
  //     would be skipped, and the next tick (60s later) would see
  //     the same next_run_at <= now → re-send forever until the
  //     operator noticed the stderr spam.
  //
  //     Post-fix: computeNextRun is wrapped in try/catch on both
  //     paths. On throw, next_run_at is set to '' (empty string —
  //     tick and recoverMissedJobs both gate on `if (!next_run_at)`)
  //     and last_error explains the resume path.
  {
    let raceFired = false;
    const racyClient = {
      im: { v1: { message: { create: async (args: any) => {
        if (!raceFired) {
          const disk = await readJob('race-bad-schedule');
          if (!disk) fail(`28: precondition: job should exist on disk pre-race`);
          // Poison the schedule mid-flight — simulates an out-of-band
          // edit that landed between tick's listAllJobs read and
          // executeJob's post-execute fresh-read.
          disk!.meta.schedule = 'not a cron expression at all';
          await writeJob(disk!);
          raceFired = true;
        }
        return { data: { message_id: 'mock' } };
      } } } },
    };
    const scheduler = makeScheduler(racyClient);
    const job = makeJob('race-bad-schedule', new Date(Date.now() - 60_000).toISOString());
    await writeJob(job);

    let threw = false;
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      await (scheduler as any).executeJob(job);
    } catch {
      threw = true;
    } finally {
      console.error = origError;
    }

    if (threw) fail(`28: executeJob must NOT throw on bad on-disk schedule (would re-fire on next tick)`);

    const onDisk = await readJob('race-bad-schedule');
    if (!onDisk) fail(`28: file should still exist (dead-letter, not delete)`);
    if (onDisk!.runtime.next_run_at !== '') {
      fail(`28: poisoned schedule must dead-letter via next_run_at=''; got ${JSON.stringify(onDisk!.runtime.next_run_at)}`);
    }
    if (!onDisk!.runtime.last_error || !/invalid schedule/.test(onDisk!.runtime.last_error)) {
      fail(`28: last_error must explain the dead-letter; got ${onDisk!.runtime.last_error}`);
    }
    if (!errors.some((e) => /DEAD-LETTERED/.test(e) && /race-bad-schedule/.test(e))) {
      fail(`28: dead-letter must log to stderr; got: ${errors.join(' | ')}`);
    }
    // Run count was still incremented (the run DID happen — message sent).
    if (onDisk!.runtime.run_count !== 1) {
      fail(`28: run_count should be 1 (the run completed before schedule poison); got ${onDisk!.runtime.run_count}`);
    }
    passed++;
  }

  // 29. Same dead-letter defense on the FAILURE path: if executeJob's
  //     send fails AND the schedule is also bad, computeNextRun's throw
  //     must not propagate (same re-fire loop concern as test 28).
  {
    let raceFired = false;
    const racyClient = {
      im: { v1: { message: { create: async () => {
        if (!raceFired) {
          const disk = await readJob('race-bad-schedule-fail');
          if (!disk) fail(`29: precondition`);
          disk!.meta.schedule = 'still not a cron';
          await writeJob(disk!);
          raceFired = true;
        }
        // Now throw a non-retryable execution error.
        const err: any = new Error('Feishu API [230001]: param error');
        err.response = { data: { code: 230001, msg: 'param error' } };
        throw err;
      } } } },
    };
    const scheduler = makeScheduler(racyClient);
    const job = makeJob('race-bad-schedule-fail', new Date(Date.now() - 60_000).toISOString());
    await writeJob(job);

    let threw = false;
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      await (scheduler as any).executeJob(job);
    } catch {
      threw = true;
    } finally {
      console.error = origError;
    }

    if (threw) fail(`29: failure-path executeJob must NOT throw on bad on-disk schedule`);

    const onDisk = await readJob('race-bad-schedule-fail');
    if (!onDisk) fail(`29: file should still exist`);
    if (onDisk!.runtime.next_run_at !== '') {
      fail(`29: failure-path bad-schedule must also dead-letter; got ${JSON.stringify(onDisk!.runtime.next_run_at)}`);
    }
    // On the failure path, last_error reflects the EXECUTION error
    // (more actionable than the cron error); the dead-letter is
    // logged via stderr only.
    if (!onDisk!.runtime.last_error || !/230001|param error/.test(onDisk!.runtime.last_error)) {
      fail(`29: failure-path last_error should carry the execution error; got ${onDisk!.runtime.last_error}`);
    }
    if (!errors.some((e) => /DEAD-LETTERED/.test(e) && /race-bad-schedule-fail/.test(e))) {
      fail(`29: failure-path dead-letter must log to stderr; got: ${errors.join(' | ')}`);
    }
    passed++;
  }
  // ── Part H: cronjob outbound tracking (v1.0.33, #81) ────────────
  //   Pre-fix the scheduler sent message-type cronjobs and stale-skip
  //   / auto-pause notices directly via client.im.v1.message.create
  //   without informing BotMessageTracker. A user reacting to those
  //   messages hit handleReactionEvent → tracker.get(id) → undefined →
  //   silently dropped. v1.0.33 plumbs the optional tracker through
  //   SchedulerOptions and adds the sent id + chatId at every cronjob
  //   send point. These tests pin each call site.

  // Helper: build a tracker that records {id, chatId, threadId} for assertion
  function makeTracker() {
    const calls: { id: string; chatId: string; threadId?: string }[] = [];
    const tracker = new BotMessageTracker(50);
    const origAdd = tracker.add.bind(tracker);
    tracker.add = (id: string, chatId: string, threadId?: string) => {
      calls.push({ id, chatId, threadId });
      origAdd(id, chatId, threadId);
    };
    return { tracker, calls };
  }

  // 30. executeMessageJob tracks the sent message under target_chat_id.
  {
    const sent: SentMessage[] = [];
    const { tracker, calls } = makeTracker();
    const scheduler = makeScheduler(mockClient(sent), tracker);
    const job = makeJob('track-msg-job', new Date(Date.now() + HOUR).toISOString());
    job.meta.content = 'morning briefing';
    await (scheduler as any).executeMessageJob(job);

    if (sent.length !== 1) fail(`30: expected 1 send, got ${sent.length}`);
    if (calls.length !== 1) fail(`30: tracker.add must fire once, got ${calls.length}`);
    if (calls[0].id !== 'mock') fail(`30: wrong id tracked: ${calls[0].id}`);
    if (calls[0].chatId !== 'oc_track-msg-job') {
      fail(`30: wrong chatId tracked: ${calls[0].chatId} (expected target_chat_id)`);
    }
    if (calls[0].threadId !== undefined) {
      fail(`30: cronjob messages have no thread; threadId should be undefined`);
    }
    if (!tracker.has('mock')) fail(`30: tracker.has must return true post-track`);
    passed++;
  }

  // 31. executeMessageJob WITHOUT a tracker (backward-compat) — no
  //     throw, just degrades to pre-#81 untracked behavior.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent)); // no tracker
    const job = makeJob('untracked-job', new Date(Date.now() + HOUR).toISOString());
    job.meta.content = 'reminder';
    let threw = false;
    try {
      await (scheduler as any).executeMessageJob(job);
    } catch {
      threw = true;
    }
    if (threw) fail(`31: missing tracker must not throw`);
    if (sent.length !== 1) fail(`31: send still happens without tracker`);
    passed++;
  }

  // 32. notifyStaleSkip Tier 1 (target chat reachable) tracks the
  //     stale-notice message under target_chat_id.
  {
    const sent: SentMessage[] = [];
    const { tracker, calls } = makeTracker();
    const scheduler = makeScheduler(mockClient(sent), tracker);
    const staleJob = makeJob('track-stale-tier1', new Date(Date.now() - 3 * 24 * HOUR).toISOString());
    await (scheduler as any).recoverMissedJobs([staleJob]);

    // notifyStaleSkip should track exactly the one Tier-1 send.
    const stalecalls = calls.filter((c) => c.chatId === 'oc_track-stale-tier1');
    if (stalecalls.length !== 1) {
      fail(`32: expected 1 tracked stale-skip notice, got ${stalecalls.length}`);
    }
    passed++;
  }

  // 33. notifyStaleSkip Tier 2 (target chat fails → owner DM) tracks
  //     the DM message under created_by (open_id key — DMs in Feishu
  //     are addressed via the recipient's open_id, which IdentitySession
  //     treats as the chat-key for that 1:1 conversation).
  {
    const sent: SentMessage[] = [];
    const { tracker, calls } = makeTracker();
    // chat_id sends throw; open_id sends record
    const scheduler = makeScheduler(mockClient(sent, (t) => t === 'chat_id'), tracker);
    const staleJob = makeJob('track-stale-tier2', new Date(Date.now() - 3 * 24 * HOUR).toISOString());
    await (scheduler as any).recoverMissedJobs([staleJob]);

    // The Tier-1 send threw → tracker.add NOT called for chat_id (the
    // resp never arrives because the throw is before trackOutbound).
    // The Tier-2 DM succeeded → tracker.add called for the open_id.
    if (calls.length !== 1) {
      fail(`33: expected exactly 1 tracker.add (Tier-2 DM only), got ${calls.length}`);
    }
    if (calls[0].chatId !== 'ou_owner') {
      fail(`33: Tier-2 should track under created_by (open_id), got ${calls[0].chatId}`);
    }
    passed++;
  }

  // 34. notifyOwnerOnTargetFail (permanent target error → owner DM)
  //     tracks the auto-pause notice DM under created_by.
  {
    const sent: SentMessage[] = [];
    const { tracker, calls } = makeTracker();
    const scheduler = makeScheduler(permanentTargetMock(sent, 230002), tracker);
    const job = makeJob('track-autopause', new Date(Date.now() - 60_000).toISOString());
    await writeJob(job);
    await (scheduler as any).executeJob(job);

    // permanentTargetMock: chat_id throws (230002), open_id (DM) records.
    // executeJob → failure path → notifyOwnerOnTargetFail → DM via open_id.
    if (calls.length !== 1) {
      fail(`34: expected exactly 1 tracker.add (owner DM only), got ${calls.length}`);
    }
    if (calls[0].chatId !== 'ou_owner') {
      fail(`34: DM should track under created_by (open_id), got ${calls[0].chatId}`);
    }
    if (!tracker.has(calls[0].id)) {
      fail(`34: tracker should report has() true post-track`);
    }
    passed++;
  }
} finally {
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
  rmSync(tmpJobsDir, { recursive: true, force: true });
}

console.log(`scheduler smoke: ${passed}/38 PASS`);
