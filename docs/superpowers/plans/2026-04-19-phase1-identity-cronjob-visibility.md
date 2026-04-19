# Phase 1 — IdentitySession + CronJob Visibility

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the two highest-severity leaks — (a) MCP tools trusting Claude-declared identity and (b) `list_jobs` exposing other users' jobs in groups — by introducing a server-side `IdentitySession` and filtering `list_jobs` by `send_chat_id`.

**Architecture:** Add in-memory `(chat_id, thread_id?) → open_id` mapping populated from Feishu events. Extend job schema with `send_chat_id`/`origin_chat_id`. Sensitive tools require `chat_id` in args and read caller from the session. Scheduler sets session on cronjob trigger under a unique `thread_id` to avoid clobbering inbound human messages. Terminal skills pass a reserved `__terminal__` chat id that falls back to `LARK_OWNER_OPEN_ID`.

**Tech Stack:** TypeScript (ESM), MCP TypeScript SDK, tsx smoke tests, zod schemas.

**Spec:** `docs/superpowers/specs/2026-04-19-lark-privacy-design.md` (sections: "IdentitySession", "CronJob Visibility", "Rendering Visibility")

**Issue:** #35 (phase 1 of 3)

---

## File Structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `src/identity-session.ts` | In-memory caller mapping, cleanup, terminal fallback | Create |
| `scripts/identity-smoke.ts` | Unit coverage for session behavior | Create |
| `src/job-store.ts` | Extend `JobMeta` with `send_chat_id`, `origin_chat_id` | Modify |
| `src/channel.ts` | Call `setCaller` on inbound messages | Modify |
| `src/scheduler.ts` | Call `setCaller` on cronjob trigger with generated thread_id | Modify |
| `src/tools.ts` | Require `chat_id` on sensitive tools; filter by session + visibility | Modify |
| `src/index.ts` | Instantiate and wire IdentitySession | Modify |
| `scripts/test.sh` | Add identity smoke to test runner | Modify |
| `CHANGELOG.md` | Document v0.9.0 | Modify |
| `.claude-plugin/plugin.json`, `package.json` | Bump to v0.9.0 | Modify |

---

## Task 1: IdentitySession module

**Files:**
- Create: `src/identity-session.ts`

- [ ] **Step 1.1: Write the module**

```typescript
// src/identity-session.ts
/**
 * In-memory mapping from (chat_id, thread_id?) to the Feishu open_id of the
 * current caller. Populated by channel.ts on inbound messages and by
 * scheduler.ts when a cronjob fires. Consumed by sensitive MCP tools so they
 * never need to trust Claude-declared identity arguments.
 *
 * Intentionally not persisted — the next inbound message or cronjob tick will
 * re-populate relevant entries, so crash/restart is safe.
 */

const TERMINAL_CHAT_ID = '__terminal__';

interface SessionEntry {
  userId: string;
  updatedAt: number;
}

export class IdentitySession {
  private map = new Map<string, SessionEntry>();

  constructor(
    private readonly ownerFallback: () => string | null,
    private readonly maxAgeMs = 3600_000,
  ) {}

  private key(chatId: string, threadId?: string): string {
    return threadId ? `${chatId}#${threadId}` : chatId;
  }

  setCaller(chatId: string, threadId: string | undefined, userId: string): void {
    this.map.set(this.key(chatId, threadId), { userId, updatedAt: Date.now() });
  }

  /**
   * Returns the current caller for the given chat/thread, or null if none.
   * Prefers the thread-specific entry; falls back to chat-level.
   * Special-cases the terminal sentinel to the owner fallback.
   */
  getCaller(chatId: string, threadId?: string): string | null {
    if (chatId === TERMINAL_CHAT_ID) {
      return this.ownerFallback();
    }
    if (threadId) {
      const entry = this.map.get(this.key(chatId, threadId));
      if (entry && !this.isStale(entry)) return entry.userId;
    }
    const chatEntry = this.map.get(this.key(chatId));
    if (chatEntry && !this.isStale(chatEntry)) return chatEntry.userId;
    return null;
  }

  cleanup(): void {
    for (const [k, v] of this.map.entries()) {
      if (this.isStale(v)) this.map.delete(k);
    }
  }

  private isStale(entry: SessionEntry): boolean {
    return Date.now() - entry.updatedAt > this.maxAgeMs;
  }

  /** Test-only helper. */
  _size(): number {
    return this.map.size;
  }
}

