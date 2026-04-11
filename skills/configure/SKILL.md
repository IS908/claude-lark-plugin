---
name: configure
description: Configure the claude-lark-plugin by managing ~/.claude/channels/lark/.env. Use when the user asks to configure, setup, or change Lark/Feishu settings, credentials, or memory provider.
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
   - `OPENVIKING_API_KEY`, `MEM0_API_KEY`: show the first 3 and last 2 characters
4. Group the output by category:

```
=== Credentials ===
LARK_APP_ID:       cli_a1****
LARK_APP_SECRET:   abc****xy

=== Memory ===
MEMORY_PROVIDER:           file
LARK_INACTIVITY_HOURS:     3
LARK_MAX_SEARCH_RESULTS:   2
LARK_MIN_SEARCH_SCORE:     0.3

=== Filtering ===
LARK_ALLOWED_USER_IDS:     (not set)
LARK_ALLOWED_CHAT_IDS:     (not set)
LARK_TEXT_CHUNK_LIMIT:     4000

=== Backend: OpenViking ===
OPENVIKING_URL:            (not set)
OPENVIKING_API_KEY:        (not set)

=== Backend: mem0 ===
MEM0_URL:                  (not set)
MEM0_API_KEY:              (not set)
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

### Step 2: Memory provider

Ask which memory backend to use:
- **file** (default) — zero dependencies, stores memories as markdown files locally
- **openviking** — vector-based semantic search via OpenViking service (requires a running instance)
- **mem0** — managed memory via mem0 cloud or self-hosted (requires API key or URL)

Set `MEMORY_PROVIDER` accordingly.

### Step 3: Backend-specific config

**If openviking:**
- Ask for `OPENVIKING_URL` (default: `http://localhost:1933`)
- Ask for `OPENVIKING_API_KEY` (optional, not needed for local dev)

**If mem0:**
- Ask for `MEM0_URL` (for self-hosted) or `MEM0_API_KEY` (for cloud)
- At least one must be provided.

**If file:** no additional config needed. Skip this step.

### Step 4: Filtering (optional)

Ask if the user wants to restrict access:
- `LARK_ALLOWED_USER_IDS` — comma-separated sender open_id whitelist. Empty = allow all.
- `LARK_ALLOWED_CHAT_IDS` — comma-separated chat ID whitelist. Empty = allow all.
- If user says "skip" or "no", leave these empty.

### Step 5: Memory tuning (optional)

Ask if the user wants to adjust memory settings (or use defaults):
- `LARK_INACTIVITY_HOURS` — hours of silence before auto-flush (default: 3)
- `LARK_MAX_SEARCH_RESULTS` — max episodes injected per message (default: 2)
- `LARK_MIN_SEARCH_SCORE` — minimum relevance score for vector backends (default: 0.3)
- `LARK_TEXT_CHUNK_LIMIT` — max chars per reply chunk (default: 4000)

If user says "use defaults" or "skip", leave these at defaults.

### Step 6: Write config

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
   `LARK_APP_ID`, `LARK_APP_SECRET`, `MEMORY_PROVIDER`, `LARK_ALLOWED_USER_IDS`,
   `LARK_ALLOWED_CHAT_IDS`, `LARK_TEXT_CHUNK_LIMIT`, `LARK_INACTIVITY_HOURS`,
   `LARK_MAX_SEARCH_RESULTS`, `LARK_MIN_SEARCH_SCORE`, `OPENVIKING_URL`,
   `OPENVIKING_API_KEY`, `MEM0_URL`, `MEM0_API_KEY`, `LARK_ENABLED_SKILLS`.
3. If the file becomes empty, delete it.
4. Confirm: "All configuration cleared."

---

## Recognized config keys

| Key | Category | Required | Default |
|-----|----------|----------|---------|
| `LARK_APP_ID` | Credentials | Yes | - |
| `LARK_APP_SECRET` | Credentials | Yes | - |
| `MEMORY_PROVIDER` | Memory | No | `file` |
| `LARK_INACTIVITY_HOURS` | Memory | No | `3` |
| `LARK_MAX_SEARCH_RESULTS` | Memory | No | `2` |
| `LARK_MIN_SEARCH_SCORE` | Memory | No | `0.3` |
| `LARK_ALLOWED_USER_IDS` | Filtering | No | (empty) |
| `LARK_ALLOWED_CHAT_IDS` | Filtering | No | (empty) |
| `LARK_TEXT_CHUNK_LIMIT` | Filtering | No | `4000` |
| `LARK_ENABLED_SKILLS` | Filtering | No | (empty) |
| `OPENVIKING_URL` | OpenViking | No | `http://localhost:1933` |
| `OPENVIKING_API_KEY` | OpenViking | No | (empty) |
| `MEM0_URL` | mem0 | No | (empty) |
| `MEM0_API_KEY` | mem0 | No | (empty) |

## Notes

- Shell environment variables override `.env` values.
- Changes require a session restart or plugin reload to take effect.
- The `.env` file is read by `src/config.ts` on MCP server startup.
- When updating, always preserve unrecognized keys (user may have custom variables).
