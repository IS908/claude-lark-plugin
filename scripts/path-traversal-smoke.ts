/**
 * Path-traversal defense smoke test (v1.0.15, #93).
 *
 * Verifies the two layers of defense against Claude-supplied chat / thread /
 * message / job ids that contain `..` / `/` / `\` / NUL / control bytes:
 *
 *   Layer 1: `LARK_ID_REGEX` enforced at every tool input boundary in
 *            src/tools.ts. Verified by parsing the exported regex.
 *
 *   Layer 2: `assertSafeKey` inside MemoryStore (saveEpisode /
 *            searchEpisodes / listEpisodes / deleteEpisodes / profileDir /
 *            legacyProfilePath) and `assertSafeJobId` inside job-store
 *            (jobPath). Both throw a recognizable error before path.join
 *            collapses `..` and lets a write/read escape the configured
 *            baseDir.
 *
 * Tests cover the happy path (real Feishu id shapes pass) and the failure
 * path (every traversal vector rejects).
 */

import fs from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/file.js';
import { LARK_ID_REGEX } from '../src/tools.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function freshStore(): { store: MemoryStore; baseDir: string } {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'lark-pathtrav-smoke-'));
  return { store: new MemoryStore(baseDir), baseDir };
}

const BAD_IDS = [
  '../escape',
  '../../etc/passwd',
  'foo/bar',
  'foo\\bar',
  '..',
  '..\\..\\.ssh\\authorized_keys',
  'oc_real\0null',
  'foo\nbar',
  'foo\rbar',
  '\x01ctrl',
  '', // empty
  'a'.repeat(129), // exceeds Layer-1 (tool boundary) cap of 128
];

const GOOD_IDS = [
  'oc_e9b5b07c890b4c80b9a2eb234a1234ab',
  'om_xxx_yyy_zzz-123',
  'omt_long_thread_id_2025',
  'ou_user_open_id_alphanumeric',
  'og_group_chat_5fa3b1',
  'cli_msg_12345',
  // synthetic cronjob thread ids use colon — accept under LARK_ID_REGEX (Tier-1 in tools.ts allows : explicitly)
  'job-name-12345',
];

let testNum = 0;

// 1. LARK_ID_REGEX rejects every traversal vector
{
  testNum++;
  for (const id of BAD_IDS) {
    if (LARK_ID_REGEX.test(id)) {
      fail(`LARK_ID_REGEX should REJECT bad id "${id.slice(0, 40)}"`);
    }
  }
}

// 2. LARK_ID_REGEX accepts realistic Feishu id shapes
{
  testNum++;
  for (const id of GOOD_IDS) {
    if (!LARK_ID_REGEX.test(id)) {
      fail(`LARK_ID_REGEX should ACCEPT good id "${id}"`);
    }
  }
}

// 3. saveEpisode rejects bad chatId — and the rejection happens BEFORE
//    any file is written / dir is created. Pre-fix, the write succeeded
//    at a path collapsed outside baseDir; post-fix, the throw happens
//    first and the unsafe absolute path is never touched.
{
  testNum++;
  const { store, baseDir } = freshStore();
  let threw = false;
  try {
    await store.saveEpisode('chat', 'oops', { chatId: '../../tmp/escape' });
  } catch (err) {
    threw = true;
    if (!String(err).match(/Invalid chatId/)) {
      fail(`saveEpisode bad chatId: wrong error: ${String(err)}`);
    }
  }
  if (!threw) fail('saveEpisode must throw on traversal chatId');

  // No traversed file should exist anywhere outside baseDir.
  // Spot-check the would-have-been target directory (resolved relative to
  // baseDir to mimic Node's path.join collapse): under /tmp/escape we
  // expect nothing because the throw fired first.
  const wouldHaveTarget = path.resolve(baseDir, 'episodes', '../../tmp/escape');
  if (existsSync(wouldHaveTarget)) {
    // Defensive: tmp may already have unrelated content; only fail if a
    // FRESH .md is there with our timestamp shape.
    const files = await fs.readdir(wouldHaveTarget).catch(() => [] as string[]);
    if (files.some((f) => f.endsWith('.md'))) {
      fail(`saveEpisode wrote a file at ${wouldHaveTarget} despite the throw`);
    }
  }
}

// 4. saveEpisode rejects bad threadId (thread-typed path)
{
  testNum++;
  const { store } = freshStore();
  let threw = false;
  try {
    await store.saveEpisode('thread', 'oops', {
      chatId: 'oc_safe_chat_id',
      threadId: '../../../etc/cron.daily',
    });
  } catch (err) {
    threw = true;
    if (!String(err).match(/Invalid threadId/)) {
      fail(`saveEpisode bad threadId: wrong error: ${String(err)}`);
    }
  }
  if (!threw) fail('saveEpisode must throw on traversal threadId');
}

// 5. saveEpisode accepts realistic IDs and writes inside baseDir
{
  testNum++;
  const { store, baseDir } = freshStore();
  await store.saveEpisode('thread', 'hello', {
    chatId: 'oc_real_chat',
    threadId: 'omt_real_thread',
  });
  const targetDir = path.join(baseDir, 'episodes', 'oc_real_chat', 'threads', 'omt_real_thread');
  if (!existsSync(targetDir)) fail('saveEpisode happy path did not create target dir');
  const files = await fs.readdir(targetDir);
  if (!files.some((f) => f.endsWith('.md'))) fail('saveEpisode happy path did not write any .md');
}

