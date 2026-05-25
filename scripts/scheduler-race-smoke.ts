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
    // R1-followup tighter contract: lock the FULL runtime snapshot to
    // catch a future regression that selectively writes back individual
    // fields (e.g. refactor below `computeNextRun` that skips only
    // run_count). Without these, a partial writeback could pass while
    // still corrupting the new job's `next_run_at` (would lose its
    // scheduled fire) or `last_error` (would surface OLD failure to
    // operator who thinks the NEW job is broken).
    if (onDisk.runtime.last_error !== null) {
      fail(`6: new job's last_error polluted, got "${onDisk.runtime.last_error}"`);
    }
    if (onDisk.runtime.next_run_at !== newJob.runtime.next_run_at) {
      fail(`6: new job's next_run_at stomped, got '${onDisk.runtime.next_run_at}'`);
    }
    if (onDisk.meta.created_at !== '2026-06-15T00:00:00Z') {
      fail(`6: new job's created_at clobbered, got '${onDisk.meta.created_at}'`);
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
  //
  //     R1-followup: mock now succeeds for owner DM (`ou_owner`) so
  //     the test's stderr stays clean. Pre-followup the mock threw on
  //     EVERY receive_id including the owner DM that fires after
  //     auto-pause, producing a stack-trace in the smoke output that
  //     looked like a failure but was actually expected behavior.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(
      mockClient(sent, (rid) => (rid === 'ou_owner' ? null : permanentTargetError(230002))),
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
    // Confirm owner DM fired (auto-pause path notifies)
    const ownerDm = sent.find(s => s.receive_id === 'ou_owner');
    if (!ownerDm) fail(`10: owner DM should fire after auto-pause`);
    if (!ownerDm.text.includes('AUTO-PAUSED')) {
      fail(`10: owner DM should mention AUTO-PAUSED, got "${ownerDm.text.slice(0, 80)}"`);
    }

    await deleteJob('real-pause-test');
    passed++;
  }

  // 12. R2-followup integration: CAS-on-delete prevents OLD's
  //     finally from clearing NEW's recycled slot. Pre-followup,
  //     `inFlight.delete(id)` was id-only — so the moment OLD
  //     finished, NEW's slot vanished even though NEW was still in
  //     flight. A subsequent tick would then see no slot for `id`
  //     and re-launch NEW (the exact #77 duplicate-execution bug,
  //     on the recycled job).
  //
  //     Deterministic setup using mock blocking: both OLD and NEW's
  //     mock sends block on a promise we control. We fire ticks
  //     1/2/3 with full control over which executions are still in
  //     flight when each tick decides. The acid test is tick 3:
  //       - WITH CAS:    OLD's earlier finally was a no-op (slot
  //                      holds B, captured A) → NEW's slot intact
  //                      → tick 3 sees `B === B` → BLOCKED → no
  //                      duplicate execution.
  //       - WITHOUT CAS: OLD's finally deleted the slot → tick 3
  //                      sees no slot → launches NEW AGAIN.
  //     We verify post-release that NEW ran exactly once (sends
  //     filtered for 'new-content' === 1, and on-disk run_count === 1).
  {
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    const oldBlock = new Promise<void>(r => { releaseOld = r; });
    const newBlock = new Promise<void>(r => { releaseNew = r; });
    const sends: { text: string }[] = [];

    const blockingClient = {
      im: { v1: { message: { create: async (args: any) => {
        const text = JSON.parse(args?.data?.content ?? '{}').text ?? '';
        sends.push({ text });
        if (text === 'old-content') await oldBlock;
        if (text === 'new-content') await newBlock;
        return { data: { message_id: 'mock' } };
      } } } },
    };
    const scheduler = makeScheduler(blockingClient as any);
    const inFlight = (scheduler as any).inFlight as Map<string, string>;

    // OLD on disk, fires immediately
    const oldJob = makeJob({
      id: 'cas-cleanup',
      createdAt: '2026-01-01T00:00:00Z',
      content: 'old-content',
    });
    oldJob.runtime.next_run_at = new Date(Date.now() - 60_000).toISOString();
    await writeJob(oldJob);

    // Tick 1: launches OLD (will block in mock.create)
    await (scheduler as any).tick();
    await new Promise(r => setTimeout(r, 30)); // let mock send begin + block

    if (inFlight.get('cas-cleanup') !== '2026-01-01T00:00:00Z') {
      fail(`12a: tick 1 should set slot to A, got '${inFlight.get('cas-cleanup')}'`);
    }
    if (sends.length !== 1 || sends[0].text !== 'old-content') {
      fail(`12a: tick 1 should have started OLD's send, sends=${JSON.stringify(sends)}`);
    }

    // Recycle: replace file with NEW
    const newJob = makeJob({
      id: 'cas-cleanup',
      createdAt: '2026-06-15T00:00:00Z',
      content: 'new-content',
    });
    newJob.runtime.next_run_at = new Date(Date.now() - 60_000).toISOString();
    await writeJob(newJob);

    // Tick 2: should release (A vs B), set slot to B, launch NEW
    await (scheduler as any).tick();
    await new Promise(r => setTimeout(r, 30));

    if (inFlight.get('cas-cleanup') !== '2026-06-15T00:00:00Z') {
      fail(`12b: tick 2 should overwrite slot with B, got '${inFlight.get('cas-cleanup')}'`);
    }
    if (sends.length !== 2 || sends[1].text !== 'new-content') {
      fail(`12b: tick 2 should have started NEW's send, sends=${JSON.stringify(sends)}`);
    }

    // Release OLD. Its post-send runs: readJob → NEW; isRecycledJob
    // → true → return. Finally CAS: slot holds B, captured A →
    // mismatch → no delete. POST-FIX behavior.
    releaseOld();
    await new Promise(r => setTimeout(r, 30));

    // Slot MUST still hold B (NEW still in flight via newBlock)
    if (inFlight.get('cas-cleanup') !== '2026-06-15T00:00:00Z') {
      fail(`12c: OLD's finally cleared NEW's slot — CAS regression. Slot='${inFlight.get('cas-cleanup')}'`);
    }

    // Tick 3: the acid test. WITHOUT CAS, slot would be empty here
    // and tick 3 would re-launch NEW. WITH CAS, slot holds B and
    // tick 3's gate sees B === B → blocked.
    // But first we need next_run_at to be in the past again (NEW's
    // initial value was past, hasn't been written back yet because
    // NEW is still blocked).
    await (scheduler as any).tick();
    await new Promise(r => setTimeout(r, 30));

    // CRITICAL ASSERTION: no third send. WITHOUT CAS this would be
    // 3 (old + 2x new — duplicate execution).
    if (sends.length !== 2) {
      fail(`12d: tick 3 launched a duplicate execution — CAS regression. ` +
           `sends.length=${sends.length} (expected 2: 1 OLD + 1 NEW), ` +
           `texts=[${sends.map(s => s.text).join(', ')}]`);
    }

    // Release NEW. Post-send: writeback. run_count=1. Finally CAS
    // (slot B, captured B → delete).
    releaseNew();
    await new Promise(r => setTimeout(r, 30));

    if (inFlight.has('cas-cleanup')) {
      fail(`12e: NEW's finally CAS should have cleared its own slot`);
    }

    const onDisk = await readJob('cas-cleanup');
    if (!onDisk) fail('12: file disappeared');
    if (onDisk.runtime.run_count !== 1) {
      fail(`12: NEW run_count expected 1, got ${onDisk.runtime.run_count} ` +
           `(0 = NEW never wrote back; 2+ = duplicate execution)`);
    }

    await deleteJob('cas-cleanup');
    passed++;
  }

  // 11. R1-followup integration: inFlight is now (id, created_at) so
  //     a recycle DURING execution can run on the NEXT tick. Direct
  //     unit test of the Map keying — the bare Set behavior would have
  //     blocked the NEW job's tick on the still-pending OLD entry.
  {
    const scheduler = makeScheduler(mockClient([]));
    const inFlight = (scheduler as any).inFlight as Map<string, string>;

    // OLD execution begins — tick adds entry
    inFlight.set('foo', '2026-01-01T00:00:00Z');

    // Recycled NEW job's tick checks: SAME id but DIFFERENT created_at
    // — must NOT be treated as "still in flight".
    if (inFlight.get('foo') === '2026-06-15T00:00:00Z') {
      fail(`11: identity check should differ — same id, different created_at`);
    }
    // The actual tick gate is `inFlight.get(id) === job.meta.created_at`
    // — a recycle has different created_at → gate releases.
    const newCreatedAt = '2026-06-15T00:00:00Z';
    const blockedByGate = inFlight.get('foo') !== undefined && inFlight.get('foo') === newCreatedAt;
    if (blockedByGate) fail(`11: recycled job blocked by stale in-flight entry`);

    // The OLD job is still blocked though (correct — its execution
    // is mid-flight, can't re-launch).
    const oldCreatedAt = '2026-01-01T00:00:00Z';
    const oldBlocked = inFlight.get('foo') !== undefined && inFlight.get('foo') === oldCreatedAt;
    if (!oldBlocked) fail(`11: same-identity tick should still be blocked`);

    inFlight.delete('foo'); // cleanup
    passed++;
  }

  // 13. #156 cleanup-batch-2: recoverMissedJobs re-reads + isRecycledJob
  //     check before executeJob. Pre-fix, if a delete_job+create_job
  //     landed in the few-ms tier-1/tier-2 notification window, the
  //     OLD snapshot's executeMessageJob fired OLD content to OLD
  //     target (executeJob's own isRecycledJob caught the runtime
  //     writeback but couldn't undo the side effect). Post-fix the
  //     re-read catches the recycle BEFORE the send fires.
  //
  //     Scenario: seed OLD job with stale next_run_at, then write NEW
  //     job (same id, different created_at) before recoverMissedJobs
  //     iterates. The OLD snapshot reaches the executeJob call, but
  //     our new re-read sees the recycle and skips — no send.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));

    // OLD job in the past, NOT stale (so it would normally be recovered)
    const pastButNotStale = new Date(Date.now() - 60_000).toISOString();
    const oldJob = makeJob({
      id: 'recover-recycle',
      createdAt: '2026-01-01T00:00:00Z',
      content: 'OLD content',
    });
    oldJob.runtime.next_run_at = pastButNotStale;

    // Write NEW job to disk BEFORE recoverMissedJobs runs — simulates
    // a delete+create that landed between listAllJobs and the per-job
    // executeJob.
    const newJob = makeJob({
      id: 'recover-recycle',
      createdAt: '2026-06-15T00:00:00Z',
      content: 'NEW content',
    });
    newJob.runtime.next_run_at = new Date(Date.now() + 60_000).toISOString(); // future, won't trigger
    await writeJob(newJob);

    // Call recoverMissedJobs with the OLD snapshot in the inbound list.
    // executeJob is reached but the re-read should catch the recycle
    // and skip — NO send to either OLD or NEW target.
    await (scheduler as any).recoverMissedJobs([oldJob]);

    if (sent.length !== 0) {
      fail(`13: recoverMissedJobs should skip OLD execute after recycle, got ${sent.length} sends: ${JSON.stringify(sent)}`);
    }
    // NEW job on disk untouched
    const onDisk = await readJob('recover-recycle');
    if (!onDisk) fail('13: NEW job file disappeared');
    if (onDisk.meta.content !== 'NEW content') {
      fail(`13: NEW job's meta corrupted, got ${onDisk.meta.content}`);
    }

    await deleteJob('recover-recycle');
    passed++;
  }

  // 14. #156: recoverMissedJobs skips when file was DELETED during
  //     the recovery loop (no recycle, just removed). Existing
  //     "deleted during execution" log inside executeJob already
  //     handles this if executeJob is reached, but our pre-execute
  //     re-read short-circuits earlier — symmetric.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));

    const pastButNotStale = new Date(Date.now() - 60_000).toISOString();
    const ghostJob = makeJob({
      id: 'recover-deleted',
      createdAt: '2026-01-01T00:00:00Z',
    });
    ghostJob.runtime.next_run_at = pastButNotStale;
    // Do NOT write to disk — simulates the file already being deleted.

    await (scheduler as any).recoverMissedJobs([ghostJob]);

    if (sent.length !== 0) {
      fail(`14: recoverMissedJobs should skip deleted-file path, got ${sent.length} sends`);
    }
    passed++;
  }
} finally {
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
  rmSync(tmpJobsDir, { recursive: true, force: true });
}

console.log(`scheduler-race smoke: ${passed}/${passed} PASS`);
