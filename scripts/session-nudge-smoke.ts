/**
 * Session-health nudge smoke test (v1.3.2, #190).
 *
 * Verifies the semi-automatic /compact reminder: gating order
 * (enabled → stats → close-on-drop → threshold → rearm-floor →
 * exhausted → ladder-due → idle → quiet → retry), the exponential
 * ladder (base × 2^(n-1) per unanswered nudge, 0/+2h/+6h/+14h at the
 * 2h base, 4 per episode), episode close/re-arm/auto-reset semantics,
 * heaviest-recent-session selection across the per-session stats map,
 * malformed-stats resilience, send-failure retry backoff, and the
 * noteInbound idle reset.
 *
 * Pure pieces only (SessionHealthMonitor, heaviestRecentSession);
 * the Stop-hook stats writer is exercised by
 * hooks/test-enforce-lark-reply.mjs, and index.ts wiring by
 * typecheck + dry-run.
 */

import {
  SessionHealthMonitor,
  heaviestRecentSession,
  type SessionStatsFile,
  type SessionHealthDeps,
} from '../src/session-health.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let testNum = 0;

const HOUR = 3_600_000;

function makeClock(start = 1_000_000_000_000): { now: () => number; set: (t: number) => void; add: (d: number) => void } {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v), add: (d: number) => (t += d) };
}

function statsWith(tokens: number, tsOffsetMs: number, now: number, sessionId = 'sess-heavy'): SessionStatsFile {
  return { sessions: { [sessionId]: { context_tokens: tokens, ts: new Date(now + tsOffsetMs).toISOString() } } };
}

interface Harness {
  monitor: SessionHealthMonitor;
  clock: ReturnType<typeof makeClock>;
  sent: string[];
  setStats: (s: SessionStatsFile | null) => void;
  setQuiet: (q: boolean) => void;
  setSendFail: (f: boolean) => void;
}

function makeHarness(over: Partial<{ enabled: boolean; tokenThreshold: number; idleMs: number; cooldownMs: number }> = {}): Harness {
  const clock = makeClock();
  let stats: SessionStatsFile | null = null;
  let quiet = true;
  let sendFail = false;
  const sent: string[] = [];
  const deps: SessionHealthDeps = {
    readStats: () => stats,
    isQuiet: () => quiet,
    sendOwnerNudge: async (text) => {
      if (sendFail) throw new Error('mock DM failure');
      sent.push(text);
    },
    now: clock.now,
  };
  const monitor = new SessionHealthMonitor(
    {
      enabled: over.enabled ?? true,
      tokenThreshold: over.tokenThreshold ?? 400_000,
      idleMs: over.idleMs ?? 30 * 60_000,
      // Ladder BASE (v1.3.2): undelayed schedule 0 / +2h / +6h / +14h.
      cooldownMs: over.cooldownMs ?? 2 * HOUR,
    },
    deps,
  );
  return {
    monitor,
    clock,
    sent,
    setStats: (s) => (stats = s),
    setQuiet: (q) => (quiet = q),
    setSendFail: (f) => (sendFail = f),
  };
}

/** Advance past the startup idle guard and return a ready-to-nudge harness. */
function readyHarness(tokens = 900_000): Harness {
  const h = makeHarness();
  h.clock.add(31 * 60_000); // past idleMs since construction
  h.setStats(statsWith(tokens, -60_000, h.clock.now()));
  return h;
}

// 1. Disabled → 'disabled', nothing sent
{
  testNum++;
  const h = makeHarness({ enabled: false });
  h.clock.add(HOUR);
  h.setStats(statsWith(900_000, -1000, h.clock.now()));
  if ((await h.monitor.tick()) !== 'disabled') fail('disabled monitor must return disabled');
  if (h.sent.length !== 0) fail('disabled monitor must not send');
}

