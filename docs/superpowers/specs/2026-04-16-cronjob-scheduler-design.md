# CronJob Scheduler Design

## Context

Users need the ability to schedule recurring tasks through the Feishu bot — daily standup reminders, weekly report summaries, periodic data checks, etc. Currently the plugin only responds to inbound messages; it has no way to initiate actions on a schedule.

This spec adds a file-based cronjob system to the plugin: users create jobs through Feishu chat (natural language) or a Claude Code skill, the MCP server runs a scheduler that scans every minute, and jobs persist across restarts with missed-execution recovery.

## Job Types

### `message` — Send fixed content directly

Calls the Feishu IM API to send a pre-defined message. No Claude involvement. Fast and deterministic.

Use cases: standup reminders, shift handoff notices, recurring announcements.

### `prompt` — Inject a prompt for Claude to execute

Sends a `notifications/claude/channel` notification with the prompt as content. Claude receives it like an inbound Feishu message, executes the prompt (may call tools — reply, search, fetch, etc.), and replies to the target chat.

Use cases: daily PR summaries, periodic monitoring checks, data aggregation reports.

The notification includes a hint for Claude to dispatch to a subagent so the main thread remains available for incoming Feishu messages. This is best-effort — Claude may or may not follow the hint.

## Job Descriptor Format

Each job is a JSON file at `~/.claude/channels/lark/jobs/{id}.json`.

File name = `{id}.json` where id is kebab-case (lowercase a-z, 0-9, hyphens), max 40 chars.

### Structure

```json
{
  "meta": {
    "id": "daily-pr-summary",
    "name": "每日 PR 总结",
    "type": "prompt",
    "schedule": "0 9 * * 1-5",
    "schedule_human": "weekdays at 09:00",
    "prompt": "查看 GitHub 上昨天的 PR 状态，按仓库分组总结",
    "target_chat_id": "oc_xxx",
    "status": "active",
    "created_by": "ou_xxx",
    "created_at": "2026-04-16T10:00:00Z"
  },
  "runtime": {
    "last_run_at": null,
    "next_run_at": "2026-04-17T01:00:00Z",
    "run_count": 0,
    "last_error": null
  }
}
```

### Field Reference

**meta (user-defined, low write frequency):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Kebab-case identifier, used as filename |
| `name` | string | yes | Human-readable display name (can be Chinese) |
| `type` | `"prompt" \| "message"` | yes | Job type |
| `schedule` | string | yes | Cron expression (5-field) |
| `schedule_human` | string | auto | Human-readable schedule description, generated at creation |
| `prompt` | string | type=prompt | Prompt text injected into Claude's channel |
| `content` | string | type=message | Fixed message content to send |
| `msg_type` | string | type=message | Feishu message type (default: `text`) |
| `target_chat_id` | string | yes | Chat ID to send results to |
| `status` | `"active" \| "paused"` | yes | Job state |
| `created_by` | string | yes | Creator's open_id |
| `created_at` | string | yes | ISO 8601 creation timestamp |

**runtime (system-managed, updated on every execution):**

| Field | Type | Description |
|-------|------|-------------|
| `last_run_at` | string \| null | Last execution timestamp (null if never run) |
| `next_run_at` | string | Next scheduled execution time (computed by cron-parser) |
| `run_count` | number | Total successful executions |
| `last_error` | string \| null | Error message from last execution, null if successful |

### ID Sanitization

```typescript
function sanitizeJobId(input: string): string {
  const id = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return id || `job-${Date.now()}`;
}
```

Falls back to `job-{timestamp}` when input is all non-ASCII (e.g. pure Chinese).

## Schedule Expression

Supports both standard cron and simplified aliases:

| Format | Example | Expansion |
|--------|---------|-----------|
| Standard 5-field cron | `0 9 * * 1-5` | as-is |
| `every {N}m` | `every 30m` | `*/30 * * * *` |
| `every {N}h` | `every 2h` | `0 */2 * * *` |
| `daily at {HH:MM}` | `daily at 09:00` | `0 9 * * *` |
| `weekdays at {HH:MM}` | `weekdays at 09:00` | `0 9 * * 1-5` |
| `weekly on {day} at {HH:MM}` | `weekly on mon at 09:00` | `0 9 * * 1` |

Aliases are expanded to cron at creation time. Only the cron expression is stored in `meta.schedule`; the original alias is stored in `meta.schedule_human`.

Uses `cron-parser` npm package (~20KB, no sub-dependencies) for expression parsing and next-run calculation.

## Architecture

### Files

| File | Responsibility |
|------|---------------|
| `src/job-store.ts` | **NEW** — Job CRUD: read/write JSON files, sanitizeJobId, expandScheduleAlias |
| `src/scheduler.ts` | **NEW** — JobScheduler class: periodic scan, trigger execution, crash recovery |
| `src/tools.ts` | Register 4 new MCP tools: create_job, list_jobs, update_job, delete_job |
| `src/index.ts` | Initialize scheduler, wire to MCP server |
| `skills/jobs/SKILL.md` | **NEW** — Skill for managing cronjobs via Claude Code terminal (`/lark:jobs`) |

### Scheduler

