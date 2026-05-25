/**
 * Reaction event whitelist + identity smoke test (v1.0.32, closes #80).
 *
 * Exercises:
 *   Part A — BotMessageTracker stores chatId/threadId so reaction events
 *            (which carry only message_id) can reconstitute the chat.
 *   Part B — passesWhitelist with chat-only whitelist correctly accepts
 *            a real chatId AND rejects the empty-string placeholder that
 *            handleReactionEvent passed pre-#80.
 *
 * The reaction-handler control-flow itself is NOT exercised here (would
 * need full LarkChannel constructor + Lark SDK env). The two pieces
 * above are the only logic in the fix; once they're correct, the wired
 * handleReactionEvent is a straight assemble.
 */

// Configure whitelist env BEFORE importing config.js (which captures
// at module-load).
process.env.LARK_APP_ID = process.env.LARK_APP_ID ?? 'cli_test_app_id';
process.env.LARK_APP_SECRET = process.env.LARK_APP_SECRET ?? 'test_secret';

import { BotMessageTracker, passesWhitelist } from '../src/channel.js';
import { appConfig } from '../src/config.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let testNum = 0;

// ─────────────────────────────────────────────────────────────
// Part A: BotMessageTracker stores chatId/threadId (#80)
// ─────────────────────────────────────────────────────────────

// 1. add(id, chatId) — get returns the meta
{
  const t = new BotMessageTracker(10);
  t.add('om_001', 'oc_alpha');
  const meta = t.get('om_001');
  if (!meta) fail(`1: get should return meta after add`);
  if (meta.chatId !== 'oc_alpha') fail(`1: wrong chatId: ${meta.chatId}`);
  if (meta.threadId !== undefined) fail(`1: threadId should be undefined when not passed`);
  testNum++;
}

// 2. add(id, chatId, threadId) — both stored
{
  const t = new BotMessageTracker(10);
  t.add('om_002', 'oc_beta', 'thr_xyz');
  const meta = t.get('om_002');
  if (!meta) fail(`2: get should return meta`);
  if (meta.chatId !== 'oc_beta') fail(`2: wrong chatId`);
  if (meta.threadId !== 'thr_xyz') fail(`2: wrong threadId: ${meta.threadId}`);
  testNum++;
}

// 3. get(unknown) returns undefined
{
  const t = new BotMessageTracker(10);
  t.add('om_003', 'oc_x');
  if (t.get('om_NOT_THERE') !== undefined) fail(`3: unknown id must return undefined`);
  testNum++;
}

// 4. has(id) still works alongside the new get()
{
  const t = new BotMessageTracker(10);
  t.add('om_004', 'oc_x');
  if (!t.has('om_004')) fail(`4: has should be true for tracked id`);
  if (t.has('om_NOT_THERE')) fail(`4: has should be false for unknown id`);
  testNum++;
}

// 5. Duplicate add is idempotent — second call doesn't overwrite or
//    grow the tracker.
{
  const t = new BotMessageTracker(10);
  t.add('om_005', 'oc_first');
  t.add('om_005', 'oc_second');
  const meta = t.get('om_005');
  if (!meta) fail(`5: meta missing after dup add`);
  if (meta.chatId !== 'oc_first') {
    fail(`5: first add wins (got ${meta.chatId})`);
  }
  testNum++;
}

// 6. Eviction: maxSize=2 — adding a 3rd item evicts the oldest, both
//    from the id ring AND the meta Map.
{
  const t = new BotMessageTracker(2);
  t.add('om_old', 'oc_old');
  t.add('om_mid', 'oc_mid');
  t.add('om_new', 'oc_new');
  if (t.has('om_old')) fail(`6: oldest id should be evicted`);
  if (t.get('om_old') !== undefined) fail(`6: oldest meta should be evicted`);
  if (!t.has('om_mid')) fail(`6: middle id should remain`);
  if (!t.has('om_new')) fail(`6: newest id should remain`);
  testNum++;
}

