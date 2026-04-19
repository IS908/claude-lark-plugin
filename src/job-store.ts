/**
 * Job Store — CRUD operations for cronjob JSON files.
 *
 * Each job is stored as a separate JSON file at {jobsDir}/{id}.json.
 * The file contains a { meta, runtime } structure separating user-defined
 * configuration from system-managed execution state.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { appConfig } from './config.js';

// ─── Types ──────────────────────────────────────────────────

export interface JobMeta {
  id: string;
  name: string;
  type: 'prompt' | 'message';
  schedule: string;
  schedule_human: string;
  prompt?: string;
  content?: string;
  msg_type?: string;
  /** Chat that receives the job output. Used by scheduler delivery + list_jobs visibility filter. */
  target_chat_id: string;
  /** Where the job was created (debug/audit). For legacy jobs, backfilled from target_chat_id. */
  origin_chat_id: string;
  status: 'active' | 'paused';
  created_by: string;
  created_at: string;
}

export interface JobRuntime {
  last_run_at: string | null;
  next_run_at: string;
  run_count: number;
  last_error: string | null;
}

export interface JobFile {
  meta: JobMeta;
  runtime: JobRuntime;
}

// ─── ID Sanitization ────────────────────────────────────────

export function sanitizeJobId(input: string): string {
  const id = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return id || `job-${Date.now()}`;
}

// ─── Schedule Alias Expansion ───────────────────────────────

const DAY_MAP: Record<string, string> = {
  sun: '0', mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6',
  sunday: '0', monday: '1', tuesday: '2', wednesday: '3',
  thursday: '4', friday: '5', saturday: '6',
};

/**
 * Expand a human-friendly schedule alias to a standard 5-field cron expression.
 * If the input is already a valid cron expression, returns it as-is.
 * Returns { cron, human } where human is the display label.
 */
export function expandSchedule(input: string): { cron: string; human: string } {
  const trimmed = input.trim().toLowerCase();
  let result: { cron: string; human: string } | null = null;

  // every Nm
  let match = trimmed.match(/^every\s+(\d+)\s*m(?:in(?:ute)?s?)?$/);
  if (match) {
    const n = match[1];
    result = { cron: `*/${n} * * * *`, human: `every ${n}m` };
  }

  // every Nh
  if (!result) {
    match = trimmed.match(/^every\s+(\d+)\s*h(?:ours?)?$/);
    if (match) {
      const n = match[1];
      result = { cron: `0 */${n} * * *`, human: `every ${n}h` };
    }
  }

  // daily at HH:MM
  if (!result) {
    match = trimmed.match(/^daily\s+at\s+(\d{1,2}):(\d{2})$/);
    if (match) {
      const [, h, m] = match;
      result = { cron: `${parseInt(m)} ${parseInt(h)} * * *`, human: `daily at ${h}:${m}` };
    }
  }

  // weekdays at HH:MM
  if (!result) {
    match = trimmed.match(/^weekdays\s+at\s+(\d{1,2}):(\d{2})$/);
    if (match) {
      const [, h, m] = match;
      result = { cron: `${parseInt(m)} ${parseInt(h)} * * 1-5`, human: `weekdays at ${h}:${m}` };
    }
  }

  // weekly on {day} at HH:MM
  if (!result) {
    match = trimmed.match(/^weekly\s+on\s+(\w+)\s+at\s+(\d{1,2}):(\d{2})$/);
    if (match) {
      const [, day, h, m] = match;
      const dayNum = DAY_MAP[day];
      if (dayNum !== undefined) {
        result = { cron: `${parseInt(m)} ${parseInt(h)} * * ${dayNum}`, human: `weekly on ${day} at ${h}:${m}` };
      }
    }
  }

  // Fallback: treat input as a raw cron expression
  if (!result) {
    result = { cron: trimmed, human: trimmed };
  }

  // Parse the final cron against the configured timezone to validate syntax.
  // Bad cron syntax throws immediately; invalid LARK_CRON_TIMEZONE values
  // only fail later when computeNextRun() calls .next() on the expression,
  // but create_job always calls computeNextRun after expandSchedule, so both
  // classes of error surface at create_job time (not at scheduler-tick time).
  CronExpressionParser.parse(result.cron, { tz: appConfig.cronTimezone });

  return result;
}

