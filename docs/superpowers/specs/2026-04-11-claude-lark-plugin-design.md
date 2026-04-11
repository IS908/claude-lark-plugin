# Claude Lark Plugin — Design Spec

**Date:** 2026-04-11  
**Status:** Approved  
**Language:** Node.js 20+ / TypeScript

---

## Context

Build a Claude Code channel plugin that connects Claude Code to Feishu (Lark) via WebSocket, enabling real-time chat with Claude through DMs and @bot group messages. The project extends the reference design (`chenkun.ck/claude-lark`) with a **pluggable memory architecture** — a `MemoryProvider` interface so memory backends (file-based, OpenViking, mem0) can be swapped without changing core logic.

The MVP scope is: core messaging + file-based memory (complete) + `MemoryProvider` interface with OpenViking/mem0 as documented stubs. Works alongside lark-cli's 21 Feishu API skills for full platform coverage.

---

## Architecture

```
Feishu User ──▶ Feishu Open Platform ──WebSocket──▶ claude-lark-plugin (MCP Server) ──▶ Claude Code
                                                          ◀── reply / edit / react ──◀
```

The plugin runs as an MCP server inside Claude Code. It connects to Feishu via WebSocket (no public callback URL needed), receives messages, enriches them with memory context, and forwards them to Claude. Claude responds by calling the 6 built-in MCP tools. lark-cli's skills handle all broader Feishu API operations (calendar, docs, sheets, tasks, contacts, etc.).

---

## Project Structure

```
claude-lark-plugin/
├── package.json              # channel plugin metadata + deps
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts              # Entry point: registers MCP channel, starts WebSocket
│   ├── channel.ts            # WebSocket connection, message routing, auto-flush timers
│   ├── tools.ts              # 6 MCP tool definitions
│   ├── queue.ts              # Per-chat sequential message queue
│   ├── config.ts             # Env config loading + validation
│   └── memory/
│       ├── interface.ts      # MemoryProvider interface + types
│       ├── buffer.ts         # Per-chat conversation buffer (Layer 1)
│       ├── distiller.ts      # Distillation pipeline (Stage 1 flush logic)
│       ├── file.ts           # File-based markdown adapter (complete)
│       ├── openviking.ts     # OpenViking adapter (stub with TODO)
│       └── mem0.ts           # mem0 adapter (stub with TODO)
├── scripts/
│   └── start.sh              # Skill-filtering startup script
└── docs/
    └── superpowers/specs/
        └── 2026-04-11-claude-lark-plugin-design.md
```

**Key dependencies:**
- `@larksuiteoapi/node-sdk` — official Feishu Node SDK (WebSocket + API)
- `@modelcontextprotocol/sdk` — MCP server SDK
- `dotenv` — env config
- `typescript`, `tsx` — build/dev runtime

---

## Core Components

### 1. channel.ts — Message Router

Responsibilities:
- Maintain WebSocket connection to Feishu via `@larksuiteoapi/node-sdk`
- Receive DMs and @bot group messages
- Parse message types: text, rich text, images, files, audio, video, interactive cards (v1 & v2)
- Merge quoted/parent message content into the forwarded context
- Enrich each message with memory context via `MemoryProvider`
- Push enriched messages to the per-chat queue
- Manage auto-flush timers (one `NodeJS.Timeout` per active chatId)
- Single-instance lock: exit if another process is already running the same app

### 2. queue.ts — Per-Chat Message Queue

- `Map<chatId, Promise>` for sequential processing within a chat
- Messages in different chats process in parallel
- If Claude is still processing a previous message in the same chat, new messages wait

### 3. tools.ts — MCP Tool Definitions

| Tool | Signature | Description |
|------|-----------|-------------|
| `reply` | `(chat_id, text, reply_to?, files?)` | Send text reply, optionally with images (≤10 MB) or files (≤30 MB). Auto-chunks long text by paragraphs → newlines → spaces at `LARK_TEXT_CHUNK_LIMIT` chars |
| `edit_message` | `(message_id, text, format?)` | Edit a previously sent bot message (text or card_markdown) |
| `react` | `(message_id, emoji)` | Add emoji reaction to any message |
| `download_attachment` | `(message_id, file_key)` | Download attachment to local inbox dir |
| `save_memory` | `(type, content, reason, chat_id?, thread_id?, open_id?)` | Save user profile, chat episode, or thread episode via MemoryProvider |
| `save_skill` | `(name, description, content, chat_id?)` | Save a reusable procedure as a global skill via MemoryProvider |

### 4. Memory Context Assembly

When a message arrives, before forwarding to Claude:

```
1. profile  = MemoryProvider.getProfile(userId)
2. mentioned = [MemoryProvider.getProfile(id) for @mentioned users]
3. if threadId: thread_eps = MemoryProvider.searchEpisodes(text, {chatId, threadId})
4. chat_eps  = MemoryProvider.searchEpisodes(text, {chatId})
5. skills    = MemoryProvider.searchSkills(text)  [if relevant]

Assembled context injected before message:

[Memory Context]
User Profile:
{profile}

[If @mentions] Mentioned User Profiles:
{mentioned profiles}

Relevant Past Context:
[YYYY-MM-DD] {episode 1}
[YYYY-MM-DD] {episode 2}

[Incoming Message from Feishu]
From: {userId} in {chatId}
{message text + attachments}
```

---

## Memory System

### Three-Layer Memory Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 1: Buffer（短期/工作记忆）                                  │
│  存储: 内存 Map<chatId, Message[]>                                │
│  生命周期: 仅当前 session                                         │
│  作用: 给蒸馏提供原始素材；Claude 直接在处理这些消息                   │
├──────────────────────────────────────────────────────────────────┤
│  Layer 2: Episodic Memory（情景记忆/中期记忆）                      │
│  存储: episodes/<chatId>/<timestamp>.md                           │
│  生命周期: 持久化，随时间衰减（越旧权重越低）                          │
│  注入: 冷注入 — 关键词/语义搜索取 top-N                             │
│  作用: 跨 session 保留对话上下文                                    │
├──────────────────────────────────────────────────────────────────┤
│  Layer 3: Semantic Memory（语义记忆/长期记忆）                      │
│  存储: profiles/<userId>.md, skills/<name>.md                     │
│  生命周期: 永久，会被更新覆盖                                       │
│  注入: 热注入（Profile 始终注入）+ 冷注入（Skills 搜索后注入）         │
│  作用: 跨 session 记住「这个人是谁」和「怎么做某件事」                 │
└──────────────────────────────────────────────────────────────────┘
```

### Isolation Model

| Memory Type | Scope | Who can see it |
|-------------|-------|----------------|
| **User Profile** | Per userId | Only injected when that user sends a message (or is @mentioned) |
| **Thread Episodes** | Per chatId + threadId | Only injected for messages in that thread |
| **Chat Episodes** | Per chatId | Shared by all participants in the chat |
| **Skills** | Global | Searchable and injectable for any user/chat |

### MemoryProvider Interface

```typescript
interface MemoryProvider {
  // Layer 3 — Semantic Memory (user-isolated)
  getProfile(userId: string): Promise<string | null>
  saveProfile(userId: string, content: string): Promise<void>

  // Layer 2 — Episodic Memory (chat-isolated)
  searchEpisodes(
    query: string,
    scope?: { chatId?: string; threadId?: string }
  ): Promise<Episode[]>
  saveEpisode(
    type: 'chat' | 'thread',
    content: string,
    meta: EpisodeMeta
  ): Promise<void>
  listEpisodes(chatId: string): Promise<Episode[]>        // for archival
  deleteEpisodes(chatId: string, ids: string[]): Promise<void>  // for archival

  // Layer 3 — Semantic Memory (global)
  searchSkills(query: string): Promise<Skill[]>
  saveSkill(name: string, description: string, content: string): Promise<void>
}

interface Episode {
  id: string           // filename or record ID
  content: string
  timestamp: string
  chatId?: string
  threadId?: string
}

interface EpisodeMeta {
  chatId: string
  threadId?: string
  userId?: string
}

interface Skill {
  name: string
  description: string
  content: string
}
```

### File-Based Adapter (Complete)

Base path: `~/.claude/channels/lark/memories/`

```
memories/
├── profiles/<userId>.md           ← 一个用户一个文件，更新时覆盖
├── episodes/<chatId>/
│   ├── 2026-04-01T10:00.md        ← 每次蒸馏产出一个 episode 文件
│   ├── 2026-04-08T15:30.md
│   ├── archive-2026-03.md         ← 压缩归档（阶段 3 产出）
│   └── threads/<threadId>/
│       └── 2026-04-11T09:00.md
└── skills/<name>.md               ← 一个技能一个文件
```

File format (all files):
```markdown
# {title or userId or skill name}
{description line — used for keyword search}

