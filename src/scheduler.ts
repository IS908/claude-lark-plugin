/**
 * Job Scheduler — periodic scan + execution + crash recovery.
 *
 * Runs as a setInterval in the MCP server process. On each tick,
 * reads all active jobs and executes any whose next_run_at has passed.
 * On startup, recovers missed jobs (at most one execution per job).
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { appConfig } from './config.js';
import { cronJobPrompt } from './prompts.js';
import { sanitizeOutboundText } from './tools.js';
import type { IdentitySession } from './identity-session.js';
import type { BotMessageTracker } from './channel.js';
import {
  listAllJobs,
  readJob,
  writeJob,
  computeNextRun,
  mostRecentMissedSlot,
  type JobFile,
} from './job-store.js';

/**
 * Prefix for synthetic `thread_id` values injected into cronjob channel
 * notifications. Used only for IdentitySession isolation per cronjob run —
 * NOT a real Feishu thread. Consumers that route messages to Feishu threads
 * (e.g. the `reply` tool) must exclude thread_ids with this prefix.
 */
export const JOB_THREAD_PREFIX = 'job-';

export interface SchedulerOptions {
  server: Server;
  client: Lark.Client;
  identitySession: IdentitySession;
  /**
   * Optional botMessageTracker (#81). When present, every cronjob outbound
   * message (message-type job, stale-skip notice, owner-DM auto-pause
   * notice) is tracked so reactions on those messages flow through
   * `handleReactionEvent` instead of being silently dropped. Optional
   * because legacy callers (and tests) may construct the scheduler
   * without one; absence just degrades to pre-#81 behavior for the
   * reaction-on-cronjob-message UX.
   */
  botMessageTracker?: BotMessageTracker;
}

// ─── Retry Logic ────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAYS = [30_000, 60_000, 120_000]; // 30s, 60s, 120s

// ─── Crash-recovery staleness ───────────────────────────────

/**
 * Catch-up grace for `recoverMissedJobs`. A job whose scheduled run was
 * missed by more than this is treated as stale: the run is skipped and
 * `next_run_at` advanced to the next future occurrence instead.
 *
 * Rationale: crash recovery exists for outages (restart / reboot / deploy,
 * or a laptop closed for a few hours). A job recovered much later delivers
 * wrong-time content — a market pre-open briefing fired the next morning,
 * say. This was sharpened by the #68 incident: a job wrongly skipped for 3
 * days would, without this guard, fire a 3-day-stale run the moment it
 * became visible again. 6 hours covers a normal restart and a typical
 * laptop-closed-for-the-afternoon gap while still rejecting day-plus
 * staleness.
 */
const RECOVERY_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * True when a missed scheduled run is too stale to be worth catching up.
 * Pure function — exported for unit testing.
 */
export function isMissedRunStale(
  nextRunAtMs: number,
  nowMs: number,
  thresholdMs: number = RECOVERY_STALE_THRESHOLD_MS,
): boolean {
  return nowMs - nextRunAtMs > thresholdMs;
}

// #112 fix: classification + helpers moved to src/feishu-retry.ts so
// the hot-path call sites (reply, edit_message, react, ack-reaction)
// share the same "retryable" definition. Re-export PERMANENT_TARGET_CODES
// and the getter helpers for back-compat (tests + tools.ts already
// import them from here).
import {
  PERMANENT_TARGET_CODES,
  isRetryableError,
  getFeishuApiCode,
  getFeishuApiMsg,
} from './feishu-retry.js';
export { PERMANENT_TARGET_CODES, getFeishuApiCode, getFeishuApiMsg };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * #134 helper: detect whether a fresh-read JobFile represents a
 * different "logical" job from the original (same sanitized id /
 * filename, but the original was deleted and a new one created in
 * the ≤210s execution window).
 *
 * Identity is the `(id, created_at)` tuple. Returns true ONLY when
 * BOTH sides have non-empty `created_at` AND they differ — a missing
 * `created_at` on either side (legacy job pre-dating the field, or a
 * future schema migration that nulls it) falls through to "no
 * recycle detected" so we preserve pre-fix behavior rather than
 * spuriously skipping writebacks on legacy data.
 *
 * R1-followup asymmetry note: a legacy OLD snapshot (`created_at: ''`)
 * delete+create-replaced by a NEW job with a real timestamp returns
 * `false` here — the OLD execution WILL stomp the NEW job's runtime.
 * This is the documented trade-off: detecting "OLD lacks created_at,
 * NEW has one" as a recycle would also flag the common case of an
 * operator running create_job to re-attribute a legacy job, where
 * the OLD snapshot is genuinely the same logical job. Legacy jobs
 * are typically long-running daily/weekly cronjobs (not delete+create
 * churn targets); the asymmetric gap is acceptable and shrinks every
 * time an operator touches a legacy job via update_job (which now
 * always sets created_at).
 *
 * Pure helper, exported `static`-style at module scope so the smoke
 * test can pin the contract without instantiating a full scheduler.
 */
