/**
 * Inbox garbage collection (#89). The inbox directory
 * (`~/.claude/channels/lark/inbox/`) is where:
 *   - `LarkChannel.downloadImage` writes auto-downloaded images from
 *     inbound messages (channel.ts).
 *   - The `download_attachment` tool writes attachments fetched by
 *     Claude (tools.ts).
 *
 * Pre-v1.0.35 neither path called `fs.unlink` and there was no startup
 * sweep or periodic cleanup. A heavy-image deployment would silently
 * fill the disk over weeks. This module is the missing GC.
 *
 * Two complementary policies (both apply on each run):
 *   1. **Age expiry**: files whose mtime is older than `maxAgeMs`
 *      are deleted. 7 days by default — comfortably exceeds any
 *      reasonable Claude turn so a mid-turn Read of `image_path`
 *      always finds its file.
 *   2. **Size cap**: if total directory size exceeds `maxSizeBytes`,
 *      oldest-first LRU eviction continues until under cap.
 *
 * The age pass runs FIRST. Files already gone via age don't contribute
 * to the size check, so an operator who configured a small age + large
 * size cap (rotate quickly, keep recent burst) gets predictable
 * behavior.
 *
 * Best-effort throughout: `unlink` failures (file vanished concurrently,
 * permission revoked) are swallowed so one bad file doesn't abort
 * cleanup of the rest. `readdir` failure (dir missing) is a no-op —
 * nothing to collect.
 *
 * Returns a stats object for tests + operator logging.
 */
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { appConfig } from './config.js';

export interface GcInboxOptions {
  /** Inbox directory. Defaults to appConfig.inboxDir. */
  dir?: string;
  /** Max age in ms. Defaults to appConfig.inboxMaxAgeDays × 86400_000. */
  maxAgeMs?: number;
  /** Max total size in bytes. Defaults to appConfig.inboxMaxSizeMB × 1024 × 1024. */
  maxSizeBytes?: number;
  /** Reference "now" timestamp in ms (for deterministic tests). Defaults to Date.now(). */
  now?: number;
}

export interface GcInboxResult {
  /** Total files removed (age + LRU combined). */
  removed: number;
  /** Bytes freed. */
  bytesFreed: number;
  /** Final directory size in bytes after GC. */
  finalSize: number;
  /** Files left in the directory after GC. */
  remaining: number;
}

export async function gcInbox(opts: GcInboxOptions = {}): Promise<GcInboxResult> {
  const dir = opts.dir ?? appConfig.inboxDir;
  const maxAgeMs = opts.maxAgeMs ?? appConfig.inboxMaxAgeDays * 86_400_000;
  const maxSizeBytes = opts.maxSizeBytes ?? appConfig.inboxMaxSizeMB * 1024 * 1024;
  const now = opts.now ?? Date.now();

  if (!existsSync(dir)) {
    return { removed: 0, bytesFreed: 0, finalSize: 0, remaining: 0 };
  }

  // Snapshot all file entries + stats up-front. A concurrent writer can
  // land a NEW file after this snapshot — that file is just skipped by
  // this GC pass and considered by the next one. No staleness concern
  // for correctness; mtime monotone-forward.
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // readdir failed (race with rmdir, permission revoke). Nothing to do.
    return { removed: 0, bytesFreed: 0, finalSize: 0, remaining: 0 };
  }

  interface Entry {
    path: string;
    mtimeMs: number;
    size: number;
  }
  const files: Entry[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = path.join(dir, e.name);
    try {
      const s = await fs.stat(p);
      files.push({ path: p, mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      // File vanished between readdir and stat — benign race with
      // another caller of gcInbox or a manual rm. Skip silently.
    }
  }

  let removed = 0;
  let bytesFreed = 0;

  // Pass 1: age expiry. Strict `<` so an entry whose mtime is exactly
  // (now - maxAgeMs) is borderline and KEPT. This matches the
  // isMissedRunStale convention in src/scheduler.ts.
  const cutoff = now - maxAgeMs;
  const survivors: Entry[] = [];
  for (const f of files) {
    if (f.mtimeMs < cutoff) {
      try {
        await fs.unlink(f.path);
        removed++;
        bytesFreed += f.size;
      } catch {
        // unlink failed (already gone, EACCES). Keep the entry in
        // survivors so the size accounting reflects what's actually on
        // disk — better to over-count than under-count when deciding
        // whether the size cap is reached.
        survivors.push(f);
      }
    } else {
      survivors.push(f);
    }
  }

  // Pass 2: size cap (LRU). Sum surviving sizes; if over cap, sort by
  // mtime ascending and unlink until under cap.
  let totalSize = survivors.reduce((acc, f) => acc + f.size, 0);
  if (totalSize > maxSizeBytes) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    while (totalSize > maxSizeBytes && survivors.length > 0) {
      const oldest = survivors.shift()!;
      try {
        await fs.unlink(oldest.path);
        removed++;
        bytesFreed += oldest.size;
        totalSize -= oldest.size;
      } catch {
        // unlink failed. Subtract from running total anyway so we don't
        // loop forever on an undeletable file. Operator will see it on
        // disk; we just can't reach it.
        totalSize -= oldest.size;
      }
    }
  }

  return {
    removed,
    bytesFreed,
    finalSize: totalSize,
    remaining: survivors.length,
  };
}

/**
 * Convenience wrapper for the periodic scheduler: logs the GC result
 * to stderr at info-level if anything was actually removed. Silent
 * when there's nothing to do (most ticks).
 */
export async function runInboxGcOnce(): Promise<void> {
  if (appConfig.inboxGcDisabled) return;
  try {
    const result = await gcInbox();
    if (result.removed > 0) {
      const mb = (result.bytesFreed / (1024 * 1024)).toFixed(1);
      const finalMb = (result.finalSize / (1024 * 1024)).toFixed(1);
      console.error(
        `[inbox-gc] removed ${result.removed} file(s), freed ${mb}MB ` +
        `(${result.remaining} remain, ${finalMb}MB total)`,
      );
    }
  } catch (err) {
    console.error('[inbox-gc] run failed:', err);
  }
}
