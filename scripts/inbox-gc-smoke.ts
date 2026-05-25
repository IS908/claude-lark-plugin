/**
 * Inbox GC smoke test (v1.0.35, closes #89).
 *
 * Exercises `gcInbox` (pure function) directly. Uses an injected `dir`
 * so we don't touch the real ~/.claude inbox, and an injected `now`
 * for deterministic age computations.
 */

// Set env BEFORE importing config — values aren't actually used because
// we inject opts directly, but config validation happens at import time.
process.env.LARK_APP_ID = process.env.LARK_APP_ID ?? 'cli_test_app_id';
process.env.LARK_APP_SECRET = process.env.LARK_APP_SECRET ?? 'test_secret';

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gcInbox } from '../src/inbox-gc.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let testNum = 0;

// Helper: create a file with a specific mtime (seconds since epoch) and
// content of `sizeBytes` bytes.
function makeFile(dir: string, name: string, sizeBytes: number, mtimeMs: number): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(sizeBytes, 0));
  const t = mtimeMs / 1000; // utimes wants seconds
  utimesSync(p, t, t);
  return p;
}

const tmp = mkdtempSync(join(tmpdir(), 'inbox-gc-'));
const DAY_MS = 86_400_000;
const MB = 1024 * 1024;
const NOW = 1_700_000_000_000;