export { TERMINAL_CHAT_ID };
```

- [ ] **Step 1.2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 1.3: Commit**

```bash
git add src/identity-session.ts
git commit -m "feat(identity): add IdentitySession module"
```

---

## Task 2: Smoke tests for IdentitySession

**Files:**
- Create: `scripts/identity-smoke.ts`

- [ ] **Step 2.1: Write smoke test**

```typescript
// scripts/identity-smoke.ts
import { IdentitySession, TERMINAL_CHAT_ID } from '../src/identity-session.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// 1. set/get same chat, no thread
{
  const s = new IdentitySession(() => null);
  s.setCaller('chat_A', undefined, 'ou_alice');
  if (s.getCaller('chat_A') !== 'ou_alice') fail('basic chat get');
}

// 2. thread-scoped entry takes precedence over chat-scoped
{
  const s = new IdentitySession(() => null);
  s.setCaller('chat_A', undefined, 'ou_chat');
  s.setCaller('chat_A', 't1', 'ou_thread');
  if (s.getCaller('chat_A', 't1') !== 'ou_thread') fail('thread precedence');
  if (s.getCaller('chat_A') !== 'ou_chat') fail('chat still present');
}

// 3. getCaller falls back from thread to chat when thread missing
{
  const s = new IdentitySession(() => null);
  s.setCaller('chat_A', undefined, 'ou_chat');
  if (s.getCaller('chat_A', 'no-such-thread') !== 'ou_chat') fail('fallback to chat');
}

// 4. terminal sentinel uses owner fallback
{
  const s = new IdentitySession(() => 'ou_owner');
  if (s.getCaller(TERMINAL_CHAT_ID) !== 'ou_owner') fail('terminal fallback');
}

// 5. terminal sentinel returns null when no owner configured
{
  const s = new IdentitySession(() => null);
  if (s.getCaller(TERMINAL_CHAT_ID) !== null) fail('terminal null when unset');
}

// 6. unknown chat returns null
{
  const s = new IdentitySession(() => null);
  if (s.getCaller('chat_unknown') !== null) fail('unknown chat');
}

// 7. stale entry is not returned and cleanup removes it
{
  const s = new IdentitySession(() => null, 10); // 10ms ttl
  s.setCaller('chat_A', undefined, 'ou_alice');
  await new Promise((r) => setTimeout(r, 30));
  if (s.getCaller('chat_A') !== null) fail('stale should return null');
  s.cleanup();
  if (s._size() !== 0) fail('cleanup should remove stale');
}

// 8. overwrite refreshes
{
  const s = new IdentitySession(() => null);
  s.setCaller('chat_A', undefined, 'ou_alice');
  s.setCaller('chat_A', undefined, 'ou_bob');
  if (s.getCaller('chat_A') !== 'ou_bob') fail('overwrite');
}

