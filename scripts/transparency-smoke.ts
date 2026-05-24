/**
 * Transparency smoke test — runs as part of `npm test`.
 * Covers MemoryStore.listProfileLines / removeProfileLine and the L2
 * rule-append path that forget_memory's promote_to_rule feature drives.
 * Also exercises the audit log writer.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// Route L2 rules file + audit log to a tmpdir before importing modules that
// capture paths from env at import time.
const tmp = mkdtempSync(join(tmpdir(), 'transparency-'));
process.env.LARK_PRIVACY_RULES_FILE = join(tmp, 'privacy-rules.md');
process.env.LARK_AUDIT_LOG = join(tmp, 'audit.log');

const { MemoryStore } = await import('../src/memory/file.js');
const { loadL2Rules, addL2Rule } = await import('../src/privacy-rules.js');
const { audit } = await import('../src/audit-log.js');

const root = join(tmp, 'mem');
const store = new MemoryStore(root);

let passed = 0;

// ── 1. listProfileLines returns [] for unknown user ──
{
  const lines = await store.listProfileLines('ou_ghost', 'public');
  if (lines.length !== 0) fail('1: unknown user should have no lines');
  passed++;
}

// ── 2. list + hash stability ──
{
  await store.saveProfile('ou_a', '- first\n- second\n- third', 'public');
  const lines = await store.listProfileLines('ou_a', 'public');
  if (lines.length !== 3) fail(`2: expected 3 lines, got ${lines.length}`);
  if (lines.some((l) => l.hash.length !== 8)) fail('2: hash must be 8 chars');
  if (new Set(lines.map((l) => l.hash)).size !== 3) fail('2: hashes should be unique for different lines');

  // Hash is deterministic: call again, same hashes
  const again = await store.listProfileLines('ou_a', 'public');
  if (again[0].hash !== lines[0].hash) fail('2: hash must be stable across calls');
  passed++;
}

// ── 3. removeProfileLine by hash ──
//   v1.0.19 (#88): return shape changed from boolean to
//   { removed: number, sample: string|null, allTexts: string[] } so the
//   tool reply can name the count when a hash collides across multiple
//   lines. Single-match path returns { removed: 1, ... }.
{
  const lines = await store.listProfileLines('ou_a', 'public');
  const target = lines[1]; // "- second"
  const result = await store.removeProfileLine('ou_a', 'public', target.hash);
  if (result.removed !== 1) fail(`3: remove should report 1, got ${result.removed}`);
  if (result.sample !== target.text) fail(`3: sample mismatch: ${result.sample}`);

  const after = await store.listProfileLines('ou_a', 'public');
  if (after.length !== 2) fail(`3: expected 2 lines after remove, got ${after.length}`);
  if (after.some((l) => l.text === '- second')) fail('3: removed line must be gone');
  passed++;
}

// ── 4. removeProfileLine is idempotent ──
{
  const lines = await store.listProfileLines('ou_a', 'public');
  const removedHash = 'deadbeef'; // not present
  const result = await store.removeProfileLine('ou_a', 'public', removedHash);
  if (result.removed !== 0) fail(`4: non-existent hash should report removed=0, got ${result.removed}`);
  if (result.sample !== null) fail(`4: non-existent hash should have null sample, got ${result.sample}`);
  const after = await store.listProfileLines('ou_a', 'public');
  if (after.length !== lines.length) fail('4: removing a non-existent hash should not mutate');
  passed++;
}

// ── 5. removeProfileLine doesn't cross tiers ──
{
  await store.saveProfile('ou_b', '- public-only', 'public');
  await store.saveProfile('ou_b', '- private-secret', 'private');
  const pubLines = await store.listProfileLines('ou_b', 'public');
  const privHash = (await store.listProfileLines('ou_b', 'private'))[0].hash;

  const cross = await store.removeProfileLine('ou_b', 'public', privHash);
  if (cross.removed !== 0) fail(`5: private-tier hash must not match against public tier, got removed=${cross.removed}`);

  const pubAfter = await store.listProfileLines('ou_b', 'public');
  if (pubAfter.length !== pubLines.length) fail('5: cross-tier call must not mutate public');
  passed++;
}

// ── 5a-tool. formatForgetMemoryReply singular vs plural (#88 R1) ──
//   Pure-function test of the reply-text branch logic the tool handler
//   uses. Pre-extraction, the singular/plural split was inline in the
//   handler and untested at unit level; a future regression flipping
//   the branches would not have been caught by the storage-layer tests.
{
  const { formatForgetMemoryReply } = await import('../src/tools.js');

  // Singular path: removed=1, no tail.
  const singular = formatForgetMemoryReply(
    { removed: 1, sample: 'likes Python', allTexts: ['likes Python'] },
    'abc12345',
    'public',
    '',
  );
  if (!singular.startsWith('Removed "likes Python" from public profile.')) {
    fail(`tool-fmt singular: got ${JSON.stringify(singular)}`);
  }
  if (singular.includes('lines sharing hash')) {
    fail(`tool-fmt singular leaked plural wording: ${singular}`);
  }

  // Plural path: removed=3, all texts listed numbered, recovery hint
  // names the tier and append mode.
  const plural = formatForgetMemoryReply(
    {
      removed: 3,
      sample: 'prefers tea',
      allTexts: ['prefers tea', 'prefers tea', 'prefers tea'],
    },
    'deadbeef',
    'private',
    '',
  );
  if (!plural.includes('Removed 3 lines sharing hash "deadbeef" from private profile:')) {
    fail(`tool-fmt plural header missing: ${plural}`);
  }
  if (!plural.includes('  1) "prefers tea"') || !plural.includes('  3) "prefers tea"')) {
    fail(`tool-fmt plural numbered list missing: ${plural}`);
  }
  if (!plural.includes('save_memory(type="profile", tier="private", mode="append"')) {
    fail(`tool-fmt plural recovery hint wrong tier/mode: ${plural}`);
  }

  // Tail append: singular + promote_to_rule tail.
  const singularTail = formatForgetMemoryReply(
    { removed: 1, sample: 'foo', allTexts: ['foo'] },
    'h',
    'private',
    ' Also appended to privacy-rules.md.',
  );
  if (!singularTail.endsWith(' Also appended to privacy-rules.md.')) {
    fail(`tool-fmt singular tail not preserved: ${singularTail}`);
  }
  passed++;
}

// ── 5b. removeProfileLine reports count when multiple lines share a hash (#88) ──
//   Two lines with normalized-identical text ("prefers tea" with and
//   without leading bullet, after listProfileLines strips bullets)
//   compute to the same 8-char hash. forget_memory pre-v1.0.19 returned
//   `Removed "<text>"` — singular — hiding the multi-delete entirely.
//   v1.0.19 returns count + sample so the tool can warn the user.
{
  // Construct file with two normalized-equal lines. Using replace mode
  // bypasses mergeProfileLines' dedup, so both lines persist on disk.
  await store.saveProfile('ou_dup', '- prefers tea\nprefers tea\n', 'private', 'replace');
  const lines = await store.listProfileLines('ou_dup', 'private');
  if (lines.length !== 2) fail(`5b: expected 2 lines pre-delete, got ${lines.length}`);
  // Both lines must hash-equal.
  if (lines[0].hash !== lines[1].hash) fail('5b: setup failed — duplicate lines should hash-equal');
  const result = await store.removeProfileLine('ou_dup', 'private', lines[0].hash);
  if (result.removed !== 2) fail(`5b: expected removed=2, got ${result.removed}`);
  if (result.sample !== 'prefers tea') fail(`5b: sample wrong: ${result.sample}`);
  if (result.allTexts.length !== 2) fail(`5b: allTexts should have 2 entries, got ${result.allTexts.length}`);
  // File should be empty (both lines removed).
  const after = await store.listProfileLines('ou_dup', 'private');
  if (after.length !== 0) fail(`5b: file should be empty after multi-delete, got ${after.length}`);
  passed++;
}

// ── 6. L2 rule append round-trip (what forget_memory(promote_to_rule=true) drives) ──
{
  await addL2Rule('涉及人际冲突的表述', 'Always private');
  const rules = await loadL2Rules();
  if (!rules.includes('## Always private')) fail('6: section header missing');
  if (!rules.includes('- 涉及人际冲突的表述')) fail('6: rule missing');
  passed++;
}

// ── 7. audit log writes a line per call ──
{
  await audit('test_tool', 'ou_x', { chat_id: 'oc_1' }, 'ok');
  await audit('test_tool', null, { chat_id: 'oc_1' }, 'denied');
  // Log is flushed synchronously by appendFile within this scope
  if (!existsSync(process.env.LARK_AUDIT_LOG!)) fail('7: audit log not created');
  const log = readFileSync(process.env.LARK_AUDIT_LOG!, 'utf8');
  const lines = log.trim().split('\n');
  if (lines.length !== 2) fail(`7: expected 2 log lines, got ${lines.length}`);
  if (!lines[0].includes('ok') || !lines[0].includes('ou_x')) fail('7: ok line content wrong');
  if (!lines[1].includes('denied') || !lines[1].includes('caller=-')) fail('7: denied line content wrong');
  passed++;
}

// ── 8. audit log redacts long strings ──
{
  const longPrompt = 'x'.repeat(500);
  await audit('t', 'ou_x', { prompt: longPrompt }, 'ok');
  const log = readFileSync(process.env.LARK_AUDIT_LOG!, 'utf8');
  if (log.includes('x'.repeat(500))) fail('8: long string not redacted');
  if (!log.includes('500 chars')) fail('8: truncation marker missing');
  passed++;
}

// ── 9. audit log handles unserializable args (BigInt / circular) ──
{
  // BigInt cannot be serialized by JSON.stringify — guard must fall back.
  const before = readFileSync(process.env.LARK_AUDIT_LOG!, 'utf8').length;
  await audit('t', 'ou_x', { weird: 123n as unknown as string }, 'ok');
  const after = readFileSync(process.env.LARK_AUDIT_LOG!, 'utf8');
  if (after.length <= before) fail('9: audit line not written for unserializable arg');
  if (!after.includes('<unserializable>')) fail('9: missing unserializable fallback marker');

  // Circular reference — JSON.stringify also throws here.
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  await audit('t', 'ou_x', circular, 'ok');
  const final = readFileSync(process.env.LARK_AUDIT_LOG!, 'utf8');
  // Log grew by at least one more line
  const lineCount = final.trim().split('\n').length;
  if (lineCount < 5) fail(`9: expected at least 5 log lines, got ${lineCount}`);
  passed++;
}

// ── 12. addL2Rule validation gate (#90, v1.0.26) ──
//   Pre-fix, addL2Rule wrote any text to privacy-rules.md. A 3-char
//   common word like "工程师" or "the" would then poison the substring
//   matcher in extractL2PrivatePhrases for years — every distillation
//   line containing those chars would be marked private.
//   Post-fix, addL2Rule validates: trim length >= 6 AND has a 4+-
//   letter/digit run. Rejected rules return {added: false, reason}.
{
  const { validateL2Rule } = await import('../src/privacy-rules.js');

  // Valid: >=6 chars, has substantive run
  const goodCases: string[] = [
    'salary at acme',           // 14, plenty of run
    '涉及人际冲突的表述',          // 8 chars all CJK
    'medical history',          // 15
    'work email kevin@acme.io', // 24, mixed
  ];
  for (const text of goodCases) {
    const r = validateL2Rule(text);
    if (!r.ok) fail(`12-good: "${text}" should validate, got reason ${(r as any).reason}`);
  }

  // Invalid: too short OR no substantive word
  const badCases: Array<[string, 'too-short' | 'no-substantive-word']> = [
    ['工程师', 'too-short'],            // 3 chars CJK
    ['the', 'too-short'],               // 3 chars English
    ['了', 'too-short'],                // 1 char particle
    ['家庭住址', 'too-short'],          // 4 chars CJK compound
    ['!@#$%^&*', 'no-substantive-word'], // 8 chars, no letters/digits
    ['a a a a', 'no-substantive-word'],  // 7 chars but no run >=4
    ['x x x x x x x', 'no-substantive-word'], // 13 chars, all 1-letter runs
  ];
  for (const [text, expectedReason] of badCases) {
    const r = validateL2Rule(text);
    if (r.ok) fail(`12-bad: "${text}" should be rejected`);
    if (r.reason !== expectedReason) {
      fail(`12-bad: "${text}" expected reason=${expectedReason}, got ${r.reason}`);
    }
  }

  // End-to-end: addL2Rule honors the validation (write side-effect
  // does not happen for bad input).
  const { addL2Rule, loadL2Rules } = await import('../src/privacy-rules.js');
  const before = await loadL2Rules();
  const badResult = await addL2Rule('工程师', 'Always private');
  if (badResult.added) fail('12-e2e: addL2Rule must reject 工程师');
  if (badResult.reason !== 'too-short') fail(`12-e2e: reason mismatch: ${badResult.reason}`);
  const after = await loadL2Rules();
  if (after !== before) fail(`12-e2e: file was modified despite rejection`);

  // Good case still works.
  const goodResult = await addL2Rule('salary information', 'Always private');
  if (!goodResult.added) fail('12-e2e: good rule must be added');
  const afterGood = await loadL2Rules();
  if (!afterGood.includes('- salary information')) fail(`12-e2e: rule not written: ${afterGood}`);
  passed++;
}

rmSync(tmp, { recursive: true, force: true });
console.log(`transparency smoke: ${passed}/12 PASS`);
