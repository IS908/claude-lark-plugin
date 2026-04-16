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
import {
  listAllJobs,
  writeJob,
  computeNextRun,
  type JobFile,
} from './job-store.js';

export interface SchedulerOptions {
  server: Server;
  client: Lark.Client;
}

export class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  private server: Server;
  private client: Lark.Client;
  private running = false;

  constructor(opts: SchedulerOptions) {
    this.server = opts.server;
    this.client = opts.client;
  }

  /**
   * Start the scheduler: run crash recovery, then begin periodic ticks.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Crash recovery — execute missed jobs once
    await this.recoverMissedJobs();

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
   * On startup, find active jobs whose next_run_at is in the past
   * and execute them once (most recent missed execution only).
   */
  private async recoverMissedJobs(): Promise<void> {
    const jobs = await listAllJobs();
    const now = Date.now();

    for (const job of jobs) {
      if (job.meta.status !== 'active') continue;
      if (!job.runtime.next_run_at) continue;

      const nextRun = new Date(job.runtime.next_run_at).getTime();
      if (nextRun < now) {
        console.error(`[scheduler] Recovering missed job: ${job.meta.id}`);
        await this.executeJob(job);
      }
    }
  }

  /**
   * Periodic tick: scan all active jobs and execute due ones.
   */
  private async tick(): Promise<void> {
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
   * Execute a single job and update its runtime state.
   */
  private async executeJob(job: JobFile): Promise<void> {
    const startTime = Date.now();

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

      console.error(`[scheduler] Job ${job.meta.id} executed successfully (run #${job.runtime.run_count})`);
    } catch (err: any) {
      // Failure — record error, still advance next_run_at
      job.runtime.last_run_at = new Date(startTime).toISOString();
      job.runtime.next_run_at = computeNextRun(job.meta.schedule);
      job.runtime.last_error = err?.message ?? String(err);

      console.error(`[scheduler] Job ${job.meta.id} failed:`, job.runtime.last_error);
    }

    await writeJob(job);
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
   */
  private async executePromptJob(job: JobFile): Promise<void> {
    const promptContent = [
      `[CronJob: ${job.meta.name}]`,
      `Execute this task and reply to chat_id=${job.meta.target_chat_id} with the result.`,
      `Do NOT reply to any other chat. Use a subagent when possible so the main thread stays responsive.`,
      ``,
      job.meta.prompt ?? '',
    ].join('\n');

    await this.server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: promptContent,
        meta: {
          chat_id: job.meta.target_chat_id,
          source: 'cronjob',
          job_id: job.meta.id,
          job_name: job.meta.name,
        },
      },
    });
  }
}