console.log('identity smoke: 8/8 PASS');
```

- [ ] **Step 2.2: Run the smoke test**

Run: `npx tsx scripts/identity-smoke.ts`
Expected: `identity smoke: 8/8 PASS`

- [ ] **Step 2.3: Add to test runner**

Edit `scripts/test.sh`, append before the final "All tests passed" line:

```bash
echo ""
echo "=== Identity session unit checks ==="
npx tsx scripts/identity-smoke.ts
```

- [ ] **Step 2.4: Run full test suite**

Run: `bash scripts/test.sh`
Expected: all sections PASS.

- [ ] **Step 2.5: Commit**

```bash
git add scripts/identity-smoke.ts scripts/test.sh
git commit -m "test(identity): add 8 smoke assertions for IdentitySession"
```

---

## Task 3: Extend job schema with send_chat_id / origin_chat_id

**Files:**
- Modify: `src/job-store.ts` (JobMeta interface + backwards-compat read)

- [ ] **Step 3.1: Add a failing smoke test first**

Append to `scripts/job-smoke.ts`:

```typescript
// N+1. JobMeta accepts send_chat_id and origin_chat_id (type-level only)
{
  type Required = 'send_chat_id' | 'origin_chat_id';
  type HasFields = Required extends keyof import('../src/job-store.js').JobMeta ? true : false;
  const _check: HasFields = true as HasFields;
  void _check;
}
```

Run: `npx tsx scripts/job-smoke.ts`
Expected: FAIL with type error about missing properties.

- [ ] **Step 3.2: Extend JobMeta**

In `src/job-store.ts`, find the `JobMeta` interface and add two fields alongside `target_chat_id`:

```typescript
export interface JobMeta {
  // ... existing fields ...
  target_chat_id: string;
  /** Where the job delivers output. Same as target_chat_id for legacy jobs. */
  send_chat_id: string;
  /** Where the job was created. Group id for group-created jobs, p2p chat id for private-created. */
  origin_chat_id: string;
  // ... rest of existing fields ...
}
```

- [ ] **Step 3.3: Backwards-compat read**

In `readJob`, after parsing the JSON, backfill missing fields from `target_chat_id`:

```typescript
export async function readJob(id: string): Promise<JobFile | null> {
  // ... existing read logic, after JSON.parse ...
  const job = parsed as JobFile;
  if (!job.meta.send_chat_id) job.meta.send_chat_id = job.meta.target_chat_id;
  if (!job.meta.origin_chat_id) job.meta.origin_chat_id = job.meta.target_chat_id;
  return job;
}
```

Apply the same backfill in `listAllJobs` per-job.

- [ ] **Step 3.4: Run smoke**

Run: `npx tsx scripts/job-smoke.ts`
Expected: PASS (type check now satisfied).

- [ ] **Step 3.5: Commit**

```bash
git add src/job-store.ts scripts/job-smoke.ts
git commit -m "feat(jobs): add send_chat_id and origin_chat_id to JobMeta"
```

---

## Task 4: Require chat_id on create_job and populate new fields

**Files:**
- Modify: `src/tools.ts` (create_job handler)

- [ ] **Step 4.1: Update create_job schema**

In `src/tools.ts`, find the `create_job` tool registration. Extend `inputSchema` with `origin_chat_id`, rename `target_chat_id` semantic to `send_chat_id`:

```typescript
inputSchema: z.object({
  name: z.string().describe('Display name of the job'),
  type: z.enum(['message', 'prompt']).describe('Job type'),
  schedule: z.string().describe('Cron expression or alias (e.g. "daily at 09:00")'),
  prompt: z.string().optional().describe('Prompt body (type=prompt)'),
  content: z.string().optional().describe('Message body (type=message)'),
  target_chat_id: z.string().describe('Chat that receives the job output (send_chat_id)'),
  origin_chat_id: z.string().describe('Chat where the job was created (for visibility filtering)'),
  created_by: z.string().describe('open_id of the creator'),
}),
```

- [ ] **Step 4.2: Populate both fields in the handler**

When constructing `JobMeta` inside the handler, set:

```typescript
const meta: JobMeta = {
  // ... existing fields ...
  target_chat_id,
  send_chat_id: target_chat_id,
  origin_chat_id,
  // ...
};
```

- [ ] **Step 4.3: Typecheck and run existing smoke**

Run: `npx tsc --noEmit && npx tsx scripts/job-smoke.ts`
Expected: both clean/PASS.

- [ ] **Step 4.4: Commit**

```bash
git add src/tools.ts
git commit -m "feat(jobs): create_job requires origin_chat_id, stores send_chat_id"
```

---

## Task 5: Wire IdentitySession into channel.ts (inbound messages)

**Files:**
- Modify: `src/index.ts` (instantiate session)
- Modify: `src/channel.ts` (accept session in constructor, call setCaller)

- [ ] **Step 5.1: Add config key for owner fallback**

In `src/config.ts`, add to the exported config shape:

```typescript
ownerOpenId: process.env.LARK_OWNER_OPEN_ID || null,
```

(Place alongside existing optional config fields.)

- [ ] **Step 5.2: Instantiate the session in index.ts**

In `src/index.ts`, near where other singletons are created:

```typescript
import { IdentitySession } from './identity-session.js';

