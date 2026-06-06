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
src/tools.ts        – Registers 14 MCP tools: reply, edit_message, react, download_attachment, save_memory, save_skill, create_job, list_jobs, update_job, delete_job, what_do_you_know, forget_memory, reply_doc_comment, create_doc_comment
src/audit-log.ts    – Append-only audit log for sensitive tool invocations
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

**Doc-comment flow:** Feishu doc comment event `drive.notice.comment_add_v1` → `handleCommentEvent` (pure function in `src/channel.ts`) → filter (`is_mentioned=true` AND `from_user_id != bot` AND `passesWhitelist`) → pre-fetch comment / parent body via `drive.fileComment.get` + doc title via `drive.meta.batchQuery` → enqueue per `chatKey = "doc:<file_token>"`, `threadKey = comment_id` → bind `setCaller(chatKey, comment_id, from_user_id.open_id)` → forward to Claude with envelope `<doc_comment ...>`, `meta.chat_id = "doc:<file_token>"`, `meta.thread_id = comment_id`. Outgoing reply via `reply_doc_comment` (owner-only, `chat_id` must start with `doc:`, `doc_token` must equal `chat_id` suffix, bot identity via `tenant_access_token`). Stop hook satisfies on `reply_doc_comment` with matching `comment_id` + `doc_token` AND non-error `tool_result`; `reply` / `react` / `edit_message` / `create_doc_comment` do not satisfy a pending doc_comment.

**Identity flow (v0.9.0+):** Every inbound message calls `identitySession.setCaller(chatId, threadId, senderId)` before enqueue. Sensitive MCP tools (`save_memory`, `save_skill`, `create_job`, `list_jobs`, `update_job`, `delete_job`, `what_do_you_know`, `forget_memory`, `reply_doc_comment`, `create_doc_comment`) derive the caller from the session via `resolveCaller(chat_id, thread_id)` — they never trust Claude-declared identity parameters. Terminal skills use the reserved `chat_id = "__terminal__"` which resolves to `LARK_OWNER_OPEN_ID`. (`reply_doc_comment` / `create_doc_comment` reject `__terminal__` — they require `chat_id` to start with `doc:` so the doc_token binding cannot be bypassed.)

## Key Design Decisions

- **ESM-only**: `"type": "module"` in package.json; all imports use `.js` extensions.
- **Stdio transport**: MCP server communicates via stdin/stdout; all debug logging goes to `console.error`.
- **Single-instance lock**: PID-based lock file in `/tmp/` prevents duplicate WebSocket connections.
- **Config location**: All user config lives at `~/.claude/channels/lark/.env`, not in the repo.
- **Memory is local-only**: All memory (profiles, episodes, skills) lives as markdown files under `~/.claude/channels/lark/memories/`. No remote backends — this keeps the trust boundary at OS file permissions and avoids vector-index policy questions for sensitive content.
- **Tiered profile memory (v0.10.0+)**: each user's profile lives at `profiles/{userId}/public.md` + `private.md`. `getProfile(ownerId, caller)` returns both tiers joined when caller === ownerId, and only public otherwise. Legacy single-file profiles lazy-migrate on first read (L1 + L2 classifier splits lines — L2 added in v0.11.1).
- **3-layer privacy classification**: L1 hardcoded regex/keyword rules (in code) > L2 user-edited `privacy-rules.md` (injected into distiller prompt; also consulted by legacy-profile migration via substring match, v0.11.1+) > L3 LLM judgment. `parseTieredProfile` applies L1 as a safety net over LLM output.
- **Identity is server-derived**: `IdentitySession` maps `(chat_id, thread_id?) → open_id` from authenticated Feishu events. MCP tools never accept a client-declared `open_id` or `created_by` — those are resolved server-side. Trust anchor = Feishu webhook signature.
- **CronJob visibility**: `list_jobs` filters by rendering-visibility — private chat shows caller's own jobs; group shows jobs whose `target_chat_id` matches the current chat (with prompt bodies redacted for non-owners). `update_job` / `delete_job` are owner-only.
- **Memory transparency (v0.11.0+)**: `what_do_you_know` returns the caller's profile entries (filtered by current-chat visibility); `forget_memory` removes a line by 8-char hash. `forget_memory(promote_to_rule=true)` appends the removed line to `privacy-rules.md` so future distillations classify similar content as private — the self-learning loop that completes the L1/L2/L3 infrastructure from v0.10.0.
- **Skill ownership (v1.0.14+)**: every `save_skill` write records `{created_by, created_at}` in a sidecar `skills/<slug>.meta.json`. Subsequent saves on the same slug are owner-only — non-owners get a clear "already claimed" error rather than silently overwriting. On first startup after upgrade, `migrateLegacySkills` claims all pre-v1.0.14 skills for `LARK_OWNER_OPEN_ID`. Without OWNER set, legacy skills are locked (safer than first-writer-wins, which would close the door right after letting an attacker through).
- **Audit log (v0.11.0+)**: every sensitive-tool invocation appends a line to `~/.claude/channels/lark/audit.log` (ok/denied/error with redacted args). Best-effort — log failures never propagate into tool behavior.
- **Image auto-download**: Images are downloaded to `~/.claude/channels/lark/inbox/` on receive. Claude reads local paths via `image_path` in notification meta.
- **Ack reaction**: Configurable emoji (`LARK_ACK_EMOJI`, default `MeMeMe`) sent on receive, auto-revoked after reply. Fire-and-forget, won't block message processing.
- **Bot message tracking**: `BotMessageTracker` (default 500, FIFO, configurable via `LARK_BOT_MESSAGE_TRACKER_SIZE`) tracks bot-sent message IDs. Used to filter reaction events — only reactions on bot messages are forwarded to Claude.

