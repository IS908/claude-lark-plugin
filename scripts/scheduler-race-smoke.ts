/**
 * Scheduler race smoke (v1.0.43, closes #132 #133 #134).
 *
 * All three issues are races between an in-flight `executeJob` call
 * and a concurrent operator `update_job` / `delete_job` + `create_job`
 * on the same id. They all touch the same fresh-read merge in
 * `executeJob`, so we batch-fix them under one PR and one smoke.
 *
 * Layout:
 *   Part A — `isRecycledJob` pure helper contract (5 tests)
 *   Part B — #134: delete+create same-id recycle (success + failure)
 *   Part C — #133: mid-flight type/target divergence is LOGGED but
 *            run_count still increments (semantic preserved)
 *   Part D — #132: target_chat_id changed mid-flight → permanent
 *            target error does NOT auto-pause (respects retarget)
 *
 * Mock client mirrors scheduler-smoke.ts. Permanent-target errors
 * use Feishu code 230002 (chat not found) which short-circuits the
 * retry loop instantly — keeps the smoke fast.
 */

// Pin tz before importing config (same rationale as scheduler-smoke.ts)
process.env.LARK_CRON_TIMEZONE = 'UTC';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobScheduler, isRecycledJob } from '../src/scheduler.js';
import { IdentitySession } from '../src/identity-session.js';
import { appConfig } from '../src/config.js';
import { writeJob, readJob, deleteJob } from '../src/job-store.js';
import type { JobFile } from '../src/job-store.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;

// ── Mock client + helpers ──

interface SentMessage { receive_id: string; text: string }

/**
 * Mock client. If `throwOn` returns an error object for a given
 * receive_id, that call throws (used to simulate permanent target
 * failures with Feishu code 230002).
 */
function mockClient(
  sent: SentMessage[],
  throwOn: (receiveId: string) => Error | null = () => null,
) {
  return {
    im: {
      v1: {
        message: {
          create: async (args: any) => {
            const receiveId = args?.data?.receive_id;
            const err = throwOn(receiveId);
            if (err) throw err;
            const parsed = JSON.parse(args?.data?.content ?? '{}');
            sent.push({ receive_id: receiveId, text: parsed.text ?? '' });
            return { data: { message_id: 'mock' } };
          },
        },
      },
    },
  };
}

const mockServer = { notification: async () => {} };

function makeScheduler(client: any): JobScheduler {
  return new JobScheduler({
    server: mockServer as any,
    client,
    identitySession: new IdentitySession(() => null),
  });
}

function makeJob(opts: {
  id: string;
  createdAt: string;
  target?: string;
  type?: 'message' | 'prompt';
  content?: string;
}): JobFile {
  return {
    meta: {
      id: opts.id,
      name: opts.id,
      type: opts.type ?? 'message',
      schedule: '10 21 * * 1-5',
      schedule_human: '10 21 * * 1-5',
      target_chat_id: opts.target ?? `oc_${opts.id}`,
      origin_chat_id: opts.target ?? `oc_${opts.id}`,
      status: 'active',
      created_by: 'ou_owner',
      created_at: opts.createdAt,
      content: opts.content ?? 'hi',
      msg_type: 'text',
    } as JobFile['meta'],
    runtime: { last_run_at: null, next_run_at: new Date(Date.now() + 60_000).toISOString(), run_count: 0, last_error: null },
  };
}

function permanentTargetError(code = 230002): Error {
  const err = new Error(`mock: chat not found (Feishu ${code})`);
  (err as any).response = { data: { code, msg: 'chat_not_found' } };
  return err;
}

// ── Part A: isRecycledJob pure helper ──

// 1. Different created_at → recycled
{
  const a = makeJob({ id: 'a', createdAt: '2026-01-01T00:00:00Z' });
  const b = makeJob({ id: 'a', createdAt: '2026-01-02T00:00:00Z' });
  if (!isRecycledJob(a, b)) fail('1: different created_at must be recycled');
  passed++;
}

// 2. Same created_at → not recycled
{
  const a = makeJob({ id: 'a', createdAt: '2026-01-01T00:00:00Z' });
  const b = makeJob({ id: 'a', createdAt: '2026-01-01T00:00:00Z' });
  if (isRecycledJob(a, b)) fail('2: same created_at must NOT be recycled');
  passed++;
}

// 3. Legacy job (empty created_at on either side) → fall back to NOT
//    recycled — preserves pre-fix behavior for legacy data we can't
//    reliably classify.
{
  const a = makeJob({ id: 'a', createdAt: '' });
  const b = makeJob({ id: 'a', createdAt: '2026-01-02T00:00:00Z' });
  if (isRecycledJob(a, b)) fail('3a: empty original.created_at must NOT be flagged');
  if (isRecycledJob(b, a)) fail('3b: empty fresh.created_at must NOT be flagged');
  const c = makeJob({ id: 'a', createdAt: '' });
  if (isRecycledJob(a, c)) fail('3c: both empty must NOT be flagged');
  passed++;
}

