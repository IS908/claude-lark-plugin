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
 * is HEAVY and the channel is IDLE and QUIET, it DMs the owner
 * suggesting they type `/compact` (or `/clear`) in the terminal —
 * compaction happens at an idle boundary, on the operator's terms,
 * with zero upstream dependency. Reminders follow an exponential
 * ladder (base × 2^(n-1) after the n-th unanswered nudge; 0/+2h/+6h/
 * +14h cumulative at the 2h default), at most 4 per episode, with
 * close/re-arm detection — see the Episode model block below.
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
  /**
   * Base interval of the exponential-backoff ladder. After the n-th
   * unanswered nudge the next one is due `cooldownMs × 2^(n-1)` later:
   * with the 2 h default the undelayed schedule is 0 / +2 h / +6 h /
   * +14 h cumulative. Each rung anchors on the ACTUAL previous send
   * (not an absolute timetable), so a rung delayed by a busy channel
   * shifts the rest instead of double-firing.
   */
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
  | 'rearm-floor'
  | 'not-idle'
  | 'busy'
  | 'cooldown'
  | 'episode-closed'
  | 'episode-exhausted'
  | 'retry-wait'
  | 'send-failed'
  | 'nudged';

const DEFAULT_STATS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** After a FAILED send, wait this long before retrying (a failed send never consumes a ladder rung). */
const SEND_RETRY_BACKOFF_MS = 15 * 60 * 1000;

// ── Episode model ──
// One "episode" = one continuous heavy-and-unhandled stretch. The
// ladder caps total reminders per episode so a deliberately-ignoring
// operator gets silence, not a drumbeat; close/re-arm rules detect
// (via the next Stop event's measurement) that the operator acted.
//
/** Hard cap of nudges per episode. With the 2 h base the 4th rung lands
 * at +14 h — the last rung that can still see fresh stats inside the
 * 24 h stats window; further doubling would never fire. */
const MAX_NUDGES_PER_EPISODE = 4;
/** Tokens dropping to ≤70% of the last-nudged value ⇒ the operator
 * compacted (even if still above threshold) — close the episode. */
const EPISODE_CLOSE_DROP_RATIO = 0.7;
/** After a drop-close or an exhausted episode, a NEW episode arms only
 * once tokens regrow ≥25% past the reference value — prevents an
 * instant re-nudge right after the operator compacted to a level that
 * still sits above the threshold. */
