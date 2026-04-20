---
name: configure
description: Configure the claude-lark-plugin by managing ~/.claude/channels/lark/.env. Use when the user asks to configure, setup, or change Lark/Feishu settings or credentials.
user-invocable: true
argument-hint: "[<app_id> <app_secret>] | [setup] | [clear]"
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - AskUserQuestion
---

# /lark:configure

Manage the claude-lark-plugin configuration stored in `~/.claude/channels/lark/.env`.

Arguments passed: `$ARGUMENTS`

---

## No args — Show current status

1. Read `~/.claude/channels/lark/.env` if it exists.
2. Display all recognized configuration keys with their current values.
3. Mask sensitive values:
   - `LARK_APP_ID`: show the first 6 characters, mask the rest
   - `LARK_APP_SECRET`: show the first 3 and last 2 characters, mask the middle
4. Group the output by category:

```
=== Credentials ===
LARK_APP_ID:       cli_a1****
LARK_APP_SECRET:   abc****xy

=== Memory ===
LARK_INACTIVITY_HOURS:     3
LARK_MAX_SEARCH_RESULTS:   2
LARK_MIN_SEARCH_SCORE:     0.3

=== Filtering ===
LARK_ALLOWED_USER_IDS:     (not set)
LARK_ALLOWED_CHAT_IDS:     (not set)

=== Messaging ===
LARK_TEXT_CHUNK_LIMIT:     4000

=== Acknowledgement ===
LARK_ACK_EMOJI:                MeMeMe
LARK_BOT_MESSAGE_TRACKER_SIZE: 500

=== CronJob ===
LARK_CRON_SCAN_INTERVAL:   60
LARK_CRON_TIMEZONE:        (system tz)
```

5. Suggest next steps:
   - If credentials are missing: "Run `/lark:configure <app_id> <app_secret>` to set credentials, or `/lark:configure setup` for full interactive setup."
   - If credentials exist: "Configuration looks good. Restart the session or reload plugins to apply changes."

---

## `<app_id> <app_secret>` — Quick credential setup

1. Treat the first argument as `LARK_APP_ID` and the second as `LARK_APP_SECRET`.
2. Run `mkdir -p ~/.claude/channels/lark`.
3. Read the existing `.env` if present.
4. Update or append:
   - `LARK_APP_ID=<app_id>`
   - `LARK_APP_SECRET=<app_secret>`
5. Preserve all other existing keys unchanged.
6. Write the file back.
7. Confirm: "Credentials saved to `~/.claude/channels/lark/.env`."
8. Tell the user to restart or reload plugins.

---

## `setup` — Full interactive setup

Walk the user through complete configuration, one question at a time using AskUserQuestion.

### Step 1: Credentials

Ask for `LARK_APP_ID` and `LARK_APP_SECRET`.
- If already set, show masked current values and ask if user wants to update.
- If user says "keep" or "skip", preserve existing values.
- Explain: these come from the Feishu Open Platform app dashboard.

### Step 2: Filtering (optional)

Ask if the user wants to restrict access:
- `LARK_ALLOWED_USER_IDS` — comma-separated sender open_id whitelist. Empty = allow all.
- `LARK_ALLOWED_CHAT_IDS` — comma-separated chat ID whitelist. Empty = allow all.
- If user says "skip" or "no", leave these empty.

### Step 3: CronJob timezone (optional)

Ask if the user wants to set a specific timezone for cronjob schedules:
- `LARK_CRON_TIMEZONE` — IANA timezone name (e.g. `Asia/Shanghai`, `UTC`). Default: system timezone. This affects how cron hours map to wall-clock time — worth setting explicitly for servers that may move between timezones.

If user says "use system tz" or "skip", leave unset.

### Step 4: Advanced tuning (optional)

Ask if the user wants to adjust any of these advanced settings (or use defaults):
- `LARK_INACTIVITY_HOURS` — hours of silence before memory auto-flush (default: 3)
- `LARK_MAX_SEARCH_RESULTS` — max episodes injected per message (default: 2)
- `LARK_MIN_SEARCH_SCORE` — minimum relevance score for episode search (default: 0.3)
- `LARK_TEXT_CHUNK_LIMIT` — max chars per reply chunk (default: 4000)
- `LARK_ACK_EMOJI` — emoji reaction on message receive, empty to disable (default: `MeMeMe`)
- `LARK_BOT_MESSAGE_TRACKER_SIZE` — max bot message IDs tracked for reaction filtering (default: 500)
- `LARK_CRON_SCAN_INTERVAL` — cronjob scan interval in seconds (default: 60)

If user says "use defaults" or "skip", leave these at defaults.

### Step 5: Write config

1. Run `mkdir -p ~/.claude/channels/lark`.
2. Read existing `.env` if present.
3. Merge all collected values, preserving any unrecognized keys.
4. Write the file.
5. Show a summary of what was configured (masked secrets).
6. Tell the user: "Configuration complete. Restart the session or reload plugins to apply."

---

## `clear` — Remove configuration

1. Read `~/.claude/channels/lark/.env`.
2. Remove all recognized keys:
   `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_ALLOWED_USER_IDS`,
   `LARK_ALLOWED_CHAT_IDS`, `LARK_TEXT_CHUNK_LIMIT`, `LARK_INACTIVITY_HOURS`,
   `LARK_MAX_SEARCH_RESULTS`, `LARK_MIN_SEARCH_SCORE`,
   `LARK_ACK_EMOJI`, `LARK_BOT_MESSAGE_TRACKER_SIZE`,
   `LARK_CRON_SCAN_INTERVAL`, `LARK_CRON_TIMEZONE`,
   `LARK_OWNER_OPEN_ID`, `LARK_IDENTITY_SESSION_TTL_MS`,
   `LARK_PRIVACY_RULES_FILE`, `LARK_AUDIT_LOG`.
3. If the file becomes empty, delete it.
4. Confirm: "All configuration cleared."

---

## Recognized config keys

| Key | Category | Required | Default |
|-----|----------|----------|---------|
| `LARK_APP_ID` | Credentials | Yes | - |
| `LARK_APP_SECRET` | Credentials | Yes | - |
| `LARK_INACTIVITY_HOURS` | Memory | No | `3` |
| `LARK_MAX_SEARCH_RESULTS` | Memory | No | `2` |
| `LARK_MIN_SEARCH_SCORE` | Memory | No | `0.3` |
| `LARK_ALLOWED_USER_IDS` | Filtering | No | (empty) |
| `LARK_ALLOWED_CHAT_IDS` | Filtering | No | (empty) |
| `LARK_TEXT_CHUNK_LIMIT` | Messaging | No | `4000` |
| `LARK_ACK_EMOJI` | Acknowledgement | No | `MeMeMe` |
| `LARK_BOT_MESSAGE_TRACKER_SIZE` | Acknowledgement | No | `500` |
| `LARK_CRON_SCAN_INTERVAL` | CronJob | No | `60` |
| `LARK_CRON_TIMEZONE` | CronJob | No | system timezone |
| `LARK_OWNER_OPEN_ID` | Identity | No | (empty) |
| `LARK_IDENTITY_SESSION_TTL_MS` | Identity | No | auto |
| `LARK_PRIVACY_RULES_FILE` | Privacy | No | `~/.claude/channels/lark/privacy-rules.md` |
| `LARK_AUDIT_LOG` | Privacy | No | `~/.claude/channels/lark/audit.log` |

## Notes

- Shell environment variables override `.env` values.
- Changes require a session restart or plugin reload to take effect.
- The `.env` file is read by `src/config.ts` on MCP server startup.
- When updating, always preserve unrecognized keys (user may have custom variables).
