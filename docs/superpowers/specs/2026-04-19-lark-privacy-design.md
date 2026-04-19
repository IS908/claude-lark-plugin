# Lark Privacy & Security Design

## Context

The plugin currently has three privacy leak paths that allow group members to indirectly extract information about other users:

1. **Profile memory is cross-chat.** A fact distilled from a user's private chat (e.g. "筹备跳槽", "邮箱 kk@..." ) gets loaded into any chat where that user is mentioned. Group members can `@bot 问问 kk 最近在忙什么` and receive distilled private content.
2. **`list_jobs` returns all jobs globally.** Any group member can list cronjobs created by anyone, exposing both the existence and the prompt contents (which may carry private context like "每天读我跟 XX 的邮件").
3. **MCP tools accept Claude-declared identity.** Tools like `save_memory` / `delete_job` are callable with any `user_id` argument. A socially-engineered prompt can direct Claude to act as someone else.

This spec defines:

- A **rendering visibility principle** that distinguishes how data flows out of the bot and picks the appropriate filter.
- A **tiered profile** (public/private) with a three-layer classifier (hard rules, source, LLM).
- A **transparency surface** (`what_do_you_know`, `forget_memory`) with a self-learning rule file.
- A **CronJob visibility model** keyed on `send_chat_id`.
- A server-side **`IdentitySession`** that establishes the true caller for every MCP tool call without trusting Claude's declaration.
- **Terminal safeguards** (default redaction, audit log, confirmation) for `/lark:jobs` and similar skills.

Non-goals:

- Message-content encryption at rest. OS-level file permissions are the trust boundary; adding encryption raises complexity without plugging the realistic threats.
- Defense against a compromised `app_secret`. If the Feishu credentials leak, the bot itself is forged — no in-process logic can recover from that.
- Multi-tenant terminal access. The plugin assumes one operator per Claude Code instance (matching current config model).

## Core Principle — Rendering Visibility

Every piece of sensitive data flows out of the bot through one of two paths. The path determines the filter.

### Path A — Implicit context injection

The data is loaded into Claude's prompt as background for its next turn. Claude decides whether and how to mention it.

Examples: `profile` memory, `episode` memory, loaded skills.

**Filter: by owner.** The owner always sees their own data regardless of channel; others only see the public tier. Claude's own discretion acts as a second layer — even with full context loaded, a well-behaved model won't unprompted-blurt private facts.

### Path B — Explicit output return

The data *is* the response. The tool's contract is "return this information to the caller," and Claude renders it back verbatim (or nearly so) into the current chat.

Examples: `list_jobs`, `what_do_you_know`, `list_memories`, any `get_*` / `list_*`.

**Filter: by current chat's visibility.** Because the reply lands in the current chat and is seen by everyone there, the filter ignores the caller's identity and asks: "is this row appropriate to render to this chat's audience?"

### Why the distinction matters

An owner invoking `list_jobs` in a group is not "me looking at my data" — it is "bot reading my jobs aloud to the group." Path-B filters protect against that re-rendering; path-A filters would incorrectly allow it.

This principle is load-bearing: every new tool must be classified A or B at design time.

## Tiered Profile Memory

### Storage layout

```
memories/
  profiles/
    {userId}/
      public.md     # cross-chat, shared, loaded when anyone references this user
      private.md    # owner-only, loaded only when caller == owner
```

The existing single-file `profiles/{userId}.md` is migrated to `public.md` on first read after upgrade (conservative: everything pre-existing starts in public until the next distillation pass reclassifies).

### Load logic

```ts
async loadProfile(ownerId: string, caller: string): Promise<string> {
  const pub = await read(`profiles/${ownerId}/public.md`)
  if (caller === ownerId) {
    const priv = await read(`profiles/${ownerId}/private.md`)
    return join(pub, priv)
  }
  return pub ?? ''
}
```

This is path-A (implicit injection). The caller check is sufficient because Claude itself is expected to use discretion in phrasing.

### Classification at distillation

The distiller outputs two arrays instead of one blob:

```json
{
  "public":  ["是 TikTok Live 团队的工程师", "熟悉 TypeScript 和 Rust"],
  "private": ["邮件偏好正式语气", "最近在处理会议冲突"]
}
```