/**
 * Compute the next run time from a cron expression.
 * Uses the configured timezone (LARK_CRON_TIMEZONE) so cron hours
 * always match the user's local wall-clock time.
 */
export function computeNextRun(cronExpr: string): string {
  const expr = CronExpressionParser.parse(cronExpr, { tz: appConfig.cronTimezone });
  return expr.next().toISOString()!;
}

// ─── CRUD ───────────────────────────────────────────────────

async function ensureJobsDir(): Promise<string> {
  const dir = appConfig.jobsDir;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function jobPath(id: string): string {
  return path.join(appConfig.jobsDir, `${id}.json`);
}

/**
 * Backfill new fields on pre-v0.9 jobs so the rest of the code can rely on them.
 * Exported for unit testing; production callers should use readJob / listAllJobs.
 *
 * Handles in-field transitions from earlier releases:
 *   - Pre-v0.9 jobs lack origin_chat_id. Backfill from target_chat_id.
 *   - Pre-v0.9 jobs often have empty created_by. Attribute to LARK_OWNER_OPEN_ID
 *     so the operator retains update/delete rights after upgrade.
 *
 * v0.9.0 also introduced a short-lived `send_chat_id` field (identical to
 * target_chat_id). v0.11.1 drops it — any job file still carrying the key
 * is handled by a cast-aware read below, then forgotten on next write.
 */
export function backfillJob(job: JobFile): JobFile {
  // Resurrect target_chat_id from the dropped v0.9-v0.11.0 send_chat_id field
  // if a job file was written by one of those releases and target_chat_id is
  // somehow missing. Then drop the legacy field so it doesn't get persisted
  // back on the next write — prevents permanent ghost-field pollution of
  // operators' job JSON files.
  const legacy = job.meta as unknown as { send_chat_id?: string };
  if (!job.meta.target_chat_id && legacy.send_chat_id) {
    job.meta.target_chat_id = legacy.send_chat_id;
  }
  if (legacy.send_chat_id !== undefined) {
    delete legacy.send_chat_id;
  }

  if (!job.meta.origin_chat_id) job.meta.origin_chat_id = job.meta.target_chat_id;

  // Legacy jobs may have empty created_by (the old create_job defaulted to '').
  // Without a valid owner, update_job / delete_job would permanently reject
  // every caller. Attribute to the operator via LARK_OWNER_OPEN_ID so the
  // person running the upgrade can still manage them. If LARK_OWNER_OPEN_ID
  // is unset, we leave the field empty — operator can set it and restart.
  if (!job.meta.created_by && appConfig.ownerOpenId) {
    job.meta.created_by = appConfig.ownerOpenId;
  }
  return job;
}

export async function readJob(id: string): Promise<JobFile | null> {
  try {
    const data = await fs.readFile(jobPath(id), 'utf-8');
    return backfillJob(JSON.parse(data) as JobFile);
  } catch {
    return null;
  }
}

export async function writeJob(job: JobFile): Promise<void> {
  await ensureJobsDir();
  await fs.writeFile(jobPath(job.meta.id), JSON.stringify(job, null, 2), 'utf-8');
}

export async function deleteJob(id: string): Promise<boolean> {
  try {
    await fs.unlink(jobPath(id));
    return true;
  } catch {
    return false;
  }
}

export async function listAllJobs(): Promise<JobFile[]> {
  const dir = appConfig.jobsDir;
  try {
    const files = await fs.readdir(dir);
    const jobs: JobFile[] = [];
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const data = await fs.readFile(path.join(dir, file), 'utf-8');
        jobs.push(backfillJob(JSON.parse(data) as JobFile));
      } catch (err) {
        console.error(`[job-store] Skipping corrupt job file ${file}:`, err);
      }
    }
    return jobs;
  } catch {
    return [];
  }
}

export async function jobExists(id: string): Promise<boolean> {
  try {
    await fs.access(jobPath(id));
    return true;
  } catch {
    return false;
  }
}
