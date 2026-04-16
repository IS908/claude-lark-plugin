---
description: Manage scheduled jobs (cronjobs) — create, list, pause, resume, and delete recurring tasks.
---

# CronJob Management

Use the cronjob tools to manage scheduled tasks:

- `create_job` — create a new scheduled job
- `list_jobs` — show all jobs and their status
- `update_job` — modify a job (change schedule, pause/resume, update content)
- `delete_job` — remove a job

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
"List all active cronjobs"
"Pause the daily-pr-summary job"
"Delete the morning-standup job"
"Change the schedule of weekly-report to every Monday at 9:00"
"Create a prompt job that summarizes yesterday's PRs every weekday at 9:00"
