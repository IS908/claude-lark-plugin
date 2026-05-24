/**
 * L1 hardcoded privacy rules — universal patterns applied at distillation
 * time regardless of source or explicit user override.
 *
 * Classification priority (higher wins):
 *   L1 (this file) > L2 (user's privacy-rules.md) > L3 (LLM judgment)
 *
 * L1 blacklist always wins — even if a fact appears in a public group,
 * matching content (email, phone, token, etc.) is forced into the private tier.
 * Rationale: the danger of these fields is bot-initiated re-broadcast, not
 * the one-time disclosure.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * Regex patterns that force a fact into `private`.
 *
 * NOTE on email — positioning: this plugin targets **work-chat use cases**
 * (Feishu is a corporate IM; work emails are routinely shared via signatures
 * and company directories). Under that model, email is **not sensitive by
 * default** and is intentionally NOT in the L1 blacklist — it falls through
 * to L2/L3 classification with a source-based default (group → public,
 * p2p → private).
 *
 * If your deployment is primarily personal (gmail, etc.) or you otherwise
 * want stricter handling, add a rule to your L2 privacy-rules.md under
 * "## Always private" — e.g. "contains an email address" — and the
 * distiller will respect it.
 */
export const L1_BLACKLIST_REGEX: { name: string; regex: RegExp }[] = [
  // Phone: CN mobile + US phone. Both allow optional separators
  // (`-`, `.`, space) at the standard grouping boundaries so that
  // human-written forms like `138 1234 5678` or `138-1234-5678` are
  // caught. Pre-v1.0.27 (#76) cn-mobile required 11 consecutive
  // digits and missed every separator-containing variant.
  { name: 'cn-mobile', regex: /\b1[3-9]\d[-.\s]?\d{4}[-.\s]?\d{4}\b/ },
  { name: 'us-phone', regex: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  // CN national ID: 18 digits/X. Allow separators at the standard
  // 6-8-3+1 grouping (region-yyyymmdd-seq+check) since humans
  // commonly read them out grouped. Pre-v1.0.27 required 18
  // consecutive chars.
  { name: 'cn-id', regex: /\b\d{6}[-.\s]?\d{8}[-.\s]?\d{3}[\dXx]\b/ },
  { name: 'credit-card', regex: /\b(?:\d[ -]*?){13,16}\b/ },

  // ── Service-specific API tokens (#76 fix) ──
  //
  // Pre-v1.0.27 only the generic `token-like` regex existed, which
  // required `sk|pk|api|token|secret` LITERAL prefix followed by a
  // single `-`/`_` and then 16+ alphanumeric chars with NO further
  // `-`/`_`. That signature caught nothing in practice — every
  // real-world API token has structural separators in its body
  // (e.g. `sk-ant-api03-...`, `sk_live_...`). Each major provider
  // gets a dedicated regex matching its documented format.
  { name: 'github-token', regex: /\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: 'aws-access-key', regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'slack-token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'stripe-key', regex: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{20,}\b/ },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // Generic token-like fallback: now allows `[-_]` in the body so
  // hybrid forms not matching the specific patterns above (custom
  // internal tokens, vendor-specific schemes) still trigger.
  { name: 'token-like', regex: /\b(?:sk|pk|api|token|secret)[-_][A-Za-z0-9_-]{16,}\b/i },

  { name: 'money-amount', regex: /\b\d+\s*[wk万千]\s*(?:元|块|RMB|CNY|USD)?\b|\$\d{3,}/ },
];

/** Keywords that force a fact into `private` when present (case-insensitive substring match). */
export const L1_BLACKLIST_KEYWORDS: string[] = [
  // 财务
  '薪资', '工资', 'KPI', '绩效', '奖金', 'bonus',
  // 职业异动
  '跳槽', '离职', '面试', 'offer',
  // 健康/情绪
  '病', '医院', '焦虑', '抑郁', '情绪', '吐槽',
  // 家庭
  '家庭矛盾', '婚姻', '离婚',
  // 凭据
  '密码', 'password',
];

/** Keywords that allow a fact into `public` (whitelist — otherwise defaults via L2/L3). */
export const L1_WHITELIST_KEYWORDS: string[] = [
  // 职位
  '工程师', '产品经理', 'PM', 'TL', 'CEO', 'CTO', '架构师',
  // 组织
  '团队', '部门', '公司',
  // 技术栈
  'TypeScript', 'JavaScript', 'Rust', 'Go', 'Python', 'Java', 'C++',
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

// ─── L2 user rules file ─────────────────────────────────────

const DEFAULT_L2_PATH = join(homedir(), '.claude', 'channels', 'lark', 'privacy-rules.md');

function resolveL2Path(overridePath?: string): string {
  return overridePath || process.env.LARK_PRIVACY_RULES_FILE || DEFAULT_L2_PATH;
}

/**
 * Load the L2 user rules file as raw markdown. Returns empty string if not
 * present. The distiller injects this as-is into the classification prompt;
 * we intentionally do not parse it into structured rules (LLM handles nuance).
 */
export async function loadL2Rules(overridePath?: string): Promise<string> {
  const path = resolveL2Path(overridePath);
  if (!existsSync(path)) return '';
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Extract the bullet items under `## Always private` from L2 markdown as
 * plain phrases. Used by legacy-profile migration to do a deterministic
 * substring check — the LLM is not available in that synchronous path.
 *
 * Only phrases under `## Always private` are returned; `## Always public`
 * (if any) is ignored because migration defaults gray content to public
 * anyway.
 *
 * Matching semantics at the call site are **case-insensitive substring**.
 * This works well for concrete nouns / identifiers (company names, project
 * codenames, people mentions) but does NOT interpret abstract descriptions
 * like "涉及人际冲突的内容" the way an LLM would. That's a deliberate
 * trade-off — deterministic and fast, at the cost of expressivity. Abstract
 * L2 rules still apply at L3 distillation time as before.
 *
 * Warning: very short phrases (e.g. "a", "的") will substring-match almost
 * everything and effectively turn the whole profile private. This extractor
 * does NOT reject them — operators author L2 deliberately, and migration
 * over-protection is safer than under-protection. Prefer concrete multi-char
 * phrases.
 */
export function extractL2PrivatePhrases(markdown: string): string[] {
  if (!markdown) return [];
  const phrases: string[] = [];
  let inSection = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (/^##\s+always\s+private\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) {
      // Entered a different section — stop collecting
      inSection = false;
      continue;
    }
    if (inSection && line.startsWith('- ')) {
      const phrase = line.slice(2).trim();
      if (phrase) phrases.push(phrase);
    }
  }
  return phrases;
}

/**
 * Validate that a candidate L2 rule is concrete enough not to poison
 * the substring matcher (#90). Returns `{ ok: true }` for acceptable
 * rules, `{ ok: false, reason }` for rules that would over-match.
 *
 * Two checks:
 * - `too-short`: trim length must be >= 6 characters.
 * - `no-substantive-word`: must contain at least one Unicode run of
 *   4+ Letter/Number code-points. Catches all-punctuation/whitespace
 *   inputs that clear the length floor (e.g. `"!?!?!?"`, `"a a a a"`).
 *
 * Examples:
 *
 *   REJECTED (too-short, len < 6):
 *     "the" (3) · "了" (1) · "工程师" (3)
 *     "我的生日" (4) · "家庭住址" (4) · "生日礼物" (4)
 *
 *   REJECTED (no-substantive-word, len >= 6 but no 4+ run):
 *     "!@#$%^&*" · "a a a a" · "x x x x x x x"
 *
 *   ACCEPTED:
 *     "salary" (6, single 6-run) · "salary information" (18, multi-run)
 *     "涉及人际冲突的表述" (8 CJK) · "medical history" (15)
 *     "kevin@acme.io" (13, runs `kevin`/`acme`/`io`)
 *
 * The 6-char floor is a deliberate trade-off: it rejects some
 * legitimate short CJK compounds (`家庭住址` would be private) in
 * exchange for catching the catastrophic short-common-word case
 * (`工程师` would match every engineering-related line forever).
 * Operators who want a short rule can edit `privacy-rules.md`
 * directly — this gate is only on the programmatic write boundary.
 *
 * Exported for testing.
 */
export type L2RuleValidationResult =
  | { ok: true }
  | { ok: false; reason: 'too-short' | 'no-substantive-word' };

export function validateL2Rule(text: string): L2RuleValidationResult {
  const t = text.trim();
  if (t.length < 6) return { ok: false, reason: 'too-short' };
  if (!/[\p{Letter}\p{Number}]{4,}/u.test(t)) {
    return { ok: false, reason: 'no-substantive-word' };
  }
  return { ok: true };
}

/**
 * Add a rule line to the L2 file under the given section. Creates the file
 * if missing; creates the section header if missing. New rules are inserted
 * at the TOP of their section (newest-first, changelog-style) so users who
 * open the file see their recent additions immediately.
 *
 * v1.0.26 (#90): now validates `rule` against {@link validateL2Rule}
 * before writing. Rejected rules return `{ added: false, reason }`;
 * the file is not modified. This defends against `forget_memory(
 * promote_to_rule=true)` self-learning over-broadening — pre-v1.0.26,
 * a single `forget_memory` on a 3-char common word like "工程师"
 * would write that as a private rule, causing the substring matcher
 * in `extractL2PrivatePhrases` to mark every line containing those
 * three characters as private during distillation and legacy-profile
 * migration. Manual operator edits to `privacy-rules.md` can still
 * add ANY rule (this gate is at the programmatic write boundary
 * only) — operators authoring rules deliberately remain in control.
 */
export type AddL2RuleResult =
  | { added: true }
  | { added: false; reason: 'too-short' | 'no-substantive-word' };

export async function addL2Rule(
  rule: string,
  section: 'Always private' | 'Always public',
  overridePath?: string,
): Promise<AddL2RuleResult> {
  const validity = validateL2Rule(rule);
  if (!validity.ok) {
    return { added: false, reason: validity.reason };
  }
  const path = resolveL2Path(overridePath);
  await mkdir(dirname(path), { recursive: true });
  const existing = existsSync(path) ? await readFile(path, 'utf8') : '';
  const header = `## ${section}`;

  let next = existing;
  if (!next.includes(header)) {
    // Append new section at the end
    next += (next && !next.endsWith('\n') ? '\n' : '') + (next ? '\n' : '') + `${header}\n`;
  }

  // Insert rule line directly after the section header
  const sectionIdx = next.indexOf(header);
  const newlineAfterHeader = next.indexOf('\n', sectionIdx);
  const insertAt = newlineAfterHeader + 1;
  next = `${next.slice(0, insertAt)}- ${rule}\n${next.slice(insertAt)}`;

  await writeFile(path, next, 'utf8');
  return { added: true };
}
