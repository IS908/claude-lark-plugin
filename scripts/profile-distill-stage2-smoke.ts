/**
 * Profile distillation Stage 2 orchestrator smoke (v1.0.57, closes #113).
 *
 * Pre-#113 `profileDistillationPrompt` existed but had no caller —
 * profiles only got populated via explicit `save_memory(type='profile')`.
 * v1.0.57 wires Stage 2 to fire after each Stage 1 flush, per active
 * user, gated by:
 *   - cooldown (default 24h per user)
 *   - min-episodes (default 5)
 *   - master switch LARK_PROFILE_DISTILL_ENABLED (default false)
 *
 * Layout:
 *   Part A — gating (4 tests): cooldown skip, min-episodes skip,
 *            no-eligible-users skip, system/bot sender filter
 *   Part B — dispatch shape (3 tests): identity binding, prompt body,
 *            cooldown mark on dispatch
 *   Part C — failure isolation (2 tests): per-user error doesn't
 *            stop others, l2Rules loader failure tolerated
 */

import { triggerProfileDistillation } from '../src/memory/distiller.js';
import type { ProfileDistillDeps } from '../src/memory/distiller.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;
const HOUR_MS = 60 * 60 * 1000;

// Test scaffolding: minimal mock deps with assertion hooks.
interface MockHooks {
  injections: Array<{ text: string; distillKey: string }>;
  callerBindings: Array<{ chatId: string; threadId: string; callerId: string }>;
  // Per-userId override of listEpisodes behavior
  episodeCounts: Record<string, number>;
  profiles: Record<string, string | null>;
  isPrivate: boolean;
  l2Rules: string;
  l2RulesError?: Error;
  // Per-userId override to inject getProfile errors
  profileErrors?: Record<string, Error>;
}

function makeDeps(hooks: MockHooks, nowFn?: () => number): ProfileDistillDeps {
  return {
    listEpisodes: async (chatId: string) => {
      // Return synthetic episodes matching the hook's count for the chat.
      // userId in the loop is what determines the count — but listEpisodes
      // is chat-scoped, so we use a single count for the chat. To support
      // per-user count in tests, we map by `chatId-marker`.
      const count = hooks.episodeCounts[chatId] ?? 0;
      return Array.from({ length: count }, (_, i) => ({
        content: `episode ${i + 1} content`,
      }));
    },
    getProfile: async (userId: string, caller: string) => {
      const err = hooks.profileErrors?.[userId];
      if (err) throw err;
      if (userId !== caller) fail(`getProfile: expected caller==userId (Stage 2 invariant)`);
      return hooks.profiles[userId] ?? null;
    },
    setCaller: (chatId: string, threadId: string, callerId: string) => {
      hooks.callerBindings.push({ chatId, threadId, callerId });
    },
    injectNotification: async (text: string, distillKey: string) => {
      hooks.injections.push({ text, distillKey });
    },
    isPrivateChat: () => hooks.isPrivate,
    loadL2Rules: async () => {
      if (hooks.l2RulesError) throw hooks.l2RulesError;
      return hooks.l2Rules;
    },
    nowFn,
  };
}

function freshHooks(overrides: Partial<MockHooks> = {}): MockHooks {
  return {
    injections: [],
    callerBindings: [],
    episodeCounts: {},
    profiles: {},
    isPrivate: false,
    l2Rules: '',
    ...overrides,
  };
}

// ── Part A: gating ──

// 1. Cooldown: user dispatched within window is skipped on next flush
{
  const hooks = freshHooks({ episodeCounts: { 'oc_chat': 10 } });
  const cooldownState = new Map<string, number>();
  const baseTime = 1_000_000;
  // First flush: dispatch
  let now = baseTime;
  const out1 = await triggerProfileDistillation(
    'oc_chat',
    [{ role: 'user', senderId: 'ou_alice' }],
    makeDeps(hooks, () => now),
    { cooldownMs: 24 * HOUR_MS, minEpisodes: 5, cooldownState },
  );
  if (out1.ou_alice !== 'dispatched') fail(`1a: first flush should dispatch, got ${out1.ou_alice}`);
  // Second flush 1h later: cooldown
  now = baseTime + 1 * HOUR_MS;
  const out2 = await triggerProfileDistillation(
    'oc_chat',
    [{ role: 'user', senderId: 'ou_alice' }],
    makeDeps(hooks, () => now),
    { cooldownMs: 24 * HOUR_MS, minEpisodes: 5, cooldownState },
  );
  if (out2.ou_alice !== 'cooldown') fail(`1b: 1h later should be cooldown, got ${out2.ou_alice}`);
  // Third flush 25h later: dispatched again
  now = baseTime + 25 * HOUR_MS;
  const out3 = await triggerProfileDistillation(
    'oc_chat',
    [{ role: 'user', senderId: 'ou_alice' }],
    makeDeps(hooks, () => now),
    { cooldownMs: 24 * HOUR_MS, minEpisodes: 5, cooldownState },
  );
  if (out3.ou_alice !== 'dispatched') fail(`1c: 25h later should dispatch, got ${out3.ou_alice}`);
  passed++;
}

