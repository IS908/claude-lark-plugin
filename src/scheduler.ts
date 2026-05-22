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
import type { IdentitySession } from './identity-session.js';
import {
  listAllJobs,
  writeJob,
  computeNextRun,
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

        console.error(`[scheduler] Recovering missed job: ${job.meta.id}`);
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

    // All retries exhausted or permanent error — record failure
    job.runtime.last_run_at = new Date(startTime).toISOString();
    job.runtime.next_run_at = computeNextRun(job.meta.schedule);
    job.runtime.last_error = lastErr?.message ?? String(lastErr);

    const retryNote = isRetryableError(lastErr)
      ? ` (exhausted ${MAX_RETRIES} retries)`
      : ' (non-retryable)';
    console.error(`[scheduler] Job ${job.meta.id} failed${retryNote}: ${job.runtime.last_error}`);

    await writeJob(job);
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
    const text =
      `⏭️ Scheduled job "${job.meta.id}" missed a run — it was ${lateHours}h stale ` +
      `(beyond the ${RECOVERY_STALE_THRESHOLD_MS / 3_600_000}h crash-recovery window), ` +
      `so the catch-up was skipped. The job resumes normally — next run: ${nextRunLocal}.`;
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
    const content = job.meta.content ?? '';
    const msgType = job.meta.msg_type ?? 'text';

    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: job.meta.target_chat_id,
        content: JSON.stringify(msgType === 'text' ? { text: content } : { content }),
        msg_type: msgType,
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
