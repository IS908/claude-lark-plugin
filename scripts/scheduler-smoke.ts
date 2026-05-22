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
} finally {
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
  rmSync(tmpJobsDir, { recursive: true, force: true });
}

console.log(`scheduler smoke: ${passed}/13 PASS`);
