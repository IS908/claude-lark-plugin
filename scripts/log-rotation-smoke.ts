/**
 * Log rotation smoke test (v1.0.36, closes #109 part 2 — debug.log /
 * audit.log / hook-audit.log bounding).
 *
 * Direct unit test of `appendWithRotationSync`. Integrations into the
 * 3 call sites (channel.ts debugLog, audit-log.ts audit, hook
 * inline) are verified by code review — they're one-liners.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendWithRotationSync } from '../src/log-rotation.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'log-rotation-'));
let testNum = 0;

try {
  // 1. First write to a fresh path → creates the file, no rotation
  {
    const p = join(tmp, '1.log');
    appendWithRotationSync(p, 'first line\n', 1024);
    if (!existsSync(p)) fail(`1: file should be created`);
    if (existsSync(p + '.1')) fail(`1: no rotated copy on first write`);
    if (readFileSync(p, 'utf-8') !== 'first line\n') fail(`1: content mismatch`);
    testNum++;
  }

  // 2. Multiple writes under threshold → simple append
  {
    const p = join(tmp, '2.log');
    appendWithRotationSync(p, 'a\n', 1024);
    appendWithRotationSync(p, 'b\n', 1024);
    appendWithRotationSync(p, 'c\n', 1024);
    if (readFileSync(p, 'utf-8') !== 'a\nb\nc\n') fail(`2: appends should accumulate`);
    if (existsSync(p + '.1')) fail(`2: no rotation under threshold`);
    testNum++;
  }

  // 3. Write past threshold → rotate, fresh file starts with new line
  {
    const p = join(tmp, '3.log');
    // Seed with content larger than threshold (10 bytes)
    writeFileSync(p, 'A'.repeat(50));
    appendWithRotationSync(p, 'new\n', 10);
    // Rotation: original now lives at p.1, p is just "new\n"
    if (!existsSync(p + '.1')) fail(`3: .1 should exist after rotation`);
    if (readFileSync(p + '.1', 'utf-8') !== 'A'.repeat(50)) fail(`3: .1 should hold pre-rotation content`);
    if (readFileSync(p, 'utf-8') !== 'new\n') fail(`3: live file should contain only the new write`);
    testNum++;
  }

  // 4. Rotation overwrites existing .1 (single-generation policy)
  {
    const p = join(tmp, '4.log');
    // Seed both live and .1 with distinguishable content
    writeFileSync(p, 'B'.repeat(50));
    writeFileSync(p + '.1', 'PREVIOUS_ROTATED');
    appendWithRotationSync(p, 'next\n', 10);
    // .1 should now hold the B's, not the PREVIOUS_ROTATED
    if (readFileSync(p + '.1', 'utf-8') !== 'B'.repeat(50)) {
      fail(`4: .1 should hold latest pre-rotation content (overwriting prior .1)`);
    }
    if (readFileSync(p, 'utf-8') !== 'next\n') fail(`4: live should have only new line`);
    testNum++;
  }

  // 5. Boundary: file size exactly at threshold → NO rotation (strict >)
  {
    const p = join(tmp, '5.log');
    writeFileSync(p, 'X'.repeat(100)); // exactly 100 bytes
    appendWithRotationSync(p, 'Y\n', 100);
    // At threshold (size === maxBytes), strict > means no rotation.
    if (existsSync(p + '.1')) fail(`5: at-threshold should NOT rotate (strict >)`);
    if (readFileSync(p, 'utf-8') !== 'X'.repeat(100) + 'Y\n') {
      fail(`5: at-threshold should simply append`);
    }
    testNum++;
  }

  // 6. Stat failure (path doesn't exist) is swallowed → appends OK
  {
    const p = join(tmp, '6.log');
    let onErrorCalls = 0;
    appendWithRotationSync(p, 'first\n', 100, () => { onErrorCalls++; });
    if (!existsSync(p)) fail(`6: file should be created`);
    if (onErrorCalls !== 0) fail(`6: stat ENOENT on nonexistent should be silently treated as size 0`);
    testNum++;
  }

  // 7. Append failure (path is a directory) is swallowed → no throw
  {
    const p = join(tmp, '7.log');
    // Create as a directory to force EISDIR on append
    mkdirSync(p);
    let threw = false;
    let onErrorCalls = 0;
    try {
      appendWithRotationSync(p, 'x\n', 100, () => { onErrorCalls++; });
    } catch {
      threw = true;
    }
    if (threw) fail(`7: append-to-dir must not throw`);
    if (onErrorCalls < 1) fail(`7: append-to-dir should fire onError (got ${onErrorCalls})`);
    testNum++;
  }

  // 8. Multi-line writes work correctly (helper preserves caller's framing)
  {
    const p = join(tmp, '8.log');
    appendWithRotationSync(p, 'line 1\nline 2\nline 3\n', 1024);
    if (readFileSync(p, 'utf-8') !== 'line 1\nline 2\nline 3\n') {
      fail(`8: multi-line write should not be transformed`);
    }
    testNum++;
  }

  // 9. Empty string write is a no-op file-creation
  {
    const p = join(tmp, '9.log');
    appendWithRotationSync(p, '', 100);
    if (!existsSync(p)) fail(`9: empty write should still create the file`);
    if (statSync(p).size !== 0) fail(`9: empty write should leave 0-byte file`);
    testNum++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`log-rotation smoke: ${testNum}/${testNum} PASS`);
