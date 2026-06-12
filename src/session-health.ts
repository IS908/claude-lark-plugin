/**
 * Session health monitor — the semi-automatic actuator for #190.
 *
 * Problem: the Claude Code main loop is one long-running session shared
 * by every chat/thread/cronjob. History accumulates (measured ~0.9M
 * tokens on the reference deployment) until fullness-driven
 * auto-compaction fires — typically MID-BURST, the worst timing. After
 * a long idle gap the next inbound pays cache-write (~125% of input
 * price) on the entire accumulated payload.
 *
 * The #190 feasibility verification established that no programmatic
 * `/compact` / `/clear` trigger exists (hooks observe only; the Skill
 * tool excludes built-ins; the Agent SDK has no compaction API; the
 * session is also shared with the operator's own terminal work, which
 * vetoes autonomous clears even if a mechanism existed). So this module
 * keeps #190's state machine but swaps the actuator: when the session
 * is HEAVY and the channel is IDLE and QUIET, it sends the owner one
 * rate-limited Feishu DM suggesting they type `/compact` (or `/clear`)
 * in the terminal — compaction happens at an idle boundary, on the
 * operator's terms, with zero upstream dependency.
 *
 * Inputs:
 * - Context size: the Stop hook (hooks/enforce-lark-reply.mjs) writes
 *   `{context_tokens, ts}` per session_id to a sidecar stats file on
 *   every Stop event. context_tokens is read from the transcript's
 *   last assistant `usage` (input + cache_read + cache_creation) — the
 *   EXACT current context size, no estimation.
 * - Idle: `noteInbound()` is called from the index.ts message handler
 *   on every forwarded message (IM, doc-comment, reaction), so idle
 *   means "nothing forwarded to Claude for idleMs".
 * - Quiet: `isQuiet()` (queue depth == 0) so the nudge never lands
 *   while a turn is in flight.
 *
 * All state is in-memory; restart resets idle/cooldown tracking (the
 * monitor then waits a full idleMs before it can nudge — conservative).
 */

import { readFileSync } from 'node:fs';

export interface SessionStatsEntry {
  context_tokens?: unknown;
  ts?: unknown;
}

export interface SessionStatsFile {
  sessions?: Record<string, SessionStatsEntry>;
}

export interface SessionHealthConfig {
  enabled: boolean;
  /** Nudge when the heaviest recent session exceeds this. */
  tokenThreshold: number;
  /** Channel must be inbound-idle for this long. */
  idleMs: number;
  /** Min spacing between successful nudges. */
  cooldownMs: number;
  /** Ignore stats entries older than this (default 24 h). */
  statsMaxAgeMs?: number;
}

export interface SessionHealthDeps {
  /** Returns parsed stats or null. Default impl reads a JSON file. */
  readStats: () => SessionStatsFile | null;
  /** Sends the owner DM. Rejections are caught and retried after a backoff. */
  sendOwnerNudge: (text: string) => Promise<void>;
  /** True when no conversation chain is in flight (queue depth 0). */
  isQuiet: () => boolean;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Outcome of a tick — returned for observability and tests. */
export type TickOutcome =
  | 'disabled'
  | 'no-stats'
  | 'below-threshold'
  | 'not-idle'
  | 'busy'
  | 'cooldown'
  | 'retry-wait'
  | 'send-failed'
  | 'nudged';

const DEFAULT_STATS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** After a FAILED send, wait this long before retrying (not the full cooldown). */
const SEND_RETRY_BACKOFF_MS = 15 * 60 * 1000;

/** Read + parse the sidecar stats file; null on any failure (fail-quiet). */
export function readStatsFile(path: string): SessionStatsFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as SessionStatsFile) : null;
  } catch {
    return null;
  }
}

/**
 * Pick the heaviest fresh entry. Multiple Claude Code sessions in the
 * same project (the bot's megasession + the operator's dev sessions)
 * all run the Stop hook, so the stats file is a per-session map — the
 * nudge cares about whichever recent session is heaviest.
 */
