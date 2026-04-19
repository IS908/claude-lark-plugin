# Phase 2 — Profile Tiering (public / private)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split each user's profile memory into `public.md` and `private.md` so facts distilled from private chat never leak into groups where others mention the user. Introduce the L1 hard-rule classifier, the L2 user rules file, and update the distiller to emit tiered output.

**Architecture:** Storage layout moves from `profiles/{userId}.md` (single file) to `profiles/{userId}/public.md` + `private.md`. Classification at distillation time runs in three layers — L1 (hardcoded regex / keyword lists in code), L2 (user-editable markdown file injected into the distiller prompt as context), L3 (LLM decides gray-area, conservative default private). Blacklist L1 always wins. Load-time: `caller == owner` loads both tiers; otherwise only public.

**Tech Stack:** TypeScript, MCP, tsx smoke tests.

**Spec:** `docs/superpowers/specs/2026-04-19-lark-privacy-design.md` (sections: "Tiered Profile Memory", "Migration")

**Issue:** #35 (phase 2 of 3)

**Prerequisites:**
- Phase 0 merged (memory backend consolidated to a single `MemoryStore` class).
- Phase 1 merged (IdentitySession is used for caller derivation).

---

## File Structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `src/privacy-rules.ts` | L1 hard rules (blacklist regex, keyword, whitelist) + L2 file loader | Create |
| `src/memory/tier-classifier.ts` | Apply L1 to a candidate fact; return `public`/`private`/`gray` | Create |
| `src/memory/file.ts` | Tiered read/write; migration; caller-aware loadProfile; update inline types | Modify |
| `src/memory/distiller.ts` | Emit `{public, private}` JSON; include L2 rules in prompt | Modify |
| `src/memory/buffer.ts` | Pass source (p2p vs group) to distiller | Modify |
| `src/channel.ts` | Inject caller-aware profile when enriching | Modify |
| `scripts/privacy-rules-smoke.ts` | L1 classifier unit checks | Create |
| `scripts/profile-tier-smoke.ts` | Tiered I/O + migration unit checks | Create |
| `scripts/test.sh` | Add new smokes | Modify |
| `CHANGELOG.md`, version files | Bump to v0.10.0 | Modify |

---

## Task 1: L1 hard-rule classifier

**Files:**
- Create: `src/privacy-rules.ts`

- [ ] **Step 1.1: Write the module**

```typescript
// src/privacy-rules.ts
/**
 * L1 hardcoded privacy rules — universal patterns applied at distillation
 * time regardless of source or explicit user override.
 */

/** Regex patterns that force a fact into `private`. */
export const L1_BLACKLIST_REGEX: { name: string; regex: RegExp }[] = [
  { name: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  { name: 'cn-mobile', regex: /\b1[3-9]\d{9}\b/ },
  { name: 'us-phone', regex: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  { name: 'cn-id', regex: /\b\d{17}[\dXx]\b/ },
  { name: 'credit-card', regex: /\b(?:\d[ -]*?){13,16}\b/ },
  { name: 'token-like', regex: /\b(?:sk|pk|api|token|secret)[-_][a-zA-Z0-9]{16,}\b/i },
  { name: 'money-amount', regex: /\b\d+[wkm万千百]\s*(?:元|块|RMB|CNY|USD|\$)?\b/ },
];

/** Keywords that force a fact into `private` when present (case-insensitive substring match). */
export const L1_BLACKLIST_KEYWORDS: string[] = [
  '薪资', '工资', 'KPI', '绩效', '跳槽', '离职', '面试 offer',
  '病', '医院', '焦虑', '抑郁', '情绪', '吐槽',
  '家庭矛盾', '婚姻', '离婚',
  '密码', 'password',
];

/** Keywords that allow a fact into `public` (whitelist — otherwise defaults via layer 2/3). */
export const L1_WHITELIST_KEYWORDS: string[] = [
  '工程师', '产品经理', 'PM', 'TL', 'CEO', 'CTO',
  '团队', '部门', '公司',
  'TypeScript', 'Rust', 'Go', 'Python', 'Java',
];

export type TierDecision = 'private' | 'public' | 'gray';

/** Apply L1 only. Returns a decision or `gray` when L1 gives no signal. */
export function applyL1(fact: string): TierDecision {
  for (const { regex } of L1_BLACKLIST_REGEX) {
    if (regex.test(fact)) return 'private';
  }
  const lower = fact.toLowerCase();
  for (const kw of L1_BLACKLIST_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return 'private';
  }
  for (const kw of L1_WHITELIST_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return 'public';
  }
  return 'gray';
}
```

