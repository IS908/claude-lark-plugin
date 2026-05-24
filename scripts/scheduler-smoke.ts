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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMissedRunStale, JobScheduler } from '../src/scheduler.js';
import { IdentitySession } from '../src/identity-session.js';
import { appConfig } from '../src/config.js';
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

function makeScheduler(client: any): JobScheduler {
  return new JobScheduler({
    server: mockServer as any,
    client,
    identitySession: new IdentitySession(() => null),
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
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(permanentTargetMock(sent));
    const job = makeJob('no-owner-permanent', new Date(Date.now() - 60_000).toISOString(), '');
    await (scheduler as any).executeJob(job);
    if (job.meta.status !== 'paused') fail(`18: empty-owner job must still auto-pause`);
    if (sent.length !== 0) fail(`18: no DM should be sent when created_by is empty`);
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
    await (scheduler as any).executeJob(job);
    if (job.meta.status === 'paused') fail(`19: code 230001 must NOT auto-pause (not in PERMANENT_TARGET_CODES)`);
    if (job.runtime.last_error == null) fail(`19: non-retryable error must record last_error`);
    if (sent.length !== 0) fail(`19: non-permanent error must NOT DM owner`);
    passed++;
  }
} finally {
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
  rmSync(tmpJobsDir, { recursive: true, force: true });
}

console.log(`scheduler smoke: ${passed}/19 PASS`);