Classification runs in three priority layers:

**L1 — Hard rules (code-fixed).** Universal patterns that are always private regardless of source:

- Email addresses (regex)
- Phone numbers (regex)
- ID numbers, bank cards, tokens, passwords
- Specific monetary amounts ("薪资 3w", "奖金 5 万")
- Specific date+time combinations that reveal schedule ("明天 3 点")

Also L1-whitelist (always allowed in public): job titles, team names, public tech stack tags, public handles.

L1 rules are shipped in `src/privacy-rules.ts` as exported constants. Not user-configurable to avoid footguns; universal enough that the correct default is clear.

**L2 — User rules (markdown).** Personal/org-specific sensitivities at `~/.claude/channels/lark/privacy-rules.md`:

```markdown
## Always private
- 公司内部项目代号（例如 Project Phoenix、代号 X-23）
- 客户名：ACME Corp、Globex
- 对同事或上级的评价和吐槽
- 涉及换工作、面试的表述

## Always public
- 公开身份：TikTok Live 团队工程师
- 公开的技术栈标签、GitHub handle
```

Natural language examples, not regex. The distiller reads this file and injects it into its classification prompt as context. Append-only; users add entries as they notice misclassifications.

**L3 — LLM fallback.** Gray-area items classified by the distiller itself. The prompt's default rule is: **"If uncertain, classify as private."** Conservative default keeps errors biased toward overprotection.

### Blacklist priority

L1 blacklist overrides everything, including source and explicit user override. Even if a user writes their email in a public group chat, the bot will not store it in `public.md`. Rationale: the danger of blacklist items is bot-initiated re-broadcast, not the one-time disclosure.

### Source as signal

When L1 does not decide:

- Facts distilled from **group messages** default to `public` (already spoken in front of the group).
- Facts distilled from **private chat** default to `private` (not yet voluntarily shared).
- An explicit `save_memory --scope=public` call overrides the default.

## Memory Transparency & Self-Learning

Silent distillation stays (no per-flush notification), but the user gains two path-B tools:

### `what_do_you_know`

Returns the caller's profile entries. Path-B, so filtered by current chat:

- **In private chat**: returns `public.md` + `private.md`, both rendered.
- **In a group**: returns only `public.md` (rendering private in group would defeat the whole point).
- **In terminal**: returns both, in redacted summary form (see Terminal Safeguards).

### `forget_memory`

Removes a specific line from the caller's profile. Args: `id` or `line_hash`. Always caller-only (you can only forget things about yourself).

### Self-learning rule loop

When `forget_memory` removes a line, the bot asks:

> "要不要加条规则，以后自动把这类归为 private？
> 建议 rule：『涉及人际冲突、情绪表达的内容』。
> [是，加入] [否，只本次]"

On confirmation, the rule is appended to `~/.claude/channels/lark/privacy-rules.md` (L2). Future distillations read the updated file and avoid the same misclassification.

Over time the rule file grows from empty to a personal privacy profile. If it exceeds ~100 entries, that signals L3 prompt needs improvement — the rule file is a patch layer, not a substitute.

## CronJob Visibility

### Fields

Every job stores three identity-related fields:

| Field | Meaning |
|---|---|
| `created_by` | open_id of the human who created the job |
| `origin_chat_id` | chat where the creation conversation happened (debug/audit only) |
| `send_chat_id` | chat where the job's output is delivered |

### `list_jobs` filter

Path-B tool. Filter by **current chat's visibility**:

```
return jobs where:
  (current chat is private  AND  job.created_by == caller)          -- owner sees all their jobs in private
  OR
  (current chat is group G  AND  job.send_chat_id == G)             -- group sees all jobs posting here
```

Consequences:

- Private-chat creation, private-chat list → visible.
- Private-chat creation that sends to group G, listed in G → visible in G (audit right).
- Private-chat creation that sends to private, listed in group → **not visible** (no reason to broadcast).
- Group creation, listed in a different group → not visible.

### Redaction in group view

Even when a job is visible in a group, fields are redacted:

| Field | Private (owner) view | Group audit view |
|---|---|---|
| `id` / `name` | ✅ | ✅ |
| `schedule` | ✅ | ✅ |
| `send_chat_id` | ✅ | ✅ (is current chat anyway) |
| `created_by` | ✅ | ✅ (accountability) |
| `next_run_at` | ✅ | ✅ |
| `prompt` / `message` body | ✅ | ❌ (may contain private context) |
| `meta` | ✅ | ❌ |

The group view deliberately keeps `created_by` so group members have an accountable handle to contact if they find the job inappropriate.

### Mutation

`delete_job` / `update_job` remain **owner-only** regardless of visibility. Audit rights ≠ mutation rights.

## IdentitySession — MCP Tool Authentication

### Principle

MCP server maintains `(chat_id, thread_id?) → open_id` mappings populated from Feishu events. Sensitive tools read the mapping server-side; they never trust Claude-declared identity parameters.

The trust anchor is the Feishu webhook itself (authenticated by `app_secret`). The mapping transmits that anchor to the MCP layer.

### API

`src/identity-session.ts`:

```ts
interface SessionEntry { userId: string; updatedAt: number }

class IdentitySession {
  setCaller(chatId: string, threadId: string | undefined, userId: string): void
  getCaller(chatId: string, threadId?: string): string | null    // thread-specific, falls back to chat
  cleanup(maxAgeMs?: number): void                                // drop stale entries
}
```

In-memory only. Not persisted across restarts — each incoming message or cronjob tick will re-populate the relevant entry.

### Integration points

1. **`channel.ts`** — inside `handleMessageEvent`, before enqueue:
   ```ts
   identitySession.setCaller(chatId, threadId, senderId)
   ```

2. **`scheduler.ts`** — when triggering a `prompt`-type job:
   ```ts
   identitySession.setCaller(job.send_chat_id, jobThreadId, job.created_by)
   ```
   `jobThreadId` is a newly-generated id scoped to this execution; it is included in the `notifications/claude/channel` metadata so Claude's subsequent tool calls arrive carrying `thread_id` matching the session entry.

3. **`tools.ts`** — sensitive tools consult the session:
   ```ts
   const caller = identitySession.getCaller(chat_id, thread_id)
   if (!caller) return { isError: true, content: "no active session" }
   // proceed using `caller` as authoritative identity
   ```

Sensitive tool list (initial): `list_jobs`, `delete_job`, `update_job`, `save_memory`, `forget_memory`, `what_do_you_know`.

Non-sensitive tools (`reply`, `react`, `edit_message`, `download_attachment`) do not need session checks.

### Handling implementation edge cases

**CronJob concurrency.** If a cronjob and a human message arrive to the same chat in close succession, a single `(chat_id, null)` entry would clobber. Solution: cronjob executions always run under a dedicated `jobThreadId`, so they occupy a different session key than human messages (which use `thread_id` from the event, or null).

**Missing `chat_id` in tool args.** Every sensitive tool's schema must require `chat_id` (and optionally `thread_id`). If a tool's semantics don't naturally need chat_id, it probably shouldn't be sensitive.

**Restart resilience.** The session table is ephemeral. Next Feishu event or cronjob tick repopulates. No persistence needed.

**Observability.** Every `setCaller` and every denied tool call logs to `debug.log`:
```
[identity] setCaller chat=oc_xxx thread=t1 user=ou_yyy
[identity] list_jobs denied: no session for chat=oc_xxx thread=t1
```

## Terminal Safeguards

Threat model on the terminal differs fundamentally: the operator is superuser, so technical controls are futile. Real threats are shoulder-surfing, screen sharing, and accidental exposure by a borrowed laptop.

### Default redaction, `--verbose` opt-in

`/lark:jobs` default output:

```
[1] morning-brief   · daily 09:00   · → group "Team Sync"
[2] mail-digest     · daily 22:00   · → private
3 jobs. Use --verbose to show prompts.
```

Prompt body, meta, and other free-form content are hidden unless `--verbose` is passed. Same pattern applies to `/lark:memory show`, etc.

### Audit log

Every skill invocation appends to `~/.claude/channels/lark/audit.log`:

```
2026-04-19T14:32:01Z  list_jobs            verbose=false  count=3
2026-04-19T14:33:15Z  delete_job           id=morning-brief
2026-04-19T14:35:02Z  list_jobs            verbose=true   count=3   ⚠ exposed prompts
```

Append-only, not user-rotated. Its purpose is retrospective self-audit by the operator ("did anyone use my laptop while I was away?").

### Destructive confirmation

`delete_job`, `forget_memory`, and similar prompt for confirmation in terminal:

```
/lark:jobs delete morning-brief
→ Delete job "morning-brief" (daily 09:00, → group "Team Sync")? [y/N]
```

Foot-gun prevention, not security.

### Identity fallback

Terminal skill invocations reach MCP tools with no Feishu event to seed the session. Resolution:

- Terminal skills pass a reserved sentinel `chat_id = "__terminal__"`.
- `IdentitySession.getCaller` recognizes the sentinel and returns `process.env.LARK_OWNER_OPEN_ID` (new config key).
- `LARK_OWNER_OPEN_ID` is set at `/lark:configure` time (auto-detected from the first real human message received, confirmed with the operator, then written to `.env`).

With this fallback, terminal invocations take the "owner in private chat" code path automatically — no separate permission branches needed.

## Configuration additions

New keys in `~/.claude/channels/lark/.env`:

| Key | Purpose |
|---|---|
| `LARK_OWNER_OPEN_ID` | Fallback identity for terminal invocations |
| `LARK_PRIVACY_RULES_FILE` | Optional override for L2 rules path (default: `privacy-rules.md` in channel dir) |
| `LARK_IDENTITY_SESSION_TTL_MS` | Optional override for session stale cleanup (default: 1 hour) |

## File-system changes

```
~/.claude/channels/lark/
  .env                       # + LARK_OWNER_OPEN_ID
  privacy-rules.md           # NEW — L2 user rules, append-only
  audit.log                  # NEW — terminal invocation audit
  memories/
    profiles/
      {userId}/
        public.md            # NEW split (replaces {userId}.md)
        private.md           # NEW
      {userId}.md            # DEPRECATED — migrated on first read
```

## Migration

1. First time the plugin boots with the new code:
   - Any `profiles/{userId}.md` is moved to `profiles/{userId}/public.md`.
   - A stub `profiles/{userId}/private.md` is created empty.
2. On next distillation for that user, the three-layer classifier runs against the existing `public.md` contents and reclassifies lines that hit L1-blacklist or L2 rules into `private.md`. This happens lazily, not as a batch rewrite.
3. `LARK_OWNER_OPEN_ID` is auto-populated at next `/lark:configure` run, or on the next human message in P2P with the bot (confirmed to the operator via terminal prompt before writing).

Existing cronjobs gain `send_chat_id = target_chat_id` (rename) and `origin_chat_id` defaulted from existing metadata where available, else empty string (not null).

## Test plan

1. **Rendering visibility unit tests** — matrix of (tool kind, caller, chat type, data ownership) → expected filter result.
2. **Profile tier classification** — table of sample utterances and expected public/private assignment under L1/L2/L3 rules.
3. **`list_jobs` visibility** — 12-case matrix covering the four cells of (origin, send) × (list location).
4. **IdentitySession concurrency** — simulate cronjob trigger overlapping with human message in the same chat, verify thread_id isolation prevents clobber.
5. **Terminal safeguards** — `/lark:jobs` default vs `--verbose`; audit.log append; confirmation prompt.
6. **Migration smoke** — start with legacy `profiles/{userId}.md`, boot, verify lazy migration on first load.
7. **L2 self-learning** — call `forget_memory` on a misclassified line, accept rule suggestion, verify rule appended and subsequent distillation respects it.

## Open questions

1. **Group-visible job content search.** Should a group admin be able to query "show all jobs posting here in the last 30 days" for audit purposes? Deferred — out of v1 scope, add if operators ask.
2. **Rule-file rotation.** If L2 grows past ~100 entries, UX degrades. No compaction mechanism in v1; revisit if it becomes a real issue.
3. **Per-group L2 override.** Could users want different privacy posture per group (e.g., stricter in a cross-company group)? Deferred — single global L2 for v1 is simpler and matches current one-operator assumption.