- [ ] **Step 1.2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 1.3: Commit**

```bash
git add src/privacy-rules.ts
git commit -m "feat(privacy): add L1 hardcoded privacy rules"
```

---

## Task 2: Smoke tests for L1

**Files:**
- Create: `scripts/privacy-rules-smoke.ts`

- [ ] **Step 2.1: Write smoke test**

```typescript
// scripts/privacy-rules-smoke.ts
import { applyL1 } from '../src/privacy-rules.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const cases: [string, 'private' | 'public' | 'gray'][] = [
  ['我的邮箱是 kk@bytedance.com', 'private'],
  ['手机号 13800138000', 'private'],
  ['薪资大概 3w', 'private'],
  ['最近在准备跳槽', 'private'],
  ['密码是 abc123!@#', 'private'],
  ['我是 TikTok Live 团队的工程师', 'public'],
  ['熟悉 TypeScript 和 Rust', 'public'],
  ['晚上想吃烤鱼', 'gray'],
  ['偏好会议安排在下午', 'gray'],
];

for (const [fact, expected] of cases) {
  const got = applyL1(fact);
  if (got !== expected) fail(`"${fact}" expected ${expected} got ${got}`);
}

console.log(`privacy-rules smoke: ${cases.length}/${cases.length} PASS`);
```

- [ ] **Step 2.2: Run it**

Run: `npx tsx scripts/privacy-rules-smoke.ts`
Expected: `privacy-rules smoke: 9/9 PASS`

- [ ] **Step 2.3: Wire into test runner**

Edit `scripts/test.sh`, add before the final success line:

```bash
echo ""
echo "=== Privacy rules unit checks ==="
npx tsx scripts/privacy-rules-smoke.ts
```

- [ ] **Step 2.4: Commit**

```bash
git add scripts/privacy-rules-smoke.ts scripts/test.sh
git commit -m "test(privacy): add 9 L1 classifier smoke assertions"
```

---

## Task 3: L2 user rules file loader

**Files:**
- Modify: `src/privacy-rules.ts`

- [ ] **Step 3.1: Add loader**

Append to `src/privacy-rules.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Load the L2 user rules file as raw markdown. Returns empty string if not
 * present. The distiller injects this as-is into the classification prompt;
 * we intentionally do not parse it into structured rules (LLM handles nuance).
 */
export async function loadL2Rules(
  overridePath?: string,
): Promise<string> {
  const path =
    overridePath ||
    process.env.LARK_PRIVACY_RULES_FILE ||
    join(homedir(), '.claude', 'channels', 'lark', 'privacy-rules.md');
  if (!existsSync(path)) return '';
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/** Append a rule line to the L2 file (self-learning loop). Creates the file if missing. */
export async function addL2Rule(
  rule: string,
  section: 'Always private' | 'Always public',
  overridePath?: string,
): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const path =
    overridePath ||
    process.env.LARK_PRIVACY_RULES_FILE ||
    join(homedir(), '.claude', 'channels', 'lark', 'privacy-rules.md');
  await mkdir(dirname(path), { recursive: true });
  const existing = existsSync(path) ? await readFile(path, 'utf8') : '';
  const header = `## ${section}`;
  let next = existing;
  if (!existing.includes(header)) {
    next += (next ? '\n\n' : '') + `${header}\n`;
  }
  // Append after the section header
  const sectionIdx = next.indexOf(header);
  const insertAt = next.indexOf('\n', sectionIdx) + 1;
  next = `${next.slice(0, insertAt)}- ${rule}\n${next.slice(insertAt)}`;
  await writeFile(path, next, 'utf8');
}
```

- [ ] **Step 3.2: Smoke for L2**

Append to `scripts/privacy-rules-smoke.ts`:

```typescript
import { loadL2Rules, addL2Rule } from '../src/privacy-rules.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'privacy-rules-'));
const tmpFile = join(tmp, 'rules.md');

// L2.1 — empty load
if ((await loadL2Rules(tmpFile)) !== '') fail('L2 empty should return ""');

// L2.2 — append creates file
await addL2Rule('涉及人际冲突的表述', 'Always private', tmpFile);
const a = await loadL2Rules(tmpFile);
if (!a.includes('Always private') || !a.includes('涉及人际冲突')) fail('L2 append create');

