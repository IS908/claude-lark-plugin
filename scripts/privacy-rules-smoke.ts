/**
 * Privacy rules smoke test — runs as part of `npm test`.
 * Exits non-zero if any assertion fails.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyL1, loadL2Rules, addL2Rule } from '../src/privacy-rules.js';

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

console.log(`privacy-rules smoke: L1 ${l1Passed}/${l1Cases.length}, L2 ${l2Passed}/5 — PASS`);
