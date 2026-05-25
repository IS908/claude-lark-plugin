/**
 * Append-only audit log for sensitive MCP tool invocations.
 *
 * Purpose: the operator can retrospectively inspect which tools were called
 * on their machine, by whom, and with what outcome. This is primarily a
 * defense against terminal-side incidents (borrowed laptop, screen share,
 * accidental invocation) — the log itself is plaintext on the same disk,
 * so the trust boundary is OS file permissions.
 *
 * Best-effort: log failures never propagate out of this module (would be
 * worse to crash a tool call because of a log I/O issue).
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { appendWithRotationSync } from './log-rotation.js';
import { appConfig } from './config.js';

const DEFAULT_PATH = join(homedir(), '.claude', 'channels', 'lark', 'audit.log');

function resolvePath(): string {
  return process.env.LARK_AUDIT_LOG || DEFAULT_PATH;
}

export type AuditOutcome = 'ok' | 'denied' | 'error';

/** Best-effort append. Never throws. */
export async function audit(
  tool: string,
  caller: string | null,
  args: Record<string, unknown>,
  outcome: AuditOutcome,
): Promise<void> {
  // Wrap the whole body — JSON.stringify can throw on non-serializable args
  // (circular refs, bigint, etc.), and a logging side-effect must never
  // affect the calling tool's behavior.
  try {
    let argsStr: string;
    try {
      argsStr = JSON.stringify(redact(args));
    } catch {
      argsStr = '<unserializable>';
    }
    const line =
      [
        new Date().toISOString(),
        tool.padEnd(18),
        outcome.padEnd(7),
        `caller=${caller ?? '-'}`,
        `args=${argsStr}`,
      ].join('  ') + '\n';

    const path = resolvePath();
    await mkdir(dirname(path), { recursive: true });
    // #109 fix: rotate at LARK_LOG_MAX_BYTES (default 50MB). Pre-fix
    // audit.log grew without bound. Uses the sync helper here even
    // though the surrounding flow is async — the rotation check is
    // cheap (one stat) and keeps the failure modes obvious.
    appendWithRotationSync(path, line, appConfig.logMaxBytes);
  } catch {
    // Silent — log failures should never affect tool behavior.
  }
}

/**
 * Truncate long string fields so the log stays scannable and doesn't balloon
 * on large save_memory / prompt payloads.
 */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 80) {
      out[k] = `${v.slice(0, 60)}… (${v.length} chars)`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