// L2.3 — second append reuses section
await addL2Rule('客户名 ACME Corp', 'Always private', tmpFile);
const b = await loadL2Rules(tmpFile);
if ((b.match(/## Always private/g) || []).length !== 1) fail('L2 should reuse section');
if (!b.includes('ACME Corp')) fail('L2 second rule present');

// L2.4 — new section created when different header used
await addL2Rule('GitHub handle @kk', 'Always public', tmpFile);
const c = await loadL2Rules(tmpFile);
if (!c.includes('## Always public')) fail('L2 new section');

rmSync(tmp, { recursive: true, force: true });
console.log('L2 rules smoke: 4/4 PASS');
```

- [ ] **Step 3.3: Run**

Run: `npx tsx scripts/privacy-rules-smoke.ts`
Expected: both smoke sections PASS.

- [ ] **Step 3.4: Commit**

```bash
git add src/privacy-rules.ts scripts/privacy-rules-smoke.ts
git commit -m "feat(privacy): L2 user rules loader and appender"
```

---

## Task 4: Tiered file provider — storage layout + migration

**Files:**
- Modify: `src/memory/file.ts`
- Create: `scripts/profile-tier-smoke.ts`

- [ ] **Step 4.1: Update method signatures on MemoryStore**

Phase 0 already inlined the types in `src/memory/file.ts`. We update the method signatures directly on the class:

```typescript
// Before (Phase 0 state):
async getProfile(userId: string): Promise<string | null>
async saveProfile(userId: string, content: string): Promise<void>

// After:
async getProfile(ownerId: string, caller: string): Promise<string | null>
async saveProfile(ownerId: string, content: string, tier: 'public' | 'private'): Promise<void>
```

- [ ] **Step 4.2: Rewrite file provider storage**

In `src/memory/file.ts`:

```typescript
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const PROFILE_ROOT = /* existing root */; // e.g. join(memRoot, 'profiles')

function tierPath(ownerId: string, tier: 'public' | 'private'): string {
  return join(PROFILE_ROOT, ownerId, `${tier}.md`);
}

function legacyPath(ownerId: string): string {
  return join(PROFILE_ROOT, `${ownerId}.md`);
}

/** Lazy migration: if legacy single file exists and new dir doesn't, move legacy → public.md. */
async function migrateIfNeeded(ownerId: string): Promise<void> {
  const legacy = legacyPath(ownerId);
  const pub = tierPath(ownerId, 'public');
  if (!existsSync(legacy)) return;
  if (existsSync(pub)) return; // already migrated
  await mkdir(dirname(pub), { recursive: true });
  await rename(legacy, pub);
}

export async function getProfile(ownerId: string, caller: string): Promise<string | null> {
  await migrateIfNeeded(ownerId);
  const readOpt = async (p: string) => (existsSync(p) ? await readFile(p, 'utf8') : '');
  const pub = await readOpt(tierPath(ownerId, 'public'));
  if (caller === ownerId) {
    const priv = await readOpt(tierPath(ownerId, 'private'));
    const joined = [pub.trim(), priv.trim()].filter(Boolean).join('\n\n');
    return joined || null;
  }
  return pub.trim() || null;
}

export async function saveProfile(
  ownerId: string,
  content: string,
  tier: 'public' | 'private',
): Promise<void> {
  const p = tierPath(ownerId, tier);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content, 'utf8');
}
```

Update the export shape so existing consumers keep compiling. Since Phase 0 collapsed the providers down to a single `MemoryStore` class, only this file and its callers (`src/channel.ts`, `src/tools.ts`) need to compile against the new signatures.

- [ ] **Step 4.3: Smoke — migration + caller filtering**

Create `scripts/profile-tier-smoke.ts`:

```typescript
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_MEM_ROOT = mkdtempSync(join(tmpdir(), 'profile-tier-'));
const root = process.env.LARK_MEM_ROOT!;

// The file provider reads LARK_MEM_ROOT or similar — adjust this smoke to match
// whatever the actual override knob is in src/memory/file.ts.
const { getProfile, saveProfile } = await import('../src/memory/file.js');

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// 1. migration: legacy file becomes public.md
mkdirSync(join(root, 'profiles'), { recursive: true });
writeFileSync(join(root, 'profiles', 'ou_alice.md'), 'I am legacy', 'utf8');
const own = await getProfile('ou_alice', 'ou_alice');
if (own !== 'I am legacy') fail('migration read by owner');

// 2. caller != owner still reads public only
const other = await getProfile('ou_alice', 'ou_bob');
if (other !== 'I am legacy') fail('non-owner sees public after migration');

// 3. save private tier; owner sees both, other only public
await saveProfile('ou_alice', 'I am private', 'private');
const ownBoth = await getProfile('ou_alice', 'ou_alice');
if (!ownBoth?.includes('legacy') || !ownBoth?.includes('private')) fail('owner sees both tiers');
const otherStill = await getProfile('ou_alice', 'ou_bob');
if (otherStill?.includes('private')) fail('non-owner must NOT see private');

rmSync(root, { recursive: true, force: true });
console.log('profile-tier smoke: 3/3 PASS');
```

- [ ] **Step 4.4: Wire into test runner**

Edit `scripts/test.sh`, add:

```bash
echo ""
echo "=== Profile tiering unit checks ==="
npx tsx scripts/profile-tier-smoke.ts
```

- [ ] **Step 4.5: Run full suite**

Run: `bash scripts/test.sh`
Expected: all PASS.

- [ ] **Step 4.6: Commit**

```bash
git add src/memory/file.ts scripts/profile-tier-smoke.ts scripts/test.sh
git commit -m "feat(memory): tiered profile storage with lazy migration"
```

---

## Task 5: Distiller emits tiered output

**Files:**
- Modify: `src/memory/distiller.ts`
- Modify: `src/memory/buffer.ts` (pass source to flush handler)
- Modify: `src/channel.ts` (apply tier-aware save after flush)

- [ ] **Step 5.1: Update the distillation prompt**

In `src/prompts.ts` (or `src/memory/distiller.ts` if prompts still live there), the profile distillation prompt now outputs structured JSON:

```typescript
export const profileDistillationPrompt = (args: {
  userId: string;
  currentProfile: string;
  episodeSummaries: string[];
  chatType: 'p2p' | 'group';
  l2Rules: string; // raw markdown of the user's privacy-rules.md
}): string => `
You are maintaining a long-term profile for user ${args.userId}.

Current profile:
${args.currentProfile || '(empty)'}

Recent episodes (${args.chatType}):
${args.episodeSummaries.map((s, i) => `[${i + 1}] ${s}`).join('\n')}

User privacy rules:
${args.l2Rules || '(none)'}

Return a JSON object with exactly two arrays:
{
  "public":  [ "facts that are safe for anyone who @mentions this user to see" ],
  "private": [ "facts only this user themselves should see" ]
}

Classification rules (apply in order, higher priority wins):
1. Anything matching the user's "Always private" rules → private.
2. Anything matching the user's "Always public" rules → public.
3. Facts from a private 1:1 chat default to private (source: ${args.chatType}).
4. Facts from a group default to public (source: ${args.chatType}).
5. Specific emails, phone numbers, monetary amounts, passwords, tokens are ALWAYS private, even when mentioned in a group.
6. When uncertain, choose private.

Return ONLY the JSON object, no prose.
`;
```

- [ ] **Step 5.2: Post-process distilled JSON**

Wherever the distilled string is currently parsed, add a helper:

```typescript
// src/memory/distiller.ts
import { applyL1 } from '../privacy-rules.js';

export interface TieredProfile {
  public: string[];
  private: string[];
}

export function parseTieredProfile(raw: string): TieredProfile {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fallback: treat the whole blob as private (conservative).
    return { public: [], private: [raw.trim()] };
  }
  const pub = Array.isArray(parsed.public) ? parsed.public.map(String) : [];
  const priv = Array.isArray(parsed.private) ? parsed.private.map(String) : [];

  // L1 safety net: anything the LLM marked public but our regex hits goes private.
  const safePublic: string[] = [];
  const forcedPrivate: string[] = [...priv];
  for (const fact of pub) {
    if (applyL1(fact) === 'private') forcedPrivate.push(fact);
    else safePublic.push(fact);
  }
  return { public: safePublic, private: forcedPrivate };
}
```

- [ ] **Step 5.3: Wire buffer flush to pass chat type**

In `src/memory/buffer.ts` flush path, include `chatType` when calling the distiller invocation. In `src/channel.ts` where the flush handler saves to the provider, save each tier separately:

```typescript
const tiered = parseTieredProfile(distilledRaw);
if (tiered.public.length) {
  await memoryStore.saveProfile(
    userId,
    tiered.public.map((s) => `- ${s}`).join('\n'),
    'public',
  );
}
if (tiered.private.length) {
  await memoryStore.saveProfile(
    userId,
    tiered.private.map((s) => `- ${s}`).join('\n'),
    'private',
  );
}
```

(If the existing flush logic merges new facts with existing profile content, apply the same merge per-tier.)

- [ ] **Step 5.4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5.5: Commit**

```bash
git add src/memory/distiller.ts src/prompts.ts src/memory/buffer.ts src/channel.ts
git commit -m "feat(memory): distiller emits tiered profile JSON"
```

---

## Task 6: Enrichment uses caller-aware profile load

**Files:**
- Modify: `src/channel.ts` (enrichment pipeline)

- [ ] **Step 6.1: Pass caller into getProfile**

In the message enrichment pipeline in `src/channel.ts`, wherever `memoryStore.getProfile(...)` is called, now pass the current message sender as the caller:

```typescript
// For the speaker's own profile:
const ownProfile = await memoryStore.getProfile(senderId, senderId);

// For mentioned users' profiles (cross-user context):
for (const mentionedId of mentions) {
  const mentionedProfile = await memoryStore.getProfile(mentionedId, senderId);
  // Only public is returned because senderId !== mentionedId
}
```

- [ ] **Step 6.2: Typecheck and dry-run**

Run: `npx tsc --noEmit && npm run --silent start -- --dry-run`
Expected: clean.

- [ ] **Step 6.3: Commit**

```bash
git add src/channel.ts
git commit -m "feat(memory): enrichment loads profiles with caller-aware tier filter"
```

---

## Task 7: Document, bump, PR

**Files:**
- Modify: `CHANGELOG.md`, version files

- [ ] **Step 7.1: Bump to 0.10.0**

In `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.

- [ ] **Step 7.2: CHANGELOG entry**

```markdown
## [0.10.0] - 2026-04-20

### Added
- Tiered profile storage: `profiles/{userId}/public.md` and `private.md`. Cross-user profile lookups (e.g. someone @mentioning another user) return only the public tier; the owner sees both.
- L1 hardcoded privacy rules (`src/privacy-rules.ts`): regex + keyword blacklist for emails, phone, ID numbers, tokens, sensitive topics; whitelist for common public attributes.
- L2 user rules file at `~/.claude/channels/lark/privacy-rules.md` — natural-language markdown that the distiller injects into its classification prompt.
- Distiller now emits `{ public: [...], private: [...] }` JSON with L1 acting as a safety net over LLM classification.

### Changed
- `MemoryProvider.getProfile` signature now takes `(ownerId, caller)`; `saveProfile` now takes `(ownerId, content, tier)`.
- On first read of an existing profile, `profiles/{userId}.md` is migrated to `profiles/{userId}/public.md` in-place.

### Security
- Private-chat facts no longer leak into group chats via `@mention` injection — only the public tier is loaded when the caller is not the profile owner.
```

- [ ] **Step 7.3: Full test**

Run: `bash scripts/test.sh`
Expected: all PASS.

- [ ] **Step 7.4: Commit, push, PR**

```bash
git add CHANGELOG.md package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: release v0.10.0 — profile tiering"
git push -u origin "$(git branch --show-current)"
gh pr create --base main --title "feat: tiered profile memory + L1/L2/L3 classifier (v0.10.0)" --body "$(cat <<'EOF'
Closes #35 (phase 2 of 3)

## Summary
- Split profile storage into `public.md` / `private.md` per user; lazy-migrate legacy files on first read.
- L1 hardcoded privacy rules (regex + keyword lists); L2 user markdown rules file; L3 LLM classification with L1 as safety net.
- Distiller emits tiered JSON; enrichment pipeline loads caller-aware.
- Cross-user `@mention` now only surfaces the public tier.

Spec: `docs/superpowers/specs/2026-04-19-lark-privacy-design.md`
Depends on: #<phase1 PR number> (merged)

## Test plan
- [ ] `bash scripts/test.sh`
- [ ] Manual: write something private in p2p, have another user @ you in a group, confirm only public facts are surfaced
- [ ] Manual: pre-existing `profiles/{userId}.md` is migrated to `profiles/{userId}/public.md` on first read
- [ ] Manual: adding a rule to `privacy-rules.md` affects the next distillation

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Checklist

- Spec coverage — ✅ "Tiered Profile Memory" (storage, load logic, classification), "Migration". The L2 self-learning loop via `forget_memory` is intentionally deferred to Phase 3 (the tool itself is in Phase 3).
- Placeholder scan — ✅ All file paths concrete. `PROFILE_ROOT` in Task 4 is called out as "existing root" — the engineer reads the actual current file to find the exact constant name.
- Type consistency — ✅ `TieredProfile`, `getProfile(ownerId, caller)`, `saveProfile(ownerId, content, tier)` uniform across tasks.