// 4. Identity check is on created_at NOT on other meta. Same created_at
//    but different target — NOT recycled (target divergence is a
//    different concern, handled by #133/#132 logic).
{
  const a = makeJob({ id: 'a', createdAt: '2026-01-01T00:00:00Z', target: 'oc_old' });
  const b = makeJob({ id: 'a', createdAt: '2026-01-01T00:00:00Z', target: 'oc_new' });
  if (isRecycledJob(a, b)) fail('4: target change alone is NOT a recycle');
  passed++;
}

// 5. Same created_at as a string equality check — even a microsecond
//    apart counts as a different job. ISO-8601 strings are compared
//    by character; sub-second precision matters.
{
  const a = makeJob({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' });
  const b = makeJob({ id: 'a', createdAt: '2026-01-01T00:00:00.001Z' });
  if (!isRecycledJob(a, b)) fail('5: 1ms-apart created_at must be recycled (string-equal)');
  passed++;
}

// ── Setup for integration tests ──

const tmpJobsDir = mkdtempSync(join(tmpdir(), 'sched-race-smoke-'));
const originalJobsDir = appConfig.jobsDir;
(appConfig as { jobsDir: string }).jobsDir = tmpJobsDir;

try {
  // ── Part B: #134 recycle race ──

  // 6. Success path — OLD job's runtime writeback is SKIPPED when
  //    the file has been replaced by a NEW job (different created_at).
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));

    // OLD job — write to disk first so readJob can find it
    const oldJob = makeJob({ id: 'recycle-test', createdAt: '2026-01-01T00:00:00Z', content: 'old' });
    await writeJob(oldJob);

    // Simulate: delete + create with same id while executeJob is
    // about to do its fresh-read writeback. We hand-replace the
    // file with the NEW job's content.
    const newJob = makeJob({ id: 'recycle-test', createdAt: '2026-06-15T00:00:00Z', content: 'new' });
    newJob.runtime.run_count = 5; // new job has its own history
    newJob.runtime.last_run_at = '2026-06-15T01:00:00Z';
    await writeJob(newJob);

    // Now run executeJob with the OLD snapshot. The send already
    // "happened" (we'll let it succeed). The post-send fresh-read
    // sees NEW; recycle guard must skip writeback.
    await (scheduler as any).executeJob(oldJob);

    const onDisk = await readJob('recycle-test');
    if (!onDisk) fail('6: file disappeared');
    if (onDisk.meta.content !== 'new') fail('6: new meta corrupted');
    if (onDisk.runtime.run_count !== 5) {
      fail(`6: new job's run_count corrupted, got ${onDisk.runtime.run_count} (expected 5)`);
    }
    if (onDisk.runtime.last_run_at !== '2026-06-15T01:00:00Z') {
      fail(`6: new job's last_run_at stomped, got ${onDisk.runtime.last_run_at}`);
    }
    // The OLD send DID happen (intended behavior — in-flight execution
    // owns its side effect).
    if (sent.length !== 1) fail(`6: expected 1 send, got ${sent.length}`);
    if (sent[0].text !== 'old') fail(`6: send should use OLD content, got "${sent[0].text}"`);

    await deleteJob('recycle-test');
    passed++;
  }

  // 7. Failure path — OLD job's failure writeback (including auto-
  //    pause) is SKIPPED when the file has been recycled.
  {
    const sent: SentMessage[] = [];
    // Mock the OLD target to throw permanent target error.
    const scheduler = makeScheduler(
      mockClient(sent, (rid) => (rid === 'oc_old_target' ? permanentTargetError(230002) : null)),
    );

    const oldJob = makeJob({ id: 'recycle-fail', createdAt: '2026-01-01T00:00:00Z', target: 'oc_old_target' });
    await writeJob(oldJob);

    // Replace with NEW job using a DIFFERENT target (so the OLD
    // failure shouldn't auto-pause the new one)
    const newJob = makeJob({ id: 'recycle-fail', createdAt: '2026-06-15T00:00:00Z', target: 'oc_new_target' });
    await writeJob(newJob);

    await (scheduler as any).executeJob(oldJob);

    const onDisk = await readJob('recycle-fail');
    if (!onDisk) fail('7: file disappeared');
    if (onDisk.meta.target_chat_id !== 'oc_new_target') fail('7: new target corrupted');
    // Critical: new job must remain active (NOT auto-paused by the
    // OLD execution's failure)
    if (onDisk.meta.status !== 'active') {
      fail(`7: new job auto-paused by OLD failure, got status=${onDisk.meta.status}`);
    }
    if (onDisk.runtime.last_error !== null) {
      fail(`7: new job's last_error polluted by OLD failure, got "${onDisk.runtime.last_error}"`);
    }

    await deleteJob('recycle-fail');
    passed++;
  }

  // ── Part C: #133 mid-flight type/target divergence ──

  // 8. type changed mid-flight — log fires, run_count still increments
  //    (semantic preserved: the run DID happen, just under OLD meta).
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));

    const oldSnap = makeJob({ id: 'divergence-test', createdAt: '2026-01-01T00:00:00Z', type: 'message', content: 'msg-content' });
    await writeJob(oldSnap);

    // Mid-flight user changes type to prompt (same created_at — NOT
    // a recycle; just a meta update)
    const updated: JobFile = {
      meta: { ...oldSnap.meta, type: 'prompt', prompt: 'do-stuff' } as JobFile['meta'],
      runtime: { ...oldSnap.runtime },
    };
    await writeJob(updated);

    await (scheduler as any).executeJob(oldSnap);

    const onDisk = await readJob('divergence-test');
    if (!onDisk) fail('8: file disappeared');
    // run_count incremented (the run DID happen)
    if (onDisk.runtime.run_count !== 1) {
      fail(`8: run_count should increment to 1, got ${onDisk.runtime.run_count}`);
    }
    // Meta reflects the FRESH (user's update)
    if (onDisk.meta.type !== 'prompt') fail(`8: meta.type should be 'prompt', got '${onDisk.meta.type}'`);

    await deleteJob('divergence-test');
    passed++;
  }

  // ── Part D: #132 target retarget skips auto-pause ──

  // 9. Permanent target error fires, BUT operator retargeted mid-
  //    flight — auto-pause must be SKIPPED (NEW target gets a chance).
  {
    const sent: SentMessage[] = [];
    // OLD target throws permanent; NEW target would succeed (not
    // tried this tick, since the in-flight already sent to OLD).
    const scheduler = makeScheduler(
      mockClient(sent, (rid) => (rid === 'oc_kicked' ? permanentTargetError(230002) : null)),
    );

    const oldSnap = makeJob({ id: 'retarget-test', createdAt: '2026-01-01T00:00:00Z', target: 'oc_kicked' });
    await writeJob(oldSnap);

    // Operator retargets mid-flight (same created_at — just an update)
    const retargeted: JobFile = {
      meta: { ...oldSnap.meta, target_chat_id: 'oc_new_target' } as JobFile['meta'],
      runtime: { ...oldSnap.runtime },
    };
    await writeJob(retargeted);

    await (scheduler as any).executeJob(oldSnap);

    const onDisk = await readJob('retarget-test');
    if (!onDisk) fail('9: file disappeared');
    // Critical: status must remain 'active' (retarget preserved)
    if (onDisk.meta.status !== 'active') {
      fail(`9: retarget should skip auto-pause, got status='${onDisk.meta.status}'`);
    }
    // Target reflects user's retarget
    if (onDisk.meta.target_chat_id !== 'oc_new_target') {
      fail(`9: target reverted by writeback, got '${onDisk.meta.target_chat_id}'`);
    }
    // The OLD failure still recorded in last_error (operator can see
    // why this tick didn't deliver to the new target either — old
    // execution can't migrate mid-API-call).
    if (onDisk.runtime.last_error === null) {
      fail(`9: last_error should still record the OLD failure for visibility`);
    }

    await deleteJob('retarget-test');
    passed++;
  }

  // 10. Target UNCHANGED + permanent error → auto-pause STILL fires
  //     (the #132 fix is conditional, not an unconditional disable).
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(
      mockClient(sent, () => permanentTargetError(230002)),
    );

    const job = makeJob({ id: 'real-pause-test', createdAt: '2026-01-01T00:00:00Z', target: 'oc_dead' });
    await writeJob(job);
    // No mid-flight change — disk still shows oc_dead

    await (scheduler as any).executeJob(job);

    const onDisk = await readJob('real-pause-test');
    if (!onDisk) fail('10: file disappeared');
    if (onDisk.meta.status !== 'paused') {
      fail(`10: unchanged target + permanent error should AUTO-PAUSE, got status='${onDisk.meta.status}'`);
    }

    await deleteJob('real-pause-test');
    passed++;
  }
} finally {
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
  rmSync(tmpJobsDir, { recursive: true, force: true });
}

console.log(`scheduler-race smoke: ${passed}/${passed} PASS`);
