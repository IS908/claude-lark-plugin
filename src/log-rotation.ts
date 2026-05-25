/**
 * Single-file log rotation helper (#109). The daemon writes 3 append-
 * only logs that pre-v1.0.36 had no rotation:
 *   - `~/.claude/channels/lark/debug.log` (channel.ts) — verbose event
 *     trace, ~5GB/month at high message rate
 *   - `~/.claude/channels/lark/audit.log` (audit-log.ts) — sensitive
 *     tool invocations, slower but still unbounded
 *   - `~/.claude/channels/lark/hook-audit.log` (hooks/) — Stop hook
 *     decisions
 *
 * Rotation policy is intentionally minimal: keep ONE rotated copy
 * (`<path>.1`). When the live file exceeds `maxBytes`, rename it to
 * `.1` (overwriting any prior `.1`), then start fresh. The next
 * write lands in an empty live file. Effective on-disk cap is
 * `~2 × maxBytes`.
 *
 * Why not multi-generation rotation: this is an MCP daemon, not a
 * production service log. Operators who want long retention can
 * `mv audit.log.1 audit-2026-05.log` from cron. Single-generation
 * keeps the rotation logic small and the failure modes obvious.
 *
 * Best-effort throughout: `stat` failure (file doesn't exist),
 * `rename` failure (filesystem hiccup), and `appendFile` failure are
 * all swallowed — log writes must NEVER affect the calling
 * tool's behavior. The check is on every append; a high-rate writer
 * pays one `stat` per call. Cheap (~microseconds) and avoids the
 * complexity of a periodic-check approach.
 */
import { appendFileSync, renameSync, statSync } from 'node:fs';

/**
 * Append `line` (with a trailing newline already present, or expected
 * to be added by the caller) to `path`, rotating to `${path}.1` first
 * if the live file is over `maxBytes`. Synchronous to match the
 * existing call sites (`appendFileSync` was the pre-fix pattern).
 *
 * `line` may include any number of newlines; the helper doesn't add
 * one. The caller controls the framing.
 *
 * Returns `void`; failures are swallowed and logged at debug level
 * via the optional `onError` hook (used by tests; production callers
 * omit it for the silent-failure semantic).
 */
export function appendWithRotationSync(
  path: string,
  line: string,
  maxBytes: number,
  onError?: (err: Error) => void,
): void {
  try {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // File doesn't exist yet (first write) or stat failed for
      // another reason — treat as size 0 so we proceed to append.
    }
    if (size > maxBytes) {
      // Rotate: rename live → .1 (overwriting any prior .1). On Unix
      // this is atomic via the underlying rename(2). Errors swallowed
      // — worst case the file just keeps growing this write, next
      // write retries the rotation check.
      try {
        renameSync(path, `${path}.1`);
      } catch (err) {
        onError?.(err as Error);
      }
    }
    appendFileSync(path, line);
  } catch (err) {
    onError?.(err as Error);
  }
}
