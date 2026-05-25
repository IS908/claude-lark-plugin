/**
 * Prompt-job auto-pause smoke (v1.0.50, closes #121).
 *
 * Message-type cronjobs auto-pause on a single permanent target error
 * via `executeMessageJob`'s synchronous Feishu call path (#106). Prompt-
 * type cronjobs take a different route: dispatch a notification → Claude
 * turn → Claude's `reply` tool calls Feishu. The scheduler never sees
 * the failure directly. Pre-fix: a broken prompt-cronjob fired a full
 * Claude turn on every tick (token waste with no convergence).
 *
 * Fix: `reply` tool's `handlePermanentTargetError` path now signals
 * the scheduler via the `setCronjobOutcomeHandler` callback. Scheduler
 * tracks `consecutive_target_failures` on `job.runtime` and auto-pauses
 * after MAX_CONSECUTIVE_PROMPT_TARGET_FAILURES (3). Success resets.
 *
 * Layout:
 *   Part A — parseJobIdFromThread pure helper (3 tests)
 *   Part B — notePromptJobOutcome 'permanent_failure' increments + auto-pauses (3 tests)
 *   Part C — notePromptJobOutcome 'success' resets (1 test)
 *   Part D — recycle protection on the counter path (1 test)
 *   Part E — end-to-end via the cronjob outcome handler hook (2 tests)
 */

process.env.LARK_CRON_TIMEZONE = 'UTC';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobScheduler } from '../src/scheduler.js';
import { parseJobIdFromThread, setCronjobOutcomeHandler, handlePermanentTargetError } from '../src/tools.js';
import { IdentitySession } from '../src/identity-session.js';
import { appConfig } from '../src/config.js';
import { writeJob, readJob, deleteJob } from '../src/job-store.js';
import type { JobFile } from '../src/job-store.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;

// ── Part A: parseJobIdFromThread pure helper ──

// 1. Standard synthetic shape: prefix + jobId + -timestamp
{
  const out = parseJobIdFromThread('job-mydeploy-1748189428000');
  if (out !== 'mydeploy') fail(`1: expected 'mydeploy', got '${out}'`);
  passed++;
}

// 2. JobId containing hyphens AND trailing digits (sanitizeJobId allows
//    `cron-2026` — must not consume jobId's own digits).
{
  const out = parseJobIdFromThread('job-cron-2026-1748189428000');
  if (out !== 'cron-2026') fail(`2: expected 'cron-2026', got '${out}'`);
  passed++;
}

// 3. Non-cronjob thread_id returns null; missing returns null
{
  if (parseJobIdFromThread('thread_normal_chat') !== null) fail(`3: non-prefix should return null`);
  if (parseJobIdFromThread(undefined) !== null) fail(`3: undefined should return null`);
  if (parseJobIdFromThread('') !== null) fail(`3: empty should return null`);
  if (parseJobIdFromThread('job-') !== null) fail(`3: empty jobId should return null`);
  passed++;
}

// ── Setup for integration tests ──

const tmpJobsDir = mkdtempSync(join(tmpdir(), 'prompt-job-pause-'));
const originalJobsDir = appConfig.jobsDir;
(appConfig as { jobsDir: string }).jobsDir = tmpJobsDir;

interface SentMessage { receive_id: string; text: string }

