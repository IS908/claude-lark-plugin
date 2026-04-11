# Claude Lark Plugin

![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)

Chat with Claude Code in real time through Feishu (Lark). Pluggable memory with file-based, OpenViking, and mem0 backends.

[Chinese version (README_CN.md)](README_CN.md)

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
- Quoted reply support with automatic parent message fetching
- Attachment extraction (image, file, audio, video)

### Responding

- Text replies with automatic chunking for long messages (configurable limit)
- Image and file uploads (images up to 10 MB, files up to 30 MB)
- Message editing (plain text and card markdown)
- Emoji reactions on any message
- Auto-chunking splits at paragraph, line, or word boundaries

### Memory

- Three-layer architecture: Buffer, Episodic, and Semantic memory
- Auto-flush distillation from conversation buffer to episodic memory
- Pluggable backends: file-based (default), OpenViking (vector search), mem0
- User profiles, chat episodes, thread episodes, and global skills
- Memory-enriched context injection on every incoming message

### Reliability

- Per-chat message queue for sequential processing within each conversation
- Single-instance lock to prevent duplicate event handling
- User and chat ID whitelisting for access control
- Graceful degradation when memory providers are unavailable

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

Enable the WebSocket mode under **Event Subscriptions** and subscribe to the `im.message.receive_v1` event.

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

This walks you through all configuration options step by step -- credentials, memory provider, filtering, and tuning.

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
| 2 | Episodic | Per-chat / per-thread | Cold (search-based) | File / OpenViking / mem0 |
| 3 | Semantic | Per-user (profile) or global (skills) | Hot (always loaded) | File / OpenViking / mem0 |

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
| `LARK_TEXT_CHUNK_LIMIT` | `4000` | Maximum characters per message chunk |
| `LARK_ENABLED_SKILLS` | `lark-im,lark-contact,lark-doc,lark-calendar,lark-task` | Comma-separated skills to load alongside the plugin |

### Optional -- Memory

| Variable | Default | Description |
|---|---|---|
| `MEMORY_PROVIDER` | `file` | Memory backend: `file`, `openviking`, or `mem0` |
| `LARK_MIN_SEARCH_SCORE` | `0.3` | Minimum similarity score for memory search results |
| `LARK_MAX_SEARCH_RESULTS` | `2` | Maximum number of memory search results to inject |
| `LARK_INACTIVITY_HOURS` | `3` | Hours of inactivity before buffer flush to episodic memory |
| `OPENVIKING_URL` | `http://localhost:1933` | OpenViking server URL |
| `OPENVIKING_API_KEY` | (empty) | OpenViking API key |
| `MEM0_URL` | (empty) | mem0 server URL |
| `MEM0_API_KEY` | (empty) | mem0 API key |

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

Step 2: Memory Provider
  -> file (default, zero deps) / openviking (vector search) / mem0 (managed memory)

Step 3: Backend Config (conditional)
  -> If openviking: OPENVIKING_URL, OPENVIKING_API_KEY
  -> If mem0: MEM0_URL, MEM0_API_KEY
  -> If file: skipped

Step 4: Filtering (optional)
  -> LARK_ALLOWED_USER_IDS, LARK_ALLOWED_CHAT_IDS

Step 5: Memory Tuning (optional)
  -> LARK_INACTIVITY_HOURS, LARK_MAX_SEARCH_RESULTS, LARK_MIN_SEARCH_SCORE, LARK_TEXT_CHUNK_LIMIT
```

All values are written to `~/.claude/channels/lark/.env`. Changes require a session restart or plugin reload to take effect.

---

## lark-cli Integration

Install [lark-cli](https://github.com/nicepkg/lark-cli) for full Feishu API access beyond messaging -- calendar, docs, sheets, tasks, contacts, and more. The `scripts/start.sh` launcher loads a configurable set of lark-cli skills alongside the plugin.

```bash
# Default skills loaded by start.sh:
# lark-im, lark-contact, lark-doc, lark-calendar, lark-task
```

Override with the `LARK_ENABLED_SKILLS` environment variable to add or remove skills.

---

## Token Optimization

Use `scripts/start.sh` with `LARK_ENABLED_SKILLS` to control which skills are loaded. Loading fewer skills reduces the system prompt size and token consumption per request.

```bash
# Minimal setup -- messaging only
LARK_ENABLED_SKILLS=lark-im bash scripts/start.sh

# Full setup
LARK_ENABLED_SKILLS=lark-im,lark-contact,lark-doc,lark-calendar,lark-task,lark-sheets bash scripts/start.sh
```

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
| `save_memory` | Save a memory entry (profile, chat episode, or thread episode) for cross-session recall. |
| `save_skill` | Save a reusable procedure as a globally searchable skill. |

---

## Requirements

- **Node.js** 20+ and npm
- **Feishu/Lark** custom app with WebSocket mode enabled
- **OpenViking** (optional) -- for vector-based memory search
- **lark-cli** (optional) -- for extended Feishu API access (calendar, docs, sheets, tasks, contacts)

---

## License

[Apache 2.0](LICENSE)