// 2. Min-episodes gate: <5 episodes → skipped
{
  const hooks = freshHooks({ episodeCounts: { 'oc_thin': 3 } });
  const out = await triggerProfileDistillation(
    'oc_thin',
    [{ role: 'user', senderId: 'ou_bob' }],
    makeDeps(hooks),
    { cooldownMs: 24 * HOUR_MS, minEpisodes: 5, cooldownState: new Map() },
  );
  if (out.ou_bob !== 'no-episodes') fail(`2: thin chat should skip, got ${out.ou_bob}`);
  if (hooks.injections.length !== 0) fail(`2: no injection should fire for skipped user`);
  passed++;
}

// 3. No eligible users: flush with only assistant + system → empty outcomes
{
  const hooks = freshHooks({ episodeCounts: { 'oc_empty': 10 } });
  const out = await triggerProfileDistillation(
    'oc_empty',
    [
      { role: 'assistant', senderId: 'bot' },
      { role: 'user', senderId: 'system' },
      { role: 'user', senderId: '' }, // empty senderId
    ],
    makeDeps(hooks),
    { cooldownMs: 24 * HOUR_MS, minEpisodes: 5, cooldownState: new Map() },
  );
  if (Object.keys(out).length !== 0) fail(`3: no candidates should yield empty outcomes, got ${JSON.stringify(out)}`);
  if (hooks.injections.length !== 0) fail(`3: no injection`);
  passed++;
}

// 4. Sentinel filter: 'system' and 'bot' senderIds explicitly skipped
{
  const hooks = freshHooks({ episodeCounts: { 'oc_mixed': 10 } });
  const out = await triggerProfileDistillation(
    'oc_mixed',
    [
      { role: 'user', senderId: 'system' },
      { role: 'user', senderId: 'bot' },
      { role: 'user', senderId: 'ou_real' },
    ],
    makeDeps(hooks),
    { cooldownMs: 24 * HOUR_MS, minEpisodes: 5, cooldownState: new Map() },
  );
  if (out.system !== undefined) fail(`4: 'system' must be filtered out`);
  if (out.bot !== undefined) fail(`4: 'bot' must be filtered out`);
  if (out.ou_real !== 'dispatched') fail(`4: real user should dispatch, got ${out.ou_real}`);
  passed++;
}

// ── Part B: dispatch shape ──

// 5. Identity binding: setCaller fires with userId as callerId
{
  const hooks = freshHooks({ episodeCounts: { 'oc_id': 10 } });
  await triggerProfileDistillation(
    'oc_id',
    [{ role: 'user', senderId: 'ou_charlie' }],
    makeDeps(hooks),
    { cooldownMs: 24 * HOUR_MS, minEpisodes: 5, cooldownState: new Map() },
  );
  if (hooks.callerBindings.length !== 1) fail(`5: should bind exactly 1 caller, got ${hooks.callerBindings.length}`);
  const b = hooks.callerBindings[0];
  if (b.callerId !== 'ou_charlie') fail(`5: callerId should be userId, got ${b.callerId}`);
  if (b.chatId !== 'oc_id') fail(`5: chatId mismatch, got ${b.chatId}`);
  if (!b.threadId.startsWith('distill-ou_charlie-')) {
    fail(`5: threadId should match pattern distill-<userId>-<ts>, got ${b.threadId}`);
  }
  passed++;
}

