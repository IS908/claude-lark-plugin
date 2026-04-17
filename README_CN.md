# Claude Lark Plugin

[![docs](https://img.shields.io/badge/docs-English-blue)](README.md)
[![node](https://img.shields.io/badge/node-%3E%3D20.0.0-339933?logo=node.js&logoColor=white)](package.json)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

通过飞书（Lark）与 Claude Code 实时聊天。支持可插拔记忆系统，内置文件存储和 OpenViking 后端。

---

## 工作原理

```
飞书用户 ──> 飞书开放平台 ──WebSocket──> claude-lark-plugin (MCP Server) ──> Claude Code
                                                  <── 回复 / 编辑 / 表情 ──<
```

本插件以 MCP Server 形式运行在 Claude Code 内部。通过 WebSocket 连接飞书开放平台（无需公网回调地址），接收消息后注入记忆上下文，转发给 Claude 处理。Claude 通过内置的 6 个 MCP 工具进行回复。lark-cli 的各项技能负责处理更广泛的飞书 API 操作（日历、文档、表格、任务、通讯录等）。

---

## 功能特性

### 消息接收

- 私聊消息和群聊 @机器人 消息
- 富文本、图片、文件、音视频等多种消息类型
- 引用回复自动合并上下文
- 附件下载到本地收件箱

### 消息回复

- 文字、图片（不超过 10 MB）、文件（不超过 30 MB）
- **卡片渲染**：长文本或富 markdown 内容（标题、代码块、表格、列表、粗体，或超过 500 字符）自动渲染为飞书卡片。可通过 `format='card'` 强制卡片，`format='text'` 强制纯文本，可选 `footer` 底部小字脚注
- 编辑已发送的消息
- 表情回复
- 长文本自动按段落、换行、空格分段发送

### 记忆系统

- 三层架构：Buffer（短期）/ 情景记忆（中期）/ 语义记忆（长期）
- 自动蒸馏：对话静默超时后自动触发摘要
- 可插拔后端：文件存储（内置）、OpenViking（向量搜索）、mem0（计划中）

### 定时任务（CronJob）

- **两种任务类型**：`message`（发送固定内容，确定性）和 `prompt`（Claude 执行后回复，尽力而为）
- 标准 cron 表达式 + 简化别名（`every 30m`、`daily at 09:00`、`weekdays at 17:00`）
- 通过飞书聊天或 `/lark:jobs` skill 创建和管理任务
- 崩溃恢复：重启后自动补执行错过的任务
- 任务以 JSON 文件存储在 `~/.claude/channels/lark/jobs/`

### 可靠性

- 每个会话独立消息队列，同一会话按序处理
- 单实例锁，防止重复启动
- 发送者/群聊白名单过滤（两个列表同时配置时为 OR 关系）
- 优雅降级处理

---

## 快速开始

### 第 1 步：创建飞书机器人

1. 前往[飞书开放平台](https://open.feishu.cn/)创建自建应用
2. 启用「机器人」能力
3. 添加以下权限：`im:message`、`im:message:send_as_bot`、`im:resource`
4. 获取 App ID 和 App Secret

### 第 2 步：安装插件

**通过插件市场安装（推荐）：**

在 Claude Code 中执行以下命令：

```text
/plugin marketplace add https://github.com/IS908/claude-lark-plugin.git
/plugin install lark@claude-lark-plugin
/reload-plugins
```

**从源码安装（开发用）：**

```bash
git clone https://github.com/IS908/claude-lark-plugin.git
cd claude-lark-plugin
npm install
```

然后启动 Claude Code 时手动加载插件：

```bash
claude --dangerously-load-development-channels plugin:lark@claude-lark-plugin
```

可选：安装 [lark-cli](https://github.com/larksuite/cli) 以获取完整飞书 API 能力（日历、文档、表格、任务、通讯录等）：

```bash
npm install -g @larksuite/cli
npx skills add larksuite/cli -y -g
```

### 第 3 步：配置凭据

**交互式配置（推荐）：**

```text
/lark:configure setup
```

引导式完成所有配置 -- 凭据、记忆后端、访问过滤、参数调优。

**快速配置：**

```text
/lark:configure <app_id> <app_secret>
```

**手动配置：**

```bash
mkdir -p ~/.claude/channels/lark
cat > ~/.claude/channels/lark/.env << 'EOF'
LARK_APP_ID=cli_your_app_id
LARK_APP_SECRET=your_app_secret
EOF
```

### 第 4 步：启动

```bash
# 通过插件市场安装的，使用启动脚本：
bash scripts/start.sh

# 从源码安装的：
claude --dangerously-load-development-channels plugin:lark@claude-lark-plugin
```

### 更新插件

**插件市场：**

```text
/plugin update lark@claude-lark-plugin
/reload-plugins
```

**从源码：**

```bash
cd claude-lark-plugin
git pull
npm install
```

`~/.claude/channels/lark/.env` 中的配置不受更新影响。更新后需重启 session 或 reload 插件生效。

查看当前版本：

```bash
node -e "console.log(require('./package.json').version)"
```

---

## 记忆系统

### 三层架构

| 层级 | 名称 | 作用域 | 注入方式 | 存储位置 |
|------|------|--------|----------|----------|
| Layer 1 | Buffer（短期/工作记忆） | 当前 session，按 chatId 隔离 | 直接处理（Claude 直接读取这些消息） | 内存 `Map<chatId, Message[]>` |
| Layer 2 | 情景记忆（中期记忆） | 持久化，按 chatId / threadId 隔离 | 冷注入 -- 关键词/语义搜索取 top-N | `episodes/<chatId>/<timestamp>.md` |
| Layer 3 | 语义记忆（长期记忆） | Profile 按 userId 隔离；Skill 全局共享 | 热注入（Profile 始终注入）+ 冷注入（Skill 搜索后注入） | `profiles/<userId>.md`、`skills/<name>.md` |

### 隔离模型

| 记忆类型 | 作用域 | 可见范围 |
|----------|--------|----------|
| 用户画像 (Profile) | 按 userId | 仅在该用户发送消息或被 @提及 时注入 |
| 话题情景 (Thread Episode) | 按 chatId + threadId | 仅在该话题内的消息中注入 |
| 会话情景 (Chat Episode) | 按 chatId | 该会话内所有参与者共享 |
| 技能 (Skill) | 全局 | 可被任意用户/会话搜索和注入 |

### 蒸馏管道

| 阶段 | 描述 | 状态 |
|------|------|------|
| 阶段 1：Buffer -> Episode（对话蒸馏） | 静默超时或 Claude 主动调用 `save_memory` 时触发。Claude 将原始对话压缩为 3-5 句摘要，过滤寒暄和无效信息 | MVP 已实现 |
| 阶段 2：Episodes -> Profile（事实提取） | 情景记忆累积超过阈值后，Claude 回顾近期内容，提取/更新/删除用户画像中的事实 | 后续迭代 |
| 阶段 3：Episode 压缩/归档 | 某会话下情景文件过多时，将最旧的合并为历史概要，删除已合并文件 | 后续迭代 |

---

## 配置参考

### 必填

| 变量 | 说明 |
|------|------|
| `LARK_APP_ID` | 飞书应用 App ID |
| `LARK_APP_SECRET` | 飞书应用 App Secret |

### 可选 -- 过滤

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LARK_ALLOWED_USER_IDS` | （空） | 发送者 open_id 白名单，逗号分隔 |
| `LARK_ALLOWED_CHAT_IDS` | （空） | 群聊 ID 白名单，逗号分隔 |

> **白名单语义**：两个列表都设置时，发送者在 `LARK_ALLOWED_USER_IDS` 里**或**聊天在 `LARK_ALLOWED_CHAT_IDS` 里即允许（OR 关系）。只设置一个列表时，只用那个列表过滤。
| `LARK_TEXT_CHUNK_LIMIT` | `4000` | 单条消息最大字符数 |
| `LARK_CRON_SCAN_INTERVAL` | `60` | 定时任务扫描间隔（秒） |
| `LARK_CRON_TIMEZONE` | 系统时区 | IANA 时区名（如 `Asia/Shanghai`、`UTC`），影响 cron 表达式中小时字段的墙钟映射 |
| `LARK_ENABLED_SKILLS` | （空） | lark-cli 技能白名单，用于 start.sh |

### 可选 -- 记忆

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMORY_PROVIDER` | `file` | 记忆后端：`file`、`openviking` 或 `mem0`（计划中） |
| `LARK_MIN_SEARCH_SCORE` | `0.3` | 最低相关度分数（仅向量后端生效） |
| `LARK_MAX_SEARCH_RESULTS` | `2` | 每次查询返回的最大情景数 |
| `LARK_INACTIVITY_HOURS` | `3` | 自动蒸馏触发的静默时长（小时） |
| `OPENVIKING_URL` | `http://localhost:1933` | OpenViking 服务地址 |
| `OPENVIKING_API_KEY` | （空） | OpenViking API 密钥 |
| `MEM0_URL` | （空） | mem0 服务地址（计划中） |
| `MEM0_API_KEY` | （空） | mem0 API 密钥（计划中） |

---

## 交互式配置

插件内置交互式配置命令，可在 Claude Code 中直接使用：

| 命令 | 说明 |
|------|------|
| `/lark:configure` | 查看当前配置状态（敏感信息脱敏显示） |
| `/lark:configure <app_id> <app_secret>` | 快速配置凭据 |
| `/lark:configure setup` | 完整交互式引导配置 |
| `/lark:configure clear` | 清除所有配置 |

### `/lark:configure setup` 流程

交互式引导分 5 步，每步可选择跳过或使用默认值：

```
第 1 步：凭据
  -> LARK_APP_ID 和 LARK_APP_SECRET（已有配置时显示脱敏值，可选保留/更新）

第 2 步：记忆后端
  -> file（默认，零依赖）/ openviking（向量语义搜索）/ mem0（计划中）

第 3 步：后端配置（按选择分支）
  -> openviking: OPENVIKING_URL、OPENVIKING_API_KEY
  -> mem0（计划中）: MEM0_URL、MEM0_API_KEY
  -> file: 跳过

第 4 步：访问过滤（可选）
  -> LARK_ALLOWED_USER_IDS、LARK_ALLOWED_CHAT_IDS

第 5 步：记忆参数调优（可选）
  -> LARK_INACTIVITY_HOURS、LARK_MAX_SEARCH_RESULTS、LARK_MIN_SEARCH_SCORE、LARK_TEXT_CHUNK_LIMIT
```

所有配置写入 `~/.claude/channels/lark/.env`。修改后需重启 session 或 reload 插件生效。

---

## lark-cli 集成

本插件负责：消息接收 + 记忆管理 + 直接回复工具。

lark-cli 负责：完整的飞书 API（日历、文档、表格、任务、通讯录等 21 项技能）。

`scripts/start.sh` 同时加载两者。用户通过 `.env` 中的 `LARK_ENABLED_SKILLS` 配置加载哪些 lark-cli 技能：

```dotenv
LARK_ENABLED_SKILLS=lark-im,lark-contact,lark-doc,lark-calendar,lark-task,lark-wiki
```

---

## Token 优化

`scripts/start.sh` 通过 `LARK_ENABLED_SKILLS` 过滤 Claude Code 系统提示词中的技能列表，仅加载指定技能，节省数千个 token。

```bash
# 默认加载的技能
LARK_ENABLED_SKILLS="${LARK_ENABLED_SKILLS:-lark-im,lark-contact,lark-doc,lark-calendar,lark-task}"

# 启动插件
exec claude --dangerously-load-development-channels plugin:lark@claude-lark-plugin
```

如需增减技能，在 `.env` 文件中修改 `LARK_ENABLED_SKILLS` 即可。

---

## 后台守护进程

使用 tmux 在后台持续运行插件：

```bash
# 创建后台会话
tmux new-session -d -s lark 'bash scripts/start.sh'

# 查看日志
tmux attach -t lark

# 分离会话（插件继续运行）
# 按 Ctrl+B 然后按 D

# 停止
tmux kill-session -t lark
```

---

## 可用工具

| 工具 | 签名 | 说明 |
|------|------|------|
| `reply` | `(chat_id, text, reply_to?, files?)` | 发送文字回复，可附带图片或文件。长文本自动按段落/换行/空格分段 |
| `edit_message` | `(message_id, text, format?)` | 编辑已发送的机器人消息（支持 text 和 card_markdown 格式） |
| `react` | `(message_id, emoji)` | 对消息添加表情回复 |
| `download_attachment` | `(message_id, file_key)` | 下载消息中的附件到本地收件箱 |
| `save_memory` | `(type, content, reason, chat_id?, thread_id?, open_id?)` | 保存用户画像、会话情景或话题情景 |
| `save_skill` | `(name, description, content, chat_id?)` | 保存可复用的操作流程为全局技能 |

---

## 环境要求

- Node.js >= 20.0.0
- Claude Code（已安装并可运行）
- 飞书自建应用（已启用机器人能力并配置权限）

---

## 开源协议

[Apache License 2.0](LICENSE)
