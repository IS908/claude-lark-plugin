# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.9.0] - 2026-04-19

### Added
- **`IdentitySession`** (`src/identity-session.ts`) — server-side `(chat_id, thread_id?) → open_id` mapping populated from Feishu events. Sensitive MCP tools now consult the session instead of trusting Claude-declared identity parameters. Closes a privacy hole where a socially-engineered prompt could make tools act on behalf of another user.
- **`send_chat_id` and `origin_chat_id` on `JobMeta`** — enables visibility filtering based on where a job delivers output vs where it was created. Legacy jobs are backfilled from `target_chat_id` on read.
- **`LARK_OWNER_OPEN_ID` config key** — identity fallback for terminal skill invocations. Terminal skills pass the reserved `__terminal__` chat id; the session resolves it to this owner. Without this set, terminal-side sensitive operations are denied.
- **`LARK_IDENTITY_SESSION_TTL_MS` config key** — optional override for session entry staleness. Default is `max(2h, LARK_INACTIVITY_HOURS × 2h)` so session entries always outlive the auto-flush window — otherwise flush-triggered `save_memory` calls would fail to resolve the caller.
- `scripts/identity-smoke.ts` — 8 smoke assertions covering chat/thread precedence, fallback, terminal sentinel, unknown chat, staleness, cleanup, and overwrite.

### Changed
- **`list_jobs` now filters by rendering visibility.** In a private chat, the caller sees jobs they created. In a group chat, everyone sees jobs whose `send_chat_id` matches that group — with prompt/content/meta redacted for non-owners (owner identity and schedule remain visible for accountability). Closes the hole where group members could inspect each other's full job prompts.
- **`update_job` / `delete_job` restricted to job owner.** Visibility ≠ mutation rights.
- **`save_memory` no longer accepts a client-supplied `open_id`.** Profile writes always target the resolved caller — you cannot write facts "on behalf of" another user.
- **`create_job` now requires `chat_id`** (used to resolve caller identity and populate `origin_chat_id`). The `created_by` parameter is removed; creator is derived from the session.
- **Scheduler attaches a unique `thread_id`** (`job-<id>-<timestamp>`) to each cronjob execution so cronjob session entries don't clobber concurrent inbound human messages in the same chat.
- Cronjob deliveries use `send_chat_id` (same value as `target_chat_id` for freshly created jobs).

### Security
- Group members can no longer list or inspect other users' jobs in a group — `list_jobs` returns only the jobs delivering output to that group, with free-form content redacted for non-owners.
- Socially-engineered prompts ("act as kk and list their jobs") can no longer direct tools to act on behalf of a different user — the caller is derived server-side from the Feishu event, not from tool arguments.
- Terminal skill invocations now require `LARK_OWNER_OPEN_ID` to be configured; missing or mismatched identity results in tool rejection.
- **Defensive posture for the `__terminal__` sentinel.** The MCP server instructions explicitly warn Claude never to substitute `__terminal__` for a real `chat_id`, and `src/identity-session.ts` carries a SECURITY NOTE documenting the trust-but-verify model. A stronger server-side heuristic (e.g. reject `__terminal__` when a fresh real-chat session entry exists) is deferred to Phase 3. Practical risk is low — the sentinel is not surfaced in any notification metadata, so Claude would need to invent the string on its own.
- Thread-id handling strengthened at the parameter-description level on all sensitive tools (`save_memory`, `create_job`, `list_jobs`, `update_job`, `delete_job`): Claude is told explicitly that omitting `thread_id` in a cronjob turn silently attributes the action to the wrong user. Prevents a subtle cross-turn leak where a cronjob-owned action would be recorded against the last human speaker's identity.

### Migration
- **Legacy jobs with empty `created_by`** (created before the field was enforced) are backfilled to `LARK_OWNER_OPEN_ID` on read. This keeps the operator's existing jobs mutable via `update_job` / `delete_job` after upgrade. If `LARK_OWNER_OPEN_ID` is unset, legacy jobs with empty `created_by` remain un-mutable — set the env var and restart to recover them.
- **Legacy jobs missing `send_chat_id` / `origin_chat_id`** are backfilled from `target_chat_id` on read. No operator action required.
- **`MEMORY_PROVIDER=openviking` or `mem0`** users: already migrated in v0.8.5 (those backends were dropped). No v0.9.0-specific migration.

## [0.8.5] - 2026-04-19

### Removed
- `MemoryProvider` abstraction and the `openviking` / `mem0` backends. The file-based memory store is now the only (and always-was-the-default) backend.
- Config keys no longer read: `MEMORY_PROVIDER`, `OPENVIKING_URL`, `OPENVIKING_API_KEY`, `MEM0_URL`, `MEM0_API_KEY`.
- Deleted: `src/memory/interface.ts`, `src/memory/factory.ts`, `src/memory/openviking.ts`, `src/memory/mem0.ts`, `test/test-openviking.ts`.