try {
  // 1. Missing directory → no throw, all-zeros result
  {
    const r = await gcInbox({
      dir: join(tmp, 'nonexistent'),
      maxAgeMs: 7 * DAY_MS,
      maxSizeBytes: 500 * MB,
      now: NOW,
    });
    if (r.removed !== 0 || r.bytesFreed !== 0 || r.finalSize !== 0 || r.remaining !== 0) {
      fail(`1: missing dir should return zeros, got ${JSON.stringify(r)}`);
    }
    testNum++;
  }

  // 2. Empty directory → no throw, all-zeros result
  {
    const dir = mkdtempSync(join(tmp, 'empty-'));
    const r = await gcInbox({ dir, maxAgeMs: 7 * DAY_MS, maxSizeBytes: 500 * MB, now: NOW });
    if (r.removed !== 0 || r.remaining !== 0) {
      fail(`2: empty dir should return zeros, got ${JSON.stringify(r)}`);
    }
    testNum++;
  }

  // 3. Age expiry: file older than maxAge gets deleted, fresh file kept
  {
    const dir = mkdtempSync(join(tmp, 'age-'));
    makeFile(dir, 'old.png', 1024, NOW - 8 * DAY_MS); // 8 days old → delete
    makeFile(dir, 'fresh.png', 2048, NOW - 1 * DAY_MS); // 1 day old → keep
    const r = await gcInbox({
      dir,
      maxAgeMs: 7 * DAY_MS,
      maxSizeBytes: 500 * MB,
      now: NOW,
    });
    if (r.removed !== 1) fail(`3: expected 1 removed, got ${r.removed}`);
    if (r.bytesFreed !== 1024) fail(`3: bytesFreed expected 1024, got ${r.bytesFreed}`);
    if (r.remaining !== 1) fail(`3: 1 file should remain, got ${r.remaining}`);
    if (!existsSync(join(dir, 'fresh.png'))) fail(`3: fresh file should survive`);
    if (existsSync(join(dir, 'old.png'))) fail(`3: old file should be gone`);
    testNum++;
  }

  // 4. Boundary: file exactly at threshold (mtime === cutoff) is KEPT
  //    (strict `<` for stale check, matches isMissedRunStale convention)
  {
    const dir = mkdtempSync(join(tmp, 'boundary-'));
    makeFile(dir, 'exactly-at.png', 1024, NOW - 7 * DAY_MS); // exactly 7 days
    makeFile(dir, 'just-over.png', 1024, NOW - 7 * DAY_MS - 1); // 7d + 1ms
    const r = await gcInbox({
      dir,
      maxAgeMs: 7 * DAY_MS,
      maxSizeBytes: 500 * MB,
      now: NOW,
    });
    if (r.removed !== 1) fail(`4: expected exactly 1 removed (just-over), got ${r.removed}`);
    if (!existsSync(join(dir, 'exactly-at.png'))) fail(`4: exactly-at-threshold must survive`);
    if (existsSync(join(dir, 'just-over.png'))) fail(`4: just-over-threshold must be removed`);
    testNum++;
  }

  // 5. Size cap LRU: total > cap → evict oldest first until under cap.
  //    All files fresh (within age), only size matters.
  {
    const dir = mkdtempSync(join(tmp, 'lru-'));
    // 5 files, 100MB each, total 500MB. Cap = 250MB → evict 3 oldest.
    for (let i = 0; i < 5; i++) {
      makeFile(dir, `file-${i}.png`, 100 * MB, NOW - (5 - i) * 60_000);
      // file-0 is oldest (5min), file-4 is newest (1min)
    }
    const r = await gcInbox({
      dir,
      maxAgeMs: 7 * DAY_MS,
      maxSizeBytes: 250 * MB,
      now: NOW,
    });
    if (r.removed !== 3) fail(`5: expected 3 evicted, got ${r.removed}`);
    // Should remain: file-3, file-4 (the two newest)
    if (existsSync(join(dir, 'file-0.png'))) fail(`5: file-0 (oldest) should be evicted`);
    if (existsSync(join(dir, 'file-1.png'))) fail(`5: file-1 should be evicted`);
    if (existsSync(join(dir, 'file-2.png'))) fail(`5: file-2 should be evicted`);
    if (!existsSync(join(dir, 'file-3.png'))) fail(`5: file-3 should survive`);
    if (!existsSync(join(dir, 'file-4.png'))) fail(`5: file-4 should survive`);
    if (r.finalSize !== 200 * MB) fail(`5: finalSize expected 200MB, got ${r.finalSize}`);
    testNum++;
  }

  // 6. Combined: age expiry FIRST removes some files; remaining size
  //    still over cap → LRU pass removes more. Confirms the two passes
  //    compose correctly.
  {
    const dir = mkdtempSync(join(tmp, 'combined-'));
    // 2 stale files (10MB each) + 4 fresh files (100MB each) = 420MB
    // After age pass: 4 × 100MB = 400MB
    // Size cap 250MB → evict 2 oldest fresh ones
    // Final: 2 × 100MB = 200MB
    makeFile(dir, 'stale-a.png', 10 * MB, NOW - 8 * DAY_MS);
    makeFile(dir, 'stale-b.png', 10 * MB, NOW - 9 * DAY_MS);
    for (let i = 0; i < 4; i++) {
      makeFile(dir, `fresh-${i}.png`, 100 * MB, NOW - (4 - i) * 60_000);
    }
    const r = await gcInbox({
      dir,
      maxAgeMs: 7 * DAY_MS,
      maxSizeBytes: 250 * MB,
      now: NOW,
    });
    // 2 stale removed by age + 2 fresh evicted by size = 4 total
    if (r.removed !== 4) fail(`6: expected 4 total removed, got ${r.removed}`);
    if (r.bytesFreed !== 2 * 10 * MB + 2 * 100 * MB) {
      fail(`6: bytesFreed mismatch: ${r.bytesFreed}`);
    }
    if (r.finalSize !== 200 * MB) fail(`6: finalSize expected 200MB, got ${r.finalSize}`);
    // Verify the right files survive (the 2 NEWEST of the 4 fresh)
    if (!existsSync(join(dir, 'fresh-2.png'))) fail(`6: fresh-2 should survive`);
    if (!existsSync(join(dir, 'fresh-3.png'))) fail(`6: fresh-3 should survive`);
    if (existsSync(join(dir, 'fresh-0.png'))) fail(`6: fresh-0 should be size-evicted`);
    if (existsSync(join(dir, 'fresh-1.png'))) fail(`6: fresh-1 should be size-evicted`);
    testNum++;
  }

  // 7. Subdirectories ignored — only top-level files counted
  {
    const dir = mkdtempSync(join(tmp, 'subdir-'));
    makeFile(dir, 'top.png', 100, NOW - 8 * DAY_MS); // stale, should delete
    // Create a subdir with a stale file inside — must NOT be touched
    const sub = mkdtempSync(join(dir, 'sub-'));
    makeFile(sub, 'inner.png', 100, NOW - 30 * DAY_MS);
    const r = await gcInbox({
      dir,
      maxAgeMs: 7 * DAY_MS,
      maxSizeBytes: 500 * MB,
      now: NOW,
    });
    if (r.removed !== 1) fail(`7: only top-level file should be removed, got ${r.removed}`);
    if (!existsSync(join(sub, 'inner.png'))) fail(`7: subdirectory contents must survive`);
    testNum++;
  }

  // 8. All files survive when nothing is stale + size is under cap
  {
    const dir = mkdtempSync(join(tmp, 'survive-'));
    for (let i = 0; i < 3; i++) {
      makeFile(dir, `keep-${i}.png`, 10 * MB, NOW - i * 60_000);
    }
    const r = await gcInbox({
      dir,
      maxAgeMs: 7 * DAY_MS,
      maxSizeBytes: 500 * MB,
      now: NOW,
    });
    if (r.removed !== 0) fail(`8: nothing should be removed, got ${r.removed}`);
    if (r.remaining !== 3) fail(`8: all 3 should remain, got ${r.remaining}`);
    if (readdirSync(dir).length !== 3) fail(`8: 3 files should still be on disk`);
    testNum++;
  }

  // 9. Size cap exactly at total: borderline case, nothing evicted
  //    (uses strict `>`, so total === cap is fine)
  {
    const dir = mkdtempSync(join(tmp, 'exact-'));
    for (let i = 0; i < 5; i++) {
      makeFile(dir, `f-${i}.png`, 50 * MB, NOW - i * 60_000); // 250MB total
    }
    const r = await gcInbox({
      dir,
      maxAgeMs: 7 * DAY_MS,
      maxSizeBytes: 250 * MB, // exactly equal — no eviction
      now: NOW,
    });
    if (r.removed !== 0) fail(`9: at-cap should not evict (strict >), got ${r.removed}`);
    if (r.finalSize !== 250 * MB) fail(`9: finalSize should equal cap, got ${r.finalSize}`);
    testNum++;
  }

  // 10. Mixed file types (no extension filtering — inbox holds whatever)
  {
    const dir = mkdtempSync(join(tmp, 'mixed-'));
    makeFile(dir, 'screenshot.png', 100, NOW - 8 * DAY_MS);
    makeFile(dir, 'report.pdf', 100, NOW - 8 * DAY_MS);
    makeFile(dir, 'data.bin', 100, NOW - 8 * DAY_MS);
    makeFile(dir, 'no-ext', 100, NOW - 8 * DAY_MS);
    const r = await gcInbox({
      dir,
      maxAgeMs: 7 * DAY_MS,
      maxSizeBytes: 500 * MB,
      now: NOW,
    });
    if (r.removed !== 4) fail(`10: all 4 stale should be removed regardless of extension, got ${r.removed}`);
    testNum++;
  }

  // 11. R2-followup: pass 1 (age expiry) — unlink failure pushes the
  //     entry into survivors so finalSize + remaining reflect on-disk
  //     state. Pre-followup the swallow worked but the stats counted
  //     the file as evicted; pass 1 ALREADY did this correctly, so
  //     this test is the symmetric guard / regression lock.
  {
    const dir = mkdtempSync(join(tmp, 'age-eacces-'));
    makeFile(dir, 'undeletable.png', 100, NOW - 8 * DAY_MS); // stale
    makeFile(dir, 'fresh.png', 200, NOW - 1 * DAY_MS); // not stale
    const r = await gcInbox({
      dir,
      maxAgeMs: 7 * DAY_MS,
      maxSizeBytes: 500 * MB,
      now: NOW,
      // Simulate EACCES on the stale file (and any other unlink) —
      // cross-platform via injected mock.
      unlinkFn: async (p) => {
        if (p.endsWith('undeletable.png')) {
          throw Object.assign(new Error('mock EACCES'), { code: 'EACCES' });
        }
        // For other paths, defer to real unlink
        const realFs = await import('node:fs/promises');
        return realFs.unlink(p);
      },
    });
    if (r.removed !== 0) fail(`11: unlink failed, nothing should count as removed (got ${r.removed})`);
    if (r.bytesFreed !== 0) fail(`11: bytesFreed must reflect actual freed, got ${r.bytesFreed}`);
    if (r.remaining !== 2) fail(`11: both files still on disk → remaining=2, got ${r.remaining}`);
    if (r.finalSize !== 300) fail(`11: finalSize must reflect both files, got ${r.finalSize}`);
    if (!existsSync(join(dir, 'undeletable.png'))) fail(`11: undeletable.png still on disk per mock`);
    testNum++;
  }

  // 12. R2-followup: pass 2 (LRU) — unlink failure must NOT silently
  //     subtract from totalSize. Pre-followup THIS was the real bug:
  //     undeletable file's bytes were subtracted as if freed, and the
  //     entry was dropped from survivors → finalSize and remaining
  //     lied about actual disk state.
  {
    const dir = mkdtempSync(join(tmp, 'lru-eacces-'));
    // 3 files × 100MB each, cap 150MB → must evict 2 oldest.
    // Make the oldest undeletable. Expected: middle+newest survive
    // (size-evict middle one too since cap is 150MB and oldest blocks
    // 100MB), undeletable counted in finalSize.
    makeFile(dir, 'lru-old.png', 100 * MB, NOW - 3 * 60_000);
    makeFile(dir, 'lru-mid.png', 100 * MB, NOW - 2 * 60_000);
    makeFile(dir, 'lru-new.png', 100 * MB, NOW - 1 * 60_000);
    const r = await gcInbox({
      dir,
      maxAgeMs: 7 * DAY_MS,
      maxSizeBytes: 150 * MB,
      now: NOW,
      unlinkFn: async (p) => {
        if (p.endsWith('lru-old.png')) {
          throw Object.assign(new Error('mock EACCES'), { code: 'EACCES' });
        }
        const realFs = await import('node:fs/promises');
        return realFs.unlink(p);
      },
    });
    // Loop: shift old → unlink fails → undeletable. Still over cap (300MB).
    //       shift mid → unlink succeeds → totalSize=200MB. Still over cap.
    //       shift new → unlink succeeds → totalSize=100MB. Under cap, exit.
    // Wait — that would leave NOTHING behind that we wanted to keep.
    // Re-check: survivors after sort = [old, mid, new]. Cap is 150MB.
    // After shift+fail(old): totalSize=300 (unchanged). survivors=[mid, new].
    // After shift+succeed(mid): totalSize=200. survivors=[new]. Still > cap.
    // After shift+succeed(new): totalSize=100. Under cap, exit.
    // Push undeletables back into survivors: survivors=[old].
    // So: removed=2 (mid, new), bytesFreed=200MB, finalSize=100MB (only
    // the old's 100MB), remaining=1 (only old).
    if (r.removed !== 2) fail(`12: 2 files actually deleted (mid+new), got ${r.removed}`);
    if (r.bytesFreed !== 200 * MB) fail(`12: bytesFreed should be 200MB, got ${r.bytesFreed}`);
    // Pre-followup: totalSize would have been mis-subtracted on the
    // first iteration → finalSize=0, remaining=0. THE BUG.
    // Post-followup: undeletable's bytes never subtracted → finalSize=100MB.
    if (r.finalSize !== 100 * MB) {
      fail(`12 (THE BUG): finalSize must reflect undeletable still on disk, got ${r.finalSize} (pre-fix would have reported 0)`);
    }
    if (r.remaining !== 1) {
      fail(`12 (THE BUG): remaining must count the undeletable, got ${r.remaining} (pre-fix would have reported 0)`);
    }
    if (!existsSync(join(dir, 'lru-old.png'))) fail(`12: undeletable file still on disk per mock`);
    if (existsSync(join(dir, 'lru-mid.png'))) fail(`12: lru-mid should be evicted`);
    if (existsSync(join(dir, 'lru-new.png'))) fail(`12: lru-new should be evicted`);
    testNum++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`inbox-gc smoke: ${testNum}/${testNum} PASS`);