const identitySession = new IdentitySession(() => appConfig.ownerOpenId);
```

Pass `identitySession` into `LarkChannel` and `registerTools` (add it to both constructors/signatures).

- [ ] **Step 5.3: Set caller on inbound messages**

In `src/channel.ts` `handleMessageEvent`, after `senderId` is extracted from `data.sender.sender_id.open_id` and before `this.queue.enqueue(...)`:

```typescript
this.identitySession.setCaller(chatId, threadId, senderId);
```

(Add `identitySession: IdentitySession` to the constructor and store it as `this.identitySession`.)

- [ ] **Step 5.4: Typecheck and dry-run**

Run: `npx tsc --noEmit && npm run --silent start -- --dry-run`
Expected: both clean.

- [ ] **Step 5.5: Commit**

```bash
git add src/config.ts src/channel.ts src/index.ts
git commit -m "feat(identity): wire IdentitySession into channel inbound path"
```

---

## Task 6: Scheduler sets caller on cronjob trigger with unique thread_id

**Files:**
- Modify: `src/scheduler.ts` (accept session, generate thread id, set caller, include thread_id in meta)

- [ ] **Step 6.1: Add session to scheduler**

In `src/scheduler.ts`, add `private identitySession: IdentitySession` to the class and accept it in the constructor. Wire it from `src/index.ts` where the scheduler is instantiated.

- [ ] **Step 6.2: Set caller before notifying Claude**

In `executePromptJob`, before calling `this.server.notification(...)`:

```typescript
const jobThreadId = `job-${job.meta.id}-${Date.now()}`;
this.identitySession.setCaller(
  job.meta.send_chat_id,
  jobThreadId,
  job.meta.created_by,
);

