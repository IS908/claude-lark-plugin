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
{
  const lines = await store.listProfileLines('ou_a', 'public');
  const target = lines[1]; // "- second"
  const ok = await store.removeProfileLine('ou_a', 'public', target.hash);
  if (!ok) fail('3: remove should succeed');

  const after = await store.listProfileLines('ou_a', 'public');
  if (after.length !== 2) fail(`3: expected 2 lines after remove, got ${after.length}`);
  if (after.some((l) => l.text === '- second')) fail('3: removed line must be gone');
  passed++;
}

// ── 4. removeProfileLine is idempotent ──
{
  const lines = await store.listProfileLines('ou_a', 'public');
  const removedHash = 'deadbeef'; // not present
  const ok = await store.removeProfileLine('ou_a', 'public', removedHash);
  if (ok) fail('4: removing a non-existent hash should return false');
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

  const okCross = await store.removeProfileLine('ou_b', 'public', privHash);
  if (okCross) fail('5: private-tier hash must not match against public tier');

  const pubAfter = await store.listProfileLines('ou_b', 'public');
  if (pubAfter.length !== pubLines.length) fail('5: cross-tier call must not mutate public');
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

rmSync(tmp, { recursive: true, force: true });
console.log(`transparency smoke: ${passed}/9 PASS`);