## Configuration

Required env vars: `LARK_APP_ID`, `LARK_APP_SECRET` (in `~/.claude/channels/lark/.env`).

Optional but recommended: `LARK_OWNER_OPEN_ID` — enables terminal-side skills (e.g. `/lark:jobs`) to act as the operator. Without it, terminal tool calls are denied.

For doc-comment support, the Feishu app must have these scopes enabled in the dev console:
- `docs:document.comment:read` — pre-fetch comment bodies
- `docs:document.comment:create` — post replies / new top-level comments
- `drive:drive.metadata:readonly` — fetch doc titles
- `docx:document:readonly` — read docx contents when Claude wants context

The event `drive.notice.comment_add_v1` must be enabled in the dev console (事件与回调 → 添加事件). Bot identity provides tenant-wide coverage — no per-file subscribe needed.

The `/lark:configure` skill (in `skills/configure/SKILL.md`) provides interactive setup within Claude Code.

## Important Conventions

- **Stdout is sacred**: MCP uses stdio for JSON-RPC. All logging must go to `console.error`, never `console.log`. The Lark SDK uses custom loggers to redirect to stderr.
- **`.mcp.json` must use `--silent`**: Prevents npm script lifecycle output from corrupting MCP transport.
- **Channel protocol**: Messages are forwarded to Claude via `notifications/claude/channel` (not `sendLoggingMessage`). Requires `experimental: { 'claude/channel': {} }` capability.
- **User display names**: Resolved via contact API → cached. Falls back to stable aliases (`user_` + last 7 chars of open_id). Memory keys always use raw open_id/chat_id.
- **Group chat filtering**: Only messages with @bot mentions are processed (precise match via bot open_id fetched at startup). P2P messages are always processed.
- **Reaction events**: Subscribed to `im.message.reaction.created_v1`. Filtered: ignores bot's own reactions, non-bot messages, and respects whitelists.
- **Stop hook enforces reply (v1.0.10+)**: `hooks/enforce-lark-reply.mjs` runs on every Claude `Stop` event. If a `<channel source="plugin:lark:lark">` message in the current turn was not answered by `reply` or `react` targeting the same `message_id`, the hook exits `2` and Claude is forced to remediate before ending the turn. (`edit_message` is intentionally excluded — its `message_id` targets the bot's previous card, not the user's inbound id, so it cannot satisfy a pending reply obligation.) To intentionally bypass (async handling / non-actionable event), put the literal sentinel `[LARK_DEFER]` or `[LARK_NO_REPLY]` on **its own line** in the turn's text output (inline echo is rejected — the line-only requirement guards against user-content echo attacks). Audit trail at `~/.claude/channels/lark/hook-audit.log` (override path with `LARK_HOOK_AUDIT_LOG`). Fail-safe: any hook error exits `0`, never blocks.
- **Doc-comment events (v1.1.0+)**: subscribed via `drive.notice.comment_add_v1` in `src/channel.ts` (pure `handleCommentEvent` + dispatcher registration). Filters: `is_mentioned=true` + `from_user_id != bot` + `passesWhitelist(from_user_id, "doc:<file_token>")`. Identity binding is per-comment: `setCaller("doc:<file_token>", comment_id, from_user_id.open_id)` at event time; `reply_doc_comment` / `create_doc_comment` must pass `thread_id=comment_id` and `doc_token=<file_token suffix of chat_id>` (binding enforced, no `__terminal__` escape). Owner-only — caller resolved via `IdentitySession` must equal `LARK_OWNER_OPEN_ID`. Stop hook requires `tool_result.is_error !== true` for the matching `reply_doc_comment` call to count as a satisfier; errored calls leave the obligation pending unless Claude follows up with `[LARK_DEFER]`.
- **Docs-surface drift check**: `bash scripts/check-doc-surfaces.sh` greps for common patterns where code and docs drift apart (env vars in `src/` not in `README.md`/`README_CN.md`; stale `setCaller(..., undefined, ...)` prose; smoke case counts in `CHANGELOG.md` not matching actual). Not wired into CI — false positives on benign edits. Run manually on security-impacting commits.

## Debugging

Debug logs are written to `~/.claude/channels/lark/debug.log`. Contains raw event data (sender, mentions, chatType) for diagnosing message flow issues.

Plugin code runs from three locations — all must stay in sync during development:
- `workspace` (source of truth)
- `~/.claude/plugins/marketplaces/claude-lark-plugin/` (marketplace clone)
- `~/.claude/plugins/cache/claude-lark-plugin/lark/<version>/` (Claude Code runtime cache)
