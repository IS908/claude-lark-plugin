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
//
// Mirrors the R1-audit-hardened semantics:
//   - malformed JSON / non-array tiers → throw (handler returns isError)
//   - empty-both arrays → no-op (preserves existing)
//   - single-side empty → still REPLACES the other tier with the new data
//   - newlines collapsed in array elements (one fact per bullet line)
async function applyTieredProfile(store: MemoryStore, userId: string, json: string): Promise<{ noop?: true }> {
  const raw = json.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let parsed: { public?: unknown; private?: unknown };
  try { parsed = JSON.parse(raw); } catch (err) { throw new Error(`malformed JSON: ${(err as Error).message}`); }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.public) || !Array.isArray(parsed.private)) {
    throw new Error('shape: needs {public:[...], private:[...]}');
  }
  const arrPublic = parsed.public as string[];
  const arrPrivate = parsed.private as string[];
  if (arrPublic.length === 0 && arrPrivate.length === 0) {
    return { noop: true };
  }
  const tiered = parseTieredProfile(JSON.stringify({ public: arrPublic, private: arrPrivate }));
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  const fmt = (arr: string[]) =>
    arr
      .map(oneLine)
      .filter(Boolean)
      .map((line) => (line.startsWith('-') ? line : `- ${line}`))
      .join('\n') +
    (arr.some((s) => oneLine(s).length > 0) ? '\n' : '');
  // v1.0.34 (R1-followup on #54): mirror tools.ts's switch to
  // saveProfileTiered for the atomic-pair write. Pre-followup these
  // were two separate saveProfile calls; the test still exercises the
  // same end-to-end behavior, now under one mutex acquisition.
  await store.saveProfileTiered(userId, {
    public: fmt(tiered.public),
    private: fmt(tiered.private),
  });
  return {};
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

// 3. Empty public array, populated private — public truncated to
//    empty, private fully replaced. Single-side empty is the
//    "rewrite from fresh read" semantic that the distiller intends.
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

// 4. Empty BOTH arrays — NO-OP, existing tiers preserved.
//    R1-audit hardening: pre-fix would have truncated both tiers,
//    nuking the user's entire profile on a low-content distillation
//    cycle. New semantics treat empty-both as "produced no extractable
//    facts" rather than "wipe the profile" — operator can still do an
//    explicit wipe via forget_memory or by editing the files directly.
{
  testNum++;
  const { store, baseDir, userId } = freshStore();
  // Seed with prior content.
  await store.saveProfile(userId, '- old public\n', 'public', 'replace');
  await store.saveProfile(userId, '- old private\n', 'private', 'replace');

  const json = JSON.stringify({ public: [], private: [] });
  const result = await applyTieredProfile(store, userId, json);
  if (!result.noop) fail('empty both should be a no-op');

  const pub = await readTier(baseDir, userId, 'public');
  const priv = await readTier(baseDir, userId, 'private');
  if (!pub.includes('old public')) fail(`empty-both no-op: prior public dropped: "${pub}"`);
  if (!priv.includes('old private')) fail(`empty-both no-op: prior private dropped: "${priv}"`);
}

// 5. Malformed JSON — REJECTED, existing tiers preserved.
//    R1-audit hardening: pre-fix the fallback path REPLACED public→empty
//    and private→raw blob on any transient LLM JSON hiccup, silently
//    destroying the user's existing public profile. New behavior is to
//    refuse the write so Claude/operator sees a signal and can retry.
{
  testNum++;
  const { store, baseDir, userId } = freshStore();
  // Seed with prior content.
  await store.saveProfile(userId, '- preserved public\n', 'public', 'replace');
  await store.saveProfile(userId, '- preserved private\n', 'private', 'replace');

  let threw = false;
  try {
    await applyTieredProfile(store, userId, 'NOT JSON {{{');
  } catch (err) {
    threw = true;
    if (!/malformed JSON/.test(String(err))) {
      fail(`malformed JSON: wrong error: ${err}`);
    }
  }
  if (!threw) fail('malformed JSON must throw (handler returns isError)');

  // Both prior tiers MUST be preserved — no destructive partial write.
  const pub = await readTier(baseDir, userId, 'public');
  const priv = await readTier(baseDir, userId, 'private');
  if (!pub.includes('preserved public')) fail(`malformed JSON: prior public destroyed: "${pub}"`);
  if (!priv.includes('preserved private')) fail(`malformed JSON: prior private destroyed: "${priv}"`);
}

// 5b. Structurally-invalid JSON (e.g. public is a string instead of an
//     array) — REJECTED, existing tiers preserved.
//     R1-audit hardening: parseTieredProfile's default-to-[] would have
//     silently emptied the public tier on a Claude shape-error.
{
  testNum++;
  const { store, baseDir, userId } = freshStore();
  await store.saveProfile(userId, '- preserved public\n', 'public', 'replace');

  let threw = false;
  try {
    await applyTieredProfile(store, userId, JSON.stringify({ public: 'oops', private: [] }));
  } catch (err) {
    threw = true;
    if (!/shape/.test(String(err))) fail(`shape-invalid: wrong error: ${err}`);
  }
  if (!threw) fail('shape-invalid JSON must throw');

  const pub = await readTier(baseDir, userId, 'public');
  if (!pub.includes('preserved public')) fail(`shape-invalid: prior public destroyed: "${pub}"`);
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

// 9. Embedded newlines in array elements are collapsed to a single
//    space — preserves one-fact-per-line semantics so listProfileLines
//    can still address each line by hash. R1-audit nit #4.
{
  testNum++;
  const { store, baseDir, userId } = freshStore();
  const json = JSON.stringify({
    public: ['multi\nline\nfact', 'normal fact'],
    private: ['secret with\ttabs and  spaces'],
  });
  await applyTieredProfile(store, userId, json);
  const pub = await readTier(baseDir, userId, 'public');
  const priv = await readTier(baseDir, userId, 'private');
  // The multi-line fact must collapse to one bullet line.
  if (!pub.includes('- multi line fact')) fail(`newline collapse failed in public: ${pub}`);
  // Each line in public.md is one fact — count non-empty lines.
  const pubLines = pub.split('\n').filter((l) => l.trim());
  if (pubLines.length !== 2) fail(`public should have exactly 2 bullet lines, got ${pubLines.length}: ${pub}`);
  // Private side also normalized.
  if (!priv.includes('- secret with tabs and spaces')) fail(`whitespace collapse failed in private: ${priv}`);
}

console.log(`profile-tiered smoke: ${testNum}/${testNum} PASS`);
