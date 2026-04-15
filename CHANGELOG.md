# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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

[0.7.1]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.7.1
[0.7.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.7.0
[0.6.1]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.6.1
[0.6.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.6.0
[0.5.3]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.5.3
[0.5.2]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.5.2
[0.5.1]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.5.1
[0.5.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.5.0
[0.4.0]: https://github.com/IS908/claude-lark-plugin/releases/tag/v0.4.0
