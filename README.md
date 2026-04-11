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

```bash
cd claude-lark-plugin
npm install
```

### 3. Configure Credentials

Create the environment file at `~/.claude/channels/lark/.env`:

```bash
mkdir -p ~/.claude/channels/lark
cat > ~/.claude/channels/lark/.env << 'EOF'
LARK_APP_ID=cli_your_app_id
LARK_APP_SECRET=your_app_secret
EOF
```

### 4. Start

```bash
# Direct start
npm start

# Or use the launcher script (loads skills automatically)
bash scripts/start.sh
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