await this.server.notification({
  method: 'notifications/claude/channel',
  params: {
    content: promptContent,
    meta: {
      chat_id: job.meta.send_chat_id,
      thread_id: jobThreadId,
      source: 'cronjob',
      job_id: job.meta.id,
      job_name: job.meta.name,
    },
  },
});
```

(Replace the previous `chat_id: job.meta.target_chat_id` with `send_chat_id`. Add `thread_id` to meta so downstream tool calls can pass it back.)

- [ ] **Step 6.3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6.4: Commit**

```bash
git add src/scheduler.ts src/index.ts
git commit -m "feat(identity): scheduler sets caller on cron trigger with unique thread_id"
```

---

## Task 7: Sensitive tools consult IdentitySession

**Files:**
- Modify: `src/tools.ts` (list_jobs, update_job, delete_job, save_memory, save_skill, create_job)

- [ ] **Step 7.1: Add a shared auth helper**

Near the top of `registerTools` in `src/tools.ts`:

```typescript
function resolveCaller(
  chat_id: string | undefined,
  thread_id: string | undefined,
): { caller: string } | { error: { isError: true; content: [{ type: 'text'; text: string }] } } {
  if (!chat_id) {
    return {
      error: {
        isError: true,
        content: [{ type: 'text' as const, text: 'chat_id is required for this tool' }],
      },
    };
  }
  const caller = identitySession.getCaller(chat_id, thread_id);
  if (!caller) {
    return {
      error: {
        isError: true,
        content: [{ type: 'text' as const, text: 'no active identity session for this chat' }],
      },
    };
  }
  return { caller };
}
```

Accept `identitySession: IdentitySession` as a new parameter to `registerTools`.

- [ ] **Step 7.2: Require chat_id on sensitive tools**

For each of `list_jobs`, `update_job`, `delete_job`, add `chat_id` and optional `thread_id` to their `inputSchema`:

```typescript
chat_id: z.string().describe('The chat this tool call is acting from'),
thread_id: z.string().optional().describe('Thread id if applicable'),
```

For `save_memory`: `chat_id` is already present — also accept optional `thread_id` if not already, and **remove** the client-supplied `open_id` field (we will derive it from the session).

- [ ] **Step 7.3: Gate each handler with resolveCaller**

Example for `list_jobs`:

```typescript
async ({ status, chat_id, thread_id }) => {
  const auth = resolveCaller(chat_id, thread_id);
  if ('error' in auth) return auth.error;
  const { caller } = auth;
  // ... continue to list & filter ...
}
```

Apply the same gate to `update_job`, `delete_job`, `save_memory`, `create_job`.

- [ ] **Step 7.4: `save_memory` uses `caller` as owner**

In the `save_memory` handler, replace any use of the (now removed) `open_id` input with `caller`. Profile writes are always for the calling user.

- [ ] **Step 7.5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7.6: Commit**

```bash
git add src/tools.ts
git commit -m "feat(identity): sensitive tools resolve caller from IdentitySession"
```

---

## Task 8: list_jobs visibility filter + redaction

**Files:**
- Modify: `src/tools.ts` (list_jobs handler)
- Modify: `src/channel.ts` (chat type helper if not already present)

- [ ] **Step 8.1: Expose chat type from channel**

If `channel.ts` already caches chat type (p2p/group), add a tiny lookup method. Otherwise add:

```typescript
// In LarkChannel
isPrivateChat(chatId: string): boolean {
  return chatId.startsWith('ou_') || this.p2pChatIds.has(chatId);
}
```

Pass this capability into `registerTools` (either the whole channel reference, or just a `isPrivateChat` function).

- [ ] **Step 8.2: Apply rendering-visibility filter in list_jobs**

Replace the body of `list_jobs` with:

```typescript
async ({ status, chat_id, thread_id }) => {
  const auth = resolveCaller(chat_id, thread_id);
  if ('error' in auth) return auth.error;
  const { caller } = auth;

  const jobs = await listAllJobs();
  const byStatus = status === 'all' ? jobs : jobs.filter((j) => j.meta.status === status);

  const isPrivate = isPrivateChat(chat_id);
  const visible = byStatus.filter((j) => {
    if (isPrivate) return j.meta.created_by === caller; // owner-only in private
    return j.meta.send_chat_id === chat_id;              // group: posting-to-this-group
  });

  if (visible.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No jobs found.' }] };
  }

  const lines = visible.map((j) => {
    const statusIcon = j.meta.status === 'active' ? '✅' : '⏸️';
    const lastRun = j.runtime.last_run_at
      ? new Date(j.runtime.last_run_at).toLocaleString()
      : 'never';
    const error = j.runtime.last_error ? ` ⚠️ ${j.runtime.last_error}` : '';
    const isOwner = j.meta.created_by === caller;

    // Group audit view: redact prompt/content/meta when caller is not owner
    if (!isPrivate && !isOwner) {
      return `${statusIcon} **${j.meta.id}** (${j.meta.type}) — ${j.meta.schedule_human}\n   By: ${j.meta.created_by} | Next: ${j.runtime.next_run_at}`;
    }
    return `${statusIcon} **${j.meta.id}** (${j.meta.type}) — ${j.meta.schedule_human}\n   Next: ${j.runtime.next_run_at} | Last: ${lastRun} | Runs: ${j.runtime.run_count}${error}`;
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: `Timezone: ${appConfig.cronTimezone}\n\n${lines.join('\n\n')}`,
      },
    ],
  };
}
```

- [ ] **Step 8.3: Typecheck + existing tests**

Run: `bash scripts/test.sh`
Expected: all PASS.

- [ ] **Step 8.4: Commit**

```bash
git add src/channel.ts src/tools.ts
git commit -m "feat(jobs): list_jobs filters by chat visibility and redacts group view"
```

---

## Task 9: update_job / delete_job owner-only

**Files:**
- Modify: `src/tools.ts`

- [ ] **Step 9.1: Gate delete_job**

In the `delete_job` handler, after resolving caller and before calling `deleteJob(id)`:

```typescript
const existing = await readJob(id);
if (!existing) {
  return { content: [{ type: 'text' as const, text: `Job "${id}" not found.` }] };
}
if (existing.meta.created_by !== caller) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: `You are not the owner of "${id}". Only ${existing.meta.created_by} can delete it.` },
    ],
  };
}
```

- [ ] **Step 9.2: Gate update_job**

Same pattern at the top of `update_job` handler.

- [ ] **Step 9.3: Smoke — owner check**

Add assertions to `scripts/job-smoke.ts` covering filename-level behavior (existing test patterns apply). If end-to-end behavior is hard to reach in the smoke, rely on typecheck + manual verification here.

- [ ] **Step 9.4: Full test suite**

Run: `bash scripts/test.sh`
Expected: all PASS.

- [ ] **Step 9.5: Commit**

```bash
git add src/tools.ts scripts/job-smoke.ts
git commit -m "feat(jobs): update/delete restricted to job owner"
```

---

## Task 10: Document, bump version, PR

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`

