# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Lark Plugin is an MCP (Model Context Protocol) channel plugin that connects Claude Code to Feishu/Lark via WebSocket. It receives messages from Feishu users, enriches them with memory context, and forwards them to Claude Code. Responses flow back through the Feishu IM API.

## Commands

```bash
npm start              # Run with tsx (development)
npm run build          # Compile TypeScript to dist/
npm run typecheck      # Type-check without emitting
bash scripts/start.sh  # Production launcher (loads lark-cli skills)
npm start -- --dry-run # Validate config and module loading without connecting
```

## Architecture

```
src/index.ts        – Entry point: wires MCP server, LarkChannel, memory, and buffer together
src/config.ts       – Loads config from ~/.claude/channels/lark/.env (dotenv)
src/channel.ts      – LarkChannel: Feishu WebSocket client, message parsing, memory enrichment pipeline
src/tools.ts        – Registers 10 MCP tools: reply, edit_message, react, download_attachment, save_memory, save_skill, create_job, list_jobs, update_job, delete_job
src/feishu-card.ts  – Card builder: markdown optimization, Schema 2.0 card assembly
src/job-store.ts    – Job CRUD: read/write JSON files, sanitizeJobId, expandScheduleAlias
src/scheduler.ts    – JobScheduler: periodic scan (60s), trigger execution, crash recovery
src/queue.ts        – Per-thread sequential message queue
src/memory/
  file.ts           – MemoryStore: local markdown files under ~/.claude/channels/lark/memories/ (Episodes, tiered Profiles public.md/private.md, Skills)
  buffer.ts         – In-memory ring buffer with auto-flush on inactivity
  distiller.ts      – Builds flush prompts to distill buffer into episodic memory; parseTieredProfile with L1 safety net
src/privacy-rules.ts  – L1 hardcoded regex + keyword rules; L2 user-rules file (privacy-rules.md) read/append
```

**Data flow:** Feishu event → `LarkChannel.handleMessageEvent` → whitelist check → ack reaction (MeMeMe) → text extraction → image auto-download → enqueue per-chat → record in buffer → enrich with memory (profile + episodes + skills) → forward via `notifications/claude/channel` → Claude calls `reply` tool → response sent back to Feishu → ack reaction revoked.

**Reaction flow:** Feishu reaction event → `handleReactionEvent` → filter (bot self, bot messages only, whitelists) → forward to Claude via channel notification.

**CronJob flow:** `JobScheduler.tick()` every 60s → read all job files → for each active job where `next_run_at <= now` → execute (message: direct Feishu API / prompt: inject via `notifications/claude/channel` under a unique `thread_id` + bind session identity to `job.created_by`) → update `runtime` in job file. On startup, `recoverMissedJobs()` runs the same check once for crash recovery.

**Identity flow (v0.9.0+):** Every inbound message calls `identitySession.setCaller(chatId, threadId, senderId)` before enqueue. Sensitive MCP tools (`save_memory`, `create_job`, `list_jobs`, `update_job`, `delete_job`) derive the caller from the session via `resolveCaller(chat_id, thread_id)` — they never trust Claude-declared identity parameters. Terminal skills use the reserved `chat_id = "__terminal__"` which resolves to `LARK_OWNER_OPEN_ID`.

## Key Design Decisions

- **ESM-only**: `"type": "module"` in package.json; all imports use `.js` extensions.
- **Stdio transport**: MCP server communicates via stdin/stdout; all debug logging goes to `console.error`.
- **Single-instance lock**: PID-based lock file in `/tmp/` prevents duplicate WebSocket connections.
- **Config location**: All user config lives at `~/.claude/channels/lark/.env`, not in the repo.
- **Memory is local-only**: All memory (profiles, episodes, skills) lives as markdown files under `~/.claude/channels/lark/memories/`. No remote backends — this keeps the trust boundary at OS file permissions and avoids vector-index policy questions for sensitive content.
- **Tiered profile memory (v0.10.0+)**: each user's profile lives at `profiles/{userId}/public.md` + `private.md`. `getProfile(ownerId, caller)` returns both tiers joined when caller === ownerId, and only public otherwise. Legacy single-file profiles lazy-migrate on first read (L1 classifier splits lines).
- **3-layer privacy classification**: L1 hardcoded regex/keyword rules (in code) > L2 user-edited `privacy-rules.md` (injected into distiller prompt) > L3 LLM judgment. `parseTieredProfile` applies L1 as a safety net over LLM output.
- **Identity is server-derived**: `IdentitySession` maps `(chat_id, thread_id?) → open_id` from authenticated Feishu events. MCP tools never accept a client-declared `open_id` or `created_by` — those are resolved server-side. Trust anchor = Feishu webhook signature.
- **CronJob visibility**: `list_jobs` filters by rendering-visibility — private chat shows caller's own jobs; group shows jobs whose `send_chat_id` matches the current chat (with prompt bodies redacted for non-owners). `update_job` / `delete_job` are owner-only.
- **Image auto-download**: Images are downloaded to `~/.claude/channels/lark/inbox/` on receive. Claude reads local paths via `image_path` in notification meta.
- **Ack reaction**: Configurable emoji (`LARK_ACK_EMOJI`, default `MeMeMe`) sent on receive, auto-revoked after reply. Fire-and-forget, won't block message processing.
- **Bot message tracking**: `BotMessageTracker` (default 500, FIFO, configurable via `LARK_BOT_MESSAGE_TRACKER_SIZE`) tracks bot-sent message IDs. Used to filter reaction events — only reactions on bot messages are forwarded to Claude.

## Configuration

Required env vars: `LARK_APP_ID`, `LARK_APP_SECRET` (in `~/.claude/channels/lark/.env`).

Optional but recommended: `LARK_OWNER_OPEN_ID` — enables terminal-side skills (e.g. `/lark:jobs`) to act as the operator. Without it, terminal tool calls are denied.

The `/lark:configure` skill (in `skills/configure/SKILL.md`) provides interactive setup within Claude Code.

## Important Conventions

- **Stdout is sacred**: MCP uses stdio for JSON-RPC. All logging must go to `console.error`, never `console.log`. The Lark SDK uses custom loggers to redirect to stderr.
- **`.mcp.json` must use `--silent`**: Prevents npm script lifecycle output from corrupting MCP transport.
- **Channel protocol**: Messages are forwarded to Claude via `notifications/claude/channel` (not `sendLoggingMessage`). Requires `experimental: { 'claude/channel': {} }` capability.
- **User display names**: Resolved via contact API → cached. Falls back to stable aliases (`user_` + last 7 chars of open_id). Memory keys always use raw open_id/chat_id.
- **Group chat filtering**: Only messages with @bot mentions are processed (precise match via bot open_id fetched at startup). P2P messages are always processed.
- **Reaction events**: Subscribed to `im.message.reaction.created_v1`. Filtered: ignores bot's own reactions, non-bot messages, and respects whitelists.

## Debugging

Debug logs are written to `~/.claude/channels/lark/debug.log`. Contains raw event data (sender, mentions, chatType) for diagnosing message flow issues.

Plugin code runs from three locations — all must stay in sync during development:
- `workspace` (source of truth)
- `~/.claude/plugins/marketplaces/claude-lark-plugin/` (marketplace clone)
- `~/.claude/plugins/cache/claude-lark-plugin/lark/<version>/` (Claude Code runtime cache)