// 6. Prompt body: includes userId, current profile, recent episodes
{
  const hooks = freshHooks({
    episodeCounts: { 'oc_prompt': 10 },
    profiles: { 'ou_dana': 'public: works on infra' },
    l2Rules: '## Always private\n- mentions of family',
  });
  await triggerProfileDistillation(
    'oc_prompt',
    [{ role: 'user', senderId: 'ou_dana' }],
    makeDeps(hooks),
    { cooldownMs: 24 * HOUR_MS, minEpisodes: 5, cooldownState: new Map() },
  );
  if (hooks.injections.length !== 1) fail(`6: one injection, got ${hooks.injections.length}`);
  const inj = hooks.injections[0];
  if (!inj.text.includes('ou_dana')) fail(`6: prompt missing target userId`);
  if (!inj.text.includes('public: works on infra')) fail(`6: prompt missing currentProfile`);
  if (!inj.text.includes('episode 1 content')) fail(`6: prompt missing episode summary`);
  if (!inj.text.includes('episode 10 content')) fail(`6: prompt missing latest episode (slice(-10))`);
  if (!inj.text.includes('mentions of family')) fail(`6: prompt missing l2Rules`);
  passed++;
}

// 7. Cooldown is marked on DISPATCH (not on success). Even if injection
//    rejects, the cooldown state holds — failed turns don't retry-storm.
{
  const hooks = freshHooks({ episodeCounts: { 'oc_disp': 10 } });
  // Make injectNotification throw asynchronously
  const baseDeps = makeDeps(hooks);
  const flakyDeps: ProfileDistillDeps = {
    ...baseDeps,
    injectNotification: async () => {
      throw new Error('mock injection failure');
    },
  };
  const cooldownState = new Map<string, number>();
  const out = await triggerProfileDistillation(
    'oc_disp',
    [{ role: 'user', senderId: 'ou_evan' }],
    flakyDeps,
    { cooldownMs: 24 * HOUR_MS, minEpisodes: 5, cooldownState },
  );
  if (out.ou_evan !== 'dispatched') fail(`7: orchestrator should report dispatched (caller does fire-and-forget)`);
  if (!cooldownState.has('ou_evan')) fail(`7: cooldown must be set even when injection rejects`);
  // Wait a tick for the rejected promise's caught error to log
  await new Promise((r) => setTimeout(r, 10));
  passed++;
}

// ── Part C: failure isolation ──

// 8. Per-user failure doesn't stop others: getProfile throws for one
//    user but the others still get dispatched
{
  const hooks = freshHooks({
    episodeCounts: { 'oc_iso': 10 },
    profileErrors: { 'ou_breaks': new Error('mock profile read failure') },
  });
  const out = await triggerProfileDistillation(
    'oc_iso',
    [
      { role: 'user', senderId: 'ou_first' },
      { role: 'user', senderId: 'ou_breaks' },
      { role: 'user', senderId: 'ou_last' },
    ],
    makeDeps(hooks),
    { cooldownMs: 24 * HOUR_MS, minEpisodes: 5, cooldownState: new Map() },
  );
  if (out.ou_first !== 'dispatched') fail(`8: first user should dispatch, got ${out.ou_first}`);
  if (out.ou_breaks !== 'error') fail(`8: breaking user should report 'error', got ${out.ou_breaks}`);
  if (out.ou_last !== 'dispatched') fail(`8: third user should still dispatch after error, got ${out.ou_last}`);
  // Two injections (first + last); the breaking one didn't reach inject
  if (hooks.injections.length !== 2) fail(`8: expected 2 injections, got ${hooks.injections.length}`);
  passed++;
}

// 9. l2Rules load failure is tolerated — orchestration continues with
//    empty rules
{
  const hooks = freshHooks({
    episodeCounts: { 'oc_l2err': 10 },
    l2RulesError: new Error('mock fs read failure'),
  });
  const out = await triggerProfileDistillation(
    'oc_l2err',
    [{ role: 'user', senderId: 'ou_fred' }],
    makeDeps(hooks),
    { cooldownMs: 24 * HOUR_MS, minEpisodes: 5, cooldownState: new Map() },
  );
  if (out.ou_fred !== 'dispatched') fail(`9: l2Rules failure shouldn't block dispatch, got ${out.ou_fred}`);
  // Prompt was built with empty l2Rules — verify by checking the
  // injection's text doesn't contain anything we'd recognize as L2.
  // The prompt's L2 section shows "(none set)" when empty.
  if (!hooks.injections[0].text.includes('(none set)')) {
    fail(`9: prompt should show '(none set)' for empty l2Rules after error fallback`);
  }
  passed++;
}

console.log(`profile-distill stage2 smoke: ${passed}/${passed} PASS`);
