/**
 * Profile tiering smoke test — runs as part of `npm test`.
 * Exits non-zero if any assertion fails.
 *
 * Covers:
 *  - tiered read (owner sees both tiers; non-owner sees only public)
 *  - tiered write
 *  - lazy migration from legacy single-file profile with L1-filter split
 *  - migration idempotency / partial-failure recovery
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/file.js';
import { parseTieredProfile } from '../src/memory/distiller.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'profile-tier-'));
const store = new MemoryStore(root);

let passed = 0;

// ── 1. save + read own (both tiers) ──────────────────────────
await store.saveProfile('ou_alice', '- is an engineer', 'public');
await store.saveProfile('ou_alice', '- prefers afternoon meetings', 'private');
const ownSelf = await store.getProfile('ou_alice', 'ou_alice');
if (!ownSelf?.includes('engineer')) fail('1: owner should see public');
if (!ownSelf?.includes('afternoon')) fail('1: owner should see private');
passed++;

// ── 2. non-owner sees only public ───────────────────────────
const byOther = await store.getProfile('ou_alice', 'ou_bob');
if (!byOther?.includes('engineer')) fail('2: non-owner should see public');
if (byOther?.includes('afternoon')) fail('2: non-owner must NOT see private');
passed++;

// ── 3. getProfile on unknown user returns null ──────────────
const missing = await store.getProfile('ou_ghost', 'ou_bob');
if (missing !== null) fail(`3: unknown user should return null, got ${JSON.stringify(missing)}`);
passed++;

// ── 3b. non-owner view of private-only user is null, not leaked ──
{
  const r = mkdtempSync(join(tmpdir(), 'profile-private-only-'));
  const s = new MemoryStore(r);
  await s.saveProfile('ou_priv', 'top-secret content', 'private', 'replace');
  // Owner sees it
  const own = await s.getProfile('ou_priv', 'ou_priv');
  if (own !== 'top-secret content') fail(`3b: owner should see private, got ${JSON.stringify(own)}`);
  // Non-owner must NOT see it (no leak via empty-public-but-private-exists)
  const other = await s.getProfile('ou_priv', 'ou_peek');
  if (other !== null) fail(`3b: non-owner must see null for private-only user, got ${JSON.stringify(other)}`);
  rmSync(r, { recursive: true, force: true });
  passed++;
}

// ── 4. migration: legacy single-file profile is split by L1 ──
const legacyRoot = mkdtempSync(join(tmpdir(), 'profile-legacy-'));
const legacyStore = new MemoryStore(legacyRoot);
mkdirSync(join(legacyRoot, 'profiles'), { recursive: true });
const legacyContent = [
  '- TikTok Live 团队的工程师', // whitelist → public
  '- 熟悉 TypeScript 和 Rust',   // whitelist → public
  '- 偏好会议安排在下午',         // gray → public
  '- 最近在筹备跳槽',             // keyword "跳槽" → private
  '- 手机号 13800138000',          // regex cn-mobile → private
].join('\n');
writeFileSync(join(legacyRoot, 'profiles', 'ou_migrate.md'), legacyContent, 'utf-8');

// First read triggers migration
const afterMigrate = await legacyStore.getProfile('ou_migrate', 'ou_migrate');
if (!afterMigrate?.includes('工程师')) fail('4: migrated public content missing');
if (!afterMigrate?.includes('跳槽')) fail('4: migrated private content missing (owner should see it)');

// ── 5. non-owner view after migration does NOT see private ──
const afterMigrateByOther = await legacyStore.getProfile('ou_migrate', 'ou_bob');
if (!afterMigrateByOther?.includes('工程师')) fail('5: public survives for non-owner');
if (afterMigrateByOther?.includes('跳槽')) fail('5: non-owner must NOT see migrated private (跳槽)');
if (afterMigrateByOther?.includes('13800138000')) fail('5: non-owner must NOT see migrated private (mobile)');
passed++;
passed++;

// ── 6. migration is idempotent — legacy file removed after first migration ──
if (existsSync(join(legacyRoot, 'profiles', 'ou_migrate.md'))) {
  fail('6: legacy file should be deleted after migration');
}
if (!existsSync(join(legacyRoot, 'profiles', 'ou_migrate', 'public.md'))) {
  fail('6: public.md should exist after migration');
}
if (!existsSync(join(legacyRoot, 'profiles', 'ou_migrate', 'private.md'))) {
  fail('6: private.md should exist after migration');
}
passed++;

// ── 7. second getProfile call is a no-op (doesn't re-migrate) ──
// Mutate public.md to a recognizable sentinel; re-reading should see the sentinel
// (would be overwritten if migration ran again)
const publicPath = join(legacyRoot, 'profiles', 'ou_migrate', 'public.md');
writeFileSync(publicPath, '- SENTINEL', 'utf-8');
const reread = await legacyStore.getProfile('ou_migrate', 'ou_migrate');
if (!reread?.includes('SENTINEL')) fail('7: migration should not re-run on subsequent reads');
passed++;

// ── 8. migration partial-failure recovery: legacy + new dir both exist ──
// Simulate: legacy never cleaned up last time. New dir is authoritative.
const partialRoot = mkdtempSync(join(tmpdir(), 'profile-partial-'));
const partialStore = new MemoryStore(partialRoot);
mkdirSync(join(partialRoot, 'profiles', 'ou_partial'), { recursive: true });
writeFileSync(join(partialRoot, 'profiles', 'ou_partial', 'public.md'), '- already-migrated', 'utf-8');
writeFileSync(join(partialRoot, 'profiles', 'ou_partial.md'), '- legacy-stale', 'utf-8');
const recovered = await partialStore.getProfile('ou_partial', 'ou_partial');
if (!recovered?.includes('already-migrated')) fail('8: new layout should be authoritative');
if (recovered?.includes('legacy-stale')) fail('8: stale legacy content must not leak');
if (existsSync(join(partialRoot, 'profiles', 'ou_partial.md'))) {
  fail('8: stale legacy file should be cleaned up');
}
passed++;

// ── 8b. legacy migration respects L2 privacy-rules.md ──────
{
  const r = mkdtempSync(join(tmpdir(), 'profile-l2-migrate-'));
  // Point L2 path to a file inside this tmp root; write rules BEFORE reading profile.
  const l2Path = join(r, 'privacy-rules.md');
  writeFileSync(
    l2Path,
    '## Always private\n- Phoenix\n- ACME Corp\n',
    'utf-8',
  );
  process.env.LARK_PRIVACY_RULES_FILE = l2Path;

  // Legacy single-file profile that L1 alone wouldn't flag
  mkdirSync(join(r, 'profiles'), { recursive: true });
  writeFileSync(
    join(r, 'profiles', 'ou_org.md'),
    [
      '- 参与了项目 Phoenix 的评估', // L2 "Phoenix" → private
      '- 客户 ACME Corp 的年度回顾',  // L2 "ACME Corp" → private
      '- 熟悉 TypeScript 和 Rust',     // L1 whitelist → public
      '- 偏好会议安排在下午',            // gray → public
    ].join('\n'),
    'utf-8',
  );

  const s = new MemoryStore(r);
  const own = await s.getProfile('ou_org', 'ou_org');
  const byOther = await s.getProfile('ou_org', 'ou_other');

  // Owner sees everything merged
  if (!own?.includes('Phoenix')) fail('8b: owner should see Phoenix');
  if (!own?.includes('ACME Corp')) fail('8b: owner should see ACME Corp');
  if (!own?.includes('TypeScript')) fail('8b: owner should see TS');

  // Non-owner view: Phoenix + ACME must be hidden (they went to private via L2),
  // TypeScript + 偏好会议 should remain in public
  if (byOther?.includes('Phoenix')) fail('8b: L2 private phrase leaked to public (Phoenix)');
  if (byOther?.includes('ACME Corp')) fail('8b: L2 private phrase leaked to public (ACME)');
  if (!byOther?.includes('TypeScript')) fail('8b: TS should be in public');
  if (!byOther?.includes('偏好会议')) fail('8b: gray content should stay in public');

  delete process.env.LARK_PRIVACY_RULES_FILE;
  rmSync(r, { recursive: true, force: true });
  passed++;
}

// ── 9a. saveProfile on unmigrated legacy runs migration first ──
{
  const r = mkdtempSync(join(tmpdir(), 'profile-save-first-'));
  const s = new MemoryStore(r);
  mkdirSync(join(r, 'profiles'), { recursive: true });
  // Legacy profile has mixed content; user has never been read yet
  writeFileSync(
    join(r, 'profiles', 'ou_saveFirst.md'),
    '- legacy public\n- 薪资 3w private\n',
    'utf-8',
  );

  // saveProfile fires BEFORE any getProfile — must migrate first to avoid
  // losing legacy content
  await s.saveProfile('ou_saveFirst', '- newly saved public', 'public');

  // Legacy's "薪资 3w" must have ended up in private.md via L1 split
  const own = await s.getProfile('ou_saveFirst', 'ou_saveFirst');
  if (!own?.includes('薪资 3w')) fail('9a: legacy private content lost on save-before-read');
  if (!own?.includes('newly saved public')) fail('9a: new saved content missing');

  rmSync(r, { recursive: true, force: true });
  passed++;
}

// ── 9. saveProfile writes to correct tier file ──
const writeRoot = mkdtempSync(join(tmpdir(), 'profile-write-'));
const writeStore = new MemoryStore(writeRoot);
await writeStore.saveProfile('ou_w', 'public content', 'public', 'replace');
await writeStore.saveProfile('ou_w', 'private content', 'private', 'replace');
const pubFile = readFileSync(join(writeRoot, 'profiles', 'ou_w', 'public.md'), 'utf-8');
const privFile = readFileSync(join(writeRoot, 'profiles', 'ou_w', 'private.md'), 'utf-8');
if (pubFile !== 'public content') fail(`9: public.md content wrong: ${pubFile}`);
if (privFile !== 'private content') fail(`9: private.md content wrong: ${privFile}`);
passed++;

// ── 10. append mode: preserves existing, dedupes case-insensitive ──
{
  const r = mkdtempSync(join(tmpdir(), 'profile-append-'));
  const s = new MemoryStore(r);
  // Start with an existing tier
  await s.saveProfile('ou_app', '- Prefers tea', 'private', 'replace');
  // Single-fact save (default append) should add the new line, keep existing
  await s.saveProfile('ou_app', "Doesn't eat fish", 'private');
  const body1 = readFileSync(join(r, 'profiles', 'ou_app', 'private.md'), 'utf-8');
  if (!body1.includes('Prefers tea')) fail('10: append dropped existing line');
  if (!body1.includes("- Doesn't eat fish")) fail('10: append did not add new line (with auto-bullet)');
  // Exact-duplicate save should be a no-op
  const before = body1;
  await s.saveProfile('ou_app', "Doesn't eat fish", 'private');
  const body2 = readFileSync(join(r, 'profiles', 'ou_app', 'private.md'), 'utf-8');
  if (body2 !== before) fail('10: exact duplicate should not change file');
  // Case-insensitive dedupe
  await s.saveProfile('ou_app', '- prefers tea', 'private');
  const body3 = readFileSync(join(r, 'profiles', 'ou_app', 'private.md'), 'utf-8');
  if (body3 !== before) fail('10: case-insensitive dedupe failed');
  rmSync(r, { recursive: true, force: true });
  passed++;
}

// ── 11. append mode: multi-line, partial dedupe ────────────────
{
  const r = mkdtempSync(join(tmpdir(), 'profile-append-multi-'));
  const s = new MemoryStore(r);
  await s.saveProfile('ou_multi', '- existing one\n- existing two', 'private', 'replace');
  await s.saveProfile('ou_multi', '- existing one\n- new three\n- new four', 'private');
  const body = readFileSync(join(r, 'profiles', 'ou_multi', 'private.md'), 'utf-8');
  const lines = body.split('\n').filter(Boolean);
  if (lines.length !== 4) fail(`11: expected 4 lines, got ${lines.length}: ${JSON.stringify(lines)}`);
  if (!lines.includes('- new three')) fail('11: missing new three');
  if (!lines.includes('- new four')) fail('11: missing new four');
  rmSync(r, { recursive: true, force: true });
  passed++;
}

// ── 12. append mode: empty file gets first entry with auto-bullet ──
{
  const r = mkdtempSync(join(tmpdir(), 'profile-append-first-'));
  const s = new MemoryStore(r);
  await s.saveProfile('ou_first', 'bare fact no bullet', 'private');
  const body = readFileSync(join(r, 'profiles', 'ou_first', 'private.md'), 'utf-8');
  if (body !== '- bare fact no bullet\n') fail(`12: first-entry auto-bullet wrong: ${JSON.stringify(body)}`);
  rmSync(r, { recursive: true, force: true });
  passed++;
}

// ── parseTieredProfile: well-formed JSON ─────────────────────
{
  const { public: pub, private: priv } = parseTieredProfile(
    '{"public":["a","b"],"private":["c"]}'
  );
  if (pub.length !== 2 || priv.length !== 1) fail('parse.1: array counts wrong');
  if (pub[0] !== 'a' || priv[0] !== 'c') fail('parse.1: content wrong');
  passed++;
}

// ── parseTieredProfile: strips markdown code fence ───────────
{
  const wrapped = '```json\n{"public":["x"],"private":["y"]}\n```';
  const { public: pub, private: priv } = parseTieredProfile(wrapped);
  if (pub[0] !== 'x' || priv[0] !== 'y') fail('parse.2: fence strip failed');
  passed++;
}

// ── parseTieredProfile: L1 safety net ────────────────────────
{
  // LLM mis-classified a phone number as public → must be forced to private.
  // (Email is NOT in L1 since v0.10.0 — see privacy-rules.ts for rationale.)
  const { public: pub, private: priv } = parseTieredProfile(
    '{"public":["phone 13800138000","TikTok Live engineer"],"private":[]}'
  );
  if (pub.some(s => s.includes('13800138000'))) fail('parse.3: phone leaked to public');
  if (!priv.some(s => s.includes('13800138000'))) fail('parse.3: phone missing from private');
  if (!pub.some(s => s.includes('TikTok Live engineer'))) fail('parse.3: clean public fact dropped');
  passed++;
}

// ── parseTieredProfile: parse failure → conservative fallback ─
{
  const { public: pub, private: priv } = parseTieredProfile('this is not json at all');
  if (pub.length !== 0) fail('parse.4: bad JSON should produce empty public');
  if (priv.length !== 1) fail('parse.4: bad JSON should preserve content as private');
  if (priv[0] !== 'this is not json at all') fail('parse.4: content wrong');
  passed++;
}

// ── parseTieredProfile: malformed object (missing arrays) ────
{
  const { public: pub, private: priv } = parseTieredProfile('{"some":"object"}');
  if (pub.length !== 0 || priv.length !== 0) fail('parse.5: object without arrays should be empty tiers');
  passed++;
}

// ── parseTieredProfile: non-string array items coerced ───────
{
  const { public: pub } = parseTieredProfile('{"public":[1,true,null],"private":[]}');
  if (pub.length !== 3) fail('parse.6: non-string items should be coerced to strings');
  if (pub[0] !== '1' || pub[1] !== 'true') fail(`parse.6: coercion content: ${JSON.stringify(pub)}`);
  passed++;
}

// Cleanup
rmSync(root, { recursive: true, force: true });
rmSync(legacyRoot, { recursive: true, force: true });
rmSync(partialRoot, { recursive: true, force: true });
rmSync(writeRoot, { recursive: true, force: true });

console.log(`profile-tier smoke: ${passed}/21 PASS`);