export function heaviestRecentSession(
  stats: SessionStatsFile | null,
  now: number,
  maxAgeMs: number,
): { sessionId: string; tokens: number } | null {
  if (!stats?.sessions || typeof stats.sessions !== 'object') return null;
  let best: { sessionId: string; tokens: number } | null = null;
  for (const [sessionId, entry] of Object.entries(stats.sessions)) {
    if (!entry || typeof entry !== 'object') continue;
    const tokens = typeof entry.context_tokens === 'number' && Number.isFinite(entry.context_tokens)
      ? entry.context_tokens
      : NaN;
    const ts = typeof entry.ts === 'string' ? Date.parse(entry.ts) : NaN;
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    if (!Number.isFinite(ts) || now - ts > maxAgeMs || ts - now > 60_000) continue;
    if (!best || tokens > best.tokens) best = { sessionId, tokens };
  }
  return best;
}

export class SessionHealthMonitor {
  private lastInboundAt: number;
  private lastNudgeAt = 0;
  private lastAttemptAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly statsMaxAgeMs: number;

  constructor(
    private readonly cfg: SessionHealthConfig,
    private readonly deps: SessionHealthDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.statsMaxAgeMs = cfg.statsMaxAgeMs ?? DEFAULT_STATS_MAX_AGE_MS;
    // Conservative startup: treat "monitor started" as inbound activity
    // so a fresh process always waits a full idleMs before nudging.
    this.lastInboundAt = this.now();
  }

  /** Call on every message forwarded to Claude (any source). */
  noteInbound(): void {
    this.lastInboundAt = this.now();
  }

  /**
   * One evaluation pass. Synchronous decision, async send. Returns the
   * outcome so callers/tests can observe why no nudge fired.
   */
  async tick(): Promise<TickOutcome> {
    if (!this.cfg.enabled) return 'disabled';

    const now = this.now();
    const heaviest = heaviestRecentSession(this.deps.readStats(), now, this.statsMaxAgeMs);
    if (!heaviest) return 'no-stats';
    if (heaviest.tokens < this.cfg.tokenThreshold) return 'below-threshold';
    if (now - this.lastInboundAt < this.cfg.idleMs) return 'not-idle';
    if (!this.deps.isQuiet()) return 'busy';
    if (now - this.lastNudgeAt < this.cfg.cooldownMs) return 'cooldown';
    if (now - this.lastAttemptAt < SEND_RETRY_BACKOFF_MS) return 'retry-wait';

    this.lastAttemptAt = now;
    const idleMin = Math.round((now - this.lastInboundAt) / 60_000);
    const cooldownH = Math.round(this.cfg.cooldownMs / 3_600_000);
    const text =
      `📊 Claude Code session ${heaviest.sessionId.slice(0, 8)}… has accumulated ` +
      `~${Math.round(heaviest.tokens / 1000)}k tokens of context ` +
      `(nudge threshold ${Math.round(this.cfg.tokenThreshold / 1000)}k). ` +
      `The channel has been idle for ${idleMin} min — a good moment to type /compact ` +
      `(or /clear for a full reset) in the terminal, so compaction happens at an idle ` +
      `boundary instead of mid-burst and the next long-idle cache write is cheaper. ` +
      `Reminder is rate-limited to once per ${cooldownH}h; tune via LARK_SESSION_NUDGE_*.`;

    try {
      await this.deps.sendOwnerNudge(text);
      this.lastNudgeAt = now;
      this.log(
        `[session-health] nudge sent (session=${heaviest.sessionId.slice(0, 8)} tokens=${heaviest.tokens} idleMin=${idleMin})`,
      );
      return 'nudged';
    } catch (err) {
      // lastNudgeAt deliberately NOT set — a transient DM failure must
      // not silence the nudge for a whole cooldown. lastAttemptAt
      // applies the shorter retry backoff instead.
      this.log(`[session-health] nudge send failed (retry in ${SEND_RETRY_BACKOFF_MS / 60_000}min): ${err}`);
      return 'send-failed';
    }
  }

  /** Start the periodic evaluation. unref'd — never holds the process open. */
  start(intervalMs: number): void {
    if (this.timer || !this.cfg.enabled) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
