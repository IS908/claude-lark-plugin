/**
 * Episode cap + empty-keyword guard smoke (v1.0.42, closes #100).
 *
 * Covers both halves of the #100 fix:
 *   - Fix A: searchEpisodes returns [] when keyword extraction yields
 *     nothing, AND skips per-file when keywordScore === 0. Pre-fix,
 *     recency alone (1.0 for today's episodes) exceeded the
 *     consumer-side `minSearchScore=0.3` floor, so any emoji-only /
 *     stopword input injected the most recent unrelated episode.
 *   - Fix B: `MemoryStore.capByBytes` truncates UTF-8 safely (lands
 *     on lead-byte boundaries, appends `\n... [truncated]`).
 *     `saveEpisode` calls it on write; `enrichWithMemory` calls it
 *     on inject.
 *
 * Fix B is exercised here through the pure static helper. The
 * filesystem path through saveEpisode is covered by the read-back
 * round-trip in test 7.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { MemoryStore } from '../src/memory/file.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let testNum = 0;

// ── Part A: capByBytes pure-function contract ──

// 1. Under-cap content passes through untouched.
{
  if (MemoryStore.capByBytes('short text', 1000) !== 'short text') {
    fail(`1: under-cap content modified`);
  }
  testNum++;
}

// 2. Exactly-at-cap content passes through untouched.
{
  const s = 'a'.repeat(100); // 100 ASCII bytes
  if (MemoryStore.capByBytes(s, 100) !== s) {
    fail(`2: at-cap content modified`);
  }
  testNum++;
}

// 3. Over-cap ASCII content is truncated and tagged.
{
  const out = MemoryStore.capByBytes('a'.repeat(200), 50);
  if (!out.endsWith('\n... [truncated]')) {
    fail(`3: missing truncation tag, got: ${JSON.stringify(out.slice(-25))}`);
  }
  // Truncated body should be exactly 50 'a's
  const body = out.slice(0, out.lastIndexOf('\n... [truncated]'));
  if (body !== 'a'.repeat(50)) {
    fail(`3: truncated body wrong length: ${body.length}`);
  }
  testNum++;
}

// 4. UTF-8 safety — CJK 3-byte chars never bisected.
{
  // 10 CJK chars = 30 bytes. Cap at 16 bytes → should keep 5 chars (15 bytes)
  // not 5.33 chars + a partial 3-byte sequence rendered as U+FFFD.
  const cjk = '人工智能助手开发指南示'; // 11 CJK chars
  const out = MemoryStore.capByBytes(cjk, 16);
  if (!out.endsWith('\n... [truncated]')) {
    fail(`4: missing truncation tag on CJK`);
  }
  const body = out.slice(0, out.lastIndexOf('\n... [truncated]'));
  if (body.includes('�')) {
    fail(`4: CJK truncation produced replacement character — boundary not honored`);
  }
  // Should be exactly 5 chars (15 bytes ≤ 16)
  if ([...body].length !== 5) {
    fail(`4: CJK truncation kept ${[...body].length} chars, expected 5`);
  }
  testNum++;
}

// 5. Zero cap returns empty string.
{
  if (MemoryStore.capByBytes('anything', 0) !== '') {
    fail(`5: zero cap should return ''`);
  }
  testNum++;
}

// 6. Negative cap returns empty string (defensive).
{
  if (MemoryStore.capByBytes('anything', -10) !== '') {
    fail(`6: negative cap should return ''`);
  }
  testNum++;
}

// ── Part B: saveEpisode round-trip enforces the (default) cap ──

// 7. Write a pathologically large episode at the DEFAULT cap, read
//    it back, confirm cap. R1-followup honesty fix: an earlier draft
//    of this test set `process.env.LARK_EPISODE_WRITE_CAP_BYTES`
//    AFTER `appConfig` had already been frozen at import time, so
//    the env mutation did nothing and the assertion silently passed
//    on the default 8KB. Now we honestly assert the default behavior:
//    a 10KB write produces ≤ 8KB + tag-overhead on disk. The
//    configurability contract is covered by test 7b (direct
//    `capByBytes` call with a small custom cap).
{
  const tmpRoot = mkdtempSync(join(tmpdir(), 'episode-cap-'));
  try {
    const store = new MemoryStore(tmpRoot);
    const huge = 'X'.repeat(10_000);
    await store.saveEpisode('chat', huge, { chatId: 'oc_test' });

    const dir = join(tmpRoot, 'episodes', 'oc_test');
    const files = await fs.readdir(dir);
    if (files.length !== 1) {
      fail(`7: expected 1 file written, got ${files.length}`);
    }
    const written = await fs.readFile(join(dir, files[0]), 'utf-8');

    const defaultCap = 8 * 1024;
    const tagOverhead = '\n... [truncated]'.length;
    const expectedMax = defaultCap + tagOverhead;
    const writtenBytes = Buffer.byteLength(written, 'utf-8');
    if (writtenBytes > expectedMax) {
      fail(`7: written file too large: ${writtenBytes} > ${expectedMax}`);
    }
    if (writtenBytes < defaultCap - 4) {
      // Body should fill close to the cap (UTF-8 walk-back can shave
      // up to 3 bytes for non-ASCII; ASCII never shaves anything).
      // ASCII content shouldn't shave at all.
      fail(`7: written file unexpectedly small for ASCII input: ${writtenBytes} < ${defaultCap - 4}`);
    }
    if (!written.endsWith('\n... [truncated]')) {
      fail(`7: written file missing truncation tag`);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  testNum++;
}

// 7b. Configurability contract at the helper level — pin that
//     capByBytes honors arbitrary caller-supplied caps. Pairs with
//     test 7 above to cover both "saveEpisode uses appConfig" and
//     "the underlying helper actually respects its arg".
{
  const out = MemoryStore.capByBytes('Y'.repeat(10_000), 256);
  const tagOverhead = '\n... [truncated]'.length;
  const bytes = Buffer.byteLength(out, 'utf-8');
  if (bytes > 256 + tagOverhead) {
    fail(`7b: capByBytes(_, 256) returned ${bytes} bytes, expected ≤ ${256 + tagOverhead}`);
  }
  if (!out.endsWith('\n... [truncated]')) {
    fail(`7b: capByBytes truncation tag missing`);
  }
  testNum++;
}

// ── Part C: searchEpisodes empty-keyword + zero-score guards ──

// 8. Empty-keyword guard with a SAME-LANGUAGE episode that would
//    substring-match the query — pre-followup, this returned the
//    Chinese episode because "好的" is 2 chars (passes `length > 1`)
//    and `MemoryStore.matchKeyword('...好的...', '好的')` falls back
//    to substring (`includes`) on non-ASCII → hit. Post-R1 followup,
//    "好的" / "👍" are in the stopword/emoji-strip set, so
//    extractKeywords yields `[]` and the empty-keyword short-circuit
//    fires regardless of episode content.
{
  const tmpRoot = mkdtempSync(join(tmpdir(), 'episode-cjk-'));
  try {
    const store = new MemoryStore(tmpRoot);
    // Episode literally contains the ack phrase as a substring.
    await store.saveEpisode(
      'chat',
      '部署计划讨论 好的 大家先看 PR\n后续推进 v2 设计',
      { chatId: 'oc_cjk' }
    );

    // "好的" — must return [] even though the episode contains it.
    const results = await store.searchEpisodes('好的', { chatId: 'oc_cjk' });
    if (results.length !== 0) {
      fail(`8: Chinese ack "好的" must yield 0 even when episode contains it; got ${results.length}`);
    }

    // Emoji-only — same protection
    const results2 = await store.searchEpisodes('👍', { chatId: 'oc_cjk' });
    if (results2.length !== 0) {
      fail(`8: emoji-only "👍" must yield 0; got ${results2.length}`);
    }

    // Mixed ack + emoji — still []
    const results3 = await store.searchEpisodes('好的 👍 嗯嗯', { chatId: 'oc_cjk' });
    if (results3.length !== 0) {
      fail(`8: ack + emoji combo must yield 0; got ${results3.length}`);
    }

    // English ack
    const results4 = await store.searchEpisodes('thanks 👍', { chatId: 'oc_cjk' });
    if (results4.length !== 0) {
      fail(`8: "thanks 👍" must yield 0; got ${results4.length}`);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  testNum++;
}

// 8b. Positive control for the new stopword set — a real CJK content
//     keyword still matches. Guards against the followup over-
//     stopwording the search to uselessness.
{
  const tmpRoot = mkdtempSync(join(tmpdir(), 'episode-cjk-pos-'));
  try {
    const store = new MemoryStore(tmpRoot);
    await store.saveEpisode(
      'chat',
      '部署计划讨论 好的 大家先看 PR',
      { chatId: 'oc_cjk_pos' }
    );

    // "部署" is real content — should still match (not in stopwords)
    const results = await store.searchEpisodes('部署 讨论', { chatId: 'oc_cjk_pos' });
    if (results.length !== 1) {
      fail(`8b: real CJK keyword "部署" should still match, got ${results.length}`);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  testNum++;
}

// 9. Non-matching keywords (keywordScore === 0 per file) → returns []
{
  const tmpRoot = mkdtempSync(join(tmpdir(), 'episode-zero-'));
  try {
    const store = new MemoryStore(tmpRoot);
    await store.saveEpisode('chat', 'discussion about kubernetes operators', { chatId: 'oc_y' });

    // Query has real keywords ('raspberry', 'pi', 'ubuntu') but NONE
    // of them appear in the episode. Pre-fix: recency=1.0 → pushed
    // anyway. Post-fix: keywordScore=0 → skipped per-file → [].
    const results = await store.searchEpisodes('raspberry pi ubuntu install', { chatId: 'oc_y' });
    if (results.length !== 0) {
      fail(`9: non-matching keywords should yield 0 episodes, got ${results.length}`);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  testNum++;
}

// 10. Genuine match still returns the episode.
{
  const tmpRoot = mkdtempSync(join(tmpdir(), 'episode-match-'));
  try {
    const store = new MemoryStore(tmpRoot);
    await store.saveEpisode('chat', 'kubernetes cluster setup notes for staging', { chatId: 'oc_z' });

    const results = await store.searchEpisodes('kubernetes deployment', { chatId: 'oc_z' });
    if (results.length !== 1) {
      fail(`10: matching keyword should yield 1 episode, got ${results.length}`);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  testNum++;
}

console.log(`episode-cap smoke: ${testNum}/${testNum} PASS`);