{content body}
```

Episode retrieval strategy (no vector search):
1. List all files in `episodes/<chatId>/` sorted by mtime descending
2. Filter by keyword overlap between query terms and filename + first two lines
3. Return top `LARK_MAX_SEARCH_RESULTS` (default: 2)

### OpenViking Adapter (Stub)

```typescript
// TODO: implement using OpenViking REST API at OPENVIKING_URL
// Reference: https://github.com/volcengine/OpenViking
// Auth: OPENVIKING_API_KEY (optional for local dev)
// Advantage: vector-based semantic search for episodes and skills
export class OpenVikingMemoryProvider implements MemoryProvider { ... }
```

### mem0 Adapter (Stub)

```typescript
// TODO: implement using mem0 REST API at MEM0_URL or mem0 cloud (MEM0_API_KEY)
// Reference: https://docs.mem0.ai
// Advantage: built-in memory management, deduplication, and relevance scoring
export class Mem0MemoryProvider implements MemoryProvider { ... }
```

Provider selection: set `MEMORY_PROVIDER=file|openviking|mem0` in `.env` (default: `file`).

---

## Memory Distillation Pipeline

```
Buffer（原始消息）
  │
  │ ── 阶段 1: Buffer → Episode（对话蒸馏）──── MVP ✅
  │    触发: auto-flush（N 小时无活动）或 Claude 主动调 save_memory
  │    过程: Claude 压缩原始对话为 3-5 句摘要
  │    滤噪: 过滤寒暄、失败尝试、重复内容
  │    输出: episodes/<chatId>/<timestamp>.md
  ▼
Episodic Memory（情景记忆）
  │
  │ ── 阶段 2: Episodes → Profile（事实提取）── 后续迭代
  │    触发: 累积 > N 条 episode（如 10 条）或用户显式要求
  │    过程: Claude 回顾近期 episodes，提取/更新/删除事实
  │    输出: 更新 profiles/<userId>.md（覆盖，不追加）
  ▼
Semantic Memory（语义记忆）
  │
  │ ── 阶段 3: Episode 压缩/归档 ──────────── 后续迭代
  │    触发: 某个 chatId 下 episode 文件数 > M（如 20）
  │    过程: 将最旧的 10 条合并为一条历史概要
  │    输出: episodes/<chatId>/archive-<date>.md
  │    清理: 删除已合并的旧文件
  ▼
Archived Episodes（归档记忆）
```

### 阶段 1: Buffer → Episode（对话蒸馏）— MVP

**主动蒸馏（mid-conversation）:**
Claude calls `save_memory` when it identifies signal worth preserving:
- User preferences, communication style, domain expertise
- Key facts: decisions made, ongoing projects, resolved problems
- The tool description explicitly prohibits saving pleasantries, failed attempts, ephemeral details

**被动蒸馏（auto-flush）:**

```
channel.ts 维护:
  buffers: Map<chatId, Message[]>     // 原始消息缓冲
  timers: Map<chatId, NodeJS.Timeout> // 每个 chat 的倒计时

每条消息到达:
  → buffers.get(chatId).push(message)
  → 重置该 chatId 的定时器为 LARK_INACTIVITY_HOURS

定时器到期（N 小时无活动）:
  → 注入系统消息让 Claude 蒸馏:
    "[Auto-memory-flush]
     以下是本次对话的原始消息（N 条）。
     请：
     1. 用 3-5 句话概括（重点：决定/解决/遗留了什么）
     2. 如有新偏好或重要事实，调 save_memory(type=profile) 保存
     3. 调 save_memory(type=chat) 保存对话摘要"
  → 正常 MCP 流转 → Claude 调 save_memory() → 写入 episode 文件
  → 清空 buffer
```

On startup: re-arm flush timers for any chat whose most recent episode is older than `LARK_INACTIVITY_HOURS`.

### 阶段 2: Episodes → Profile（事实提取）— 后续迭代

```
触发条件: 某用户的 episode 数超过阈值（默认 10 条）

过程:
  1. 加载当前 profile + 最近 10 条 episode
  2. 注入系统消息让 Claude 对比:
     "当前用户画像: {profile}
      最近对话摘要: {episodes}
      请更新画像:
      - 新增: 新偏好/事实
      - 修改: 已变化的信息
      - 删除: 已过时的信息
      输出完整更新后画像，调 save_memory(type=profile)"
  3. Profile 文件被覆盖（不追加）
```

### 阶段 3: Episode 压缩（归档）— 后续迭代

```
触发条件: 某 chatId 下 episode 文件数 > 20

过程:
  1. 取最旧的 10 条 episode
  2. Claude 合并为一条 200 字以内的历史概要
  3. 写入 archive-<date>.md
  4. 删除已合并的旧文件
