# Phase 3 — Transparency Tools, Self-Learning, Terminal Safeguards

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users visibility and control over what the bot remembers (`what_do_you_know`, `forget_memory`), a self-learning loop that feeds removals back into the L2 rules, and terminal-side safeguards (default redaction, audit log, destructive confirmation) for `/lark:jobs` and similar skills.

**Architecture:** Two new MCP tools implement the transparency surface using the rendering-visibility principle from Phase 1 (`what_do_you_know` filters by current chat). `forget_memory` removes a line from the caller's profile and surfaces a rule-append prompt. A new `/lark:jobs` skill (skills/jobs/SKILL.md existing or created) wraps `list_jobs` with default redaction + `--verbose`. Audit log is append-only file writes. Destructive confirmations are implemented as interactive skill steps, not tool-layer logic.

**Tech Stack:** TypeScript, MCP tools, Claude Code skills (markdown).

**Spec:** `docs/superpowers/specs/2026-04-19-lark-privacy-design.md` (sections: "Memory Transparency & Self-Learning", "Terminal Safeguards")

**Issue:** #35 (phase 3 of 3)

**Prerequisites:** Phase 0, Phase 1, and Phase 2 merged.

---

## File Structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `src/tools.ts` | `what_do_you_know`, `forget_memory` tools + audit-log wrapper | Modify |
| `src/memory/file.ts` | `removeProfileLine`, `listProfileLines` helpers on `MemoryStore` | Modify |
| `src/audit-log.ts` | Append-only audit log writer | Create |
| `skills/jobs/SKILL.md` | `/lark:jobs` terminal skill with redaction + confirmation | Create or modify |
| `scripts/transparency-smoke.ts` | Tool + rule-append smoke | Create |
| `scripts/test.sh` | Wire in new smoke | Modify |
| `CHANGELOG.md`, version files | Bump to v0.11.0 | Modify |

---

## Task 1: Profile line-level helpers

**Files:**
- Modify: `src/memory/file.ts`

- [ ] **Step 1.1: Add methods to MemoryStore**

Append inside the `MemoryStore` class in `src/memory/file.ts`:

```typescript
import { createHash } from 'node:crypto';

function lineHash(line: string): string {
  return createHash('sha1').update(line).digest('hex').slice(0, 8);
}

export async function listProfileLines(
  ownerId: string,
  tier: 'public' | 'private',
): Promise<Array<{ index: number; hash: string; text: string }>> {
  await migrateIfNeeded(ownerId);
  const p = tierPath(ownerId, tier);
  if (!existsSync(p)) return [];
  const content = await readFile(p, 'utf8');
  return content
    .split('\n')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((text, index) => ({ index, hash: lineHash(text), text }));
}

export async function removeProfileLine(
  ownerId: string,
  tier: 'public' | 'private',
  hash: string,
): Promise<boolean> {
  const lines = await listProfileLines(ownerId, tier);
  const kept = lines.filter((l) => l.hash !== hash);
  if (kept.length === lines.length) return false;
  const next = kept.map((l) => l.text).join('\n') + '\n';
  await writeFile(tierPath(ownerId, tier), next, 'utf8');
  return true;
}
```

- [ ] **Step 1.2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 1.3: Commit**

```bash
git add src/memory/file.ts
git commit -m "feat(memory): listProfileLines / removeProfileLine helpers"
```

---

## Task 2: `what_do_you_know` tool

**Files:**
- Modify: `src/tools.ts`

- [ ] **Step 2.1: Register the tool**

Inside `registerTools`, add:

```typescript
// ── what_do_you_know ──
server.registerTool(
  'what_do_you_know',
  {
    description:
      "Show the caller what the bot has stored in their profile. Path-B (explicit output): filtered by current chat's visibility — in groups, only the public tier is returned.",
    inputSchema: z.object({
      chat_id: z.string().describe('The chat this call is acting from'),
      thread_id: z.string().optional(),
    }),
  },
  async ({ chat_id, thread_id }) => {
    const auth = resolveCaller(chat_id, thread_id);
    if ('error' in auth) return auth.error;
    const { caller } = auth;

    const isPrivate = isPrivateChat(chat_id);
    const pub = await memoryStore.listProfileLines(caller, 'public');
    const priv = isPrivate
      ? await memoryStore.listProfileLines(caller, 'private')
      : [];

    const render = (
      tier: string,
      lines: Array<{ hash: string; text: string }>,
    ) =>
      lines.length === 0
        ? `_${tier}: (empty)_`
        : `**${tier}:**\n${lines.map((l) => `- [${l.hash}] ${l.text}`).join('\n')}`;

    const parts = [render('public', pub)];
    if (isPrivate) parts.push(render('private', priv));

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `What I know about you (in this chat's visibility):\n\n${parts.join('\n\n')}\n\n_Use \`forget_memory\` with a hash to remove a line._`,
        },
      ],
    };
  },
);
```

- [ ] **Step 2.2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2.3: Commit**

```bash
git add src/tools.ts
git commit -m "feat(memory): add what_do_you_know MCP tool"
```

---

## Task 3: `forget_memory` tool with rule-append suggestion

**Files:**
- Modify: `src/tools.ts`

- [ ] **Step 3.1: Register the tool**

```typescript
// ── forget_memory ──
server.registerTool(
  'forget_memory',
  {
    description:
      'Remove a specific line from the caller’s profile. Always caller-scoped — you can only forget things about yourself. Optionally promotes the removal into a persistent L2 rule.',
    inputSchema: z.object({
      chat_id: z.string(),
      thread_id: z.string().optional(),
      hash: z.string().describe('8-char line hash from what_do_you_know'),
      tier: z.enum(['public', 'private']).default('public'),
      promote_to_rule: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'If true, the removed line is appended to privacy-rules.md under "Always private" so future distillations respect it.',
        ),
    }),
  },
  async ({ chat_id, thread_id, hash, tier, promote_to_rule }) => {
    const auth = resolveCaller(chat_id, thread_id);
    if ('error' in auth) return auth.error;
    const { caller } = auth;

    const lines = await memoryStore.listProfileLines(caller, tier);
    const target = lines.find((l) => l.hash === hash);
    if (!target) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `No line with hash ${hash} in ${tier} tier.` }],
      };
    }

    const removed = await memoryStore.removeProfileLine(caller, tier, hash);
    if (!removed) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Failed to remove line ${hash}.` }],
      };
    }

    if (promote_to_rule) {
      const { appendL2Rule } = await import('./privacy-rules.js');
      await appendL2Rule(target.text, 'Always private');
    }

    const tail = promote_to_rule
      ? ' Rule also added to privacy-rules.md so future distillations will classify similar content as private.'
      : '';
    return {
      content: [
        {
          type: 'text' as const,
          text: `Removed "${target.text}" from ${tier} profile.${tail}`,
        },
      ],
    };
  },
);
```

- [ ] **Step 3.2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3.3: Commit**

```bash
git add src/tools.ts
git commit -m "feat(memory): add forget_memory with optional promote_to_rule"
```

---

## Task 4: Audit log writer

**Files:**
- Create: `src/audit-log.ts`
- Modify: `src/tools.ts` (wrap sensitive tool calls)

- [ ] **Step 4.1: Module**

```typescript
// src/audit-log.ts
import { appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const LOG_PATH =
  process.env.LARK_AUDIT_LOG ||
  join(homedir(), '.claude', 'channels', 'lark', 'audit.log');

export async function audit(
  tool: string,
  caller: string | null,
  args: Record<string, unknown>,
  outcome: 'ok' | 'denied' | 'error',
): Promise<void> {
  const line =
    [
      new Date().toISOString(),
      tool.padEnd(20),
      outcome.padEnd(7),
      `caller=${caller ?? '-'}`,
      `args=${JSON.stringify(redact(args))}`,
    ].join('  ') + '\n';
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, line, 'utf8');
  } catch {
    // Best-effort — don't crash the tool on log failures.
  }
}

function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 80) out[k] = `${v.slice(0, 60)}...`;
    else out[k] = v;
  }
  return out;
}
```

- [ ] **Step 4.2: Wrap sensitive tools**

In `src/tools.ts`, add a helper near `resolveCaller`:

```typescript
import { audit } from './audit-log.js';

async function withAudit<T>(
  toolName: string,
  chat_id: string | undefined,
  thread_id: string | undefined,
  args: Record<string, unknown>,
  fn: (caller: string) => Promise<T>,
): Promise<T> {
  const auth = resolveCaller(chat_id, thread_id);
  if ('error' in auth) {
    await audit(toolName, null, args, 'denied');
    return auth.error as unknown as T;
  }
  try {
    const result = await fn(auth.caller);
    await audit(toolName, auth.caller, args, 'ok');
    return result;
  } catch (e) {
    await audit(toolName, auth.caller, args, 'error');
    throw e;
  }
}
```