function mockClient(sent: SentMessage[]) {
  return {
    im: {
      v1: {
        message: {
          create: async (args: any) => {
            const parsed = JSON.parse(args?.data?.content ?? '{}');
            sent.push({ receive_id: args?.data?.receive_id, text: parsed.text ?? '' });
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

function makePromptJob(id: string, createdAt = '2026-01-01T00:00:00Z'): JobFile {
  return {
    meta: {
      id,
      name: id,
      type: 'prompt',
      schedule: '*/15 * * * *',
      schedule_human: 'every 15 min',
      target_chat_id: `oc_${id}`,
      origin_chat_id: `oc_${id}`,
      status: 'active',
      created_by: 'ou_owner',
      created_at: createdAt,
      prompt: 'do the task',
    } as JobFile['meta'],
    runtime: { last_run_at: null, next_run_at: new Date(Date.now() + 60_000).toISOString(), run_count: 0, last_error: null },
  };
}

try {
  // ── Part B: notePromptJobOutcome 'permanent_failure' ──

  // 4. First failure: counter goes 0 → 1, job stays active.
  {
    const scheduler = makeScheduler(mockClient([]));
    const job = makePromptJob('inc-test-1');
    await writeJob(job);

    await scheduler.notePromptJobOutcome('inc-test-1', 'permanent_failure', { code: 230002, reason: 'chat_not_found' });

    const after = await readJob('inc-test-1');
    if (!after) fail(`4: file disappeared`);
    if (after.runtime.consecutive_target_failures !== 1) {
      fail(`4: counter should be 1, got ${after.runtime.consecutive_target_failures}`);
    }
    if (after.meta.status !== 'active') {
      fail(`4: should still be active after 1 failure, got status=${after.meta.status}`);
    }
    await deleteJob('inc-test-1');
    passed++;
  }

  // 5. Second failure: counter 1 → 2, still active.
  {
    const scheduler = makeScheduler(mockClient([]));
    const job = makePromptJob('inc-test-2');
    job.runtime.consecutive_target_failures = 1;
    await writeJob(job);

    await scheduler.notePromptJobOutcome('inc-test-2', 'permanent_failure', { code: 230002, reason: 'chat_not_found' });

    const after = await readJob('inc-test-2');
    if (after!.runtime.consecutive_target_failures !== 2) {
      fail(`5: counter should be 2, got ${after!.runtime.consecutive_target_failures}`);
    }
    if (after!.meta.status !== 'active') {
      fail(`5: should still be active after 2 failures`);
    }
    await deleteJob('inc-test-2');
    passed++;
  }

  // 6. Third failure: counter reaches threshold → AUTO-PAUSED.
  {
    const sent: SentMessage[] = [];
    const scheduler = makeScheduler(mockClient(sent));
    const job = makePromptJob('inc-test-3');
    job.runtime.consecutive_target_failures = 2;
    await writeJob(job);

    await scheduler.notePromptJobOutcome('inc-test-3', 'permanent_failure', { code: 230002, reason: 'chat_not_found' });

    const after = await readJob('inc-test-3');
    if (after!.runtime.consecutive_target_failures !== 3) {
      fail(`6: counter should reach 3, got ${after!.runtime.consecutive_target_failures}`);
    }
    if (after!.meta.status !== 'paused') {
      fail(`6: should be AUTO-PAUSED at threshold, got status=${after!.meta.status}`);
    }
    // Owner DM should fire
    const dm = sent.find(s => s.receive_id === 'ou_owner');
    if (!dm) fail(`6: owner DM should fire on auto-pause`);
    if (!dm!.text.includes('AUTO-PAUSED')) {
      fail(`6: DM should mention AUTO-PAUSED, got "${dm!.text.slice(0, 80)}"`);
    }
    await deleteJob('inc-test-3');
    passed++;
  }

  // ── Part C: 'success' resets ──

  // 7. Success after a partial-failure streak resets counter to 0.
  {
    const scheduler = makeScheduler(mockClient([]));
    const job = makePromptJob('reset-test');
    job.runtime.consecutive_target_failures = 2; // 2 consecutive failures, then success
    await writeJob(job);

    await scheduler.notePromptJobOutcome('reset-test', 'success');

    const after = await readJob('reset-test');
    if (after!.runtime.consecutive_target_failures !== 0) {
      fail(`7: success must reset counter to 0, got ${after!.runtime.consecutive_target_failures}`);
    }
    if (after!.meta.status !== 'active') {
      fail(`7: success must NOT pause; status should remain active`);
    }
    await deleteJob('reset-test');
    passed++;
  }

  // ── Part D: recycle protection ──

  // 8. Counter increment on a recycled job ID — the OLD-shape failure
  //    landing on disk after recycle would corrupt the NEW job's
  //    counter. The fix's READ-MODIFY-WRITE shape preserves the NEW
  //    job's `created_at` + meta; only `consecutive_target_failures`
  //    is updated. Pre-fix would have ALSO clobbered the meta with
  //    OLD meta; the readJob-then-modify pattern protects against
  //    that without needing explicit isRecycledJob (the read returns
  //    NEW, the failure-attribution is best-effort by nature, and
  //    incrementing NEW's counter from a stale signal is acceptable
  //    — NEW will reset on its own success). This test documents the
  //    actual behavior + verifies meta survives.
  {
    const scheduler = makeScheduler(mockClient([]));
    const newJob = makePromptJob('recycle-test', '2026-06-15T00:00:00Z');
    newJob.runtime.consecutive_target_failures = 0;
    await writeJob(newJob);

    // Signal a permanent_failure (e.g. an OLD turn's defer landing
    // after recycle). The fix's read-modify-write keeps the NEW
    // meta intact and increments the NEW counter.
    await scheduler.notePromptJobOutcome('recycle-test', 'permanent_failure', { code: 230002, reason: 'chat_not_found' });

    const after = await readJob('recycle-test');
    if (after!.meta.created_at !== '2026-06-15T00:00:00Z') {
      fail(`8: NEW meta.created_at must be preserved, got ${after!.meta.created_at}`);
    }
    if (after!.runtime.consecutive_target_failures !== 1) {
      fail(`8: NEW counter should be 1 (single increment), got ${after!.runtime.consecutive_target_failures}`);
    }
    await deleteJob('recycle-test');
    passed++;
  }

  // ── Part E: end-to-end via the cronjob outcome handler hook ──

  // 9. R1-followup: genuine end-to-end through handlePermanentTargetError.
  //    Pre-followup this test re-imported tools.js with dead code and
  //    just called notePromptJobOutcome directly — same as Part B, no
  //    actual coverage of the handler-wiring chain. Now: wire the
  //    handler, synthesize a Feishu permanent error, call
  //    handlePermanentTargetError with a synthetic cronjob thread_id,
  //    verify the counter increments via the full chain
  //    (handlePermanentTargetError → cronjobOutcomeHandler →
  //    scheduler.notePromptJobOutcome → fs writeJob).
  {
    const scheduler = makeScheduler(mockClient([]));
    const job = makePromptJob('e2e-handler-test');
    await writeJob(job);

    let handlerSeen: { jobId: string; kind: string } | null = null;
    setCronjobOutcomeHandler((jobId, kind, ctx) => {
      handlerSeen = { jobId, kind };
      void scheduler.notePromptJobOutcome(jobId, kind, ctx);
    });

    // Synthetic Feishu permanent target error (shape from feishu-retry.ts)
    const err: any = new Error('mock: chat not found');
    err.response = { data: { code: 230002, msg: 'chat_not_found' } };

    // Call handlePermanentTargetError as the reply tool's catch block
    // would, with the cronjob synthetic thread_id.
    const fakeThreadId = `job-e2e-handler-test-${Date.now()}`;
    const result = handlePermanentTargetError(err, {
      tool: 'reply',
      chat_id: 'oc_e2e-handler-test',
      thread_id: fakeThreadId,
    });

    // The handler returns a defer payload for the reply tool to return.
    if (!result || !result.isError) {
      fail(`9: handlePermanentTargetError should return a defer payload, got ${JSON.stringify(result)}`);
    }
    // Handler chain should have been invoked synchronously
    if (!handlerSeen) fail(`9: cronjobOutcomeHandler was not invoked`);
    if ((handlerSeen as any).jobId !== 'e2e-handler-test') fail(`9: wrong jobId, got ${(handlerSeen as any).jobId}`);
    if ((handlerSeen as any).kind !== 'permanent_failure') fail(`9: wrong kind, got ${(handlerSeen as any).kind}`);

    // notePromptJobOutcome is async (void-wrapped) — wait for fs write
    await new Promise((r) => setTimeout(r, 30));

    const after = await readJob('e2e-handler-test');
    if (after!.runtime.consecutive_target_failures !== 1) {
      fail(`9: end-to-end chain should increment counter on disk, got ${after!.runtime.consecutive_target_failures}`);
    }
    await deleteJob('e2e-handler-test');
    passed++;
  }

  // 10. Deleted job: notePromptJobOutcome gracefully no-ops (no
  //     crash, no resurrection).
  {
    const scheduler = makeScheduler(mockClient([]));
    // No job at this id
    await scheduler.notePromptJobOutcome('ghost-id', 'permanent_failure', { code: 230002, reason: 'gone' });
    // If we reach here without crash, success
    const after = await readJob('ghost-id');
    if (after !== null) fail(`10: ghost job must not be resurrected, got ${JSON.stringify(after)}`);
    passed++;
  }
} finally {
  (appConfig as { jobsDir: string }).jobsDir = originalJobsDir;
  rmSync(tmpJobsDir, { recursive: true, force: true });
}

console.log(`prompt-job-auto-pause smoke: ${passed}/${passed} PASS`);
