/**
 * Episode prune smoke test (v1.0.36, closes #109 part 3).
 *
 * Exercises `MemoryStore.pruneEpisodes(maxAgeMs)` end-to-end. Creates
 * a tmp episodes directory, seeds with fresh + stale `.md` files
 * (using `utimesSync` for deterministic mtimes), runs prune, asserts
 * the right files survived.
 */
process.env.LARK_APP_ID = process.env.LARK_APP_ID ?? 'cli_test_app_id';
process.env.LARK_APP_SECRET = process.env.LARK_APP_SECRET ?? 'test_secret';

import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/memory/file.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'episode-prune-'));
const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

let testNum = 0;
const store = new MemoryStore(tmp);

function seedEpisode(chatId: string, name: string, ageMs: number, content = '# episode\n'): string {
  const dir = join(tmp, 'episodes', chatId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, content);
  const t = (NOW - ageMs) / 1000;
  utimesSync(p, t, t);
  return p;
}

function seedThreadEpisode(chatId: string, threadId: string, name: string, ageMs: number): string {
  const dir = join(tmp, 'episodes', chatId, 'threads', threadId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, '# thread episode\n');
  const t = (NOW - ageMs) / 1000;
  utimesSync(p, t, t);
  return p;
}

try {
  // 1. Missing episodes dir → no throw, all-zeros result
  {
    const r = await store.pruneEpisodes(180 * DAY_MS, NOW);
    if (r.removedFiles !== 0) fail(`1: missing dir should return 0 removed, got ${r.removedFiles}`);
    if (r.bytesFreed !== 0) fail(`1: missing dir should return 0 bytes, got ${r.bytesFreed}`);
    testNum++;
  }

  // 2. Age expiry: stale episode deleted, fresh kept
  {
    const stale = seedEpisode('oc_test2', 'old.md', 200 * DAY_MS);
    const fresh = seedEpisode('oc_test2', 'new.md', 30 * DAY_MS);
    const r = await store.pruneEpisodes(180 * DAY_MS, NOW);
    if (r.removedFiles !== 1) fail(`2: expected 1 removed, got ${r.removedFiles}`);
    if (existsSync(stale)) fail(`2: stale must be unlinked`);
    if (!existsSync(fresh)) fail(`2: fresh must survive`);
    testNum++;
  }

  // 3. Recursive walk hits chat thread episodes too
  {
    const stale = seedEpisode('oc_test3', 'top-old.md', 200 * DAY_MS);
    const staleThread = seedThreadEpisode('oc_test3', 'thr_x', 'old.md', 200 * DAY_MS);
    const freshThread = seedThreadEpisode('oc_test3', 'thr_x', 'new.md', 1 * DAY_MS);
    const r = await store.pruneEpisodes(180 * DAY_MS, NOW);
    if (r.removedFiles !== 2) fail(`3: should remove top+thread stale, got ${r.removedFiles}`);
    if (existsSync(stale)) fail(`3: top stale gone`);
    if (existsSync(staleThread)) fail(`3: thread stale gone`);
    if (!existsSync(freshThread)) fail(`3: thread fresh survives`);
    testNum++;
  }

  // 4. Multiple chats — each pruned independently
  {
    const a1 = seedEpisode('oc_chatA', 'a1.md', 200 * DAY_MS);
    const a2 = seedEpisode('oc_chatA', 'a2.md', 1 * DAY_MS);
    const b1 = seedEpisode('oc_chatB', 'b1.md', 200 * DAY_MS);
    const b2 = seedEpisode('oc_chatB', 'b2.md', 1 * DAY_MS);
    const r = await store.pruneEpisodes(180 * DAY_MS, NOW);
    if (r.removedFiles !== 2) fail(`4: 2 stales across 2 chats, got ${r.removedFiles}`);
    if (existsSync(a1) || existsSync(b1)) fail(`4: both stales should be gone`);
    if (!existsSync(a2) || !existsSync(b2)) fail(`4: both fresh should survive`);
    testNum++;
  }

  // 5. Boundary: file exactly at retention age is KEPT (strict <)
  {
    const exactly = seedEpisode('oc_boundary', 'exactly.md', 180 * DAY_MS);
    const justOver = seedEpisode('oc_boundary', 'just-over.md', 180 * DAY_MS + 1);
    const r = await store.pruneEpisodes(180 * DAY_MS, NOW);
    if (!existsSync(exactly)) fail(`5: exactly-at-threshold must survive (strict <)`);
    if (existsSync(justOver)) fail(`5: just-over-threshold must be removed`);
    if (r.removedFiles !== 1) fail(`5: only the over should be removed, got ${r.removedFiles}`);
    testNum++;
  }

  // 6. Non-.md files in the episodes dir are NOT touched
  {
    const stale = seedEpisode('oc_nonmd', 'old.md', 200 * DAY_MS);
    const nonMd = join(tmp, 'episodes', 'oc_nonmd', 'something.txt');
    writeFileSync(nonMd, 'not an episode');
    const t = (NOW - 200 * DAY_MS) / 1000;
    utimesSync(nonMd, t, t); // stale too
    const r = await store.pruneEpisodes(180 * DAY_MS, NOW);
    if (existsSync(stale)) fail(`6: stale .md should be gone`);
    if (!existsSync(nonMd)) fail(`6: non-.md file must survive even if stale-aged`);
    testNum++;
  }

  // 7. bytesFreed accounting matches sum of removed file sizes
  {
    const big = seedEpisode('oc_bytes', 'big.md', 200 * DAY_MS, 'A'.repeat(5000));
    const small = seedEpisode('oc_bytes', 'small.md', 200 * DAY_MS, 'B'.repeat(100));
    seedEpisode('oc_bytes', 'fresh.md', 1 * DAY_MS, 'fresh'); // not removed
    const r = await store.pruneEpisodes(180 * DAY_MS, NOW);
    if (r.removedFiles !== 2) fail(`7: expected 2 removed, got ${r.removedFiles}`);
    if (r.bytesFreed !== 5100) fail(`7: bytesFreed must equal sum of removed sizes, got ${r.bytesFreed}`);
    if (existsSync(big) || existsSync(small)) fail(`7: stale files should be gone`);
    if (r.skipped !== 0) fail(`7: happy path → 0 skipped, got ${r.skipped}`);
    testNum++;
  }

  // 8. R1-followup: `skipped` counter — files we tried to unlink but
  //     couldn't (stat raced with delete, EACCES, etc.) increment a
  //     visible counter so an operator can see why a stuck file persists.
  //     Simulate via a stale file under a readonly directory: chmod
  //     0500 prevents unlink (POSIX requires dir write to remove a child).
  //
  //     R2-followup: skip the chmod assertion when running as root
  //     (Docker / devcontainer / CI as root) — root bypasses POSIX dir
  //     perms, so the chmod doesn't actually block unlink and the test
  //     would falsely fail. Detect via process.getuid (undefined on
  //     Windows / not-applicable; we then trust the chmod works).
  {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
      console.error('  [skip] test 8: running as root, chmod doesn\'t block unlink');
      testNum++;
    } else {
      const chatId = 'oc_skipped';
      const stale = seedEpisode(chatId, 'undeletable.md', 200 * DAY_MS);
      const chatDir = join(tmp, 'episodes', chatId);
      const { chmodSync } = await import('node:fs');
      chmodSync(chatDir, 0o500); // r-x for owner; cannot unlink children
      try {
        const r = await store.pruneEpisodes(180 * DAY_MS, NOW);
        if (r.removedFiles !== 0) fail(`8: unlink should fail, 0 removed expected (got ${r.removedFiles})`);
        if (r.skipped !== 1) fail(`8: skipped counter must be 1 (got ${r.skipped})`);
        if (!existsSync(stale)) fail(`8: undeletable file should still exist`);
      } finally {
        // Restore writability so the cleanup tmp rmSync can finish
        chmodSync(chatDir, 0o700);
      }
      testNum++;
    }
  }

  // 9. R2-followup: ENOENT during prune (file vanished between readdir
  //     and stat — e.g. concurrent prune + manual rm) must NOT count
  //     toward `skipped`. Pre-followup the conflation produced
  //     false-alarm "N skipped" notices in operator logs.
  //     Hard to reproduce without injecting an unlink-mid-iteration
  //     race; instead, exercise the code path by deleting a file
  //     between readdir snapshot and stat — synthesized by patching
  //     the stat call indirectly via a sub-helper would be invasive.
  //     Simpler: confirm an EMPTY directory + a stale file that we
  //     pre-delete (so readdir saw it, stat hits ENOENT) produces
  //     skipped=0.
  {
    const chatId = 'oc_enoent';
    const ghost = seedEpisode(chatId, 'ghost.md', 200 * DAY_MS);
    const fresh = seedEpisode(chatId, 'fresh.md', 1 * DAY_MS);
    // Pre-delete the ghost file BEFORE running prune. readdir won't
    // see it (different from the race; readdir is one syscall), so
    // this actually tests "missing-after-readdir" only indirectly.
    // For a deterministic ENOENT-during-stat, we need to inject — but
    // we don't have a stat hook. Instead, verify the happy path on a
    // dir whose only stale file got pre-deleted: skipped=0, fresh
    // survives.
    const { rmSync } = await import('node:fs');
    rmSync(ghost);
    const r = await store.pruneEpisodes(180 * DAY_MS, NOW);
    if (r.skipped !== 0) {
      fail(`9: pre-deleted-stale-file should NOT count as skipped (got ${r.skipped})`);
    }
    if (!existsSync(fresh)) fail(`9: fresh survived`);
    testNum++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`episode-prune smoke: ${testNum}/${testNum} PASS`);
