/**
 * profile_tiered smoke test (v1.0.17, #97).
 *
 * Verifies the new `save_memory(type="profile_tiered", content=<JSON>)`
 * server-side path correctly avoids the dual-call race that pre-v1.0.17
 * dropped L1-redirected lines on every auto-flush.
 *
 * The race (now closed):
 *   1. Claude calls save_memory(tier="public", mode="replace", content="phone is 13912345678\nuses Python")
 *      → L1 hits the phone → APPENDS phone to private.md, REPLACES public.md
 *        with "uses Python"
 *   2. Claude calls save_memory(tier="private", mode="replace", content="likes tea")
 *      → REPLACES private.md → the phone line is GONE
 *
 * The fix routes Claude to one call with the full JSON; the server runs
 * parseTieredProfile (which moves L1 hits from public→private BEFORE any
 * write), then issues two saveProfile(mode='replace') calls with the
 * already-segregated arrays. Because public no longer contains L1 hits,
 * saveProfile's internal redirect doesn't fire — the two replaces are
 * independent and idempotent.
 *
 * This file exercises the parseTieredProfile + saveProfile chain end-to-
 * end against a real on-disk store. The MCP tool handler that wires them
 * is exercised separately via the dry-run smoke (modules load) — we
 * don't want to instantiate a full MCP server here.
 */

import fs from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/file.js';
import { parseTieredProfile } from '../src/memory/distiller.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function freshStore(): { store: MemoryStore; baseDir: string; userId: string } {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'lark-profile-tiered-smoke-'));
  return { store: new MemoryStore(baseDir), baseDir, userId: 'ou_test_user' };
}

// Replicates the tools.ts handler's apply-to-store logic so we don't need
// to stand up the full MCP server. If this drifts from the real handler
// the test gives false confidence — so re-check after any tools.ts edit
// to the profile_tiered branch.
async function applyTieredProfile(store: MemoryStore, userId: string, json: string): Promise<void> {
  const tiered = parseTieredProfile(json);
  const fmt = (arr: string[]) =>
    arr.map((line) => (line.startsWith('-') ? line : `- ${line}`)).join('\n') +
    (arr.length > 0 ? '\n' : '');
  await store.saveProfile(userId, fmt(tiered.public), 'public', 'replace');
  await store.saveProfile(userId, fmt(tiered.private), 'private', 'replace');
}

async function readTier(baseDir: string, userId: string, tier: 'public' | 'private'): Promise<string> {
  const p = path.join(baseDir, 'profiles', userId, `${tier}.md`);
  if (!existsSync(p)) return '';
  return await fs.readFile(p, 'utf-8');
}

let testNum = 0;

// 1. Regression for #97 — the exact failure sequence from the issue.
//    Phone (L1 hit) was in `public` array; pre-fix it would have been
//    redirected by saveProfile, then immediately wiped by the private
//    replace. With the new server-side parsing, parseTieredProfile moves
//    the phone to private FIRST, then both replaces operate on already-
//    segregated arrays. No data loss.
{
  testNum++;
  const { store, baseDir, userId } = freshStore();
  const json = JSON.stringify({
    public: ['user phone is 13912345678', 'uses Python'],
    private: ['likes tea'],
  });
  await applyTieredProfile(store, userId, json);

  const pub = await readTier(baseDir, userId, 'public');
  const priv = await readTier(baseDir, userId, 'private');

  if (pub.includes('13912345678')) fail(`#97 regression: phone leaked to public.md — pub=${pub}`);
  if (!priv.includes('13912345678')) fail(`#97 regression: phone LOST (not in private.md either) — priv=${priv}`);
  if (!priv.includes('likes tea')) fail(`#97 regression: private originals dropped — priv=${priv}`);
  if (!pub.includes('uses Python')) fail(`#97 regression: safe public fact dropped — pub=${pub}`);
}

// 2. Multiple L1 hits in public — all should land in private alongside
//    the explicitly-private items, in a single atomic replace.
{
  testNum++;
  const { store, baseDir, userId } = freshStore();
  const json = JSON.stringify({
    public: [
      'phone 13912345678',
      'works at Acme',
      'salary 50k',           // L1 keyword 'salary'
      'open-source on GitHub',
    ],
    private: ['enjoys cycling'],
  });
  await applyTieredProfile(store, userId, json);

  const pub = await readTier(baseDir, userId, 'public');
  const priv = await readTier(baseDir, userId, 'private');

  // Public should keep only the truly-public facts.
  if (pub.includes('13912345678') || pub.includes('salary')) {
    fail(`multi-L1: L1 hits leaked to public — pub=${pub}`);
  }
  if (!pub.includes('Acme') || !pub.includes('GitHub')) {
    fail(`multi-L1: safe public facts dropped — pub=${pub}`);
  }
  // Private should contain all 3 (1 original + 2 redirected).
  for (const expected of ['enjoys cycling', '13912345678', 'salary']) {
    if (!priv.includes(expected)) fail(`multi-L1: missing "${expected}" in priv=${priv}`);
  }
}