// 2. No stats / unreadable stats → 'no-stats'
{
  testNum++;
  const h = makeHarness();
  h.clock.add(HOUR);
  h.setStats(null);
  if ((await h.monitor.tick()) !== 'no-stats') fail('null stats must return no-stats');
  h.setStats({} as SessionStatsFile);
  if ((await h.monitor.tick()) !== 'no-stats') fail('empty stats must return no-stats');
}

// 3. Below threshold → 'below-threshold'
{
  testNum++;
  const h = makeHarness();
  h.clock.add(HOUR);
  h.setStats(statsWith(100_000, -1000, h.clock.now()));
  if ((await h.monitor.tick()) !== 'below-threshold') fail('light session must not nudge');
}

// 4. Startup guard: heavy stats but monitor just constructed → 'not-idle'
{
  testNum++;
  const h = makeHarness();
  h.setStats(statsWith(900_000, -1000, h.clock.now()));
  if ((await h.monitor.tick()) !== 'not-idle') fail('fresh monitor must wait a full idleMs before nudging');
}

// 5. noteInbound resets the idle clock
{
  testNum++;
  const h = readyHarness();
  h.monitor.noteInbound();
  h.clock.add(10 * 60_000); // only 10 min since inbound
  h.setStats(statsWith(900_000, -1000, h.clock.now()));
  if ((await h.monitor.tick()) !== 'not-idle') fail('recent inbound must block the nudge');
  h.clock.add(21 * 60_000); // now 31 min since inbound
  if ((await h.monitor.tick()) !== 'nudged') fail('idle elapsed after inbound must nudge');
}

// 6. Busy queue → 'busy'
{
  testNum++;
  const h = readyHarness();
  h.setQuiet(false);
  if ((await h.monitor.tick()) !== 'busy') fail('in-flight queue must block the nudge');
}

// 7. Happy path: nudge fires once, text carries the numbers; immediate
//    repeat hits cooldown
{
  testNum++;
  const h = readyHarness(912_345);
  const outcome = await h.monitor.tick();
  if (outcome !== 'nudged') fail(`expected nudged, got ${outcome}`);
  if (h.sent.length !== 1) fail('exactly one DM expected');
  if (!h.sent[0].includes('912k')) fail(`nudge text must carry the token count: ${h.sent[0]}`);
  if (!h.sent[0].includes('/compact')) fail('nudge text must mention /compact');
  h.clock.add(60_000);
  h.setStats(statsWith(912_345, -1000, h.clock.now()));
  if ((await h.monitor.tick()) !== 'cooldown') fail('immediate re-tick must hit cooldown');
}

// 8. Ladder rung due → nudges again (rung 2 due at +base after rung 1)
{
  testNum++;
  const h = readyHarness();
  await h.monitor.tick(); // nudged (rung 1)
  h.clock.add(7 * HOUR); // well past the +2h rung-2 due time, still idle
  h.setStats(statsWith(900_000, -1000, h.clock.now()));
  if ((await h.monitor.tick()) !== 'nudged') fail('due ladder rung must nudge again');
  if (h.sent.length !== 2) fail('two DMs expected');
}

// 9. Stale stats entry (older than 24h) is ignored → 'no-stats'
{
  testNum++;
  const h = makeHarness();
  h.clock.add(HOUR);
  h.setStats(statsWith(900_000, -25 * HOUR, h.clock.now()));
  if ((await h.monitor.tick()) !== 'no-stats') fail('stale stats must not nudge');
}

// 10. Send failure: 'send-failed', no cooldown consumed, retry blocked
//     by the 15-min backoff, then succeeds
{
  testNum++;
  const h = readyHarness();
  h.setSendFail(true);
  if ((await h.monitor.tick()) !== 'send-failed') fail('DM failure must report send-failed');
  h.setSendFail(false);
  h.clock.add(60_000);
  h.setStats(statsWith(900_000, -1000, h.clock.now()));
  if ((await h.monitor.tick()) !== 'retry-wait') fail('within backoff must wait, not spam');
  h.clock.add(15 * 60_000);
  h.setStats(statsWith(900_000, -1000, h.clock.now()));
  if ((await h.monitor.tick()) !== 'nudged') fail('after backoff the nudge must retry and succeed');
}

