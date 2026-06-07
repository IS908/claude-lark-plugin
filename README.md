# Claude Lark Plugin

[![docs](https://img.shields.io/badge/docs-中文-blue)](README_CN.md)
[![node](https://img.shields.io/badge/node-%3E%3D20.0.0-339933?logo=node.js&logoColor=white)](package.json)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Chat with Claude Code in real time through Feishu (Lark). Local-file memory, scheduled jobs, rich media support.

---

## How It Works

```
Feishu User ──> Feishu Open Platform ──WebSocket──> claude-lark-plugin (MCP Server) ──> Claude Code
                                                          <── reply / edit / react ──<
```

The plugin connects to Feishu via the Lark SDK WebSocket client, receives messages in real time, enriches them with memory context, and forwards them to Claude Code as an MCP channel. Claude's responses are sent back through the Feishu IM API.

---

## Features

### Messaging

- Direct messages (P2P) and group chats (responds to @bot mentions)
- Rich message types: text, post (rich text), image, file, audio, video, interactive cards
- **Image auto-download**: images are downloaded to a local inbox so Claude can see them directly
- Quoted reply support with automatic parent message fetching
- Attachment extraction (image, file, audio, video) with type-aware download
- **Reaction events**: user emoji reactions on bot messages are forwarded to Claude

### Responding

- Text replies with automatic chunking for long messages (configurable limit)
- **Card rendering**: long or markdown-rich replies (headings, code blocks, tables, lists, bold, or > 500 chars) auto-render as Feishu cards. Pass `format='card'` to force card, `format='text'` to force plain. Optional `footer` footnote supported
- **Ack reaction**: bot automatically reacts with an emoji (default: MeMeMe) on receive, removes it after replying
- Image and file uploads (images up to 10 MB, files up to 30 MB)
- Message editing (plain text and card markdown)
- Emoji reactions on any message
- Auto-chunking splits at paragraph, line, or word boundaries

### Memory

- Three-layer architecture: Buffer, Episodic, and Semantic memory
- Auto-flush distillation from conversation buffer to episodic memory
- Local markdown-file storage under `~/.claude/channels/lark/memories/`
- User profiles (tiered public/private since v0.10.0), chat episodes, thread episodes, and global skills
- Memory-enriched context injection on every incoming message, filtered by caller identity

### Privacy & Security (v0.9.0+)

- **Server-derived caller identity**: sensitive tools (`save_memory`, `create_job`, `list_jobs`, `update_job`, `delete_job`, `what_do_you_know`, `forget_memory`) resolve the calling user from the authenticated Feishu event stream, not from tool arguments — socially-engineered prompts cannot act on behalf of another user
- **Memory transparency (v0.11.0+)**: `what_do_you_know` lists what the bot has stored about the caller (filtered by current-chat visibility); `forget_memory` removes a specific line by hash. Optional `promote_to_rule` feeds corrections into `privacy-rules.md` — a self-learning loop that makes future misclassifications less likely
- **Append-only audit log (v0.11.0+)**: `~/.claude/channels/lark/audit.log` records every sensitive-tool invocation (timestamp / tool / caller / outcome / redacted args) so the operator can retrospectively inspect what was accessed on their machine
- **Terminal skills default to redacted output (v0.11.0+)**: `/lark:jobs` hides prompt bodies by default; verbose opt-in is required. Destructive operations require interactive confirmation
- **Tiered profile memory (v0.10.0+)**: each user's profile is split into `public.md` (visible to anyone who @mentions the user) and `private.md` (owner-only). Private-chat preferences no longer leak into groups via @mention injection
- **L1/L2/L3 classification** (v0.10.0+): hardcoded regex + keyword rules catch phones / credentials / sensitive Chinese keywords. Email is intentionally NOT in L1 — the plugin targets **work-chat use cases** where emails are commonly shared via signatures/directories; personal deployments can add their own "Always private" email rule to `privacy-rules.md`. User-editable `privacy-rules.md` covers personal/org-specific cases; LLM handles the nuance. `parseTieredProfile` applies an L1 safety net over LLM output so misclassified credentials get forced to private
- **Legacy-profile migration respects L2 rules (v0.11.1+)**: if the operator authors `privacy-rules.md` before (or during) the upgrade, `## Always private` phrases are applied as case-insensitive substring matches during migration — org-specific codenames, client names, and people mentions get routed to `private.md` even though L1 alone wouldn't flag them
- **`list_jobs` visibility filter**: in a group chat, members only see jobs whose `target_chat_id` matches that group (with prompt bodies redacted for non-owners); in a private chat, the caller sees their own jobs. Group members can no longer inspect each other's private jobs
- **Owner-only mutations**: `update_job` / `delete_job` require `caller == created_by`
- **CronJob isolation**: each cronjob execution runs under a unique `thread_id` so scheduled actions don't collide with concurrent human messages in the same chat
- **Terminal fallback**: terminal skill invocations (e.g. `/lark:jobs`) resolve via the reserved `__terminal__` chat id → `LARK_OWNER_OPEN_ID`

### Scheduled Jobs (CronJob)

- **Two job types**: `message` (send fixed content, deterministic) and `prompt` (Claude executes and replies, best-effort)
- Standard cron expressions + simplified aliases (`every 30m`, `daily at 09:00`, `weekdays at 17:00`)
- Create and manage jobs through Feishu chat or `/lark:jobs` skill
- Crash recovery: missed jobs are executed once on restart
- Job storage as JSON files at `~/.claude/channels/lark/jobs/`

### Reliability

- Per-chat message queue for sequential processing within each conversation
- Single-instance lock to prevent duplicate event handling
- User and chat ID whitelisting for access control (OR semantics when both lists set)
- Crash recovery for scheduled jobs (missed executions run once on restart)

---

## Quick Start

### 1. Create a Feishu Bot

Create a custom app at [Feishu Open Platform](https://open.feishu.cn/app) and enable the following permissions:

| Permission | Purpose |
|---|---|
| `im:message.p2p_msg:readonly` | Receive direct messages |
| `im:message.group_at_msg:readonly` | Receive group @bot messages |
| `im:message:send_as_bot` | Send messages as the bot |
| `im:resource` | Download attachments |
| `im:message.reactions:write` | Add emoji reactions |
| `im:message.reactions:read` | Receive reaction events |
| `docs:document.comment:read` | Pre-fetch comment bodies for doc-comment events |
| `docs:document.comment:create` | Post doc-comment replies / new top-level comments |
| `drive:drive.metadata:readonly` | Fetch doc titles for envelope |
| `docx:document:readonly` | Read docx contents when Claude wants context |

Enable the WebSocket mode under **Event Subscriptions** and subscribe to these events:
- `im.message.receive_v1` -- receive messages
- `im.message.reaction.created_v1` -- receive emoji reactions on bot messages
- `drive.notice.comment_add_v1` -- receive doc-comment notifications when @-mentioned

### 2. Install the Plugin

**Via plugin marketplace (recommended):**

Run the following commands inside Claude Code:

```text
/plugin marketplace add https://github.com/IS908/claude-lark-plugin.git
/plugin install lark@claude-lark-plugin
/reload-plugins
```

**From source (for development):**

```bash
git clone https://github.com/IS908/claude-lark-plugin.git
cd claude-lark-plugin
npm install
```

Then load the plugin manually when starting Claude Code:

```bash
claude --dangerously-load-development-channels plugin:lark@claude-lark-plugin
```

Optionally, install [lark-cli](https://github.com/larksuite/cli) for full Feishu API access (calendar, docs, sheets, tasks, contacts, etc.):

```bash
npm install -g @larksuite/cli
npx skills add larksuite/cli -y -g
```

### 3. Configure Credentials

**Interactive setup (recommended):**

```text
/lark:configure setup
```

This walks you through all configuration options step by step -- credentials, filtering, and memory tuning.

**Quick setup:**

```text
/lark:configure <app_id> <app_secret>
```

**Manual setup:**

```bash
mkdir -p ~/.claude/channels/lark
cat > ~/.claude/channels/lark/.env << 'EOF'
LARK_APP_ID=cli_your_app_id
LARK_APP_SECRET=your_app_secret
EOF
```

### 4. Start

If installed via the plugin marketplace, the plugin starts automatically when Claude Code launches — dependencies are installed on first run, no manual steps needed.

```bash
# If installed from source:
claude --dangerously-load-development-channels plugin:lark@claude-lark-plugin
```

### Updating

**Plugin marketplace:**

```text
/plugin update lark@claude-lark-plugin
/reload-plugins
```

**From source:**

```bash
cd claude-lark-plugin
git pull
```

Configuration in `~/.claude/channels/lark/.env` is preserved across updates. Restart the session or reload plugins to apply changes.

Check current version:

```bash
node -e "console.log(require('./package.json').version)"
```

---

## Memory System

### Three-Layer Architecture

| Layer | Name | Scope | Injection | Storage |
|---|---|---|---|---|
| 1 | Buffer | Per-chat | N/A (in-process) | In-memory ring buffer |
| 2 | Episodic | Per-chat / per-thread | Cold (search-based) | Local markdown files |
| 3 | Semantic | Per-user (profile) or global (skills) | Hot (always loaded) | Local markdown files |

### Memory Enrichment Pipeline

On every incoming message, the plugin injects relevant memory context in this order:

1. **User profile** -- always loaded for the sender (hot injection)
2. **Mentioned user profiles** -- loaded for any @mentioned users
3. **Thread episodes** -- searched by relevance if the message is in a thread
4. **Chat episodes** -- searched by relevance for the current chat
5. **Skills** -- globally searched by relevance

### Distillation Pipeline

| Stage | Description | Status |
|---|---|---|
| Buffer to Episode | Conversation buffer flushes to episodic memory after inactivity timeout | MVP |
| Episodes to Profile | Periodic extraction of user preferences from episodes | Future |
| Episode compression | Merging and summarizing old episodes | Future |

---

## Configuration Reference

### Required

| Variable | Description |
|---|---|
| `LARK_APP_ID` | Feishu app ID |
| `LARK_APP_SECRET` | Feishu app secret |

### Optional -- Filtering

| Variable | Default | Description |
|---|---|---|
| `LARK_ALLOWED_USER_IDS` | (empty) | Comma-separated list of allowed user open_ids. Empty means all users allowed. |
| `LARK_ALLOWED_CHAT_IDS` | (empty) | Comma-separated list of allowed chat IDs. Empty means all chats allowed. |

> **Whitelist semantics:** when both lists are set, a message is accepted if **either** the sender is in `LARK_ALLOWED_USER_IDS` **or** the chat is in `LARK_ALLOWED_CHAT_IDS` (OR). Setting only one list gates on that list alone.
>
> For `drive.notice.comment_add_v1` (doc-comment) events: when `LARK_ALLOWED_USER_IDS` is configured, the comment author's `open_id` must match. When only `LARK_ALLOWED_CHAT_IDS` is configured (no user list), doc-comment events pass through — the chat list cannot meaningfully match the synthetic `doc:<file_token>` chat_id, and Feishu-side ACL (bot must be a doc collaborator + @-mentioned) is the upstream boundary (v1.1.2+).

### Optional -- Messaging

| Variable | Default | Description |
|---|---|---|
| `LARK_TEXT_CHUNK_LIMIT` | `4000` | Maximum characters per message chunk |

### Optional -- Acknowledgement

| Variable | Default | Description |
|---|---|---|
| `LARK_ACK_EMOJI` | `MeMeMe` | Emoji reaction on message receive. Set to empty string to disable. |
| `LARK_DOC_COMMENT_ACK_EMOJI` | `THUMBSUP` | Reaction emoji the bot adds to inbound doc-comment events for immediate visual feedback. Empty string disables. No revoke — persistent audit marker per the async/collaborative nature of doc comments (v1.2.0+). |
| `LARK_BOT_MESSAGE_TRACKER_SIZE` | `500` | Max bot-sent message IDs tracked for reaction filtering (FIFO) |

### Optional -- CronJob

| Variable | Default | Description |
|---|---|---|
| `LARK_CRON_SCAN_INTERVAL` | `60` | CronJob scheduler scan interval in seconds |
| `LARK_CRON_TIMEZONE` | system timezone | IANA timezone for cron schedule evaluation (e.g. `Asia/Shanghai`, `UTC`). Affects how hours in cron expressions map to wall-clock time. |

### Optional -- Memory

| Variable | Default | Description |
|---|---|---|
| `LARK_MIN_SEARCH_SCORE` | `0.3` | Minimum similarity score for memory search results |
| `LARK_MAX_SEARCH_RESULTS` | `2` | Maximum number of memory search results to inject |
| `LARK_INACTIVITY_HOURS` | `3` | Hours of inactivity before buffer flush to episodic memory |

### Optional -- Identity / privacy (v0.9.0+)

| Variable | Default | Description |
|---|---|---|
| `LARK_OWNER_OPEN_ID` | (empty) | Operator open_id. Enables terminal skill invocations (e.g. `/lark:jobs`) to resolve the caller via the reserved `__terminal__` chat id. When unset, terminal-side sensitive operations are denied. |
| `LARK_IDENTITY_SESSION_TTL_MS` | `max(2h, LARK_INACTIVITY_HOURS × 2h)` | Lifetime of a server-side `(chat_id, thread_id?) → open_id` session entry. Must exceed the auto-flush window so distillation-triggered tool calls still resolve to the last real user. |
| `LARK_IDENTITY_SESSION_MAX_SIZE` | `5000` | Max number of live entries in the per-(chat,thread) caller-identity LRU. Doc-comment events (v1.1.2+) key per-comment, so a busy bot collaborating in many docs can accumulate more entries than the legacy IM-only flow. Minimum 1 (lower values clamped); no upper bound — operators choose based on RAM budget (each entry ~80 bytes). Oldest entry evicted when capacity exceeded. |
| `LARK_PRIVACY_RULES_FILE` | `~/.claude/channels/lark/privacy-rules.md` | Override the path to the L2 user rules file. The distiller injects this file's contents into its classification prompt. |
| `LARK_AUDIT_LOG` | `~/.claude/channels/lark/audit.log` | Override the path to the append-only audit log. Every sensitive-tool invocation is recorded (best-effort; log failures never propagate). (v0.11.0+) |

---

## Interactive Configuration

The plugin includes an interactive setup command accessible within Claude Code:

| Command | Description |
|---|---|
| `/lark:configure` | Show current configuration status (secrets are masked) |
| `/lark:configure <app_id> <app_secret>` | Quick credential setup |
| `/lark:configure setup` | Full interactive walkthrough |
| `/lark:configure clear` | Remove all configuration |

### `/lark:configure setup` Flow

The interactive setup walks through 5 steps, each with the option to skip or use defaults:

```
Step 1: Credentials
  -> LARK_APP_ID and LARK_APP_SECRET (shows masked current values if already set)

Step 2: Filtering (optional)
  -> LARK_ALLOWED_USER_IDS, LARK_ALLOWED_CHAT_IDS

Step 3: CronJob (optional)
  -> LARK_CRON_TIMEZONE

Step 4: Advanced tuning (optional)
  -> LARK_INACTIVITY_HOURS, LARK_MAX_SEARCH_RESULTS, LARK_MIN_SEARCH_SCORE,
     LARK_TEXT_CHUNK_LIMIT, LARK_ACK_EMOJI, LARK_BOT_MESSAGE_TRACKER_SIZE,
     LARK_CRON_SCAN_INTERVAL

Step 5: Write config
  -> ~/.claude/channels/lark/.env
```

All values are written to `~/.claude/channels/lark/.env`. Changes require a session restart or plugin reload to take effect.

---

## lark-cli Integration

Install [lark-cli](https://github.com/nicepkg/lark-cli) for full Feishu API access beyond messaging -- calendar, docs, sheets, tasks, contacts, and more. Once installed, lark-cli skills are loaded by Claude Code alongside this plugin.

---

## Background Daemon

Run the plugin as a persistent background process using tmux:

```bash
tmux new-session -d -s claude-lark 'bash scripts/start.sh'
```

Reattach with `tmux attach -t claude-lark`. View logs with `tmux capture-pane -t claude-lark -p`.

---

## Available Tools

The plugin registers the following MCP tools for Claude to use:

| Tool | Description |
|---|---|
| `reply` | Send a text reply to a Feishu chat. Supports optional image and file attachments. Long text is auto-chunked. |
| `edit_message` | Edit a previously sent bot message (text or card_markdown). |
| `react` | Add an emoji reaction to a message. |
| `download_attachment` | Download an attachment (image, file, audio, video) from a message to the local inbox. |
| `save_memory` | Save a memory entry (profile / chat episode / thread episode) for cross-session recall. Profile writes target the resolved caller (server-derived, v0.9.0+) and go into the chosen `tier` (`public` or `private`, default `private`, v0.10.0+). Requires `chat_id`. |
| `save_skill` | Save a reusable procedure as a globally searchable skill. |
| `create_job` | Create a scheduled cronjob (message or prompt type). Creator derived from session; requires `chat_id` (used to populate `origin_chat_id`). |
| `list_jobs` | List cronjobs visible in the current chat. Filter follows rendering-visibility: private → caller's own jobs, group → jobs with `target_chat_id == currentChat` (prompts redacted for non-owners). Requires `chat_id`. |
| `update_job` | Update a cronjob (schedule, content, pause/resume). Owner-only. Requires `chat_id`. |
| `delete_job` | Delete a cronjob. Owner-only. Requires `chat_id`. |
| `what_do_you_know` | List what the bot has stored in the caller's profile. Filtered by rendering visibility (both tiers in p2p, public only in groups). Each line carries an 8-char hash for use with `forget_memory`. (v0.11.0+) |
| `forget_memory` | Remove a specific line from the caller's profile by hash. Caller-scoped and idempotent. Optional `promote_to_rule` promotes the removal into a durable `## Always private` rule in `privacy-rules.md`. (v0.11.0+) |
| `reply_doc_comment` | Reply to a Feishu doc comment thread. Owner-only. Posts as the bot's app identity. (v1.1.2+) |
| `create_doc_comment` | Create a new top-level comment on a Feishu doc. Owner-only. (v1.1.2+) |

---

## Requirements

- **Node.js** 20+ and npm
- **Feishu/Lark** custom app with WebSocket mode enabled
- **lark-cli** (optional) -- for extended Feishu API access (calendar, docs, sheets, tasks, contacts)

---

## License

[Apache 2.0](LICENSE)