```typescript
class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  private store: JobStore;
  private server: Server;         // for sending notifications (prompt type)
  private client: Lark.Client;    // for sending messages (message type)

  start(): void {
    // 1. Crash recovery: scan all jobs, execute missed ones
    // 2. Start interval (every 60 seconds)
  }

  stop(): void {
    // Clear interval
  }

  private async tick(): Promise<void> {
    // Read all active jobs
    // For each: if next_run_at <= now, execute + update runtime
  }

  private async executeJob(job: JobFile): Promise<void> {
    // message type: client.im.v1.message.create(...)
    // prompt type: server.notification({ method: 'notifications/claude/channel', ... })
  }
}
```

Scan interval: **60 seconds** (configurable via `LARK_CRON_SCAN_INTERVAL` env var, default 60).

### Crash Recovery

On startup, before the first tick:

1. Read all job files from `~/.claude/channels/lark/jobs/`
2. For each `active` job where `runtime.next_run_at < now`: execute once, update `last_run_at` + recompute `next_run_at`
3. Only the most recent missed execution is recovered (not all missed intervals during downtime)

### MCP Tools

**`create_job`**

```typescript
inputSchema: z.object({
  name: z.string().describe('Job display name'),
  type: z.enum(['prompt', 'message']),
  schedule: z.string().describe('Cron expression or alias (e.g. "0 9 * * 1-5", "daily at 09:00")'),
  prompt: z.string().optional().describe('Prompt for Claude (type=prompt)'),
  content: z.string().optional().describe('Message content (type=message)'),
  target_chat_id: z.string().describe('Chat ID to send results to'),
  created_by: z.string().optional().describe('Creator open_id'),
})
```

Returns: `{ id, next_run_at }`.

**`list_jobs`**

```typescript
inputSchema: z.object({
  status: z.enum(['active', 'paused', 'all']).optional().default('all'),
})
```

Returns: array of job summaries (id, name, type, schedule_human, status, next_run_at, last_run_at, run_count).

**`update_job`**

```typescript
inputSchema: z.object({
  id: z.string(),
  status: z.enum(['active', 'paused']).optional(),
  schedule: z.string().optional(),
  prompt: z.string().optional(),
  content: z.string().optional(),
  name: z.string().optional(),
})
```

Recomputes `next_run_at` when schedule changes or status changes to active. Returns updated job summary.

**`delete_job`**

```typescript
inputSchema: z.object({
  id: z.string(),
})
```

Deletes the JSON file. Returns confirmation.

### Prompt Job Notification

```typescript
await server.notification({
  method: 'notifications/claude/channel',
  params: {
    content: [
      `[CronJob: ${job.meta.name}]`,
      `Execute this task and reply to chat_id=${job.meta.target_chat_id} with the result.`,
      `Do NOT reply to any other chat. Use a subagent when possible so the main thread stays responsive.`,
      ``,
      job.meta.prompt,
    ].join('\n'),
    meta: {
      chat_id: job.meta.target_chat_id,
      source: 'cronjob',
      job_id: job.meta.id,
      job_name: job.meta.name,
    },
  },
});
```

**Reliability note:** `prompt` type jobs are best-effort — Claude may not always follow instructions perfectly (wrong chat, no reply, ignoring the notification). For critical notifications that must be delivered, use `message` type which bypasses Claude and calls the Feishu API directly.

### MCP Instructions Update

Add to the existing instructions array:

```
CronJob notifications arrive with source='cronjob' in metadata. Dispatch these to a subagent when possible so the main thread stays available for Feishu messages. The chat_id in metadata is the target for your reply.
```

### Skill

`skills/jobs/SKILL.md` (`/lark:jobs`):

```markdown
---
description: Manage scheduled jobs (cronjobs) — create, list, pause, resume, and delete recurring tasks.
---

# CronJob Management

Use the cronjob tools to manage scheduled tasks:

- `create_job` — create a new scheduled job
- `list_jobs` — show all jobs and their status
- `update_job` — modify a job (change schedule, pause/resume, update content)
- `delete_job` — remove a job

## Examples

"Create a job that sends a standup reminder every weekday at 10:00 to this chat"
"List all active cronjobs"
"Pause the daily-pr-summary job"
"Delete the morning-standup job"
"Change the schedule of weekly-report to every Monday at 9:00"
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LARK_CRON_SCAN_INTERVAL` | `60` | Scheduler scan interval in seconds |

Job storage directory: `~/.claude/channels/lark/jobs/` (created automatically on first job creation).

## New Dependency

- `cron-parser` — cron expression parsing and next-run computation (~20KB, no sub-dependencies)

## Error Handling

- `executeJob` wraps each execution in try/catch; failures are recorded in `runtime.last_error` but don't stop the scheduler
- If a job file is corrupt (invalid JSON), it is logged and skipped during scans
- If `cron-parser` cannot parse a schedule expression, `create_job` returns an error immediately
- Scheduler tick is wrapped in try/catch so a single job failure doesn't prevent other jobs from executing

## Out of Scope

- Job execution history / audit log (only last_run_at and last_error are stored)
- Job dependencies / chaining (job B runs after job A)
- Timezone configuration (uses system timezone; cron-parser defaults to local)
- Web UI for job management
- Rate limiting / concurrent execution limits

## Verification

1. `npx tsc --noEmit` — typecheck passes
2. `npm test` — smoke tests pass
3. Manual test: create a job with `every 1m` schedule, verify it fires within 60 seconds
4. Crash recovery test: create a job with a past `next_run_at`, restart plugin, verify it executes on startup
5. Pause/resume: create active job → pause → verify it stops firing → resume → verify it fires again
6. Dry-run issue-fix self-loop until clean pass