// 11. heaviestRecentSession picks the max-token FRESH entry and
//     survives malformed entries
{
  testNum++;
  const now = 1_000_000_000_000;
  const stats: SessionStatsFile = {
    sessions: {
      light: { context_tokens: 50_000, ts: new Date(now - 1000).toISOString() },
      heavy: { context_tokens: 800_000, ts: new Date(now - 2000).toISOString() },
      'stale-heavier': { context_tokens: 999_999, ts: new Date(now - 25 * HOUR).toISOString() },
      'future-clock-skew': { context_tokens: 999_999, ts: new Date(now + 10 * 60_000).toISOString() },
      garbage1: { context_tokens: 'NaN-ish' as unknown as number, ts: new Date(now).toISOString() },
      garbage2: null as unknown as { context_tokens: number; ts: string },
      garbage3: { context_tokens: 100, ts: 12345 as unknown as string },
    },
  };
  const best = heaviestRecentSession(stats, now, 24 * HOUR);
  if (!best || best.sessionId !== 'heavy' || best.tokens !== 800_000) {
    fail(`expected heavy/800000, got ${JSON.stringify(best)}`);
  }
  if (heaviestRecentSession(null, now, 24 * HOUR) !== null) fail('null stats → null');
  if (heaviestRecentSession({ sessions: 'x' as unknown as Record<string, never> }, now, 24 * HOUR) !== null) {
    fail('non-object sessions → null');
  }
}

// 12. start() is a no-op when disabled; stop() is idempotent
{
  testNum++;
  const h = makeHarness({ enabled: false });
  h.monitor.start(60_000);
  h.monitor.stop();
  h.monitor.stop();
  const h2 = makeHarness();
  h2.monitor.start(60_000);
  h2.monitor.start(60_000); // second start must not double-arm
  h2.monitor.stop();
}

// 13. Full ladder schedule at the 2h base: rungs fire at 0 / +2h / +6h
//     / +14h, then the episode is exhausted (4 max)
{
  testNum++;
  const h = readyHarness();
  const t0 = h.clock.now();
  if ((await h.monitor.tick()) !== 'nudged') fail('rung 1 at t0');
  h.clock.set(t0 + 2 * HOUR - 60_000);
  if ((await h.monitor.tick()) !== 'cooldown') fail('rung 2 not yet due at +1h59');
  h.clock.set(t0 + 2 * HOUR + 60_000);
  if ((await h.monitor.tick()) !== 'nudged') fail('rung 2 at ~+2h');
  h.clock.set(t0 + 6 * HOUR);
  if ((await h.monitor.tick()) !== 'cooldown') fail('rung 3 due ~+6h after t0 anchored on rung-2 send (+4h)');
  h.clock.set(t0 + 6 * HOUR + 2 * 60_000);
  if ((await h.monitor.tick()) !== 'nudged') fail('rung 3 at ~+6h');
  h.clock.set(t0 + 14 * HOUR + 3 * 60_000);
  if ((await h.monitor.tick()) !== 'nudged') fail('rung 4 at ~+14h');
  h.clock.add(60 * 60_000);
  if ((await h.monitor.tick()) !== 'episode-exhausted') fail('5th reminder must never fire in one episode');
  if (h.sent.length !== 4) fail(`exactly 4 DMs per episode, got ${h.sent.length}`);
  if (!h.sent[0].includes('[1/4]') || !h.sent[3].includes('[4/4]')) fail('texts must carry rung counters');
}