### Changed
- `FileMemoryProvider` renamed to `MemoryStore`; `Episode` / `EpisodeMeta` / `Skill` types are now defined inline in `src/memory/file.ts`.
- `/lark:configure setup` simplified from 5 steps to 3 (credentials, filtering, memory tuning) — the provider selection and backend-config steps are gone.
- Docs, README, and README_CN updated to describe the single local backend.

### Migration
- Users on `MEMORY_PROVIDER=file` (the default): zero action required.
- Users previously on `MEMORY_PROVIDER=openviking`: local memory files (profiles/episodes/skills) are preserved — the OpenViking hot-path already used local files as primary storage. Only the Viking-side vector index is abandoned; semantic episode search falls back to the file provider's keyword + recency scoring.
- `MEMORY_PROVIDER=mem0` was a stub that always threw — no one was running it.

### Rationale
Precondition for the privacy redesign (#35). A pluggable abstraction made every downstream interface change a three-file synchronization exercise, and the OpenViking vector index raised a policy question ("do we index private-tier content?") with no good default for a one-operator plugin. Removing the abstraction now is cheaper than maintaining it through the next three releases.

## [0.8.4] - 2026-04-17

### Fixed
- **Image auto-download now works** (fixes #15): user-uploaded images are downloaded to `~/.claude/channels/lark/inbox/` as intended. Previously the plugin used `im.v1.image.get` which only works for images the bot itself uploaded — it silently failed for user-sent images. Switched to `im.v1.messageResource.get` with `type: 'image'` which is the correct API for downloading user-uploaded resources.
- `download_attachment` tool: also switched all paths to `messageResource.get` (routing `type` by `img_` prefix: image → `'image'`, file/audio/video → `'file'` per Feishu API semantics). All resource types now download consistently through the same API.

## [0.8.3] - 2026-04-17

### Added
- Raw card JSON support: `reply` tool accepts a `card` param with Feishu Schema 2.0 JSON, sending pre-built cards directly without `buildCards` conversion
- Centralized prompt templates: all hardcoded prompts extracted to `src/prompts.ts` (`flushPrompt`, `profileDistillationPrompt`, `cronJobPrompt`, `enrichmentPrompt`)
- `scripts/reply-card-smoke.ts` — 8 smoke test assertions covering the raw card path (valid/invalid JSON, reply_to routing, buffer recording, ack revocation, fallback text)

### Fixed
- Raw card path now records assistant response in `ConversationBuffer` (previously skipped due to early return)
- Raw card path now revokes ack reaction (previously skipped due to early return)
- Removed unused `chat_id` destructuring in `save_skill` handler
- Stale JSDoc comment ("Register all 6 MCP tools" → "Register all MCP tools")

### Changed
- Deduplicated buffer-record + ack-revoke logic into shared `recordAndRevokeAck()` helper in `reply` tool
- `files` param description now notes it is ignored when `card` is provided

## [0.8.2] - 2026-04-17

### Fixed
- CronJob timezone drift: `cron-parser` now uses an explicit timezone (`LARK_CRON_TIMEZONE`, defaults to system timezone) so cron hours always map to the user's wall-clock time. Previously the scheduler implicitly used the system tz, causing mismatched expectations when jobs were created with UTC-converted hours.
- `create_job` and `update_job` responses now surface the timezone used (`tz=...`) for verification.
- Early validation: `expandSchedule` now validates the final cron against the configured timezone for all paths (aliases + raw cron), catching invalid `LARK_CRON_TIMEZONE` values at `create_job` time instead of later at scheduler-tick time.

### Added
- `LARK_CRON_TIMEZONE` config option (IANA timezone name, e.g. `Asia/Shanghai`, `UTC`)
- 3 new smoke test assertions covering `computeNextRun` timezone behavior and alias validation

## [0.8.1] - 2026-04-17

### Fixed
- Cronjob execution failure retry: transient errors (DNS, timeout, 429, 5xx) now retry up to 3 times with delays 30s → 60s → 120s. Permanent errors (permission denied, param error) fail immediately without retry. Previously a brief network hiccup would cause a daily job to be skipped for 24 hours.

## [0.8.0] - 2026-04-17

### Added
- **CronJob scheduler**: file-based recurring task system with two job types
  - `message` type: send fixed content directly via Feishu API (deterministic, no Claude)
  - `prompt` type: inject prompt into Claude via channel notification, Claude executes and replies (best-effort)
- **4 MCP tools**: `create_job`, `list_jobs`, `update_job`, `delete_job` — manage jobs from Feishu chat or terminal
- **`/lark:jobs` skill** (`skills/jobs/SKILL.md`) — guided job management via Claude Code
- **Crash recovery**: on restart, missed jobs (where `next_run_at < now`) are executed once
- **Schedule aliases**: `every 30m`, `daily at 09:00`, `weekdays at 17:00` expanded to cron at creation
- **New dependency**: `cron-parser` (~20KB) for cron expression parsing and next-run calculation
- **New config**: `LARK_CRON_SCAN_INTERVAL` (default: 60s) — scheduler scan interval
- Job storage at `~/.claude/channels/lark/jobs/{id}.json` with `meta` / `runtime` split structure
- Design spec: `docs/superpowers/specs/2026-04-16-cronjob-scheduler-design.md`

## [0.7.1] - 2026-04-16

### Fixed
- Whitelist semantics: `LARK_ALLOWED_USER_IDS` and `LARK_ALLOWED_CHAT_IDS` now combine with **OR** when both are configured — a message is allowed if the sender matches the user list **or** the chat matches the chat list. Previously (AND) required both to match, which silently dropped valid traffic. Setting only one list still gates on that list alone.

## [0.7.0] - 2026-04-15

### Added
- Feishu reply card rendering: long or markdown-rich replies (headings, code blocks, tables, lists, bold, or length > 500 chars) auto-render as Schema 2.0 (CardKit) cards with `wathet` header template and title extracted from first heading
- `format: 'text' | 'card'` optional parameter on the `reply` tool — overrides the heuristic when Claude needs to force a specific format
- `footer: string` optional parameter on the `reply` tool — renders as a small `text_size: 'notation'` footnote at the card bottom
- Code-block-safe text splitting: long content is chunked at paragraph/line boundaries, never truncating inside a fenced code block without closing and reopening the fence with its language tag
- Multi-card overflow: oversized replies split across multiple sequential cards, bounded by element count (≤45) and total size (≤25 KB)
- Markdown optimization for Feishu rendering: heading demotion (H1→H4, H2~H6→H5), `<br>` padding around tables and consecutive headings, invalid image reference stripping, blank line compression
- `scripts/card-smoke.ts` — 11 smoke assertions covering heuristic rules, card splitting, footer, title extraction, code-block-safe boundaries, unclosed fences, and empty-input fallback; runs as part of `npm test`

### Changed
- Reply tool description updated to mention card auto-rendering
- MCP instructions updated to explain `format` and `footer` parameters

## [0.6.1] - 2026-04-15

### Fixed
- Thread-aware reply routing: replies no longer mix up when multiple threads in the same group are active concurrently. Plugin now tracks the latest inbound message per (chat, thread) and auto-corrects `reply_to` when Claude passes `thread_id` but omits `reply_to`.

### Added
- `thread_id` parameter to the `reply` tool — pass it so the plugin can auto-route into the correct thread
- `LatestMessageTracker` with 10-minute TTL

### Changed
- `MessageQueue` now keys by `chatId:threadId` instead of `chatId` — different threads in the same group process in parallel
- Instructions updated to emphasize strict message_id ↔ `<channel>` tag matching

## [0.6.0] - 2026-04-14

### Added
- Marketplace metadata: version, homepage, category, keywords in marketplace.json and plugin.json
- CHANGELOG.md following Keep a Changelog format
- Smoke tests (`npm test`): typecheck, dry-run, stdout cleanliness
- `LARK_BOT_MESSAGE_TRACKER_SIZE` config option (default: 500, was hardcoded 300)

### Changed
- BotMessageTracker size configurable via constructor and env var
- Removed version badge from READMEs (maintained in package.json and releases only)

## [0.5.3] - 2026-04-14

### Added
- Apache 2.0 LICENSE file
- README badges (version, node, license, docs)

### Changed
- Updated README badge style for both EN and CN versions

## [0.5.2] - 2026-04-12

### Changed
- Simplified `scripts/start.sh` — removed lark-cli skill symlink management
- Removed `LARK_ENABLED_SKILLS` config option

## [0.5.1] - 2026-04-12

### Fixed
- Use `Typing` emoji for P2P ack, `MeMeMe` for group @bot
- Ack revoke fallback: clear all pending acks when `reply_to` not provided
- Reaction event parsing: use `operator_type=app` to filter bot's own reactions
- Removed verbose debug JSON dumps

## [0.5.0] - 2026-04-12

### Added
- Image auto-download to local inbox; `image_path` in notification meta
- Full attachment metadata in notifications (single + multi)
- MeMeMe ack reaction on receive, auto-revoke on reply
- Reaction event forwarding (`im.message.reaction.created_v1`)
- Bot message tracking (capped 300, FIFO) for reaction filtering
- Type-aware `download_attachment` (image API for `img_` keys)
- `LARK_ACK_EMOJI` config option (default: `MeMeMe`)

### Changed
- Updated MCP instructions for image/attachment handling

## [0.4.0] - 2026-04-12

### Added
- Memory injection pipeline: user profiles, episodic memory, skills
- OpenViking adapter with dual-write architecture
- Score-based filtering (`LARK_MIN_SEARCH_SCORE`)
- HealthCheck for memory provider connectivity

[0.9.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.9.0
[0.8.5]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.8.5
[0.8.4]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.8.4
[0.8.3]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.8.3
[0.8.2]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.8.2
[0.8.1]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.8.1
[0.8.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.8.0
[0.7.1]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.7.1
[0.7.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.7.0
[0.6.1]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.6.1
[0.6.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.6.0
[0.5.3]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.5.3
[0.5.2]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.5.2
[0.5.1]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.5.1
[0.5.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.5.0
[0.4.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.4.0