// 7. Eviction order is FIFO insertion order (not access). Mirrors
//    pre-#80 behavior to confirm the meta-Map refactor didn't
//    accidentally drop entries differently.
{
  const t = new BotMessageTracker(3);
  for (let i = 0; i < 5; i++) t.add(`om_${i}`, `oc_${i}`);
  if (t.has('om_0') || t.has('om_1')) {
    fail(`7: items 0 and 1 should be evicted`);
  }
  if (!t.has('om_2') || !t.has('om_3') || !t.has('om_4')) {
    fail(`7: items 2, 3, 4 should remain`);
  }
  // Meta of remaining items is intact
  if (t.get('om_2')?.chatId !== 'oc_2') fail(`7: meta intact for surviving items`);
  testNum++;
}

// ─────────────────────────────────────────────────────────────
// Part B: passesWhitelist semantics (#80 root cause)
// ─────────────────────────────────────────────────────────────
// Pre-#80, handleReactionEvent called passesWhitelist(operatorId, '')
// because it had no chatId. With only LARK_ALLOWED_CHAT_IDS configured
// (a common "open this group, restrict everything else" config),
// `chatConfigured && [...].includes('')` was always false → every
// reaction got rejected. These tests directly probe that branch
// to lock in the regression.

// Mutate appConfig in-place; restore after Part B.
const originalAllowedUsers = appConfig.allowedUserIds.slice();
const originalAllowedChats = appConfig.allowedChatIds.slice();

try {
  // 8. Only chat whitelist + matching real chatId → allow.
  (appConfig as { allowedChatIds: string[] }).allowedChatIds = ['oc_allowed'];
  (appConfig as { allowedUserIds: string[] }).allowedUserIds = [];
  if (!passesWhitelist('ou_anyone', 'oc_allowed')) {
    fail(`8: chat whitelist should accept matching chatId`);
  }
  testNum++;

  // 9. Only chat whitelist + EMPTY chatId (the pre-#80 reaction path)
  //    → reject. This is exactly the silent-drop bug.
  if (passesWhitelist('ou_anyone', '')) {
    fail(`9: chat whitelist must reject empty chatId (was the #80 silent-drop)`);
  }
  testNum++;

  // 10. Only chat whitelist + non-matching chatId → reject.
  if (passesWhitelist('ou_anyone', 'oc_other')) {
    fail(`10: chat whitelist must reject non-matching chatId`);
  }
  testNum++;

  // 11. Only user whitelist + matching userId → allow (chatId ignored).
  (appConfig as { allowedChatIds: string[] }).allowedChatIds = [];
  (appConfig as { allowedUserIds: string[] }).allowedUserIds = ['ou_alice'];
  if (!passesWhitelist('ou_alice', '')) {
    fail(`11: user whitelist should accept matching userId even with empty chatId`);
  }
  testNum++;

  // 12. Both whitelists configured + user matches but chat doesn't
  //     → allow (OR semantics).
  (appConfig as { allowedChatIds: string[] }).allowedChatIds = ['oc_special'];
  (appConfig as { allowedUserIds: string[] }).allowedUserIds = ['ou_alice'];
  if (!passesWhitelist('ou_alice', 'oc_random')) {
    fail(`12: OR semantics — user match accepts even when chat doesn't`);
  }
  if (!passesWhitelist('ou_bob', 'oc_special')) {
    fail(`12: OR semantics — chat match accepts even when user doesn't`);
  }
  if (passesWhitelist('ou_bob', 'oc_random')) {
    fail(`12: neither match → reject`);
  }
  testNum++;

  // 13. Neither whitelist configured → accept all.
  (appConfig as { allowedChatIds: string[] }).allowedChatIds = [];
  (appConfig as { allowedUserIds: string[] }).allowedUserIds = [];
  if (!passesWhitelist('ou_anyone', '')) {
    fail(`13: no whitelists → accept all, including empty chatId`);
  }
  if (!passesWhitelist('', 'oc_anything')) {
    fail(`13: no whitelists → accept all, including empty senderId`);
  }
  testNum++;
} finally {
  (appConfig as { allowedChatIds: string[] }).allowedChatIds = originalAllowedChats;
  (appConfig as { allowedUserIds: string[] }).allowedUserIds = originalAllowedUsers;
}

console.log(`reaction-event smoke: ${testNum}/${testNum} PASS`);
