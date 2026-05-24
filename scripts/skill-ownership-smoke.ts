/**
 * Skill ownership smoke test (v1.0.14, #84).
 *
 * Covers the owner-gate added to `MemoryStore.saveSkill`:
 *   - first save claims the slug for the caller (sidecar created),
 *   - second save by the same caller succeeds (`action: 'updated'`),
 *   - second save by a different caller is denied (`reason: 'not-owner'`),
 *   - empty/garbage names that sanitize to "" are rejected,
 *   - slug collisions across different display names map to the same owner
 *     gate (the slug, not the display name, is the identity).
 *
 * Plus the legacy-claim migration:
 *   - `.md` without sidecar gets a sidecar attributed to OWNER,
 *   - re-running migration is idempotent,
 *   - without OWNER set, legacy skills stay locked (save_skill rejects).
 *
 * Each test isolates state under `os.tmpdir()/lark-skill-smoke-<unique>/`
 * so the suite does not interfere with the operator's real
 * `~/.claude/channels/lark/memories/skills/` directory.
 */

import fs from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, type SkillMeta } from '../src/memory/file.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function freshStore(): { store: MemoryStore; baseDir: string } {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'lark-skill-smoke-'));
  return { store: new MemoryStore(baseDir), baseDir };
}

async function readMeta(baseDir: string, slug: string): Promise<SkillMeta | null> {
  const p = path.join(baseDir, 'skills', `${slug}.meta.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(await fs.readFile(p, 'utf-8')) as SkillMeta;
}

let testNum = 0;

// 1. sanitizeSkillSlug — round-trips
{
  testNum++;
  const cases: [string, string][] = [
    ['Deploy Service', 'deploy-service'],
    ['deploy/service', 'deploy-service'],
    ['deploy@service', 'deploy-service'],
    ['--Foo--', 'foo'],
    ['  ABC 123  ', 'abc-123'],
  ];
  for (const [input, want] of cases) {
    const got = MemoryStore.sanitizeSkillSlug(input);
    if (got !== want) fail(`sanitize "${input}" want="${want}" got="${got}"`);
  }
}

// 2. sanitizeSkillSlug — empty / all-symbols → empty string
{
  testNum++;
  for (const input of ['', '!!!', '---', '   ', '@@@', '!@#$%']) {
    const got = MemoryStore.sanitizeSkillSlug(input);
    if (got !== '') fail(`sanitize "${input}" should be empty, got "${got}"`);
  }
}

// 3. saveSkill — first write claims slug
{
  testNum++;
  const { store, baseDir } = freshStore();
  const r = await store.saveSkill('Deploy Service', 'deploys things', 'do A then B', {
    caller: 'ou_alice',
    ownerOpenId: 'ou_owner',
  });
  if (!r.ok || r.action !== 'created' || r.slug !== 'deploy-service') {
    fail(`first save failed: ${JSON.stringify(r)}`);
  }
  const meta = await readMeta(baseDir, 'deploy-service');
  if (!meta || meta.created_by !== 'ou_alice') fail('sidecar created_by mismatch');
  if (meta.migrated === true) fail('fresh save should not be marked migrated');
}

// 4. saveSkill — owner can update
{
  testNum++;
  const { store, baseDir } = freshStore();
  await store.saveSkill('Deploy Service', 'v1', 'first', {
    caller: 'ou_alice',
    ownerOpenId: 'ou_owner',
  });
  const r = await store.saveSkill('Deploy Service', 'v2', 'second', {
    caller: 'ou_alice',
    ownerOpenId: 'ou_owner',
  });
  if (!r.ok || r.action !== 'updated') fail(`owner update failed: ${JSON.stringify(r)}`);
  const meta = await readMeta(baseDir, 'deploy-service');
  if (!meta?.updated_at) fail('updated_at should be set after second write');
  const body = await fs.readFile(path.join(baseDir, 'skills', 'deploy-service.md'), 'utf-8');
  if (!body.includes('second')) fail('content not updated');
}

// 5. saveSkill — non-owner rejected
{
  testNum++;
  const { store, baseDir } = freshStore();
  await store.saveSkill('Deploy Service', 'mine', 'alice content', {
    caller: 'ou_alice',
    ownerOpenId: 'ou_owner',
  });
  const r = await store.saveSkill('Deploy Service', 'evil', 'bob content', {
    caller: 'ou_bob',
    ownerOpenId: 'ou_owner',
  });
  if (r.ok || r.reason !== 'not-owner') fail(`non-owner should be denied: ${JSON.stringify(r)}`);
  const body = await fs.readFile(path.join(baseDir, 'skills', 'deploy-service.md'), 'utf-8');
  if (body.includes('bob content')) fail('non-owner write should NOT have changed content');
  if (!body.includes('alice content')) fail('original alice content lost');
}

// 6. saveSkill — empty slug rejected (no file written)
{
  testNum++;
  const { store, baseDir } = freshStore();
  for (const badName of ['', '!!!', '   ', '---']) {
    const r = await store.saveSkill(badName, 'd', 'c', {
      caller: 'ou_alice',
      ownerOpenId: 'ou_owner',
    });
    if (r.ok || r.reason !== 'empty-slug') {
      fail(`empty-slug "${badName}" should be rejected: ${JSON.stringify(r)}`);
    }
  }
  // No files in skills/ should exist (dir may exist from the mkdir, but
  // no .md or .meta.json files).
  const skillsDir = path.join(baseDir, 'skills');
  if (existsSync(skillsDir)) {
    const files = await fs.readdir(skillsDir);
    const wrote = files.filter((f) => f.endsWith('.md') || f.endsWith('.meta.json'));
    if (wrote.length > 0) fail(`empty-slug should write nothing, found: ${wrote.join(', ')}`);
  }
}

// 7. saveSkill — slug collision across different display names hits same owner gate
//    "Deploy Service", "deploy/service", "deploy@service" all → deploy-service.
//    The second author (bob) is denied even though his DISPLAY NAME differs.
{
  testNum++;
  const { store } = freshStore();
  await store.saveSkill('Deploy Service', 'd', 'c', {
    caller: 'ou_alice',
    ownerOpenId: 'ou_owner',
  });
  const r = await store.saveSkill('deploy/service', 'd', 'c', {
    caller: 'ou_bob',
    ownerOpenId: 'ou_owner',
  });
  if (r.ok || r.reason !== 'not-owner') {
    fail(`slug-collision via different display name should deny: ${JSON.stringify(r)}`);
  }
}

// 8. saveSkill — sidecar missing AND .md exists with OWNER set → legacy-locked
//    Simulates a pre-v1.0.14 .md that startup migration somehow missed (e.g.
//    OWNER wasn't set at startup, then user set it later but didn't restart).
{
  testNum++;
  const { store, baseDir } = freshStore();
  const dir = path.join(baseDir, 'skills');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'legacy.md'), '# legacy\nold\n\ncontent', 'utf-8');
  // No sidecar.

  const r = await store.saveSkill('legacy', 'd', 'c', {
    caller: 'ou_alice',
    ownerOpenId: 'ou_owner',
  });
  if (r.ok || r.reason !== 'legacy-locked') {
    fail(`legacy .md without sidecar should be locked: ${JSON.stringify(r)}`);
  }
  // Locked message must hint at restart since OWNER is set.
  if (!r.ok && !/[Rr]estart/.test(r.message)) {
    fail(`legacy-locked message should mention restart when OWNER configured: "${r.message}"`);
  }
}

// 9. saveSkill — sidecar missing AND .md exists WITHOUT OWNER → still locked, different hint
{
  testNum++;
  const { store, baseDir } = freshStore();
  const dir = path.join(baseDir, 'skills');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'legacy.md'), '# legacy\nold\n\ncontent', 'utf-8');

  const r = await store.saveSkill('legacy', 'd', 'c', {
    caller: 'ou_alice',
    ownerOpenId: null,
  });
  if (r.ok || r.reason !== 'legacy-locked') {
    fail(`legacy without OWNER should also be locked: ${JSON.stringify(r)}`);
  }
  if (!r.ok && !/LARK_OWNER_OPEN_ID/.test(r.message)) {
    fail(`legacy-locked message should suggest setting OWNER when null: "${r.message}"`);
  }
}

// 10. migrateLegacySkills — claims unowned .md files for OWNER
{
  testNum++;
  const { store, baseDir } = freshStore();
  const dir = path.join(baseDir, 'skills');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'foo.md'), '# foo\nx\n\nbody', 'utf-8');
  await fs.writeFile(path.join(dir, 'bar.md'), '# bar\ny\n\nbody', 'utf-8');

  await store.migrateLegacySkills('ou_owner');

  for (const slug of ['foo', 'bar']) {
    const meta = await readMeta(baseDir, slug);
    if (!meta) fail(`migration should have written sidecar for "${slug}"`);
    if (meta.created_by !== 'ou_owner') fail(`migration should attribute to OWNER`);
    if (meta.migrated !== true) fail(`migration should mark migrated=true`);
  }
}

// 11. migrateLegacySkills — idempotent (existing sidecars are NOT overwritten)
{
  testNum++;
  const { store, baseDir } = freshStore();
  const dir = path.join(baseDir, 'skills');
  await fs.mkdir(dir, { recursive: true });
  // alice's existing skill — already has a sidecar from a previous save
  await fs.writeFile(path.join(dir, 'foo.md'), '# foo\nx\n\nbody', 'utf-8');
  await fs.writeFile(
    path.join(dir, 'foo.meta.json'),
    JSON.stringify({ created_by: 'ou_alice', created_at: '2025-01-01T00:00:00.000Z' }),
    'utf-8',
  );

  await store.migrateLegacySkills('ou_owner');

  const meta = await readMeta(baseDir, 'foo');
  if (!meta) fail('migration should not delete existing sidecar');
  if (meta.created_by !== 'ou_alice') fail(`idempotent: must not clobber existing owner (got ${meta.created_by})`);
}

// 12. migrateLegacySkills — no-op without OWNER (legacy skills remain unowned and locked)
{
  testNum++;
  const { store, baseDir } = freshStore();
  const dir = path.join(baseDir, 'skills');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'foo.md'), '# foo\nx\n\nbody', 'utf-8');

  await store.migrateLegacySkills(null);

  const meta = await readMeta(baseDir, 'foo');
  if (meta !== null) fail(`migration without OWNER should NOT write sidecar (got ${JSON.stringify(meta)})`);
  // And save_skill on this slug should be legacy-locked.
  const r = await store.saveSkill('foo', 'd', 'c', { caller: 'ou_alice', ownerOpenId: null });
  if (r.ok || r.reason !== 'legacy-locked') {
    fail(`unmigrated legacy must remain locked: ${JSON.stringify(r)}`);
  }
}

// 13. migrateLegacySkills — no skills dir at all → no-op, no crash
{
  testNum++;
  const { store } = freshStore();
  await store.migrateLegacySkills('ou_owner'); // must not throw
}

// 14. readSkillMeta — corrupt sidecar treated as missing (fail-soft)
{
  testNum++;
  const { store, baseDir } = freshStore();
  const dir = path.join(baseDir, 'skills');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'corrupt.md'), '# c\nd\n\nbody', 'utf-8');
  await fs.writeFile(path.join(dir, 'corrupt.meta.json'), 'NOT-JSON{', 'utf-8');

  const meta = await store.readSkillMeta('corrupt');
  if (meta !== null) fail(`corrupt sidecar should be treated as null, got ${JSON.stringify(meta)}`);
  // saveSkill on this slug should then hit the .md-exists-no-sidecar branch
  // (legacy-locked) — corrupt sidecar must NOT be a back-door to claiming.
  const r = await store.saveSkill('corrupt', 'd', 'c', {
    caller: 'ou_attacker',
    ownerOpenId: 'ou_owner',
  });
  if (r.ok || r.reason !== 'legacy-locked') {
    fail(`corrupt sidecar must not allow new caller to claim: ${JSON.stringify(r)}`);
  }
}

// 15. After migration + save by owner — full happy path
{
  testNum++;
  const { store, baseDir } = freshStore();
  const dir = path.join(baseDir, 'skills');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'foo.md'), '# foo\nold\n\nbody', 'utf-8');

  await store.migrateLegacySkills('ou_owner');
  const r = await store.saveSkill('foo', 'fresh', 'new body', {
    caller: 'ou_owner',
    ownerOpenId: 'ou_owner',
  });
  if (!r.ok || r.action !== 'updated') {
    fail(`OWNER should be able to update post-migration: ${JSON.stringify(r)}`);
  }
  const meta = await readMeta(baseDir, 'foo');
  if (!meta?.updated_at) fail('updated_at should be present after owner update');
  if (meta?.migrated !== true) fail('migrated flag should persist across updates');
}

// 16. Atomic sidecar write (v1.0.14 R1 audit) — concurrent writes on a
//     fresh slug never produce a corrupt sidecar. Pre-fix, a plain
//     fs.writeFile on the final path could interleave two writers and
//     emit malformed JSON (e.g. `{...}\n}\n`); readSkillMeta would then
//     null out and the slug would be permanently legacy-locked. With
//     tmp+rename, every observed sidecar must parse as valid SkillMeta.
//
//     We launch many parallel claims (alice + bob, alternating). At
//     least one MUST win ownership cleanly; readSkillMeta must return a
//     populated SkillMeta whose created_by is one of the two callers.
//     The slug must remain operable by its eventual owner (no permanent
//     lockout).
{
  testNum++;
  const { store, baseDir } = freshStore();
  const N = 20;
  const callers = Array.from({ length: N }, (_, i) => (i % 2 === 0 ? 'ou_alice' : 'ou_bob'));
  await Promise.all(
    callers.map((c, i) =>
      store.saveSkill('Shared', `desc-${i}`, `body-${i}`, {
        caller: c,
        ownerOpenId: 'ou_owner',
      }),
    ),
  );
  const meta = await readMeta(baseDir, 'shared');
  if (!meta) fail('concurrent claims must not leave a null/corrupt sidecar');
  if (meta.created_by !== 'ou_alice' && meta.created_by !== 'ou_bob') {
    fail(`unexpected owner from race: ${meta.created_by}`);
  }
  // Owner can still update — proves the slug is NOT bricked.
  const r = await store.saveSkill('Shared', 'post-race', 'post-race body', {
    caller: meta.created_by,
    ownerOpenId: 'ou_owner',
  });
  if (!r.ok || r.action !== 'updated') {
    fail(`post-race owner update must succeed, got ${JSON.stringify(r)}`);
  }
}

// 17. writeSkillMeta — no .tmp leftovers in the skills dir after a normal
//     save. Tmp files in the directory would be cosmetic noise but also
//     a hint at unclean failure paths; ensure rename consumed the tmp.
{
  testNum++;
  const { store, baseDir } = freshStore();
  await store.saveSkill('Quiet', 'd', 'c', { caller: 'ou_alice', ownerOpenId: 'ou_owner' });
  const files = await fs.readdir(path.join(baseDir, 'skills'));
  const stragglers = files.filter((f) => f.includes('.tmp'));
  if (stragglers.length > 0) fail(`tmp files left behind after normal save: ${stragglers.join(', ')}`);
}

// 18. migrateLegacySkills — rethrows non-ENOENT readdir errors so a
//     permission/IO problem is loud and operator-visible, not silently
//     reported as "0 legacy skills" (R2-audit F3). Simulated with chmod
//     000 on the skills dir; we expect the await to throw.
//     Skipped on platforms where chmod doesn't restrict the test process
//     (root/Windows).
{
  testNum++;
  const { store, baseDir } = freshStore();
  const dir = path.join(baseDir, 'skills');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'locked.md'), '# locked\nd\n\nbody', 'utf-8');
  if (process.getuid?.() === 0 || process.platform === 'win32') {
    // Skip — chmod 000 is bypassed for root, and Windows permission model differs.
  } else {
    await fs.chmod(dir, 0o000);
    let threw = false;
    try {
      await store.migrateLegacySkills('ou_owner');
    } catch {
      threw = true;
    } finally {
      await fs.chmod(dir, 0o755); // restore so the temp dir can be cleaned
    }
    if (!threw) fail('migrateLegacySkills must rethrow EACCES on the skills dir');
  }
}

// 19. migrateLegacySkills — ENOENT on the skills dir is silent / safe.
//     Path: fresh install with no skills written yet.
{
  testNum++;
  const { store, baseDir } = freshStore();
  // No skills dir.
  await store.migrateLegacySkills('ou_owner'); // must NOT throw
  // And calling listLegacySlugs (via subsequent migrate) is still fine.
  await store.migrateLegacySkills(null); // also must NOT throw
  // And the skills dir is still absent (migration did not eagerly create).
  if (existsSync(path.join(baseDir, 'skills'))) {
    fail('migration on fresh install should not create skills/');
  }
}

console.log(`skill ownership smoke: ${testNum}/${testNum} PASS`);
