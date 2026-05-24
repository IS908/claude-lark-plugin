/**
 * Bot @-mention fail-safe smoke test (v1.0.25, closes #86 + #55).
 *
 * Exercises the pure helpers `shouldAcceptGroupMention` and
 * `computeBotMentioned` extracted from `LarkChannel.handleMessageEvent`.
 *
 * The bug pre-v1.0.25:
 *   - `fetchBotOpenId` could fail silently during startup race /
 *     network blip / transient permission revoke. `this.botOpenId`
 *     stayed empty string.
 *   - Group-filter logic FELL THROUGH on empty botOpenId → accepted
 *     ANY mention as if @bot was addressed (#55).
 *   - `bot_mentioned` meta field FELL THROUGH to `mentions.length > 0`
 *     — so User A's `@User B 请评审` was forwarded with
 *     `bot_mentioned=true`, biasing Claude toward replying (#86).
 *
 * Fix: both helpers return `false` (deny / not-mentioned) when
 * botOpenId is empty. Better silent during startup than spammy
 * unsolicited replies in every group.
 */

import {
  shouldAcceptGroupMention,
  computeBotMentioned,
} from '../src/channel.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let testNum = 0;

// 1. shouldAcceptGroupMention — happy path: known bot + bot in mentions
{
  testNum++;
  const out = shouldAcceptGroupMention(
    [
      { id: { open_id: 'ou_user_a' } },
      { id: { open_id: 'ou_bot' } },
    ],
    'ou_bot',
  );
  if (out !== true) fail(`1: bot present + known id → true; got ${out}`);
}

// 2. shouldAcceptGroupMention — known bot, bot NOT in mentions
{
  testNum++;
  const out = shouldAcceptGroupMention(
    [
      { id: { open_id: 'ou_user_a' } },
      { id: { open_id: 'ou_user_b' } },
    ],
    'ou_bot',
  );
  if (out !== false) fail(`2: bot absent + known id → false; got ${out}`);
}

// 3. shouldAcceptGroupMention — botOpenId empty, mentions present → REJECT
//    Pre-v1.0.25 returned true (accept any mention). This is the #55/#86 fix.
{
  testNum++;
  const out = shouldAcceptGroupMention(
    [
      { id: { open_id: 'ou_user_a' } },
      { id: { open_id: 'ou_user_b' } },
    ],
    '',
  );
  if (out !== false) {
    fail(`3: REGRESSION — botOpenId='' must REJECT group mention (was accepting any); got ${out}`);
  }
}

// 4. shouldAcceptGroupMention — no mentions
{
  testNum++;
  if (shouldAcceptGroupMention([], 'ou_bot') !== false) fail('4: empty mentions → false');
  if (shouldAcceptGroupMention(null, 'ou_bot') !== false) fail('4: null mentions → false');
  if (shouldAcceptGroupMention(undefined, 'ou_bot') !== false) fail('4: undefined mentions → false');
}

// 5. shouldAcceptGroupMention — union_id fallback when open_id missing
//    Feishu sometimes returns only one of the two id forms.
{
  testNum++;
  const out = shouldAcceptGroupMention(
    [{ id: { union_id: 'ou_bot' } }],
    'ou_bot',
  );
  if (out !== true) fail(`5: union_id match should accept; got ${out}`);
}

// 6. computeBotMentioned — happy path
{
  testNum++;
  const out = computeBotMentioned(
    [
      { id: 'ou_user_a' },
      { id: 'ou_bot' },
    ],
    'ou_bot',
  );
  if (out !== true) fail(`6: bot present → true; got ${out}`);
}

// 7. computeBotMentioned — bot NOT in mentions
{
  testNum++;
  const out = computeBotMentioned([{ id: 'ou_user_a' }], 'ou_bot');
  if (out !== false) fail(`7: bot absent → false; got ${out}`);
}

// 8. computeBotMentioned — botOpenId empty, mentions present → false
//    Pre-v1.0.25 returned true (length > 0). This is the #86 fix.
{
  testNum++;
  const out = computeBotMentioned([{ id: 'ou_user_a' }, { id: 'ou_user_b' }], '');
  if (out !== false) {
    fail(`8: REGRESSION — botOpenId='' must NOT mark bot_mentioned=true; got ${out}`);
  }
}

// 9. computeBotMentioned — empty parsedMentions
{
  testNum++;
  if (computeBotMentioned([], 'ou_bot') !== false) fail('9: empty parsedMentions → false');
  if (computeBotMentioned([], '') !== false) fail('9: empty + unknown bot → false');
}

// 10. Combined scenario (the #86 production reproducer): startup race
//     where botOpenId is still empty and User A mentions User B. Both
//     helpers must reject — group message not forwarded, meta not
//     polluted with bot_mentioned=true.
{
  testNum++;
  const mentions = [{ id: { open_id: 'ou_user_b' } }];
  const parsedMentions = [{ id: 'ou_user_b', name: 'B' }];
  const botOpenId = ''; // startup race state

  if (shouldAcceptGroupMention(mentions, botOpenId) !== false) {
    fail('10: startup race — group mention must be REJECTED');
  }
  if (computeBotMentioned(parsedMentions, botOpenId) !== false) {
    fail('10: startup race — bot_mentioned meta must be false');
  }
}

console.log(`bot-mention failsafe smoke: ${testNum}/${testNum} PASS`);