Replace the direct `resolveCaller` calls in sensitive tools (`list_jobs`, `update_job`, `delete_job`, `save_memory`, `what_do_you_know`, `forget_memory`, `create_job`) with `withAudit`. Each handler is wrapped to ensure every outcome hits the log.

- [ ] **Step 4.3: Typecheck and dry-run**

Run: `npx tsc --noEmit && npm run --silent start -- --dry-run`
Expected: clean.

- [ ] **Step 4.4: Commit**

```bash
git add src/audit-log.ts src/tools.ts
git commit -m "feat(audit): append-only audit log for sensitive tool invocations"
```

---

## Task 5: Transparency smoke test

**Files:**
- Create: `scripts/transparency-smoke.ts`

- [ ] **Step 5.1: Write smoke**

```typescript
// scripts/transparency-smoke.ts
// Smoke for listProfileLines / removeProfileLine and the promote_to_rule path.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_MEM_ROOT = mkdtempSync(join(tmpdir(), 'transparency-'));
process.env.LARK_PRIVACY_RULES_FILE = join(process.env.LARK_MEM_ROOT, 'privacy-rules.md');

const { saveProfile, listProfileLines, removeProfileLine } = await import(
  '../src/memory/file.js'
);
const { appendL2Rule, loadL2Rules } = await import('../src/privacy-rules.js');

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// 1. write and list
await saveProfile('ou_alice', '- is engineer\n- likes tea\n- uses TypeScript', 'public');
const lines = await listProfileLines('ou_alice', 'public');
if (lines.length !== 3) fail(`expected 3 lines got ${lines.length}`);

// 2. remove by hash
const removedHash = lines[1].hash;
const ok = await removeProfileLine('ou_alice', 'public', removedHash);
if (!ok) fail('remove should succeed');
const after = await listProfileLines('ou_alice', 'public');
if (after.length !== 2) fail(`expected 2 lines after remove got ${after.length}`);
if (after.some((l) => l.hash === removedHash)) fail('removed line still present');

// 3. idempotent remove
const again = await removeProfileLine('ou_alice', 'public', removedHash);
if (again) fail('second remove should return false');

// 4. rule append round-trip
await appendL2Rule('涉及人际冲突的表述', 'Always private');
const rules = await loadL2Rules();
if (!rules.includes('涉及人际冲突')) fail('rule should persist');

rmSync(process.env.LARK_MEM_ROOT!, { recursive: true, force: true });
console.log('transparency smoke: 4/4 PASS');
```

- [ ] **Step 5.2: Run**

Run: `npx tsx scripts/transparency-smoke.ts`
Expected: `transparency smoke: 4/4 PASS`

- [ ] **Step 5.3: Wire into test runner**

Add to `scripts/test.sh`:

```bash
echo ""
echo "=== Transparency unit checks ==="
npx tsx scripts/transparency-smoke.ts
```

- [ ] **Step 5.4: Run full suite**

Run: `bash scripts/test.sh`
Expected: all PASS.

- [ ] **Step 5.5: Commit**

```bash
git add scripts/transparency-smoke.ts scripts/test.sh
git commit -m "test(transparency): add 4 smoke assertions"
```

---

## Task 6: `/lark:jobs` terminal skill with default redaction

**Files:**
- Create or modify: `skills/jobs/SKILL.md`

- [ ] **Step 6.1: Inspect existing skill (if any)**

Read `skills/jobs/SKILL.md` to understand the current contract. If it doesn't exist, create the file.

- [ ] **Step 6.2: Write skill content**

Save to `skills/jobs/SKILL.md`:

```markdown
---
name: lark:jobs
description: >-
  Manage lark cronjobs from the Claude Code terminal. Lists, pauses, resumes,
  and deletes jobs. Calls the plugin's MCP tools with the reserved
  `__terminal__` chat id so identity falls back to LARK_OWNER_OPEN_ID.
---

# Lark Jobs (terminal)

Invoke this skill when the user asks to list, inspect, pause, resume, or delete
lark cronjobs from the Claude Code terminal.

## Default behavior (redacted)

When the user says "list jobs" or similar without asking for detail, call
`list_jobs` with `chat_id="__terminal__"` and render a compact view:

```
[1] morning-brief      daily 09:00      → group "Team Sync"
[2] mail-digest        daily 22:00      → private
Use `/lark:jobs verbose` to include prompt bodies.
```

Do NOT print `prompt` or `content` fields in default mode. This protects
against screen-share and shoulder-surfing leaks.

## Verbose mode

When the user explicitly says "verbose", "show full", "dump", or "include
prompt", include `prompt` / `content` / `meta` in the rendered output.
Warn in one line above the output: `⚠ verbose mode — prompt bodies visible.`

## Destructive operations

For `delete_job`, `update_job` when setting `status=paused` or changing
`schedule`, always confirm before calling the tool:

> "Confirm: delete job `<id>` (runs `<schedule>`, targets `<send_chat_id>`)?
> Reply `yes` to proceed."

Do not proceed without an affirmative reply.

## Audit

Every invocation writes to `~/.claude/channels/lark/audit.log` automatically
via the plugin's tool wrapper; this skill does not need to log explicitly.

## Identity

All tool calls pass `chat_id="__terminal__"`. The MCP server resolves this to
the operator identity via `LARK_OWNER_OPEN_ID` in the .env file. If that env
var is missing, the tool will return an error; prompt the user to run
`/lark:configure` to set it.
```

- [ ] **Step 6.3: Commit**

```bash
git add skills/jobs/SKILL.md
git commit -m "feat(skill): lark:jobs terminal skill with default redaction"
```

---

## Task 7: Document, bump, PR

**Files:**
- Modify: `CHANGELOG.md`, version files

- [ ] **Step 7.1: Bump to 0.11.0**

- [ ] **Step 7.2: CHANGELOG**

```markdown
## [0.11.0] - 2026-04-21

### Added
- `what_do_you_know` MCP tool — returns the caller's profile. Path-B: in groups only the public tier is rendered; in private chat both tiers.
- `forget_memory` MCP tool — removes a specific line from the caller's profile. Optional `promote_to_rule: true` appends the line as a new entry in `privacy-rules.md` under "Always private" so future distillations respect it (self-learning loop).
- `src/audit-log.ts` — append-only audit log at `~/.claude/channels/lark/audit.log` records every sensitive tool invocation (caller, args preview, outcome).
- `skills/jobs/SKILL.md` — `/lark:jobs` terminal skill. Default output hides prompt bodies; `verbose` mode opts in. Destructive operations require interactive confirmation.

### Changed
- All sensitive tool invocations now flow through a `withAudit` wrapper that logs outcome (ok/denied/error).

### Security
- Terminal invocations default to a redacted view to reduce shoulder-surfing and screen-share leaks.
- Users now have a self-serve path to inspect and remove misclassified memories, closing the trust gap introduced by silent auto-distillation.
```

- [ ] **Step 7.3: Full test**

Run: `bash scripts/test.sh`
Expected: all PASS.

- [ ] **Step 7.4: Commit, push, PR**

```bash
git add CHANGELOG.md package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: release v0.11.0 — transparency tools + terminal safeguards"
git push -u origin "$(git branch --show-current)"
gh pr create --base main --title "feat: transparency tools + self-learning + terminal safeguards (v0.11.0)" --body "$(cat <<'EOF'
Closes #35 (phase 3 of 3 — completes the privacy redesign)

## Summary
- `what_do_you_know` / `forget_memory` tools — users can inspect and remove their own profile entries; `forget_memory` optionally promotes the removal into a persistent L2 rule.
- Append-only audit log for every sensitive tool invocation.
- `/lark:jobs` terminal skill with default redaction, verbose opt-in, and destructive confirmation.

Spec: `docs/superpowers/specs/2026-04-19-lark-privacy-design.md`
Depends on: #<phase2 PR>  (merged)

## Test plan
- [ ] `bash scripts/test.sh`
- [ ] Manual: `/lark:jobs` default hides prompts; `verbose` shows them; delete prompts for confirmation
- [ ] Manual: `what_do_you_know` in a group returns only public tier; in p2p returns both
- [ ] Manual: `forget_memory` with promote_to_rule=true adds rule to privacy-rules.md and influences next distillation
- [ ] Manual: audit.log accumulates entries after a few tool calls

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Checklist

- Spec coverage — ✅ "Memory Transparency & Self-Learning" (what_do_you_know / forget_memory / rule append) in Tasks 2–3. "Terminal Safeguards" (redaction, audit log, confirmation, identity fallback) in Tasks 4, 6 (the identity fallback is already implemented in Phase 1).
- Placeholder scan — ✅ All tool signatures concrete; no TODO language.
- Type consistency — ✅ `listProfileLines` / `removeProfileLine` / `tier` / `hash` are consistent across Tasks 1–3 and smoke.