```

### Noise Reduction Summary

| 阶段 | 降噪手段 |
|------|---------|
| **写入时** | Claude 按 tool description 过滤：只保存决定、偏好、事实；过滤寒暄、失败尝试 |
| **检索时** | `LARK_MAX_SEARCH_RESULTS` (默认 2) 限制注入数量 |
| **评分时** | `LARK_MIN_SEARCH_SCORE` (默认 0.3) 过滤低相关度（向量后端） |
| **归档时** | 阶段 3 合并旧 episodes，防止目录膨胀 |
| **文件适配器** | 按时间 + 关键词双重过滤，只返回近期且相关的 episodes |

### MVP vs. 后续迭代 Summary

| 蒸馏阶段 | MVP | 后续 |
|---------|-----|------|
| **阶段 1**: Buffer → Episode | ✅ auto-flush + 手动 save_memory | ✅ |
| **阶段 2**: Episodes → Profile | ❌ 仅靠 Claude 主动调 save_memory(type=profile) | ✅ 自动触发 |
| **阶段 3**: Episode 压缩 | ❌ 靠 MAX_RESULTS cap 控制上下文量 | ✅ 自动归档 |

---

## lark-cli Integration

Our plugin handles: receive messages + memory + direct reply tools.  
lark-cli handles: full Feishu API (calendar, docs, sheets, tasks, contacts, etc.).

`scripts/start.sh` loads both:

```bash
#!/usr/bin/env bash
LARK_ENABLED_SKILLS="${LARK_ENABLED_SKILLS:-lark-im,lark-contact,lark-doc,lark-calendar,lark-task}"
# Filter Claude Code system prompt to only include specified skills
# (saves thousands of tokens by removing unused skills)
exec claude --dangerously-load-development-channels plugin:lark@claude-lark-plugin
```

User configures which of the 21 lark-cli skills to load via `.env`:
```dotenv
LARK_ENABLED_SKILLS=lark-im,lark-contact,lark-doc,lark-calendar,lark-task,lark-wiki
```

---

## Configuration Reference

### Required

| Variable | Description |
|----------|-------------|
| `LARK_APP_ID` | Feishu app ID |
| `LARK_APP_SECRET` | Feishu app secret |

### Optional — Filtering

| Variable | Default | Description |
|----------|---------|-------------|
| `LARK_ALLOWED_USER_IDS` | (empty) | Sender open_id whitelist, comma-separated |
| `LARK_ALLOWED_CHAT_IDS` | (empty) | Chat ID whitelist, comma-separated |
| `LARK_TEXT_CHUNK_LIMIT` | `4000` | Max chars per text chunk |
| `LARK_ENABLED_SKILLS` | (empty) | lark-cli skill whitelist for start.sh |

### Optional — Memory

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_PROVIDER` | `file` | Memory backend: `file`, `openviking`, or `mem0` |
| `LARK_MIN_SEARCH_SCORE` | `0.3` | Minimum relevance score (vector backends only) |
| `LARK_MAX_SEARCH_RESULTS` | `2` | Max episodes per query |
| `LARK_INACTIVITY_HOURS` | `3` | Auto-flush trigger threshold |
| `OPENVIKING_URL` | `http://localhost:1933` | OpenViking service URL |
| `OPENVIKING_API_KEY` | (empty) | OpenViking API key |
| `MEM0_URL` | (empty) | mem0 service URL |
| `MEM0_API_KEY` | (empty) | mem0 API key |

---

## Installation Flow

```bash
# 1. Install lark-cli for full Feishu API access
npm install -g @larksuite/cli
npx skills add larksuite/cli -y -g

# 2. Install this plugin
/plugin marketplace add https://github.com/IS908/claude-lark-plugin.git
/plugin install lark@claude-lark-plugin
/reload-plugins

# 3. Configure credentials
/lark:configure <app_id> <app_secret>

# 4. Start
bash scripts/start.sh
# or: claude --dangerously-load-development-channels plugin:lark@claude-lark-plugin
```

---

## Verification

### End-to-end test checklist

1. **WebSocket connection**: on start, logs `lark channel: connected to Feishu`
2. **DM**: send a direct message to the bot → Claude receives it and replies
3. **Group @mention**: @mention the bot in a group → Claude receives only @bot messages
4. **Quoted reply**: reply to a message → parent content is merged into context
5. **File attachment**: send an image → Claude can download and describe it
6. **Memory - profile**: ask Claude to remember a preference → check `~/.claude/channels/lark/memories/profiles/<userId>.md`
7. **Memory - episode**: trigger auto-flush (set `LARK_INACTIVITY_HOURS=0.001` for test) → check `episodes/<chatId>/` for new file
8. **Memory - injection**: start new session, send message → verify profile appears in Claude's received context
9. **lark-cli integration**: ask Claude to "create a calendar event for tomorrow" → lark-calendar skill responds
10. **MemoryProvider swap**: set `MEMORY_PROVIDER=openviking`, start OpenViking locally → verify connection log on startup
