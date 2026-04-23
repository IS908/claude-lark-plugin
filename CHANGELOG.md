# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