// 14. Delayed rung shifts the rest — no double-fire catch-up
{
  testNum++;
  const h = readyHarness();
  const t0 = h.clock.now();
  await h.monitor.tick(); // rung 1
  h.clock.set(t0 + 7 * HOUR); // rung 2 was due at +2h; fires late
  if ((await h.monitor.tick()) !== 'nudged') fail('late rung 2 fires once');
  h.clock.add(60_000);
  if ((await h.monitor.tick()) !== 'cooldown') fail('rung 3 anchors on the ACTUAL rung-2 send (+4h), no catch-up burst');
}

// 15. Drop-close above threshold + re-arm floor: compact from 900k to
//     600k closes the episode; 600k (> threshold) must NOT instantly
//     re-nudge; regrowth past the floor re-arms
{
  testNum++;
  const h = readyHarness(900_000);
  await h.monitor.tick(); // rung 1 at 900k
  h.clock.add(30 * 60_000);
  h.setStats(statsWith(600_000, -1000, h.clock.now()));
  if ((await h.monitor.tick()) !== 'episode-closed') fail('≥30% drop must close the episode');
  h.clock.add(60_000);
  if ((await h.monitor.tick()) !== 'rearm-floor') fail('post-compact level above threshold must not instantly re-nudge');
  h.clock.add(60_000);
  h.setStats(statsWith(800_000, -1000, h.clock.now())); // ≥ 750k floor
  if ((await h.monitor.tick()) !== 'nudged') fail('regrowth past the floor must arm a new episode');
  if (!h.sent[1].includes('[1/4]')) fail('new episode restarts the rung counter');
}

// 16. Drop-close below threshold: closes, then plain below-threshold
{
  testNum++;
  const h = readyHarness(900_000);
  await h.monitor.tick();
  h.clock.add(30 * 60_000);
  h.setStats(statsWith(300_000, -1000, h.clock.now()));
  if ((await h.monitor.tick()) !== 'episode-closed') fail('below-threshold drop must close');
  h.clock.add(60_000);
  if ((await h.monitor.tick()) !== 'below-threshold') fail('after close, light session is just below-threshold');
}

// 17. Exhausted episode re-arms on ≥25% NEW accumulation
{
  testNum++;
  const h = readyHarness(900_000);
  const t0 = h.clock.now();
  await h.monitor.tick();
  h.clock.set(t0 + 2 * HOUR + 60_000); await h.monitor.tick();
  h.clock.set(t0 + 6 * HOUR + 2 * 60_000); await h.monitor.tick();
  h.clock.set(t0 + 14 * HOUR + 3 * 60_000); await h.monitor.tick();
  if (h.sent.length !== 4) fail('ladder must be exhausted first');
  h.clock.set(t0 + 15 * HOUR);
  h.setStats(statsWith(1_200_000, -1000, h.clock.now())); // ≥ 900k × 1.25
  if ((await h.monitor.tick()) !== 'nudged') fail('meaningful regrowth must re-arm an exhausted episode');
  if (h.sent.length !== 5 || !h.sent[4].includes('[1/4]')) fail('re-armed episode restarts the ladder');
}

// 18. 24h of ladder silence auto-resets a stale exhausted episode
{
  testNum++;
  const h = readyHarness(900_000);
  const t0 = h.clock.now();
  await h.monitor.tick();
  h.clock.set(t0 + 2 * HOUR + 60_000); await h.monitor.tick();
  h.clock.set(t0 + 6 * HOUR + 2 * 60_000); await h.monitor.tick();
  h.clock.set(t0 + 14 * HOUR + 3 * 60_000); await h.monitor.tick();
  h.clock.add(25 * HOUR); // a day past the last ladder event
  h.setStats(statsWith(900_000, -1000, h.clock.now()));
  if ((await h.monitor.tick()) !== 'nudged') fail('stale episode state must auto-reset after 24h of silence');
  if (h.sent.length !== 5) fail('fresh episode after auto-reset');
}

console.error(`session-nudge smoke: all ${testNum} cases passed`);