const EPISODE_REARM_GROWTH_RATIO = 1.25;
/** A day of ladder silence ⇒ stale episode state; start fresh. */
const EPISODE_RESET_MS = 24 * 60 * 60 * 1000;

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
  private lastAttemptAt = 0;
  // Episode state (see the Episode model block above).
  private nudgeCount = 0;
  private nextDueAt = 0;
  private lastNudgedTokens = 0;
  /** New episode arms only at tokens ≥ this (set by a drop-close). 0 = no floor. */
  private rearmFloorTokens = 0;
  /** Last ladder event (nudge OR close) — anchors the 24 h staleness reset. */
  private lastEpisodeEventAt = 0;
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

  /** Wipe all episode state — used by the 24 h staleness reset. */
  private resetEpisode(): void {
    this.nudgeCount = 0;
    this.nextDueAt = 0;
    this.lastNudgedTokens = 0;
    this.rearmFloorTokens = 0;
  }

  /**
   * One evaluation pass. Synchronous decision, async send. Returns the
   * outcome so callers/tests can observe why no nudge fired.
   */
  async tick(): Promise<TickOutcome> {
    if (!this.cfg.enabled) return 'disabled';

    const now = this.now();

    // A day with no ladder events means the episode context is stale
    // (bot offline, stats expired, long quiet stretch) — start fresh.
    if (
      (this.nudgeCount > 0 || this.rearmFloorTokens > 0) &&
      now - this.lastEpisodeEventAt > EPISODE_RESET_MS
    ) {
      this.resetEpisode();
    }

    const heaviest = heaviestRecentSession(this.deps.readStats(), now, this.statsMaxAgeMs);
    if (!heaviest) return 'no-stats';

    // Close-on-drop: a fresh measurement at ≤70% of the last-nudged
    // value (or below threshold) means the operator compacted/cleared.
    // Set the re-arm floor so the new episode doesn't fire instantly
    // when the post-compact level still sits above the threshold.
    if (
      this.nudgeCount > 0 &&
      (heaviest.tokens < this.cfg.tokenThreshold ||
        heaviest.tokens <= this.lastNudgedTokens * EPISODE_CLOSE_DROP_RATIO)
    ) {
      const floor = Math.max(
        this.cfg.tokenThreshold,
        Math.round(heaviest.tokens * EPISODE_REARM_GROWTH_RATIO),
      );
      this.resetEpisode();
      this.rearmFloorTokens = floor;
      this.lastEpisodeEventAt = now;
      this.log(
        `[session-health] episode closed (tokens dropped to ${heaviest.tokens}); re-arm at ≥${floor}`,
      );
      return 'episode-closed';
    }

    if (heaviest.tokens < this.cfg.tokenThreshold) return 'below-threshold';
    if (this.nudgeCount === 0 && heaviest.tokens < this.rearmFloorTokens) return 'rearm-floor';

    if (this.nudgeCount >= MAX_NUDGES_PER_EPISODE) {
      // Exhausted — silence unless meaningful NEW accumulation arrived.
      if (heaviest.tokens >= this.lastNudgedTokens * EPISODE_REARM_GROWTH_RATIO) {
        this.resetEpisode();
      } else {
        return 'episode-exhausted';
      }
    }

    if (this.nudgeCount > 0 && now < this.nextDueAt) return 'cooldown';
    if (now - this.lastInboundAt < this.cfg.idleMs) return 'not-idle';
    if (!this.deps.isQuiet()) return 'busy';
    if (now - this.lastAttemptAt < SEND_RETRY_BACKOFF_MS) return 'retry-wait';

    this.lastAttemptAt = now;
    const rung = this.nudgeCount + 1;
    const nextIntervalMs = this.cfg.cooldownMs * 2 ** this.nudgeCount;
    const idleMin = Math.round((now - this.lastInboundAt) / 60_000);
    const followUp =
      rung < MAX_NUDGES_PER_EPISODE
        ? `If ignored, the next reminder backs off to ~${Math.round(nextIntervalMs / 3_600_000)}h from now`
        : `This is the last reminder for this episode`;
    const text =
      `📊 Claude Code session ${heaviest.sessionId.slice(0, 8)}… has accumulated ` +
      `~${Math.round(heaviest.tokens / 1000)}k tokens of context ` +
      `(nudge threshold ${Math.round(this.cfg.tokenThreshold / 1000)}k). ` +
      `The channel has been idle for ${idleMin} min — a good moment to type /compact ` +
      `(or /clear for a full reset) in the terminal, so compaction happens at an idle ` +
      `boundary instead of mid-burst and the next long-idle cache write is cheaper. ` +
      `[${rung}/${MAX_NUDGES_PER_EPISODE}] ${followUp}; if you already compacted, ignore this — ` +
      `figures refresh on the next message. Tune via LARK_SESSION_NUDGE_*.`;

    try {
      await this.deps.sendOwnerNudge(text);
      this.nudgeCount = rung;
      this.nextDueAt = now + nextIntervalMs;
      this.lastNudgedTokens = heaviest.tokens;
      this.rearmFloorTokens = 0;
      this.lastEpisodeEventAt = now;
      this.log(
        `[session-health] nudge ${rung}/${MAX_NUDGES_PER_EPISODE} sent ` +
          `(session=${heaviest.sessionId.slice(0, 8)} tokens=${heaviest.tokens} idleMin=${idleMin} ` +
          `nextDueIn=${Math.round(nextIntervalMs / 60_000)}min)`,
      );
      return 'nudged';
    } catch (err) {
      // Episode state deliberately untouched — a transient DM failure
      // must not consume a ladder rung. lastAttemptAt applies the
      // shorter retry backoff instead.
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
