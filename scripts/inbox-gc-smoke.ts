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
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`inbox-gc smoke: ${testNum}/${testNum} PASS`);