// 6. searchEpisodes rejects bad chatId (read-side defense)
{
  testNum++;
  const { store } = freshStore();
  let threw = false;
  try {
    await store.searchEpisodes('hello', { chatId: '../../etc' });
  } catch (err) {
    threw = true;
    if (!String(err).match(/Invalid chatId/)) {
      fail(`searchEpisodes bad chatId: wrong error: ${String(err)}`);
    }
  }
  if (!threw) fail('searchEpisodes must throw on traversal chatId');
}

// 7. listEpisodes / deleteEpisodes reject bad ids
{
  testNum++;
  const { store } = freshStore();
  let listThrew = false;
  try { await store.listEpisodes('../escape'); } catch { listThrew = true; }
  if (!listThrew) fail('listEpisodes must throw on traversal chatId');

  let delThrew = false;
  try { await store.deleteEpisodes('../escape', ['x.md']); } catch { delThrew = true; }
  if (!delThrew) fail('deleteEpisodes must throw on traversal chatId');

  let delIdThrew = false;
  try { await store.deleteEpisodes('oc_real', ['../../escape.md']); } catch { delIdThrew = true; }
  if (!delIdThrew) fail('deleteEpisodes must throw on traversal episode id');
}

// 8. profileDir / getProfile reject bad userId (defense in depth — userId
//    is server-derived, so this normally can't happen, but the storage
//    contract should reject regardless).
{
  testNum++;
  const { store } = freshStore();
  let threw = false;
  try {
    await store.getProfile('../../etc/passwd', '../../etc/passwd');
  } catch (err) {
    threw = true;
    if (!String(err).match(/Invalid userId/)) {
      fail(`getProfile bad userId: wrong error: ${String(err)}`);
    }
  }
  if (!threw) fail('getProfile must throw on traversal userId');
}

// 9. Job store: writeJob / deleteJob / readJob reject bad job ids
{
  testNum++;
  const { writeJob, deleteJob, readJob } = await import('../src/job-store.js');

  let writeThrew = false;
  try {
    await writeJob({
      meta: {
        id: '../../etc/cron.daily/payload',
        name: 'evil',
        type: 'message',
        schedule: '* * * * *',
        schedule_human: 'every min',
        content: 'x',
        msg_type: 'text',
        target_chat_id: 'oc_x',
        origin_chat_id: 'oc_x',
        status: 'active',
        created_by: 'ou_x',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      runtime: { last_run_at: null, next_run_at: '2026-01-01T00:01:00.000Z', run_count: 0, last_error: null },
    });
  } catch (err) {
    writeThrew = true;
    if (!String(err).match(/Invalid job id/)) fail(`writeJob: wrong error: ${err}`);
  }
  if (!writeThrew) fail('writeJob must throw on traversal id');

  // readJob and deleteJob catch internally and return null/false rather
  // than propagating; the path traversal STILL never executes a real
  // fs.readFile / fs.unlink on the traversed path.
  const bad = await readJob('../../etc/passwd');
  if (bad !== null) fail('readJob must return null on traversal id');

  const del = await deleteJob('../../etc/passwd');
  if (del !== false) fail('deleteJob must return false on traversal id');
}

// 10. Boundary check: regex accepts exactly 128 chars, rejects 129.
//     Catches off-by-one regressions on the upper cap.
{
  testNum++;
  const exact128 = 'a'.repeat(128);
  const exact129 = 'a'.repeat(129);
  if (!LARK_ID_REGEX.test(exact128)) fail('LARK_ID_REGEX must accept exactly 128 chars');
  if (LARK_ID_REGEX.test(exact129)) fail('LARK_ID_REGEX must reject 129 chars');
}

// 11. assertSafeKey storage-layer cap is NAME_MAX (255), looser than the
//     Layer-1 cap (128). Catches a future regression that tightens the
//     storage layer below Layer-1 (would break legitimate non-tool callers).
{
  testNum++;
  const { store } = freshStore();
  const exact255 = 'a'.repeat(255); // safe alphanumerics, no traversal
  // saveEpisode internally calls assertSafeKey(chatId) which permits up to 255.
  // We don't actually want to write a 255-char directory in /tmp on every
  // test run — just verify the assertion path does NOT throw for 255 by
  // invoking listEpisodes which calls assertSafeKey then fs.readdir (which
  // returns [] for nonexistent paths, so no .md side effects either way).
  let threw = false;
  try { await store.listEpisodes(exact255); } catch { threw = true; }
  if (threw) fail('assertSafeKey must accept exactly 255 chars');

  // 256 chars must reject.
  const exact256 = 'a'.repeat(256);
  let rejected = false;
  try { await store.listEpisodes(exact256); } catch { rejected = true; }
  if (!rejected) fail('assertSafeKey must reject 256 chars');
}

console.log(`path-traversal smoke: ${testNum}/${testNum} PASS`);
