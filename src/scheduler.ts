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
import {
  listAllJobs,
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

/** Network/transient error codes that warrant a retry. */
const RETRYABLE_NETWORK_ERRORS = new Set([
  'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
  'ECONNABORTED', 'EAI_AGAIN', 'EPIPE',
]);

/** HTTP status codes that warrant a retry. */
const RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Feishu API error codes indicating a TARGET-CHAT is permanently
 * unreachable from the bot's POV: kicked from group, chat dissolved/
 * archived, no permission to send. These are NOT transient — retrying
 * on the next tick would just fail again forever, spamming logs and
 * burning tokens (#106).
 *
 * When a cronjob hits one of these, the scheduler auto-pauses the job
 * and DMs the owner so they can decide whether to re-target or delete.
 *
 * 99991672 — permission denied (also marked non-retryable in isRetryableError)
 * 230002 / 230020 — chat not found / no permission to message this chat
 * 9499     — receive_id format invalid / target deactivated
 * 190005   — chat archived/disabled
 */
export const PERMANENT_TARGET_CODES = new Set<number>([
  99991672,
  230002,
  230020,
  9499,
  190005,
]);

/** Extract a numeric Feishu API code from a thrown error, or null. */
export function getFeishuApiCode(err: any): number | null {
  const code = err?.response?.data?.code ?? err?.data?.code;
  return typeof code === 'number' ? code : null;
}

/** Extract a human-readable Feishu API message from a thrown error. */
export function getFeishuApiMsg(err: any): string {
  return err?.response?.data?.msg ?? err?.data?.msg ?? (err?.message ?? String(err));
}

function isRetryableError(err: any): boolean {
  // Network-level errors (Node.js syscall errors)
  if (err?.code && RETRYABLE_NETWORK_ERRORS.has(err.code)) return true;
  if (err?.cause?.code && RETRYABLE_NETWORK_ERRORS.has(err.cause.code)) return true;

  // HTTP status from Feishu SDK (wrapped in response)
  const status = err?.response?.status ?? err?.status;
  if (status && RETRYABLE_HTTP_CODES.has(status)) return true;

  // Feishu API error codes — permission/param errors are NOT retryable
  const apiCode = err?.response?.data?.code ?? err?.data?.code;
  if (apiCode) {
    // Known non-retryable Feishu codes
    // 99991672 = permission denied, 230001 = param error
    if (apiCode === 99991672 || apiCode === 230001) return false;
    // Other Feishu codes starting with 9999 are usually transient
    if (apiCode >= 99990000 && apiCode < 100000000) return true;
  }

  // Error message heuristics
  const msg = (err?.message ?? '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('enotfound') || msg.includes('econnreset')) {
    return true;
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  private server: Server;
  private client: Lark.Client;
  private identitySession: IdentitySession;
  private running = false;

  constructor(opts: SchedulerOptions) {
    this.server = opts.server;
    this.client = opts.client;
    this.identitySession = opts.identitySession;
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
   */
  private async tick(): Promise<void> {
    this.identitySession.cleanup();

    const jobs = await listAllJobs();
    const now = Date.now();

    for (const job of jobs) {
      if (job.meta.status !== 'active') continue;
      if (!job.runtime.next_run_at) continue;

      const nextRun = new Date(job.runtime.next_run_at).getTime();
      if (nextRun <= now) {
        try {
          await this.executeJob(job);
        } catch (err) {
          console.error(`[scheduler] Failed to execute job ${job.meta.id}:`, err);
        }
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

        // Success — update runtime
        job.runtime.last_run_at = new Date(startTime).toISOString();
        job.runtime.next_run_at = computeNextRun(job.meta.schedule);
        job.runtime.run_count += 1;
        job.runtime.last_error = null;

        if (attempt > 0) {
          console.error(`[scheduler] Job ${job.meta.id} succeeded on retry #${attempt} (run #${job.runtime.run_count})`);
        } else {
          console.error(`[scheduler] Job ${job.meta.id} executed successfully (run #${job.runtime.run_count})`);
        }

        await writeJob(job);
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

    // All retries exhausted or permanent error — record failure.
    job.runtime.last_run_at = new Date(startTime).toISOString();
    job.runtime.next_run_at = computeNextRun(job.meta.schedule);
    job.runtime.last_error = lastErr?.message ?? String(lastErr);

    // #106 fix: detect permanent target-chat errors (bot kicked / chat
    // archived / etc) and AUTO-PAUSE the job so it stops re-firing every
    // tick. Pre-fix, the job stayed `active`; every scheduled run hit
    // the same error, wasted retries, spammed stderr, and consumed
    // tokens for type=prompt cronjobs that never produced output.
    // The owner gets a one-shot DM with the failure reason so they
    // can decide whether to re-target, re-create, or delete the job.
    const apiCode = getFeishuApiCode(lastErr);
    const isPermanentTarget = apiCode !== null && PERMANENT_TARGET_CODES.has(apiCode);
    if (isPermanentTarget) {
      job.meta.status = 'paused';
      console.error(
        `[scheduler] Job ${job.meta.id} AUTO-PAUSED — target chat ${job.meta.target_chat_id} ` +
        `permanently unreachable (Feishu code ${apiCode}: ${getFeishuApiMsg(lastErr)}). ` +
        `Owner ${job.meta.created_by} notified via DM (best-effort).`,
      );
    } else {
      const retryNote = isRetryableError(lastErr)
        ? ` (exhausted ${MAX_RETRIES} retries)`
        : ' (non-retryable)';
      console.error(`[scheduler] Job ${job.meta.id} failed${retryNote}: ${job.runtime.last_error}`);
    }

    await writeJob(job);

    // Best-effort owner notification AFTER the file is persisted so a
    // DM failure (owner unreachable too) doesn't lose the paused-state
    // write. Throws are swallowed — recovery must not abort.
    if (isPermanentTarget) {
      await this.notifyOwnerOnTargetFail(job, apiCode!, getFeishuApiMsg(lastErr));
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
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: job.meta.created_by,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
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
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: job.meta.target_chat_id, content, msg_type: 'text' },
      });
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
        await this.client.im.v1.message.create({
          params: { receive_id_type: 'open_id' },
          data: { receive_id: job.meta.created_by, content, msg_type: 'text' },
        });
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

    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: job.meta.target_chat_id,
        content: JSON.stringify({ text: content }),
        msg_type: 'text',
      },
    });
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
