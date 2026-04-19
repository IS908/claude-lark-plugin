---
description: Manage scheduled jobs (cronjobs) — create, list, pause, resume, and delete recurring tasks. Invokes the plugin's MCP tools from the Claude Code terminal; defaults to a redacted view to reduce incidental exposure (screen share, shoulder surfing).
---

# CronJob Management

Use the cronjob tools to manage scheduled tasks:

- `create_job` — create a new scheduled job
- `list_jobs` — show all jobs and their status
- `update_job` — modify a job (change schedule, pause/resume, update content)
- `delete_job` — remove a job

## Invocation context (v0.10.0+)

This skill is invoked from the Claude Code **terminal**, so there is no
Feishu message to establish a caller identity. Pass the reserved
`chat_id="__terminal__"` to every sensitive tool call. The MCP server
resolves this to `LARK_OWNER_OPEN_ID` (set in
`~/.claude/channels/lark/.env`). If the env var is missing, the tool will
refuse — prompt the user to run `/lark:configure` to set it.

## Default (redacted) view

When the user asks to list or inspect jobs WITHOUT saying "verbose",
"full", "dump", or "show prompt", render a compact view that hides
prompt bodies and content:

```
[1] morning-brief      · daily 09:00   · → group "Team Sync"
[2] mail-digest        · daily 22:00   · → private
3 jobs. Use `list verbose` to include prompt bodies.
```

Hide these fields by default: `prompt`, `content`, `msg_type`,
free-form `meta`. Rationale: screen-share and shoulder-surfing are the
realistic threats on the terminal side, so we don't splash sensitive
content unless the user explicitly asks.

## Verbose mode

When the user explicitly says "verbose", "show full", "dump prompt",
"include prompt bodies", or similar: include the hidden fields. Prefix
the output with one line:

```
⚠ verbose mode — prompt bodies and meta visible in output.
```

## Destructive operations require confirmation

Before calling `delete_job`, or `update_job` with `status=paused` /
`schedule=<new>` / `prompt=<new>` / `content=<new>` — confirm with the
user first:

> "Confirm: delete job `<id>` (runs `<schedule>`, targets
> `<target_chat_id>`)? Reply `yes` to proceed."

Do not proceed without an affirmative response. For read-only calls
(`list_jobs`) and for `update_job` that only changes `name`, no
confirmation is needed.

## Audit

Every sensitive tool invocation is written to
`~/.claude/channels/lark/audit.log` automatically by the MCP server.
You do not need to log explicitly — but remind the user on first
invocation of a session that the log exists, so they can review
retrospectively if they suspect someone else used their terminal.

## Job Types

- **message**: Send fixed content directly via Feishu API. Deterministic, no Claude involvement. Use for critical notifications.
- **prompt**: Inject a prompt for Claude to execute. Claude thinks, may call tools, and replies to the target chat. Best-effort.

## Schedule Formats

Standard cron (5-field): `0 9 * * 1-5`

Simplified aliases:
- `every 30m` — every 30 minutes
- `every 2h` — every 2 hours
- `daily at 09:00` — every day at 9am
- `weekdays at 09:00` — Monday to Friday at 9am
- `weekly on mon at 09:00` — every Monday at 9am

## Examples

"Create a job that sends a standup reminder every weekday at 10:00 to this chat"
"List all active cronjobs"  → default redacted view
"Show jobs verbose"          → full prompt bodies
"Pause the daily-pr-summary job"   → confirm first
"Delete the morning-standup job"   → confirm first
"Change the schedule of weekly-report to every Monday at 9:00"   → confirm first
"Create a prompt job that summarizes yesterday's PRs every weekday at 9:00"
