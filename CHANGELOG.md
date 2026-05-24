# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [1.0.11] - 2026-05-24

### Fixed
- **Stop hook's remediation hint listed `edit_message` as a satisfying tool** (#72). v1.0.10 dropped `edit_message` from the hook's `REPLY_TOOLS` set (its `message_id` targets the bot's own card, not the user's inbound id), but the block-message text injected into Claude's context still said `"Call mcp__plugin_lark_lark__reply (or edit_message / react targeting the same message_id) ..."`. Claude reading that hint after a block could call `edit_message` and get blocked again on the very next Stop event — a one-extra-round UX cost, no behavior-safety impact. Updated the hint to recommend only `reply` and `react`, with an explicit note that `edit_message` does NOT satisfy and why.

  Also synced two adjacent stale doc/prompt strings carrying the same v1.0.10-era conflation (found during PR #73 audit):

  - `src/prompts.ts` `mcpServerInstructions` — was "Interact via reply / edit_message / react" (listing three tools as peers, implying equivalence). The new wording distinguishes the three by role: reply = canonical substantive answer; react = ack-only for trivial messages that need no answer; edit_message = patches a prior bot card and does NOT count as responding to a user. The instruction string is in Claude's context every session; the old triad was leading Claude to occasionally substitute the wrong tool.
  - `CLAUDE.md` Stop-hook description — was "not answered by `reply` / `edit_message` / `react`" → "not answered by `reply` or `react`" with an inline note on why `edit_message` is excluded. Was stale since v1.0.10 itself.

  Also synced the stale `collectReplies` code comment (still mentioned "edit_message and react").

  New smoke test 28 asserts the hint string does not list `edit_message` as a satisfying option. The regression guard catches the specific bad pattern (`"(or edit_message"`) without false-positiving the new corrective phrasing that legitimately mentions `edit_message` in a NEGATIVE context.

## [1.0.10] - 2026-05-23

### Added
- **Stop hook enforces Lark reply before turn ends** (#70). Ships `hooks/enforce-lark-reply.mjs` and registers it as a `Stop` event hook in the plugin manifest. When Claude prepares to end a turn, the hook scans the session transcript for the most recent user message, extracts any `<channel source="plugin:lark:lark">` tags, and verifies each pending `message_id` was answered by an `mcp__plugin_lark_lark__reply` tool call in the same turn. If a Lark message is unreplied, the hook exits `2` with stderr listing the missing `message_id`s — Claude Code injects that stderr into the model context, forcing a remediation iteration before the turn can actually end. Background: previously the only enforcement was advisory (the `Stdout is sacred` clause in CLAUDE.md plus per-notification system reminders), and on long turns Claude occasionally finished with terminal-only text output, leaving the Lark user staring at silence.

  **Escape hatches.** Claude can opt out of the block by placing the literal sentinel `[LARK_DEFER]` (intentional async handling — reply will come from a later subagent / callback) or `[LARK_NO_REPLY]` (event genuinely needs no reply) **on its own line** in the turn's text output (or thinking block). The line-only requirement guards against echo attacks where user content asks the bot to print the sentinel inline.

  **Loop safety.** Honors the Claude Code `stop_hook_active` field — when the hook is re-invoked inside a forced-continuation cycle, it exits `0` to break the loop unconditionally, so a misbehaving model cannot wedge the conversation forever.

  **Fail-safe.** Any internal error (transcript unreadable, JSON parse failure, missing fields, unexpected schema) is caught and exits `0` with an audit-log entry. Tool malfunction never blocks the conversation.

  **Audit log.** Every invocation appends one line to `~/.claude/channels/lark/hook-audit.log` with status (`ok` / `deferred` / `blocked` / `loop-break` / `fail-safe`) and counts. Tail it to tune false-positive rate.

  **Heuristic batch match.** If a `reply` doesn't quote a specific `reply_to` but targets the same `chat_id` as a pending message, that counts as a reply — handles the case where Claude consolidates multiple inbound messages into one outbound reply.

  **Channel-injection hardening.** A Feishu user could otherwise place a literal `<channel source="plugin:lark:lark" message_id="om_evil">` (or even a literal `</channel>` followed by a forged sibling) inside their own message body, causing the hook to track a non-existent message_id forever. The scanner now extracts at most one channel tag per user entry — matching `src/index.ts:146`'s "one notification per inbound" invariant — and never re-parses body content.

  **Queue-race correctness.** When two inbound notifications land in the same chat across a turn boundary (one mid-assistant-work), a reply quoting the *previous* turn's message_id is no longer counted as covering the *current* turn's pending message via the chat heuristic.

  **Parser robustness.** Tolerates `>` inside quoted attribute values, whitespace around `=`, bare flag attributes, unicode attribute names. Accepts both `tool_use` and `server_tool_use` block types. Recognizes cronjob notifications via the unambiguous `job_id` attribute (set by `src/scheduler.ts:437`).

  **Reply tool semantics.** Only `mcp__plugin_lark_lark__reply` and `mcp__plugin_lark_lark__react` satisfy a pending inbound — `edit_message` does NOT. Its `message_id` argument targets the BOT's previous message (the one being patched), not the user's inbound message_id; a turn that called only `edit_message` (no prior `reply`) correctly still blocks. When `reply` IS present, the trailing `edit_message` is a harmless follow-up refinement.

  **Bounded transcript read.** The hook tail-reads at most 2 MB of the transcript JSONL — enough to span a typical turn (10–100 KB) plus generous slack, while keeping per-`Stop` latency constant in long Claude Code sessions (which can accumulate tens of MB of history). Pathologically long single turns (> 2 MB of activity) gracefully fall back to fail-safe `no-user-entry` instead of multi-second reads.

  **Tests.** `hooks/test-enforce-lark-reply.mjs` exercises 27 scenarios across 47 assertions, including dedicated injection vectors (nested-opener and early-closer), queue-race false-negative, parser edge cases, sentinel echo attack, audit-log content integrity, reply-tool semantics (`edit_message`-alone blocks; reply + edit_message satisfies), and a > 2.5 MB transcript exercising the tail-only read path.

## [1.0.9] - 2026-05-22

### Changed
- **A cronjob's `meta.id` is now derived from its filename — the single source of truth** (#68). Previously a job's identity was stored in two independent, writable places: the on-disk filename (`{id}.json`) and the internal `meta.id` field. They could diverge — via hand-edits, `cp`, or a prior release's `sanitizeJobId` rule change — and the v1.0.6 skip-on-mismatch protection (#62) then **silently skipped the file**: `list_jobs` couldn't see it, the scheduler never ran it. One operator's `premarket-news` job sat dead for 3 days this way (run_count 0, found only by manually inspecting files).

  `readJob` and `listAllJobs` now overwrite `meta.id` with the filename stem on every read. Divergence is structurally impossible, so the skip-on-mismatch logic is **removed**. A hand-edited `meta.id` is silently ignored — the job keeps running under its filename id (graceful degradation) instead of vanishing.

  **Contract:** to rename a job, rename its file. Editing `meta.id` inside the JSON has no effect.

  This also handles the `cp foo.json bar.json` case more honestly than the old skip: the copy becomes a genuinely distinct job `bar` (its own filename id), fully addressable by `update_job` / `delete_job` — not the #62 duplicate-execution bug (which required both files to claim the *same* id).

- **Crash recovery skips stale missed runs, and tells the job's chat** (follow-up from the #68 audit). `recoverMissedJobs` runs once on startup and catches up jobs whose scheduled time passed while the plugin was down. It now skips a missed run that is more than **6 hours** late — the run is dropped and `next_run_at` advanced to the next future occurrence. Crash recovery is meant for outages (restart / reboot / deploy, or a laptop closed for an afternoon); a job recovered much later delivers wrong-time content (a market pre-open briefing fired the next morning). Directly relevant on upgrade: a job wrongly skipped for days under v1.0.6–v1.0.8 would otherwise fire a multi-day-stale run the moment 1.0.9 makes it visible again — now it just resumes its schedule cleanly.

  When a stale run is skipped, the plugin posts a short notice (`⏭️ Scheduled job "…" missed a run … next run: …`) — two-tier delivery: first to the job's `target_chat_id`, and if that send fails (the chat may be gone — bot kicked, group dissolved) it falls back to a direct message to the job owner (`created_by`). Previously the skip was a stderr line only — invisible to the operator. The notice is best-effort: `next_run_at` is advanced and persisted before it is sent, so a failed notice never causes a re-skip/re-notify loop; if both channels are unreachable a final stderr line is the last resort.
- **Startup logs the job inventory** (follow-up from the #68 audit). The scheduler now logs `Loaded N job(s): <id>, <id>, …` on start. The #68 incident was hard to diagnose partly because a dead job was invisible — the inventory line gives the operator immediate visibility, and a surprising name (e.g. a `premarket-news.bak` next to `premarket-news`) flags a stray `*.json` that became a live job.

### Removed
- The filename/meta.id skip-on-mismatch check in `listAllJobs` (added in v1.0.6 for #62). No longer needed — with filename as the single source of truth there is nothing to mismatch. The v1.0.7 (#64) ENOENT / corrupt / unreadable distinction is retained.

### Upgrade notes
- **Every `*.json` file in `~/.claude/channels/lark/jobs/` is a live job.** Because the filename is now the job id, parking a backup copy there — `cp premarket.json premarket.bak.json` — creates a *second* active job (`premarket.bak`) that delivers alongside the original. Keep backups outside the jobs directory. The new startup inventory log surfaces this if it happens.
- A job that was filename/meta.id-mismatched (silently skipped under v1.0.6–v1.0.8) becomes visible again on upgrade. If its missed run is more than 6 hours stale — usually the case — the crash-recovery staleness guard skips the catch-up and resumes the normal schedule; no mistimed delivery. A job missed by under 6 hours is still caught up once, as before.

## [1.0.8] - 2026-05-19

### Fixed
- **Auto-flush `save_memory` was silently denied in threaded group chats** (#66). After the inactivity-triggered buffer flush, Claude tried to call `save_memory(type="chat", chat_id=X)` to persist the distilled summary, but `resolveCaller(X, undefined)` returned null and the call was denied — Claude printed a "no caller, giving up" diagnostic to stderr and the episode was lost. Pre-1.0.8 the `CLAUDE.md` note called this "flaky"; the actual cause is structural, not transient:

  Identity binding uses key `(chatId, threadId)`. In a threaded group chat, user messages bind under `(chat, thread)`. The flush notification carries `chatId` only (the buffer is chat-scoped, no thread). `getCaller(chat, undefined)` falls back to chat-level entries — which exist only for non-threaded chats. **Threaded group chats failed every flush.**

  Fix: in `buffer.setFlushHandler`, bind a sentinel caller `SYSTEM_FLUSH_CALLER = '__system_flush__'` before notifying Claude — mirrors `scheduler.executePromptJob`'s pattern of binding `job.meta.created_by` before a cronjob notification. Chat episodes are stored by `(chatId, threadId?)` only (not by caller), so the sentinel only affects audit-log attribution — the data itself goes to the same `episodes/<chatId>/` directory it always did. Audit log entries for system-flush writes carry `caller=__system_flush__`, making system-distilled episodes greppable.

### Added
- `SYSTEM_FLUSH_CALLER` constant exported from `src/identity-session.ts`.
- Server-side guard in `resolveCaller`: when caller resolves to `SYSTEM_FLUSH_CALLER`, only `save_memory` is authorized — all other sensitive tools (`create_job`, `update_job`, `delete_job`, `list_jobs`, `what_do_you_know`, `forget_memory`) are denied. Reason: the sentinel exists solely to let buffer flushes persist chat episodes without a real user. A sentinel-attributed `create_job` would produce a job no real operator could later update/delete (owner mismatch); a sentinel-attributed `forget_memory` couldn't address any user's profile. The guard is also defense for the sticky-binding window: `IdentitySession` entries outlive the flush turn until the next real user message overwrites them.
- Server-side guard in `save_memory`: when caller is `SYSTEM_FLUSH_CALLER`, `type="profile"` is rejected with an explanatory error. Profile writes are user-scoped (`saveProfile` writes to `profiles/<callerId>/`), and the sentinel has no user identity to legitimately own private-tier data.
- `scripts/auto-flush-smoke.ts` — 8 assertions covering: sentinel value; `setCaller`/`getCaller` roundtrip; end-to-end `save_memory(type=chat)` success with episode file written to disk; `save_memory(type=profile)` rejection; audit log records both `denied` and `ok` with the sentinel caller (operator-greppable); `create_job` denied for the sentinel; `forget_memory` denied for the sentinel.

### Changed
- The auto-flush prompt (`src/prompts.ts`) now explicitly tells Claude the turn is system-initiated, that the plugin has bound a system caller, and that profile writes will be rejected server-side. Stops Claude from second-guessing and emitting the "no caller, giving up" diagnostic on threaded chats.

Closes #66

## [1.0.7] - 2026-05-19

Three small `job-store` hygiene improvements from #64. No behaviour change for operators whose jobs directory is healthy.

### Changed
- **`listAllJobs` reads job files in parallel.** Was sequential `await fs.readFile` in a for-loop — O(N × per-file latency). Switched to `Promise.all`. Negligible at typical operator scale (<10 jobs), linear-bad once cronjob counts grow.
- **`listAllJobs` distinguishes ENOENT / corrupt / unreadable.** Pre-1.0.7 lumped all read failures under `Skipping corrupt job file <file>: <err>`. Three real failure modes now route differently:
  - **ENOENT** (file vanished between `readdir` and `readFile` — a benign race with concurrent `deleteJob`) → silent skip. The file is legitimately gone, which is the desired state.
  - **SyntaxError** (JSON parse failed) → `Skipping corrupt job file <file> (invalid JSON): <msg>`.
  - **Other** (EACCES, EISDIR, ...) → `Skipping unreadable job file <file>: <msg>`. Operator should investigate.

### Fixed
- **`writeJob` invariant documented.** v1.0.6 fixed the read-side dual-file orphan path (#62). v1.0.7 documents the symmetric write-side invariant in the `writeJob` JSDoc — if a future feature ever lets users rename a job, the caller MUST `deleteJob(oldId)` first. No code change today; every current caller (create_job / update_job / scheduler) keeps `meta.id` stable.

### Added
- Smoke tests 32–34 in `scripts/job-smoke.ts`: corrupt JSON file labelled correctly (not "unreadable"); a corrupt sibling doesn't break loading of valid jobs alongside; 20 valid jobs all load via the parallel path.

Closes #64

## [1.0.6] - 2026-05-18

### Fixed
- **Cronjob duplicate execution from filename / `meta.id` mismatch** (#62). `listAllJobs()` previously trusted whatever `meta.id` each file carried, completely independent of the on-disk filename. When the two diverged — typically via hand-edits, `cp foo.json bar.json` for testing, or stale files from a prior release whose `sanitizeJobId` rules changed — the scheduler would surface multiple `JobFile` entries with the same id at every tick and execute the job once per file. `type=message` jobs sent the notification 2×/N× per cycle; `type=prompt` jobs dispatched 2×/N× subagents with all the API-call duplication that implied. Meanwhile `update_job` / `delete_job` (which locate files via `{id}.json`) silently failed for any job whose on-disk file had been renamed.

  `listAllJobs()` now skips and logs a clear stderr warning when `file !== \`${meta.id}.json\``. Defensive (skip + warn) rather than auto-reconcile: operators may have deliberately renamed files, and silently mutating their on-disk state would be worse than surfacing the mismatch. The warning text points at the corrective action (rename file OR edit `meta.id`).

  New smoke assertions (30/31) in `scripts/job-smoke.ts` exercise both the happy path (matched files load) and the mismatch defense (mismatched files skipped + warning emitted) by writing two fixture files into a tmp `jobsDir`.

## [1.0.5] - 2026-05-12

### Fixed
- **`download_attachment` silently failed for PDF / file / audio / video** (#60). The tool's response-handling code only knew how to write a `Buffer` (or a Readable stream on newer Node). The Lark SDK returns binary resources wrapped as `{ writeFile(path): Promise<void> }` — passing that object to `fs.writeFile` either threw (caught by the outer try/catch, surfaced as the generic `"Failed to download attachment"`) or wrote `[object Object]` to disk. Images worked only because `channel.downloadImage` had separately implemented the three-shape dispatch.

  Centralised the dispatch in a new `src/sdk-resource.ts` module with `writeSdkResource(data, filePath)` — handles `Buffer`, `{ writeFile }`, and `Readable` streams uniformly, and throws a descriptive error (with a shape descriptor) when the SDK returns something unexpected. Both `channel.downloadImage` and `tools.download_attachment` now route through this helper.

- **Saved attachments now keep their original extension.** `download_attachment` previously saved every file as the opaque `file_key` (`file_v3_xxx`, no extension). Claude `Read` infers MIME from extension, so PDFs and text files weren't being parsed correctly even when the SDK bug above didn't bite. The tool now accepts an optional `file_name` parameter (the inbound notification's `meta.attachment_name`, e.g. `report.pdf`); saved file becomes `<file_key>-<sanitized_name>`. File names are sanitised (path-basename + non-`\w.-` replacement) to block traversal attempts.

- **`download_attachment` error messages now include diagnostic context** — SDK error code + message, file_key, and routed resource type. Previous behavior collapsed all failures to the generic string `"Failed to download attachment"`, leaving Claude no signal to retry or escalate.

### Added
- `src/sdk-resource.ts` — shared module exporting `writeSdkResource(data, filePath)` and `describeSdkResource(data)` (the latter is used inside error messages so future SDK shape mismatches surface a clear "object{whatever}" descriptor).
- `scripts/download-attachment-smoke.ts` — 15 mock-based assertions covering all three SDK response shapes, `img_*` vs `file_*` routing, file_name extension preservation, path-traversal sanitisation, SDK error diagnostic propagation, unknown-shape behaviour, and direct unit tests for the `capSanitizedFilename` helper (long stem, long extension, CJK chars stripped, leading-dot files, traversal). Wired into `npm test`.

## [1.0.4] - 2026-04-24

### Fixed
- **Plugin startup crash from EventDispatcher stdout pollution.** `src/channel.ts` wired a custom stderr logger onto `Lark.Client` and `Lark.WSClient` but missed `Lark.EventDispatcher`, which therefore used the SDK's default logger. On every startup the EventDispatcher wrote `[info]: [ 'event-dispatch is ready' ]` to stdout — which the MCP stdio transport reserves for JSON-RPC framing. The non-JSON bytes corrupted the handshake and Claude Code killed the plugin subprocess. Added the same stderr-redirecting logger to the EventDispatcher constructor.

  This was not caught by `scripts/test.sh`'s existing "MCP stdout clean" assertion because dry-run exits before `channel.start()`, which is where the EventDispatcher is actually constructed.

### Added
- **Static lint: `scripts/check-sdk-loggers.ts`.** Parses `src/channel.ts` and verifies every `new Lark.<Client|EventDispatcher|WSClient>(` has a `logger:` option within its argument block (paren-balanced scope, not fixed-line window). Runs as part of `npm test` — future omissions fail CI rather than manifest as a mysterious production crash.

## [1.0.3] - 2026-04-24

### Fixed
- **Follow-up messages in a Feishu thread are now correctly routed into the thread** (#56). In a group thread (话题), when Claude replied with text + image (or long text split into multiple chunks, or a multi-card response), the first message stayed in the thread via `message.reply()` but every follow-up escaped to the chat's root timeline via `message.create()`. Now all follow-ups use `message.reply(source, reply_in_thread: true)` when the triggering notification carries a `thread_id`, which routes into the thread without rendering as a quote-reply. P2P and non-threaded group chats are unaffected — the gate falls through to `message.create()` in those cases (setting `reply_in_thread: true` on a non-threaded source would incorrectly start a new thread).

Fix applies to three call sites in `src/tools.ts`:
- Multi-chunk text replies (chunks 2..N)
- Multi-card replies (cards 2..N)
- Attachments (images, files)

Cronjob-synthetic `thread_id` values (prefixed `job-`, used for IdentitySession isolation, not real Feishu threads) are excluded from thread-routing. Without this carve-out, a cronjob reply with an attachment could pull an unrelated earlier user message into a fabricated Feishu thread.

New `scripts/reply-thread-smoke.ts` verifies the routing via a mock Feishu client across six scenarios (thread + image, P2P + image, thread + long text, missing `reply_to` fallback, thread + file, thread + multi-card).

### Changed
- **Attachment message IDs now tracked in `BotMessageTracker`.** Pre-1.0.3 the attachment path fire-and-forgot the send and never recorded the returned message_id. Reactions on bot-sent images/files were therefore silently filtered out by the reaction-forwarding gate (which only forwards reactions on known-bot messages). Because the thread-routing fix now captures the send response anyway, the plugin also calls `BotMessageTracker.add` on attachments — user reactions to bot-generated images/files will now correctly surface to Claude.

## [1.0.2] - 2026-04-22

Two field-reported bug fixes on top of 1.0.1.

### Fixed
- **`save_memory` no longer overwrites existing profile content** (#51). `saveProfile` was doing an unconditional `fs.writeFile`, so a single-fact save (e.g. "记住我不吃鱼") wiped the entire tier file. Introduces a `mode` parameter: `"append"` (new default) reads the existing tier, merges incoming lines deduped case-insensitively (punctuation not normalized — `"喜欢茶"` and `"喜欢茶。"` are kept as distinct), preserves all original content, and auto-bullets lines missing a `-`/`*` prefix; `"replace"` keeps the old overwrite behavior and is now only used by the distiller auto-flush path, which intentionally rewrites the full tier from history. Near-duplicates (prefix containment either direction, normalized) emit a `[memory] Possible near-duplicate` warning to stderr.
- **Group @bot misrouted as @other-user** (#52). Feishu text messages carry opaque placeholders (`@_user_1`, `@_user_2`, …) in the `text` field with the identity mapping in the `mentions` array. The plugin's group-mention filter already matched by `open_id` correctly, but the text forwarded to Claude still contained raw placeholders — so Claude's own reasoning, reading `@_user_1`, concluded the message was addressed to a different user and stayed silent. `extractText` results (and `parentContent` in threaded replies) are now post-processed: each `@_user_N` is replaced with `@<name>` from `mentions[N-1]`. Masked / empty names (user privacy settings) and out-of-range indices keep the placeholder verbatim. A new `bot_mentioned: "true"` field is added to the `<channel>` notification `meta` when the bot's `open_id` is present in mentions — a text-independent signal that complements the resolved names.

### Changed
- `save_memory` MCP tool gains a `mode` parameter (profile only) documented in the tool schema. The distiller flush prompt now passes `mode="replace"` explicitly.
- `LarkMessage` gains `botMentioned?: boolean`; surfaces as `meta.bot_mentioned` on the MCP notification.
- **Profile line storage/display is now bullet-normalized.** `listProfileLines` strips a leading `-`/`*` marker before hashing, so a fact saved by the distiller as `"foo"` and later merged via append as `"- foo"` share one hash and render identically in `what_do_you_know`. `removeProfileLine` rewrites the tier with a consistent `- ` prefix on every remaining line. Fixes a double-bullet visual artefact (`- [hash] - foo`) that would otherwise appear on content saved after 1.0.2 append-mode.

## [1.0.1] - 2026-04-21

Small follow-ups on top of 1.0.0: prompt-type CronJobs can now override which model the dispatched subagent uses, and the `reply` tool correctly threads P2P replies onto the latest inbound message even when Claude omits `reply_to`.

### Added
- **Per-job model override** (#47) — `JobMeta` gains an optional `model` field (e.g. `"sonnet"`, `"haiku"`, `"opus"`). `create_job` / `update_job` accept a `model` parameter; `update_job` with an empty string clears the override. When set, the scheduler forwards `model` in the `notifications/claude/channel` meta so the dispatched subagent executes on the specified model. Only applies to `type=prompt` jobs; `type=message` jobs ignore it. `list_jobs` owner view surfaces `Model: <name>` when set.

### Fixed
- **P2P `reply_to` auto-fill** (#48) — the `reply` tool previously only auto-filled `reply_to` from `latestMessageTracker` when `thread_id` was present, which meant private-chat replies without an explicit `reply_to` sent as standalone messages instead of threading onto the latest inbound message. The `thread_id` precondition is dropped; `LatestMessageTracker.getLatest(chat_id, thread_id?)` already handles the undefined case by keying on `chat_id` alone. Group-chat behavior unchanged; explicit `reply_to` from Claude still wins.

## [1.0.0] - 2026-04-21

First stable release. This version marks the project as production-ready: the core feature set (messaging, memory, cronjobs, privacy tiers, cards, reactions, scheduled jobs) is complete, and every env var read by the codebase is now discoverable via `.env.example`, `README.md` / `README_CN.md`, and `/lark:configure` — with no remaining stale references to removed variables.

### Added
- `LARK_BOT_MESSAGE_TRACKER_SIZE` now documented in `README.md` and `README_CN.md` env-var tables (previously only in `CLAUDE.md` and `.env.example`).

### Fixed
- Config documentation drift (#37): `.env.example` and `/lark:configure` skill now document all 16 env vars actually read by the codebase (14 from `src/config.ts` plus `LARK_PRIVACY_RULES_FILE` from `src/privacy-rules.ts` and `LARK_AUDIT_LOG` from `src/audit-log.ts`). Adds Acknowledgement + CronJob sections; `/lark:configure setup` interactive flow now has 5 steps (Credentials / Filtering / CronJob timezone / Advanced tuning / Write config); `clear` command removes all 16 recognized keys (was 9). README setup-flow description also updated to mirror the 5-step flow.

### Removed
- All stale references to `LARK_ENABLED_SKILLS` from `README.md`, `README_CN.md`, `.env.example`, and `/lark:configure`. The variable was formally removed from `scripts/start.sh` in v0.5.2 but lingered in docs for 5 releases. The "Token Optimization" README section (which documented a skill-filtering feature that no longer exists) is also removed.

### Changed
- Version bumped to 1.0.0 to signal stability.

## [0.11.1] - 2026-04-20

Two cleanups landed together:
1. Legacy-profile migration now honors the operator's L2 privacy rules in addition to L1 (#42).
2. Consolidated `JobMeta.send_chat_id` into `target_chat_id` (internal refactor; no behavior change).

### Added
- **`extractL2PrivatePhrases(markdown)`** (`src/privacy-rules.ts`) — parses the `## Always private` section of a markdown L2 rules file and returns the bulleted phrases. Used by legacy-profile migration.
- 6 new assertions in `privacy-rules-smoke.ts` and 1 new integration assertion in `profile-tier-smoke.ts` covering the new migration path.
- 1 new assertion in `job-smoke.ts` covering the v0.9–v0.11.0 `send_chat_id` → `target_chat_id` rollback transition.

### Changed
- **`MemoryStore.migrateIfNeeded` now also consults L2 rules.** An operator who authors `~/.claude/channels/lark/privacy-rules.md` with `## Always private` phrases for their org-specific categories (project codenames, client names, people mentions) will see those phrases applied during legacy-profile migration — lines matching any L2 phrase via case-insensitive substring get routed to `private.md`. L1 still runs first and wins; L2 only applies to lines L1 would have classified as `public` or `gray`.
- **`JobMeta.send_chat_id` removed; `target_chat_id` is the canonical field.** v0.9.0–v0.11.0 kept both fields with identical values (the former as "new" name, the latter for v0.8 backward compat). The consolidation is internal-only: the `create_job` tool parameter remains `target_chat_id`; the scheduler, `list_jobs` visibility filter, and audit paths now read `target_chat_id` directly. Any job file written by v0.9–v0.11.0 with `send_chat_id` is handled by `backfillJob` (resurrects `target_chat_id` from it on first read).

### Non-change (for clarity)
- L3 LLM-based re-classification is still NOT part of migration. That was considered and rejected during Phase 2 brainstorming for latency/failure-mode reasons. If it's ever added, it will be an opt-in terminal command, not part of the automatic first-read trigger.
- Substring matching (not regex, not full NLU) is intentional. L2 rules authored as abstract descriptions ("涉及人际冲突的内容") still apply at L3 distillation time; for migration they'd need to be restated as concrete phrases if the operator wants them to match.

## [0.11.0] - 2026-04-19

Phase 3 of the privacy redesign. Adds user-facing control over what the bot remembers, a self-learning loop that promotes user corrections into persistent rules, and terminal-side safeguards against incidental exposure.

### Added
- **`what_do_you_know` tool** — lists the caller's profile entries with per-line 8-char hashes. Path-B tool (filtered by rendering visibility): in private chat, both public + private tiers are shown; in a group, only the public tier (the reply is visible to the whole group). Each line's hash is the handle that `forget_memory` uses to remove it.
- **`forget_memory` tool** — removes a specific line from the caller's profile by hash. Always caller-scoped; idempotent. Optional `promote_to_rule: true` appends the removed line to `privacy-rules.md` under `## Always private` so future distillations classify similar content as private — this is the **self-learning loop**: user corrections become persistent L2 rules without requiring manual file editing.
- **Append-only audit log** (`src/audit-log.ts`) at `~/.claude/channels/lark/audit.log`. Every sensitive-tool invocation (save_memory / create_job / list_jobs / update_job / delete_job / what_do_you_know / forget_memory) writes a line recording the timestamp, tool name, outcome (ok/denied/error), caller, and a redacted args preview. Long string fields are truncated to 60 chars + length marker. Best-effort — log failures never propagate.
- **`/lark:jobs` terminal skill** (`skills/jobs/SKILL.md`) — reworked to default to a **redacted** output view that hides `prompt`, `content`, and free-form `meta` fields. The user must explicitly ask "verbose" / "show full" / "dump prompt" to see them. Destructive operations (delete / pause / reschedule / prompt-change) prompt for interactive confirmation.
- `LARK_AUDIT_LOG` config key — optional override for the audit log path.
- `MemoryStore.listProfileLines(ownerId, tier)` / `removeProfileLine(ownerId, tier, hash)` — line-level profile helpers that power `what_do_you_know` and `forget_memory`. New exported `ProfileLine` type.
- `scripts/transparency-smoke.ts` — 9 smoke assertions covering list/remove/idempotency, cross-tier isolation, L2 rule-append round-trip, audit log redaction, and audit-log guard against unserializable args (BigInt, circular refs).

### Changed
- **`resolveCaller` now audit-logs denials automatically.** Takes `toolName` and `args` as new parameters; all 7 sensitive tool handlers updated to pass them. Callers only need to emit an `ok` audit on successful completion — denial paths are handled in the helper.
- Sensitive tools emit `void audit(toolName, caller, args, 'ok')` at each success return path, completing the audit coverage.

### Security
- **Users gain inspection + correction rights over their own profile.** Previously, profiles were silently distilled without any user-facing way to review or remove entries. `what_do_you_know` + `forget_memory` close this gap, and the `promote_to_rule` option turns each correction into a durable policy.
- **Terminal-side exposure reduced.** The `/lark:jobs` skill no longer dumps prompt bodies by default — a significant mitigation against screen-share and shoulder-surfing leaks. Destructive operations require confirmation.
- **Retrospective auditability.** The operator can inspect `audit.log` to see exactly which tools were invoked on their machine, when, by whom, and whether the call succeeded or was denied. Useful for post-incident review (borrowed laptop, accidental invocation, etc.).

### Migration
- **No operator action required.** The existing `/lark:jobs` skill continues to work; invocations now return the redacted view by default. The audit log file is created on first use.
- The `buildProfileDistillationPrompt` + `parseTieredProfile` infrastructure added in v0.10.0 is still not triggered by any production code path in this release — explicit distillation loops are left for future work.

## [0.10.0] - 2026-04-19

Phase 2 of the privacy redesign (#35). Closes the profile-memory cross-chat leak — facts distilled from a user's private chat no longer surface when someone else @mentions that user in a group.

### Added
- **Tiered profile storage** (`src/memory/file.ts`) — profiles are split into `profiles/{userId}/public.md` + `private.md`. When a caller is the profile's owner they see both tiers joined; any other caller sees only the public tier. This is the core fix for the leak path still open after v0.9.0.
- **L1 hardcoded privacy rules** (`src/privacy-rules.ts`) — regex + keyword classifier for universal sensitive patterns (phone numbers, ID numbers, credit cards, tokens, monetary amounts, Chinese sensitive keywords like 薪资 / 跳槽 / 焦虑 / 医院) plus a whitelist for safe-for-public attributes (job titles, team names, common tech stack). **Scope note**: email addresses are intentionally NOT in L1. This plugin positions itself for **work-chat use cases** (Feishu is a corporate IM where work emails are routinely shared via signatures and directories); email falls through to L2/L3 classification with a source-based default (group → public, p2p → private). Personal deployments that want stricter handling can add an "Always private" rule for emails in their own `privacy-rules.md`.
- **L2 user rules file** — `~/.claude/channels/lark/privacy-rules.md`. Natural-language markdown the distiller injects into its classification prompt. New `loadL2Rules()` reads it; `addL2Rule(rule, section)` appends a rule under `## Always private` or `## Always public`. Intended for the Phase 3 `forget_memory` self-learning loop — not yet wired to any production caller.
- **L3 LLM classification** — `buildProfileDistillationPrompt({userId, currentProfile, episodeSummaries, chatType, l2Rules})` produces a prompt that instructs Claude to emit a `{ "public": [...], "private": [...] }` JSON object. Source-chat-type is included as a classification hint (group → public default; p2p → private default).
- **`parseTieredProfile(raw)`** (`src/memory/distiller.ts`) — parses the distiller's JSON output, tolerates markdown code fences, falls back conservatively (entire blob → private) on parse failure, and **applies the L1 safety net**: anything the LLM classified as public but matching an L1 regex (phone, credential, token, etc.) is forced back to private.
- **`save_memory`'s new `tier` parameter** — `type="profile"` saves accept an optional `tier` of `"public"` or `"private"`. Defaults to `"private"` when omitted — err on the side of less exposure.
- `scripts/privacy-rules-smoke.ts` — 15 smoke assertions covering L1 classification (10) and L2 file I/O with env override (5).
- `scripts/profile-tier-smoke.ts` — 17 smoke assertions covering tiered read/write, owner vs non-owner visibility (including private-only user never leaking to non-owner), lazy migration, migration idempotency, partial-failure recovery, save-before-read migration safety, and `parseTieredProfile` edge cases (valid JSON, fence stripping, L1 safety net, parse-failure fallback, malformed object, coercion).
- `LARK_PRIVACY_RULES_FILE` config knob — overrides the default path for the L2 rules file.

### Changed
- **`MemoryStore.getProfile(userId)` → `MemoryStore.getProfile(ownerId, caller)`.** Callers now pass both the profile owner and the caller making the read; only when they match does the private tier load. Updated at two call sites in `src/channel.ts` (own profile, mentioned-user profiles).
- **`MemoryStore.saveProfile(userId, content)` → `MemoryStore.saveProfile(userId, content, tier)`.** Required new `tier` parameter (no default at the storage layer; `save_memory` tool defaults at its API layer).
- `profileDistillationPrompt` signature changed from positional args to an options object `{userId, currentProfile, episodeSummaries, chatType, l2Rules}`. The prompt itself emits JSON now; previously emitted free-form markdown.

### Security
- **Profile-memory cross-chat leak closed.** A user's private-chat preferences, ongoing work, and emotional content no longer reach others via `@mention` injection in groups — those facts live in `private.md`, which is never loaded when the caller is someone other than the owner.
- **L1 safety net on LLM output.** Even if the LLM misclassifies an email, credential, or amount as public, `parseTieredProfile` forces it back to private. Defense in depth against classification errors.

### Migration
- **Legacy single-file profiles** (`profiles/{userId}.md` from v0.9.x and earlier) are migrated lazily on first read. The migration runs the L1 classifier line-by-line: blacklist hits (phones, 跳槽, 薪资, ...) move to `private.md`; whitelist hits (工程师, TypeScript, ...) stay in `public.md`; gray content stays in `public.md` (matches pre-upgrade exposure — no regression).
- A console log summarizes each migration: `[migrate] profile ou_xxx: N public, M private`.
- Migration is idempotent: rerunning after a partial failure cleans up stale legacy files. The legacy file is deleted only after both tier files are successfully written.
- **One-way migration.** Downgrading to v0.9.x after upgrading is possible but requires manual reconstruction: `cat profiles/{userId}/public.md profiles/{userId}/private.md > profiles/{userId}.md`. Snapshot `~/.claude/channels/lark/memories/` before upgrade if you need a rollback path.
- **Distillation pipeline is infrastructure-only.** `buildProfileDistillationPrompt` and `parseTieredProfile` are ready to use but not yet triggered from any code path in this release. The loop that turns episode summaries into profile updates is completed in Phase 3 together with the `forget_memory` / `what_do_you_know` tools.

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

[1.0.9]: https://github.com/IS908/claude-lark-plugin/releases/tag/v1.0.9
[1.0.8]: https://github.com/IS908/claude-lark-plugin/releases/tag/v1.0.8
[1.0.7]: https://github.com/IS908/claude-lark-plugin/releases/tag/v1.0.7
[1.0.6]: https://github.com/IS908/claude-lark-plugin/releases/tag/v1.0.6
[1.0.5]: https://github.com/IS908/claude-lark-plugin/releases/tag/v1.0.5
[1.0.4]: https://github.com/IS908/claude-lark-plugin/releases/tag/v1.0.4
[1.0.3]: https://github.com/IS908/claude-lark-plugin/releases/tag/v1.0.3
[1.0.2]: https://github.com/IS908/claude-lark-plugin/releases/tag/v1.0.2
[1.0.1]: https://github.com/IS908/claude-lark-plugin/releases/tag/v1.0.1
[1.0.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v1.0.0
[0.11.1]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.11.1
[0.11.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.11.0
[0.10.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.10.0
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