- [ ] **Step 10.1: Bump version to 0.9.0**

In `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — set version to `0.9.0`.

- [ ] **Step 10.2: Write CHANGELOG entry**

At the top of `CHANGELOG.md`, under the Keep-a-Changelog header:

```markdown
## [0.9.0] - 2026-04-19

### Added
- `IdentitySession` (`src/identity-session.ts`) — server-side `(chat_id, thread_id?) → open_id` mapping populated from Feishu events. Sensitive MCP tools now consult the session instead of trusting Claude-declared identity parameters.
- `send_chat_id` and `origin_chat_id` on `JobMeta` — enables visibility filtering based on where a job delivers output vs where it was created.
- `LARK_OWNER_OPEN_ID` config key — identity fallback for terminal invocations (reserved `__terminal__` chat id).

### Changed
- `list_jobs` now filters by rendering visibility: in a group, only jobs with `send_chat_id == currentChat` are returned; in a private chat, only jobs `created_by == caller`. Group view redacts prompt/content/meta when caller is not the owner (creator_by remains visible for accountability).
- `update_job` / `delete_job` now require `caller == created_by`.
- `create_job` input now requires both `target_chat_id` (→ `send_chat_id`) and `origin_chat_id`.
- `save_memory` no longer accepts a client-supplied `open_id` — the profile owner is derived from the session.
- Scheduler attaches a unique `thread_id` to each cronjob execution so cronjob sessions don't clobber concurrent inbound human messages.

### Security
- Closes the path where a group member could list or inspect another user's jobs via `list_jobs`.
- Closes the path where a socially-engineered prompt could direct tools to act on behalf of a different user.
```

- [ ] **Step 10.3: Full test**

Run: `bash scripts/test.sh`
Expected: all PASS.

- [ ] **Step 10.4: Commit and push**

```bash
git add CHANGELOG.md package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: release v0.9.0 — IdentitySession + CronJob visibility"
git push -u origin "$(git branch --show-current)"
```

- [ ] **Step 10.5: Open PR**

```bash
gh pr create --base main --title "feat: IdentitySession + CronJob visibility (v0.9.0)" --body "$(cat <<'EOF'
Closes #35 (phase 1 of 3)

## Summary
- Introduce `IdentitySession` — server-side caller mapping populated from Feishu events; sensitive tools consult it instead of trusting Claude-declared identity.
- Extend job schema with `send_chat_id` / `origin_chat_id`; filter `list_jobs` by rendering visibility; redact prompt/meta in group audit view.
- `update_job` / `delete_job` owner-only. `save_memory` uses session identity.
- Scheduler tags each cronjob execution with a unique `thread_id` to isolate from concurrent inbound messages.
- Terminal invocations fall back to `LARK_OWNER_OPEN_ID` via the reserved `__terminal__` chat id.

Spec: `docs/superpowers/specs/2026-04-19-lark-privacy-design.md`

## Test plan
- [ ] `bash scripts/test.sh` (incl. new identity smoke)
- [ ] Manual: group list_jobs shows only jobs posting to that group, private list shows all own jobs
- [ ] Manual: non-owner in group receives redacted view (no prompt body)
- [ ] Manual: cronjob fires and subsequent tool calls resolve identity correctly

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Checklist (already run)

- Spec coverage — ✅ Sections "IdentitySession", "CronJob Visibility", "Rendering Visibility" and "Configuration additions/LARK_OWNER_OPEN_ID" all have tasks. Terminal `__terminal__` sentinel is implemented in Task 1; the consumer side (`/lark:jobs` skill) is deferred to Phase 3.
- Placeholder scan — ✅ No TBDs. `isPrivateChat` helper has a fallback pattern that the engineer may need to tune to the actual channel code, but the intent is explicit and the code compiles against the interface.
- Type consistency — ✅ `caller`, `send_chat_id`, `origin_chat_id`, `thread_id` consistent across tasks.
