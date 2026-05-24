/**
 * Single-instance lock helpers (#101).
 *
 * Split out from src/index.ts so unit tests can exercise the pure
 * helpers (parseLockToken, buildLockToken, getProcessStartTime)
 * WITHOUT importing src/index.ts itself — importing index.ts triggers
 * the top-level main() invocation, which connects to Feishu and
 * starts the scheduler. That side effect would make any unit test
 * that accidentally imports from index.ts pollute the user's real
 * bot.
 *
 * The acquireLock function itself stays in index.ts because it owns
 * process-level state (the LOCK_FILE path, the signal/exception
 * handlers). It calls into the helpers here for the actual logic.
 */

import { execFileSync } from 'node:child_process';

/**
 * Read a process's start time via POSIX `ps -p PID -o lstart=`.
 * Returns the start-time string (locale-formatted, but stable for a
 * given PID across reads of the same process) or null if the process
 * does not exist OR the platform's `ps` is unavailable.
 *
 * Used to disambiguate PID reuse: macOS/Linux recycle PIDs within
 * hours; checking only `process.kill(pid, 0)` says "a process with
 * this PID exists" but cannot prove it's the SAME process that wrote
 * the lock. Comparing start time against the recorded value pins
 * identity. Uses execFileSync (NOT execSync) with argv array so pid
 * cannot inject shell metacharacters; pid is also asserted to be a
 * positive integer first.
 *
 * Synchronous: acquireLock is startup-only; small `ps` shell-out is
 * cheap and bounded. stderr is ignored so a non-existent PID doesn't
 * print "No such process" noise to operator logs.
 */
export function getProcessStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // R1-audit followup on PR #124: pin LC_ALL=C / LANG=C so the
    // locale-formatted output is stable regardless of the operator's
    // environment. Pre-pin, a writer under default LANG and a reader
    // under sudo / systemd (which often clears LANG → C, or sets a
    // non-English locale like zh_CN.UTF-8) would see DIFFERENT
    // start-time strings for the SAME live process — the equality
    // check would fail → "stale, overwrite" → two bots run.
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Serialize a lock token. Format: `<pid>|<start-time-string>`. */
export function buildLockToken(pid: number): string {
  const startTime = getProcessStartTime(pid);
  return `${pid}|${startTime ?? ''}`;
}

/**
 * Parse a lock-file body into pid + recorded start time.
 *
 * Returns null on malformed input (empty, non-numeric pid, negative
 * or zero pid).
 *
 * Backward-compat: pre-v1.0.23 lock files contained PID-only (no
 * pipe). Parses cleanly with `startTime: ''` so acquireLock can
 * recognize the legacy form and overwrite (current PID's start-time
 * won't match empty string in the equality check).
 */
export function parseLockToken(content: string): { pid: number; startTime: string } | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const [pidStr, startTime = ''] = trimmed.split('|');
  const pid = parseInt(pidStr, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { pid, startTime };
}
