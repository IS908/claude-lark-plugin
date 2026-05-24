/**
 * Privacy rules smoke test — runs as part of `npm test`.
 * Exits non-zero if any assertion fails.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyL1, loadL2Rules, addL2Rule, extractL2PrivatePhrases } from '../src/privacy-rules.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// ── L1 classifier ──

const l1Cases: [string, 'private' | 'public' | 'gray'][] = [
  // NOTE: email intentionally NOT in L1 blacklist (work emails are commonly
  // shared publicly); falls through to gray.
  ['我的邮箱是 kk@bytedance.com', 'gray'],
  ['手机号 13800138000', 'private'],
  ['薪资大概 3w', 'private'],
  ['最近在准备跳槽', 'private'],
  ['密码是 abc123!@#', 'private'],
  ['token: sk-abcdef1234567890abcdef', 'private'],
  ['我是 TikTok Live 团队的工程师', 'public'],
  ['熟悉 TypeScript 和 Rust', 'public'],
  ['晚上想吃烤鱼', 'gray'],
  ['偏好会议安排在下午', 'gray'],

  // ── #76 fix: separator-tolerant phone/ID ──
  // Pre-fix, cn-mobile required 11 consecutive digits — these all missed.
  ['mobile: 138 1234 5678', 'private'],
  ['手机: 138-1234-5678', 'private'],
  ['contact 138.1234.5678', 'private'],
  // Pre-fix cn-id required 18 consecutive — grouped form missed.
  ['ID: 110101 19900101 1234', 'private'],
  ['身份证 110101-19900101-1234', 'private'],

  // ── #76 fix: service-specific tokens (real formats) ──
  ['Anthropic key: sk-ant-api03-abc123def456ghi789jkl012mno345pqr', 'private'],
  ['github token ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'private'],
  ['aws AKIAIOSFODNN7EXAMPLE', 'private'],
  ['aws temporary ASIAIOSFODNN7EXAMPLE', 'private'],
  ['slack: xoxb-1234567890-abcdefghijklm', 'private'],
  ['slack bot xoxp-1234567890-abcdefghijklm', 'private'],
  ['stripe live sk_live_abcdefghijklmnopqrstuvwxyz123456', 'private'],
  ['stripe restricted rk_test_abcdefghijklmnopqrstuvwxyz12', 'private'],
  ['jwt eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF7zjA', 'private'],

  // ── #76 negative tests (lookalikes that should NOT trigger) ──
  // Conservative — these LOOK token-y but don't match real formats.
  // Catches a future regression where someone weakens a regex.
  ['the variable AKI was set', 'gray'],        // short AKI prefix, not 16+ uppercase suffix
  ['ghp_short', 'gray'],                       // ghp_ prefix but body too short
  ['just talking about JWTs in general', 'gray'], // word "JWT" alone, no payload
  ['code 12345', 'gray'],                      // 5 digits, no phone/id pattern

  // ── R1-audit followup on #76 — hyphenated-English false-positive
  // guards. Pre-tighten `token-like` would have flagged these as
  // private (over-broad body); pre-tighten `anthropic-key` would
  // have flagged sk-ant-<English> as private. After tightening
  // (digit-or-underscore required in token-like body; sk-ant-
  // requires role+digits prefix), these stay gray.
  // Note on input choice: avoid words containing "go" (e.g. algorithm,
  // category, golang) because the pre-existing L1 whitelist keyword
  // `Go` (the language) substring-matches them as `public`, masking
  // the actual `token-like` decision we want to assert. Worth a
  // separate cleanup PR — the whitelist substring matcher is too
  // greedy on the short keyword `Go`. Filed for triage.
  ['See the api-documentation-string for details', 'gray'],
  ['the token-bucket-rate-limit-pattern', 'gray'],
  ['read the secret-management-best-practices', 'gray'],
  ['sk-ant-cipated-future-events-here', 'gray'],          // English -ipated suffix
  ['sk-ant-arctic-temperature-anomaly', 'gray'],          // English geography phrase
];

let l1Passed = 0;
for (const [fact, expected] of l1Cases) {
  const got = applyL1(fact);
  if (got !== expected) fail(`L1: "${fact}" expected ${expected} got ${got}`);
  l1Passed++;
}

// ── L2 file I/O ──

const tmp = mkdtempSync(join(tmpdir(), 'privacy-rules-'));
const tmpFile = join(tmp, 'rules.md');

let l2Passed = 0;

// L2.1 — empty load returns ''
if ((await loadL2Rules(tmpFile)) !== '') fail('L2.1: empty load should return ""');
l2Passed++;

// L2.2 — append creates file + adds section header + rule
await addL2Rule('涉及人际冲突的表述', 'Always private', tmpFile);
const a = await loadL2Rules(tmpFile);
if (!a.includes('## Always private')) fail('L2.2: header missing');
if (!a.includes('- 涉及人际冲突的表述')) fail('L2.2: rule missing');
l2Passed++;

// L2.3 — second append under same section reuses header (only 1 occurrence)
await addL2Rule('客户名 ACME Corp', 'Always private', tmpFile);
const b = await loadL2Rules(tmpFile);
if ((b.match(/## Always private/g) || []).length !== 1) fail('L2.3: section duplicated');
if (!b.includes('- 客户名 ACME Corp')) fail('L2.3: second rule missing');
l2Passed++;

// L2.4 — new section created when different header used
await addL2Rule('GitHub handle @kk', 'Always public', tmpFile);
const c = await loadL2Rules(tmpFile);
if (!c.includes('## Always public')) fail('L2.4: new section not created');
if ((c.match(/## Always/g) || []).length !== 2) fail('L2.4: expected 2 "## Always" sections');
l2Passed++;

// L2.5 — LARK_PRIVACY_RULES_FILE env override
process.env.LARK_PRIVACY_RULES_FILE = tmpFile;
const d = await loadL2Rules(); // no arg, should use env
if (d !== c) fail('L2.5: env override not honored');
delete process.env.LARK_PRIVACY_RULES_FILE;
l2Passed++;

rmSync(tmp, { recursive: true, force: true });

// ── extractL2PrivatePhrases ──

let extractPassed = 0;

// E.1 — empty / null input
if (extractL2PrivatePhrases('').length !== 0) fail('extract.1 empty');
extractPassed++;

// E.2 — only Always-private section
const p2 = extractL2PrivatePhrases(`## Always private
- 项目代号 Phoenix
- 客户 ACME Corp
`);
if (p2.length !== 2) fail(`extract.2 count: got ${p2.length}`);
if (p2[0] !== '项目代号 Phoenix') fail(`extract.2 item 0: ${p2[0]}`);
extractPassed++;

// E.3 — ignores Always-public section
const p3 = extractL2PrivatePhrases(`## Always private
- secret 1

## Always public
- public 1
`);
if (p3.length !== 1 || p3[0] !== 'secret 1') fail(`extract.3: ${JSON.stringify(p3)}`);
extractPassed++;

// E.4 — handles mixed-order sections
const p4 = extractL2PrivatePhrases(`## Always public
- visible

## Always private
- hidden
`);
if (p4.length !== 1 || p4[0] !== 'hidden') fail(`extract.4: ${JSON.stringify(p4)}`);
extractPassed++;

// E.5 — tolerates blank lines and comments between bullets
const p5 = extractL2PrivatePhrases(`## Always private
- first

- second
some non-bullet prose that should be ignored
- third
`);
if (p5.length !== 3) fail(`extract.5 count: got ${p5.length}`);
extractPassed++;

// E.6 — no Always-private section returns []
if (extractL2PrivatePhrases('## Always public\n- x\n').length !== 0) fail('extract.6');
extractPassed++;

console.log(`privacy-rules smoke: L1 ${l1Passed}/${l1Cases.length}, L2 ${l2Passed}/5, extract ${extractPassed}/6 — PASS`);