export function isRecycledJob(original: JobFile, fresh: JobFile): boolean {
  const a = original.meta.created_at;
  const b = fresh.meta.created_at;
  if (!a || !b) return false;
  return a !== b;
}

export class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  private server: Server;
  private client: Lark.Client;
  private identitySession: IdentitySession;
  private botMessageTracker: BotMessageTracker | undefined;
  private running = false;
  /**
   * Per-job re-entrancy guard (#77, v1.0.29; recycle-aware in v1.0.43).
   *
   * `tick()` runs on a 60s setInterval, but `executeJob()` can sit inside
   * the retry loop for up to 210s (30 + 60 + 120). Without this guard,
   * the second tick would see the same job's `next_run_at <= now`
   * (because runtime isn't persisted until the retry loop exits) and
   * fire executeJob a second time — duplicate execution, the exact
   * symptom #62 already tried to eliminate via filename-as-id.
   *
   * v1.0.43 #134 fix: switched from `Set<string>` (keyed on bare id) to
   * `Map<string, string>` (id → created_at) so the guard respects the
   * `(id, created_at)` identity tuple introduced by `isRecycledJob`.
   * Pre-fix, a `delete_job('foo')` + `create_job('foo')` during the
   * 210s in-flight window would have the NEW job's tick blocked by
   * the OLD execution's still-pending `inFlight` entry — the new job
   * would miss its first fire even though the OLD execution's
   * writeback now correctly skips. Post-fix, `tick()` skips only
   * when `inFlight.get(id) === job.meta.created_at`; a different
   * `created_at` (recycled job) is treated as a distinct logical
   * job and gets its own re-entrancy slot.
   *
   * Legacy jobs without `created_at` (very old jobs that pre-date
   * the field) use the empty string as their key value. Two legacy
   * jobs with the same id would still collide — but the PRE-#134
   * design had no way to distinguish them either; this matches the
   * pre-fix legacy behavior.
   *
   * Cleanup uses CAS-on-delete (R2-followup correction): the
   * finally-block compares the slot's current value to the
   * `created_at` captured in tick()'s closure and only deletes on
   * match. Without this, a recycle could play out as:
   *   1. tick: inFlight.set(foo, A); launch executeJob(A)
   *   2. recycle: file replaced with B
   *   3. tick: inFlight.get(foo)=A, jobA.created_at=B → release;
   *      inFlight.set(foo, B); launch executeJob(B)
   *   4. A finishes; A's finally — if id-only — runs
   *      inFlight.delete(foo), erasing B's entry; B is now
   *      unprotected and a third tick could re-launch it
   * The CAS makes step 4 a no-op for A (slot holds B, not A), so
   * B's re-entrancy stays gated until B's own finally fires.
   *
   * NOT used by recoverMissedJobs — start() awaits recoverMissedJobs
   * before installing the tick timer, so the two paths are temporally
   * disjoint.
   */
  private inFlight = new Map<string, string>();

  constructor(opts: SchedulerOptions) {
    this.server = opts.server;
    this.client = opts.client;
    this.identitySession = opts.identitySession;
    this.botMessageTracker = opts.botMessageTracker;
  }

  /**
   * Track an outbound cronjob message in botMessageTracker (#81) so a
   * user reaction to it lands on the reaction handler with a recognized
   * (id, chatId) pair. Best-effort — never throws. `chatId` is the
   * receive_id the send used (a real `oc_xxx` chat id for chat_id sends,
   * the recipient's `ou_xxx` open_id for DM sends — both work as
   * chat-key in `IdentitySession` because DMs are addressed via the
   * recipient's open_id).
   *
   * Cronjob outbound has no `thread_id` — message-type jobs and
   * scheduler notices are single, fresh sends (not replies into an
   * existing thread). `setCaller` will key by chat-level only, which
   * is correct: a reaction to a cronjob message belongs to whoever
   * reacted, not to the cronjob owner.
   */
  private trackOutbound(resp: any, chatId: string): void {
    if (!this.botMessageTracker) return;
    const id = resp?.data?.message_id;
    if (id && chatId) {
      this.botMessageTracker.add(id, chatId);
      return;
    }
    // R2-audit followup: a successful send that lacks message_id in
    // the response (malformed Feishu response, future SDK shape drift)
    // would silently fail to track. Without a breadcrumb the symptom
    // — "reactions on cronjob messages still don't land post-#81" —
    // would be indistinguishable from the original bug. Log once per
    // call so the operator can grep for the regression.
    console.error(
      `[scheduler] trackOutbound: no message_id in response or empty chatId ` +
      `(id=${id ? 'set' : 'missing'} chatId=${chatId ? 'set' : 'empty'}); ` +
      `cronjob message not tracked, reactions on it will not route`,
    );
  }

  /**
   * Start the scheduler: run crash recovery, then begin periodic ticks.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Load the job inventory once and log it. Gives the operator immediate
    // visibility into what jobs exist — the #68 incident was hard to
    // diagnose partly because a dead job was invisible. A surprising name
    // here (e.g. a "premarket-news.bak" sitting next to "premarket-news")
    // is the operator's cue that a stray *.json — a backup copy? — in the
    // jobs dir has become a live job (every *.json is one, since v1.0.9).
    const jobs = await listAllJobs();
    if (jobs.length > 0) {
      console.error(
        `[scheduler] Loaded ${jobs.length} job(s): ${jobs.map((j) => j.meta.id).join(', ')}`,
      );
    } else {
      console.error('[scheduler] No jobs configured');
    }

    // Crash recovery — execute missed jobs once (skipping stale ones)
    await this.recoverMissedJobs(jobs);

    // Start periodic scan
    const intervalMs = appConfig.cronScanInterval * 1000;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[scheduler] Tick error:', err);
      });
    }, intervalMs);

    console.error(`[scheduler] Started (scan every ${appConfig.cronScanInterval}s)`);
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.error('[scheduler] Stopped');
  }

  /**
   * On startup, find active jobs whose next_run_at is in the past and
   * execute them once (most recent missed execution only).
   *
   * A missed run more than {@link RECOVERY_STALE_THRESHOLD_MS} old is
   * considered stale: the run is skipped and `next_run_at` advanced to the
   * next future occurrence, so the job resumes its normal schedule without
   * delivering wrong-time content. See {@link isMissedRunStale}.
   *
   * Takes the already-loaded job list from {@link start} to avoid a second
   * `listAllJobs` read.
   */
  private async recoverMissedJobs(jobs: JobFile[]): Promise<void> {
    const now = Date.now();

    for (const job of jobs) {
      if (job.meta.status !== 'active') continue;
      if (!job.runtime.next_run_at) continue;

      const nextRun = new Date(job.runtime.next_run_at).getTime();
      if (nextRun >= now) continue; // not missed

      // Per-job try/catch — matches tick()'s pattern. The stale path's
      // computeNextRun (throws on a malformed cron) and writeJob (throws
      // on an FS error) would otherwise propagate to start() → main() and
      // abort plugin startup. One bad job must not kill recovery for the
      // rest, nor the whole process.
      try {
        if (isMissedRunStale(nextRun, now)) {
          const lateHours = ((now - nextRun) / 3_600_000).toFixed(1);
          console.error(
            `[scheduler] Skipping stale missed job ${job.meta.id}: ${lateHours}h late ` +
            `(> ${RECOVERY_STALE_THRESHOLD_MS / 3_600_000}h threshold). Rescheduling to next occurrence.`,
          );
          // Advance the schedule FIRST so the job is no longer stale on the
          // next startup — must happen regardless of whether the notice
          // below succeeds.
          job.runtime.next_run_at = computeNextRun(job.meta.schedule);
          await writeJob(job);
          // Then tell the job's chat (best-effort) — a stderr line alone
          // is invisible to the operator (#68 follow-up). notifyStaleSkip
          // never throws.
          await this.notifyStaleSkip(job, lateHours);
          continue;
        }

        // #103 fix (v1.0.22): catch-up runs the MOST RECENT missed slot,
        // not the OLDEST. Pre-fix, recoverMissedJobs called executeJob
        // with the stored next_run_at unchanged — for an hourly job that
        // was down 03:00→08:30, that meant delivering "03:00 content" at
        // 08:30 (5h time-shift) while silently dropping the 04:00–08:00
        // slots. Now: fast-forward next_run_at to the latest pre-now
        // slot so the catch-up reflects "what should have just fired".
        // executeJob still advances to the next future slot after success.
        const recovered = mostRecentMissedSlot(job.meta.schedule, nextRun, now);
        // R1-audit followup: re-check stale after fast-forward. The
        // `isMissedRunStale` gate at line 234 ran on the ORIGINAL nextRun
        // (fresh). If `mostRecentMissedSlot` hit its 1000-iter cap (per-
        // second crons over a few minutes, or per-minute crons over a
        // few hours), the returned `recovered` slot can be hours-to-
        // days behind now even though the original wasn't stale —
        // delivering content keyed to an arbitrary past slot. Treat as
        // stale and route through the existing skip-and-notify path.
        if (isMissedRunStale(recovered, now)) {
          const lateHours = ((now - recovered) / 3_600_000).toFixed(1);
          console.error(
            `[scheduler] Skipping job ${job.meta.id}: post-fast-forward slot ` +
            `${new Date(recovered).toISOString()} is ${lateHours}h late (cap hit on pathological schedule). ` +
            `Rescheduling to next occurrence.`,
          );
          job.runtime.next_run_at = computeNextRun(job.meta.schedule);
          await writeJob(job);
          await this.notifyStaleSkip(job, lateHours);
          continue;
        }
        if (recovered !== nextRun) {
          const skippedH = ((recovered - nextRun) / 3_600_000).toFixed(1);
          console.error(
            `[scheduler] Recovering missed job ${job.meta.id}: fast-forwarded next_run_at ` +
            `from ${new Date(nextRun).toISOString()} to ${new Date(recovered).toISOString()} ` +
            `(skipped ~${skippedH}h of intermediate slots — only the most-recent missed run is delivered).`,
          );
          job.runtime.next_run_at = new Date(recovered).toISOString();
        } else {
          console.error(
            `[scheduler] Recovering missed job ${job.meta.id} (no intermediate slots to skip)`,
          );
        }
        // #156 fix: re-read before executeJob to catch a recycle that
        // happened between listAllJobs (boot, called once in start())
        // and this per-job recovery call. Window is small (only the
        // few ms of tier-1/tier-2 notifyStaleSkip sends per iteration)
        // but a delete_job + create_job inside it would otherwise have
        // recoverMissedJobs deliver OLD content to OLD target before
        // the new tick lifecycle catches up. executeJob's own
        // isRecycledJob guard already protects the NEW runtime, but
        // the unwanted OLD side effect (Feishu send) would still land.
        // Re-read here closes the gap symmetrically with executeJob.
        const recheck = await readJob(job.meta.id);
        if (!recheck) {
          console.error(
            `[scheduler] Job ${job.meta.id} deleted during boot recovery; skipping (no side effect).`,
          );
          continue;
        }
        if (isRecycledJob(job, recheck)) {
          console.error(
            `[scheduler] Job ${job.meta.id} was recycled during boot recovery ` +
            `(created_at: ${job.meta.created_at} → ${recheck.meta.created_at}); ` +
            `skipping OLD-snapshot execute (the NEW job will fire on its own schedule via tick()).`,
          );
          continue;
        }
        await this.executeJob(job);
      } catch (err) {
        console.error(`[scheduler] Failed to recover job ${job.meta.id}:`, err);
      }
    }
  }

  /**
   * Periodic tick: scan all active jobs and execute due ones.
   * Also piggybacks a cleanup pass over the identity session to drop
   * stale entries so the in-memory map does not grow unboundedly.
   *
   * Per-job re-entrancy is gated by `this.inFlight` (#77, v1.0.29).
   * Execution is launched fire-and-forget (`.catch().finally()` rather
   * than `await`) so a slow job — typically one churning through the
   * 30/60/120s retry sleeps — does NOT serialize the rest of this
   * tick's jobs, and the next tick can still run other jobs while
   * the slow one is in flight.
   */
  private async tick(): Promise<void> {
    this.identitySession.cleanup();

    const jobs = await listAllJobs();
    const now = Date.now();

    for (const job of jobs) {
      if (job.meta.status !== 'active') continue;
      if (!job.runtime.next_run_at) continue;
      // #77 re-entrancy guard: skip jobs whose previous execution is
      // still in flight. Without this, a job in the 30+60+120s retry
      // sleep window would be re-launched on each subsequent tick.
      //
      // v1.0.43 #134 fix: compare BOTH id AND created_at. If the
      // user delete+create'd inside the window, the new job's
      // created_at differs from the in-flight entry's — treat as a
      // distinct logical job and let it run. The OLD execution's
      // writeback will skip via isRecycledJob, so the two don't
      // collide on disk either.
      const jobCreatedAt = job.meta.created_at ?? '';
      const inFlightCreatedAt = this.inFlight.get(job.meta.id);
      if (inFlightCreatedAt !== undefined && inFlightCreatedAt === jobCreatedAt) {
        continue;
      }

      const nextRun = new Date(job.runtime.next_run_at).getTime();
      if (nextRun <= now) {
        // R2-followup: capture `jobCreatedAt` in the closure so the
        // finally-block can perform a CAS-on-delete. Pre-followup the
        // delete was id-only, which broke the re-entrancy invariant
        // under recycle: if OLD execution was in flight and a recycle
        // landed a NEW job, this tick overwrote OLD's slot with NEW's
        // — then OLD's finally fired `inFlight.delete(id)`, erasing
        // NEW's entry. NEW was still in flight but unprotected, and
        // the next tick would re-launch NEW (the exact #77 duplicate-
        // execution bug, on the recycled job). Post-followup: each
        // execution's finally only clears its OWN slot.
        this.inFlight.set(job.meta.id, jobCreatedAt);
        this.executeJob(job)
          .catch((err) => {
            console.error(`[scheduler] Failed to execute job ${job.meta.id}:`, err);
          })
          .finally(() => {
            // CAS: only clear if the slot still holds OUR generation.
            // A concurrent recycle that overwrote our entry must keep
            // its own slot intact until its own executeJob finishes.
            if (this.inFlight.get(job.meta.id) === jobCreatedAt) {
              this.inFlight.delete(job.meta.id);
            }
          });
      }
    }
  }

  /**
   * Execute a single job with retry logic for transient failures.
   *
   * Retry strategy:
   * - Up to 3 retries with delays: 30s, 60s, 120s
   * - Only retries transient errors (network, 5xx, rate-limit)
   * - Permanent errors (permission denied, invalid params) fail immediately
   * - On final failure, records last_error and advances next_run_at
   *
   * #78 read-modify-write race fix (v1.0.29): the in-memory `job`
   * snapshot taken when the tick fired can be stale by the time the
   * retry loop exits (up to 210s later). During that window the user
   * may have `update_job`'d schedule/status/prompt or `delete_job`'d
   * entirely. Pre-fix, `writeJob(job)` blindly stomped those changes
   * (resurrecting deleted jobs, un-pausing user-paused jobs, ignoring
   * a new schedule).
   *
   * Post-fix: before each write we re-read the file via {@link readJob}.
   * If the file is gone the run is logged-and-dropped (no resurrection).
   * Otherwise we apply only the runtime fields we computed (and the
   * auto-pause status from the #106 path) onto the fresh on-disk meta,
   * so user updates to schedule / prompt / status survive in-flight
   * executions. The fresh meta+runtime is also copied back onto the
   * input `job` reference so callers see the post-write state without
   * needing a separate readJob.
   */
  private async executeJob(job: JobFile): Promise<void> {
    const startTime = Date.now();
    let lastErr: any = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (job.meta.type === 'message') {
          await this.executeMessageJob(job);
        } else if (job.meta.type === 'prompt') {
          await this.executePromptJob(job);
        }

        // Success — fresh-read merge (#78). The on-disk file may have
        // changed mid-execution; user updates to meta (schedule,
        // status, prompt, etc.) win, and `next_run_at` is computed
        // against the FRESH schedule so a `update_job(schedule=...)`
        // mid-flight takes effect on the next tick. A deletion mid-
        // flight is honored: no writeJob, no resurrection.
        const fresh = await readJob(job.meta.id);
        if (!fresh) {
          console.error(
            `[scheduler] Job ${job.meta.id} was deleted during execution — ` +
            `the run succeeded but no runtime is recorded (not resurrecting the file).`,
          );
          return;
        }
        // #134 fix: same-id-recycled detection. A delete_job + create_job
        // with the same sanitized id (filename) inside the ≤210s
        // execution window produces a fresh file at the same path. The
        // fresh-read above sees the NEW job's meta — applying our OLD
        // execution's runtime (last_run_at from before the new job
        // existed, run_count++ pretending the new job has run once)
        // corrupts the new job's state. Identity is the (id, created_at)
        // tuple; if either side lacks created_at (legacy job), we can't
        // reliably detect recycling and fall back to pre-fix behavior.
        if (isRecycledJob(job, fresh)) {
          console.error(
            `[scheduler] Job ${job.meta.id} was recycled during execution ` +
            `(created_at: ${job.meta.created_at} → ${fresh.meta.created_at}); ` +
            `skipping runtime writeback for the stale execution. ` +
            `The OLD run's side effects (message/prompt) already fired; ` +
            `the NEW job is unaffected and will run on its own schedule.`,
          );
          return;
        }
        // #133 audit log: type/target divergence detection. If the user
        // ran update_job(type=...) or update_job(target_chat_id=...)
        // mid-flight, the in-flight execution used the OLD values
        // (already sent / already injected); writeJob below persists
        // the NEW meta and increments run_count, leaving the operator
        // with a misleading "this prompt-type job ran once" when
        // actually the OLD message-type job ran. We can't undo the
        // side effect — surface it in the log so the operator who
        // greps for the anomaly finds an explanation rather than
        // having to reverse-engineer the timeline. run_count is still
        // incremented (the run DID happen, just under different meta);
        // the NEXT run uses fresh meta normally.
        if (
          fresh.meta.type !== job.meta.type ||
          fresh.meta.target_chat_id !== job.meta.target_chat_id
        ) {
          console.error(
            `[scheduler] Job ${job.meta.id}: meta changed during execution ` +
            `(was type=${job.meta.type} target=${job.meta.target_chat_id}; ` +
            `now type=${fresh.meta.type} target=${fresh.meta.target_chat_id}). ` +
            `The in-flight run used the OLD values and ALREADY took effect; ` +
            `next run will use the FRESH values.`,
          );
        }
        fresh.runtime.last_run_at = new Date(startTime).toISOString();
        fresh.runtime.run_count = (fresh.runtime.run_count ?? 0) + 1;
        // Compute next_run_at defensively (R1-audit followup on this PR):
        // the on-disk schedule can be poisoned by an out-of-band edit
        // (manual JSON edit / restore-from-backup / future code path
        // that bypasses update_job's Zod validation). Pre-fix, a thrown
        // computeNextRun would short-circuit the writeJob — leaving
        // `next_run_at` unchanged on disk → next tick re-fires with the
        // same `<= now` value → the chat message is RE-SENT every 60s
        // until an operator notices the stderr spam. The dead-letter
        // (next_run_at='') makes both tick and recoverMissedJobs skip
        // the job via their existing `if (!next_run_at) continue;`
        // guards. last_error explains the resume path.
        try {
          fresh.runtime.next_run_at = computeNextRun(fresh.meta.schedule);
          fresh.runtime.last_error = null;
        } catch (cronErr: any) {
          fresh.runtime.next_run_at = '';
          fresh.runtime.last_error =
            `invalid schedule '${fresh.meta.schedule}': ${cronErr?.message ?? cronErr} ` +
            `— job dead-lettered; fix via update_job to resume.`;
          console.error(
            `[scheduler] Job ${fresh.meta.id}: invalid schedule '${fresh.meta.schedule}' ` +
            `(${cronErr?.message ?? cronErr}) — DEAD-LETTERED (cleared next_run_at to ` +
            `prevent re-fire loop). Fix with update_job.`,
          );
        }

        if (attempt > 0) {
          console.error(`[scheduler] Job ${fresh.meta.id} succeeded on retry #${attempt} (run #${fresh.runtime.run_count})`);
        } else {
          console.error(`[scheduler] Job ${fresh.meta.id} executed successfully (run #${fresh.runtime.run_count})`);
        }

        await writeJob(fresh);
        // Reflect post-write state on the caller's `job` reference so
        // existing call sites (tick / recoverMissedJobs / tests) see
        // the same state that's now on disk.
        job.meta = fresh.meta;
        job.runtime = fresh.runtime;
        return;
      } catch (err: any) {
        lastErr = err;

        // Check if the error is retryable
        if (!isRetryableError(err) || attempt >= MAX_RETRIES) {
          break; // permanent error or exhausted retries
        }

        const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
        console.error(
          `[scheduler] Job ${job.meta.id} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), ` +
          `retrying in ${delay / 1000}s: ${err?.message ?? err}`
        );
        await sleep(delay);
      }
    }

    // Failure path — fresh-read merge (#78). Same rationale as the
    // success path above. If the file was deleted during execution,
    // record the failure to stderr only and do not resurrect.
    const freshFail = await readJob(job.meta.id);
    if (!freshFail) {
      console.error(
        `[scheduler] Job ${job.meta.id} was deleted during execution — ` +
        `failure (${lastErr?.message ?? lastErr}) not recorded (not resurrecting the file).`,
      );
      return;
    }
    // #134 fix (failure path): same recycle check as success path.
    // Without this, an OLD execution's failure (e.g. retry exhaustion
    // on a target the NEW job doesn't even use) would stomp
    // last_run_at + last_error onto the new job and — worse, via
    // #106's auto-pause — flip the NEW job to status=paused on the
    // OLD target's permanent error.
    if (isRecycledJob(job, freshFail)) {
      console.error(
        `[scheduler] Job ${job.meta.id} was recycled during execution ` +
        `(created_at: ${job.meta.created_at} → ${freshFail.meta.created_at}); ` +
        `the OLD run failed (${lastErr?.message ?? lastErr}) but the NEW job ` +
        `is unaffected — no runtime writeback, no auto-pause.`,
      );
      return;
    }
    freshFail.runtime.last_run_at = new Date(startTime).toISOString();
    // Same dead-letter defense as the success path (R1-audit followup).
    // A poisoned on-disk schedule throws here and would otherwise leave
    // next_run_at unchanged → tick re-fires every 60s, hitting the same
    // execution failure each time. On the failure path, the execution
    // error itself goes into last_error (more actionable for the
    // operator than the cron error); the dead-letter is only logged.
    try {
      freshFail.runtime.next_run_at = computeNextRun(freshFail.meta.schedule);
    } catch (cronErr: any) {
      freshFail.runtime.next_run_at = '';
      console.error(
        `[scheduler] Job ${freshFail.meta.id}: invalid schedule '${freshFail.meta.schedule}' ` +
        `(${cronErr?.message ?? cronErr}) — DEAD-LETTERED on failure-path advance ` +
        `(cleared next_run_at). Fix with update_job.`,
      );
    }
    freshFail.runtime.last_error = lastErr?.message ?? String(lastErr);

    // #106 fix: detect permanent target-chat errors (bot kicked / chat
    // archived / etc) and AUTO-PAUSE the job so it stops re-firing every
    // tick. Pre-fix, the job stayed `active`; every scheduled run hit
    // the same error, wasted retries, spammed stderr, and consumed
    // tokens for type=prompt cronjobs that never produced output.
    // The owner gets a one-shot DM with the failure reason so they
    // can decide whether to re-target, re-create, or delete the job.
    //
    // #132 fix: only auto-pause when the target HAS NOT CHANGED mid-
    // flight. Pre-fix, an operator who noticed the failure and ran
    // `update_job(target_chat_id='oc_new', status='active')` mid-
    // retry would get their un-pause silently reverted on the
    // failure path (the OLD target's permanent error fired the auto-
    // pause regardless). Post-fix: if the operator retargeted, give
    // the new target a chance on the NEXT tick. If THAT also fails
    // with a permanent error, the next executeJob's failure path
    // will auto-pause — for real this time, with no concurrent
    // retarget to clobber. The old comment ("regardless of user
    // intent is correct") was over-stated; respecting an explicit
    // retarget is the better trade-off.
    const apiCode = getFeishuApiCode(lastErr);
    const targetUnchanged = freshFail.meta.target_chat_id === job.meta.target_chat_id;
    const isPermanentTarget =
      apiCode !== null && PERMANENT_TARGET_CODES.has(apiCode) && targetUnchanged;
    if (isPermanentTarget) {
      freshFail.meta.status = 'paused';
      console.error(
        `[scheduler] Job ${freshFail.meta.id} AUTO-PAUSED — target chat ${freshFail.meta.target_chat_id} ` +
        `permanently unreachable (Feishu code ${apiCode}: ${getFeishuApiMsg(lastErr)}). ` +
        `Owner ${freshFail.meta.created_by} notified via DM (best-effort).`,
      );
    } else if (apiCode !== null && PERMANENT_TARGET_CODES.has(apiCode) && !targetUnchanged) {
      // #132: explicit log for the retarget-skip path so an operator
      // who greps for the missing auto-pause has an explanation.
      console.error(
        `[scheduler] Job ${freshFail.meta.id} target changed during execution ` +
        `(was ${job.meta.target_chat_id}, now ${freshFail.meta.target_chat_id}); ` +
        `skipping AUTO-PAUSE for the OLD target's permanent error (Feishu code ${apiCode}). ` +
        `The NEW target will be attempted on the next tick — if it also fails ` +
        `permanently, auto-pause will fire then.`,
      );
    } else {
      const retryNote = isRetryableError(lastErr)
        ? ` (exhausted ${MAX_RETRIES} retries)`
        : ' (non-retryable)';
      console.error(`[scheduler] Job ${freshFail.meta.id} failed${retryNote}: ${freshFail.runtime.last_error}`);
    }

    await writeJob(freshFail);
    // Reflect post-write state on the caller's `job` reference.
    job.meta = freshFail.meta;
    job.runtime = freshFail.runtime;

    // Best-effort owner notification AFTER the file is persisted so a
    // DM failure (owner unreachable too) doesn't lose the paused-state
    // write. Throws are swallowed — recovery must not abort.
    if (isPermanentTarget) {
      await this.notifyOwnerOnTargetFail(freshFail, apiCode!, getFeishuApiMsg(lastErr));
    }
  }

  /**
   * Best-effort DM to the cronjob owner when the target chat becomes
   * permanently unreachable (#106). Mirrors `notifyStaleSkip`'s shape
   * but skips the chat-tier delivery (we already know the chat is the
   * problem) — goes straight to owner DM. Silent if owner is unset
   * (legacy job without `created_by`) — operator will only see the
   * stderr line from executeJob.
   */
  private async notifyOwnerOnTargetFail(job: JobFile, code: number, reason: string): Promise<void> {
    if (!job.meta.created_by) return;
    const text = sanitizeOutboundText(
      `⚠️ Scheduled job "${job.meta.id}" was AUTO-PAUSED after failing to deliver to chat ` +
      `${job.meta.target_chat_id} (Feishu code ${code}: ${reason}). ` +
      `Resume it with update_job after fixing the target (re-invite the bot, or change target_chat_id), ` +
      `or delete with delete_job if it's no longer needed.`,
    );
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: job.meta.created_by,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
      this.trackOutbound(resp, job.meta.created_by); // #81 — DMs key by open_id
    } catch (err) {
      console.error(
        `[scheduler] notifyOwnerOnTargetFail: DM to ${job.meta.created_by} also failed for ${job.meta.id}:`,
        err,
      );
    }
  }

  /**
   * Best-effort: notify the operator that a stale missed run was skipped.
   *
   * Delivery is two-tier:
   *   1. `target_chat_id` — where the job normally delivers, so all
   *      messages about a job stay in one place.
   *   2. If that send fails (the chat may be gone — bot kicked, group
   *      dissolved), fall back to a direct message to the job owner
   *      (`created_by` open_id). The owner's DM with the bot is a
   *      different, usually-still-reachable channel.
   *
   * A stderr line alone (the pre-v1.0.9 behavior) is invisible to the
   * operator; this surfaces the skip where they actually watch (#68
   * follow-up). If BOTH channels fail, a final stderr line is the last
   * resort.
   *
   * Never throws — a failed notice must not abort recovery. `next_run_at`
   * is already advanced + persisted by the caller before this runs, so a
   * failure here does not cause a re-skip / re-notify loop on next startup.
   */
  private async notifyStaleSkip(job: JobFile, lateHours: string): Promise<void> {
    let nextRunLocal: string;
    try {
      nextRunLocal = new Date(job.runtime.next_run_at).toLocaleString('en-US', {
        timeZone: appConfig.cronTimezone,
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch {
      nextRunLocal = job.runtime.next_run_at; // fall back to raw ISO
    }
    // Stale-skip notice text is entirely server-built (no user input
    // interpolated) — sanitize anyway as a defense-in-depth pattern so
    // any future format-string change cannot quietly become an @-mention
    // vector. job.meta.id was sanitized at create time by sanitizeJobId,
    // so it's already alphanumeric+`-`.
    const text = sanitizeOutboundText(
      `⏭️ Scheduled job "${job.meta.id}" missed a run — it was ${lateHours}h stale ` +
      `(beyond the ${RECOVERY_STALE_THRESHOLD_MS / 3_600_000}h crash-recovery window), ` +
      `so the catch-up was skipped. The job resumes normally — next run: ${nextRunLocal}.`,
    );
    const content = JSON.stringify({ text });

    // Tier 1 — the job's chat.
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: job.meta.target_chat_id, content, msg_type: 'text' },
      });
      this.trackOutbound(resp, job.meta.target_chat_id); // #81
      return; // delivered
    } catch (err) {
      console.error(
        `[scheduler] Stale-skip notice to chat ${job.meta.target_chat_id} failed for ${job.meta.id}:`,
        err,
      );
    }

    // Tier 2 — direct message to the job owner. created_by may be empty
    // for a legacy job with no resolvable owner; skip the fallback then.
    if (job.meta.created_by) {
      try {
        const resp = await this.client.im.v1.message.create({
          params: { receive_id_type: 'open_id' },
          data: { receive_id: job.meta.created_by, content, msg_type: 'text' },
        });
        this.trackOutbound(resp, job.meta.created_by); // #81 — DMs key by open_id
        console.error(
          `[scheduler] Stale-skip notice for ${job.meta.id} delivered to owner DM (target chat unreachable).`,
        );
        return;
      } catch (err) {
        console.error(
          `[scheduler] Stale-skip owner-DM fallback also failed for ${job.meta.id}:`,
          err,
        );
      }
    }

    // Both channels unreachable — stderr is the last resort.
    console.error(
      `[scheduler] Stale-skip notice for ${job.meta.id} could not be delivered to any channel.`,
    );
  }

  /**
   * message type: send fixed content via Feishu IM API.
   */
  private async executeMessageJob(job: JobFile): Promise<void> {
    const rawContent = job.meta.content ?? '';
    const msgType = job.meta.msg_type ?? 'text';

    // create_job (src/tools.ts) hardcodes `msg_type: 'text'` for type=
    // message jobs — non-text is reachable only via a hand-edited job
    // file. R1-audit followup on #96 flagged that Feishu's `post` rich-
    // text payload ALSO supports `<at>` tags, so a hand-edited job
    // file with `msg_type='post'` and an `<at>` inside the post body
    // would bypass the sanitizer below. Defense: refuse non-text
    // msg_types here. Operator who has a legitimate post/interactive
    // cronjob need can extend executeMessageJob explicitly with a
    // per-format sanitizer.
    if (msgType !== 'text') {
      console.error(
        `[scheduler] executeMessageJob: refusing job "${job.meta.id}" with msg_type=${msgType} ` +
        `(only 'text' is supported by message-type jobs; non-text payloads bypass <at>-tag sanitization #96). ` +
        `Edit the job file to msg_type='text' or convert to a prompt-type job.`,
      );
      return;
    }

    // Cronjob message-type bodies are author-controlled at create_job
    // time, NOT runtime user input — but a `create_job` call itself
    // is reachable from a prompt-injected Claude (e.g. user asks Claude
    // to schedule a "polite reminder" and quietly slips `<at user_id="all">`
    // into the content). The content lives in the job file forever,
    // firing on every scheduled tick. Sanitize on send to defang any
    // such payload that landed before #96 shipped.
    const content = sanitizeOutboundText(rawContent);

    const resp = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: job.meta.target_chat_id,
        content: JSON.stringify({ text: content }),
        msg_type: 'text',
      },
    });
    // #81: track so a reaction on the cronjob's message routes correctly.
    this.trackOutbound(resp, job.meta.target_chat_id);
  }

  /**
   * prompt type: inject prompt into Claude's channel via MCP notification.
   *
   * Each execution runs under a unique thread_id so its IdentitySession entry
   * does not clobber concurrent inbound human messages in the same chat.
   */
  private async executePromptJob(job: JobFile): Promise<void> {
    const jobThreadId = `${JOB_THREAD_PREFIX}${job.meta.id}-${Date.now()}`;

    // Bind the job owner as caller so tools invoked from this Claude turn
    // (e.g. save_memory, list_jobs) resolve to the job creator, not to any
    // human who happened to send a message to the same chat.
    this.identitySession.setCaller(job.meta.target_chat_id, jobThreadId, job.meta.created_by);

    const promptContent = cronJobPrompt(
      job.meta.name,
      job.meta.target_chat_id,
      job.meta.prompt ?? ''
    );

    await this.server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: promptContent,
        meta: {
          chat_id: job.meta.target_chat_id,
          thread_id: jobThreadId,
          source: 'cronjob',
          job_id: job.meta.id,
          job_name: job.meta.name,
          ...(job.meta.model ? { model: job.meta.model } : {}),
        },
      },
    });
  }
}