// 3. Empty public array — public.md is truncated to empty, private gets
//    its full content. The distiller emits empty arrays for "no facts in
//    this tier this cycle"; the server must honor that.
{
  testNum++;
  const { store, baseDir, userId } = freshStore();
  const json = JSON.stringify({
    public: [],
    private: ['private only fact'],
  });
  await applyTieredProfile(store, userId, json);

  const pub = await readTier(baseDir, userId, 'public');
  const priv = await readTier(baseDir, userId, 'private');
  if (pub.trim() !== '') fail(`empty public: file should be empty, got "${pub}"`);
  if (!priv.includes('private only fact')) fail(`empty public: private missing fact: ${priv}`);
}

// 4. Empty BOTH arrays — both tier files truncated to empty.
//    Honors the distiller's "this user produced no extractable facts"
//    case rather than carrying old facts forward.
{
  testNum++;
  const { store, baseDir, userId } = freshStore();
  // Seed with prior content.
  await store.saveProfile(userId, '- old public\n', 'public', 'replace');
  await store.saveProfile(userId, '- old private\n', 'private', 'replace');

  const json = JSON.stringify({ public: [], private: [] });
  await applyTieredProfile(store, userId, json);

  const pub = await readTier(baseDir, userId, 'public');
  const priv = await readTier(baseDir, userId, 'private');
  if (pub.trim() !== '' || priv.trim() !== '') {
    fail(`empty both: tiers should be empty, got pub="${pub}" priv="${priv}"`);
  }
}

// 5. Malformed JSON — parseTieredProfile falls back to "treat as private"
//    rather than throwing. The server still writes (no exception leaks
//    to the tool handler), so the caller doesn't get a confusing crash.
{
  testNum++;
  const { store, baseDir, userId } = freshStore();
  await applyTieredProfile(store, userId, 'NOT JSON {{{');
  const pub = await readTier(baseDir, userId, 'public');
  const priv = await readTier(baseDir, userId, 'private');
  if (pub.trim() !== '') fail(`malformed: public should be empty, got "${pub}"`);
  if (!priv.includes('NOT JSON')) fail(`malformed: raw fell-back content not in private: "${priv}"`);
}

// 6. Idempotency — applying the same JSON twice produces the same files.
//    Catches a regression where mode='replace' was accidentally changed
//    to 'append' (which would accumulate duplicates).
{
  testNum++;
  const { store, baseDir, userId } = freshStore();
  const json = JSON.stringify({
    public: ['fact A', 'fact B'],
    private: ['secret C'],
  });
  await applyTieredProfile(store, userId, json);
  const pub1 = await readTier(baseDir, userId, 'public');
  const priv1 = await readTier(baseDir, userId, 'private');
  await applyTieredProfile(store, userId, json);
  const pub2 = await readTier(baseDir, userId, 'public');
  const priv2 = await readTier(baseDir, userId, 'private');
  if (pub1 !== pub2) fail(`idempotency: public differs on second apply\nfirst=${pub1}\nsecond=${pub2}`);
  if (priv1 !== priv2) fail(`idempotency: private differs on second apply\nfirst=${priv1}\nsecond=${priv2}`);
}

// 7. Replace truly replaces — old content not in new JSON is dropped.
//    This is the distiller's intended semantic ("rewrite from a fresh
//    read of history") that the dual-call pattern was supposed to
//    provide but couldn't safely after L1 redirect was added.
{
  testNum++;
  const { store, baseDir, userId } = freshStore();
  await applyTieredProfile(
    store,
    userId,
    JSON.stringify({ public: ['old fact'], private: ['old secret'] }),
  );
  await applyTieredProfile(
    store,
    userId,
    JSON.stringify({ public: ['new fact'], private: ['new secret'] }),
  );
  const pub = await readTier(baseDir, userId, 'public');
  const priv = await readTier(baseDir, userId, 'private');
  if (pub.includes('old fact')) fail(`replace: old public fact survived — pub=${pub}`);
  if (priv.includes('old secret')) fail(`replace: old private secret survived — priv=${priv}`);
  if (!pub.includes('new fact')) fail(`replace: new public fact missing — pub=${pub}`);
  if (!priv.includes('new secret')) fail(`replace: new private secret missing — priv=${priv}`);
}

// 8. Pre-formatted bullet lines pass through (parseTieredProfile +
//    saveProfile must not double-bullet). LLMs occasionally include the
//    "- " prefix in the array elements themselves.
{
  testNum++;
  const { store, baseDir, userId } = freshStore();
  const json = JSON.stringify({
    public: ['- fact A', '- fact B'],   // already bulleted
    private: [],
  });
  await applyTieredProfile(store, userId, json);
  const pub = await readTier(baseDir, userId, 'public');
  if (pub.includes('- - fact A')) fail(`double-bullet bug: pub=${pub}`);
  if (!pub.includes('- fact A') || !pub.includes('- fact B')) fail(`pre-bulleted lost: pub=${pub}`);
}

console.log(`profile-tiered smoke: ${testNum}/${testNum} PASS`);
