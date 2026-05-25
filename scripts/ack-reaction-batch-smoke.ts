/**
 * Ack-reaction batch smoke (v1.0.44, closes #136 #137).
 *
 * #136 — set-vs-revoke race: when a fast bot's reply outpaces the
 *        Feishu ack-create round-trip, revokeAckFor sees no entry
 *        and silently no-ops; the .then() then stores an orphan
 *        that sits up to 6 min until the TTL backstop. Fix: mark
 *        pending-revoke when no entry; .then() consumes the mark
 *        and immediately deletes the reaction.
 *
 * #137 — react and download_attachment also "respond to" an inbound
 *        message per the Stop hook, but neither revoked the ack.
 *        Fix: lift revokeAckFor to a shared helper, wire into both
 *        tool handlers via try/finally so it always fires.
 *
 * Layout:
 *   Part A — markPendingAckRevoke / consumePendingAckRevoke
 *            contracts on LarkChannel (3 tests)
 *   Part B — FIFO cap eviction at PENDING_REVOKE_CAP (1 test)
 *   Part C — revokeAckFor marks pending when Map empty (1 test)
 *   Part D — react tool revokes ack on success + failure (2 tests)
 *   Part E — download_attachment revokes ack on success + failure
 *            (2 tests)
 */

import { LarkChannel } from '../src/channel.js';
import { registerTools } from '../src/tools.js';
import { IdentitySession } from '../src/identity-session.js';
import type { MemoryStore } from '../src/memory/file.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;

// ── Part A: pure helper contracts on LarkChannel ──

// 1. mark + consume cycle: consume returns true once, false after.
{
  const ch = new LarkChannel();
  ch.markPendingAckRevoke('msg_1');
  if (ch.getPendingAckRevokeSize() !== 1) fail(`1: size after mark, got ${ch.getPendingAckRevokeSize()}`);
  if (!ch.consumePendingAckRevoke('msg_1')) fail(`1: consume should return true on hit`);
  if (ch.getPendingAckRevokeSize() !== 0) fail(`1: size after consume should be 0`);
  if (ch.consumePendingAckRevoke('msg_1')) fail(`1: second consume should return false`);
  passed++;
}

// 2. Empty messageId is rejected (defensive).
{
  const ch = new LarkChannel();
  ch.markPendingAckRevoke('');
  if (ch.getPendingAckRevokeSize() !== 0) fail(`2: empty messageId must not be marked`);
  passed++;
}

// 3. Re-marking the same id bumps insertion order (LRU-ish) — not a
//    duplicate. Set semantics already enforce uniqueness, but we
//    explicitly delete-then-add so the bumped entry sits at the back
//    (won't be the next to evict under cap pressure).
{
  const ch = new LarkChannel();
  ch.markPendingAckRevoke('msg_a');
  ch.markPendingAckRevoke('msg_b');
  ch.markPendingAckRevoke('msg_a'); // bump msg_a to back
  if (ch.getPendingAckRevokeSize() !== 2) fail(`3: re-mark should not duplicate, got size ${ch.getPendingAckRevokeSize()}`);
  passed++;
}

// ── Part B: FIFO cap eviction ──

// 4. Filling past PENDING_REVOKE_CAP evicts oldest first.
//    R2-followup: reference LarkChannel.PENDING_REVOKE_CAP directly
//    instead of hard-coding 500 — future cap changes won't silently
//    desync this test's eviction expectations.
{
  const ch = new LarkChannel();
  const cap = LarkChannel.PENDING_REVOKE_CAP;
  // Mark cap + 5 entries
  for (let i = 0; i < cap + 5; i++) ch.markPendingAckRevoke(`msg_${i}`);
  if (ch.getPendingAckRevokeSize() !== cap) {
    fail(`4: size should be capped at ${cap}, got ${ch.getPendingAckRevokeSize()}`);
  }
  // The first 5 should have been evicted
  if (ch.consumePendingAckRevoke('msg_0')) fail(`4: oldest entry msg_0 should be evicted`);
  if (ch.consumePendingAckRevoke('msg_4')) fail(`4: msg_4 should be evicted`);
  // msg_5 should still be present (boundary)
  if (!ch.consumePendingAckRevoke('msg_5')) fail(`4: msg_5 should NOT be evicted`);
  // Latest entry preserved
  if (!ch.consumePendingAckRevoke(`msg_${cap + 4}`)) fail(`4: latest entry msg_${cap + 4} should be present`);
  passed++;
}

// ── Part C/D/E setup: register tools with a real channel ──

const handlers = new Map<string, (args: any) => Promise<any>>();
const fakeServer = {
  registerTool(name: string, _config: any, handler: any) {
    handlers.set(name, handler);
  },
};

interface ApiCall { method: string; args: any }

function makeMockClient(opts: { failOn?: (method: string) => boolean } = {}) {
  const calls: ApiCall[] = [];
  const failOn = opts.failOn ?? (() => false);
  const record = (method: string, args: any) => {
    calls.push({ method, args });
    if (failOn(method)) {
      const err: any = new Error(`mock: ${method} failed`);
      err.response = { data: { code: 230001, msg: 'mock failure' } };
      throw err;
    }
    return { data: { reaction_id: 'mock_reaction_id', message_id: 'mock_msg_id' } };
  };
  return {
    calls,
    im: {
      v1: {
        messageReaction: {
          create: async (args: any) => record('messageReaction.create', args),
          delete: async (args: any) => record('messageReaction.delete', args),
        },
        messageResource: {
          get: async (args: any) => record('messageResource.get', args),
        },
        message: {
          create: async (args: any) => record('message.create', args),
          reply: async (args: any) => record('message.reply', args),
        },
      },
    },
  };
}

const noopMemory = {} as MemoryStore;

function setupHandlers(opts: { failOnMethod?: string } = {}) {
  handlers.clear();
  const channel = new LarkChannel();
  const ackReactions = channel.getAckReactions();
  const client = makeMockClient({
    failOn: opts.failOnMethod ? (m) => m === opts.failOnMethod : undefined,
  });
  const identitySession = new IdentitySession(() => null);
  identitySession.setCaller('chat_test', undefined, 'ou_caller');
  registerTools(
    fakeServer as any,
    client as any,
    noopMemory,
    identitySession,
    channel,
    undefined,
    ackReactions,
    undefined,
    undefined,
  );
  return { channel, ackReactions, client };
}

// ── Part C: revokeAckFor marks pending when Map empty ──

// 5. Reply tool with reply_to to a RECORDED inbound message that has
//    NO ack yet (race scenario): revokeAckFor's markIfMissing gate
//    (#159/#160) checks isRecentInbound — true here because we
//    explicitly record before reply — and marks pending. Subsequent
//    consume returns true.
{
  const { channel } = setupHandlers();
  const reply = handlers.get('reply');
  if (!reply) fail(`5: reply handler missing`);

  // v1.0.53 #159/#160: register the message as a recent inbound first.
  // Pre-fix, reply would have marked unconditionally — now it gates
  // on isRecentInbound.
  channel.recordInboundId('om_no_ack_yet');

  await reply({
    chat_id: 'chat_test',
    text: 'hi',
    reply_to: 'om_no_ack_yet',
  });

  if (!channel.consumePendingAckRevoke('om_no_ack_yet')) {
    fail(`5: revokeAckFor should have marked 'om_no_ack_yet' as pending-revoke (recent-inbound path)`);
  }
  passed++;
}

// 5b. #159/#160 fix: reply with reply_to to a NON-INBOUND id (e.g.
//     Claude quoting a bot card or stale message) must NOT mark
//     pending. The gate fails closed → no Set leak.
{
  const { channel } = setupHandlers();
  const reply = handlers.get('reply');
  if (!reply) fail(`5b: reply handler missing`);

  // Do NOT recordInboundId. The id isn't a known inbound.
  await reply({
    chat_id: 'chat_test',
    text: 'hi',
    reply_to: 'om_stale_bot_msg',
  });

  if (channel.consumePendingAckRevoke('om_stale_bot_msg')) {
    fail(`5b: non-inbound reply_to MUST NOT mark pending (closes #160 leak)`);
  }
  if (channel.getPendingAckRevokeSize() !== 0) {
    fail(`5b: pendingAckRevokes should stay empty, got size ${channel.getPendingAckRevokeSize()}`);
  }
  passed++;
}

// ── Part D: react tool revokes ack ──

// 6. react with matching ack → revoke fires (messageReaction.delete
//    called with the right reaction_id).
{
  const { ackReactions, client } = setupHandlers();
  const react = handlers.get('react');
  if (!react) fail(`6: react handler missing`);

  ackReactions.set('om_react_target', { reactionId: 'rxn_react', addedAt: Date.now() });

  await react({ message_id: 'om_react_target', emoji: 'THUMBSUP' });

  // Both create (the react itself) AND delete (the ack revoke) fired
  const createCall = client.calls.find(c => c.method === 'messageReaction.create');
  const deleteCall = client.calls.find(c => c.method === 'messageReaction.delete');
  if (!createCall) fail(`6: react should fire messageReaction.create`);
  if (!deleteCall) fail(`6: react should revoke ack via messageReaction.delete`);
  if (deleteCall!.args.path.reaction_id !== 'rxn_react') {
    fail(`6: wrong reaction_id in revoke, got ${deleteCall!.args.path.reaction_id}`);
  }
  if (ackReactions.has('om_react_target')) {
    fail(`6: ack entry should be removed after revoke`);
  }
  passed++;
}

// 7. react with NO matching ack → must NOT mark pending (R1-followup:
//    react's message_id parameter is not guaranteed to be the inbound
//    user message id — Claude can react to bot messages too. Marking
//    pending on arbitrary ids would leak Set entries and evict
//    legitimate reply-side marks under sustained workload, re-opening
//    the #136 stuck-MeMeMe bug. Tracked at #159 for a smarter
//    inbound-id-aware variant).
{
  const { channel } = setupHandlers();
  const react = handlers.get('react');
  if (!react) fail(`7: react handler missing`);

  await react({ message_id: 'om_no_ack_react', emoji: 'HEART' });

  if (channel.consumePendingAckRevoke('om_no_ack_react')) {
    fail(`7: react with no matching ack must NOT mark pending-revoke (would leak Set on bot-id reacts)`);
  }
  passed++;
}

// ── Part E: download_attachment intentionally does NOT revoke ack ──

// 8. download_attachment with matching ack → ack SURVIVES (R2-audit
//    followup). The Stop hook only accepts `reply` and `react` as
//    satisfying an inbound; download_attachment alone will be force-
//    blocked, and Claude follows up with reply which handles the
//    revoke. Revoking from download_attachment risks "no MeMeMe AND
//    no reply" in the rare race where reply's follow-up fails before
//    its finally fires. The cleaner contract: download is silent on
//    the ack lifecycle.
{
  const { ackReactions, client } = setupHandlers();
  const download = handlers.get('download_attachment');
  if (!download) fail(`8: download_attachment handler missing`);

  ackReactions.set('om_dl_target', { reactionId: 'rxn_dl', addedAt: Date.now() });

  await download({
    message_id: 'om_dl_target',
    file_key: 'file_test',
    file_name: 'test.txt',
  }).catch(() => {});

  // No revoke call should have been made
  const deleteCall = client.calls.find(c => c.method === 'messageReaction.delete');
  if (deleteCall) {
    fail(`8: download_attachment must NOT revoke ack (reply owns the revoke). Got delete call: ${JSON.stringify(deleteCall.args)}`);
  }
  // Ack entry survives — reply (which always follows download per
  // Stop hook policy) will revoke it.
  if (!ackReactions.has('om_dl_target')) {
    fail(`8: ack entry must SURVIVE download_attachment (so reply can revoke it)`);
  }
  passed++;
}

// 9. download_attachment with NO matching ack → no mark, no log.
//    Confirms the no-op contract holds in the empty-Map case too.
{
  const { channel } = setupHandlers();
  const download = handlers.get('download_attachment');
  if (!download) fail(`9: download_attachment handler missing`);

  await download({
    message_id: 'om_no_ack_dl',
    file_key: 'file_test',
    file_name: 'test.txt',
  }).catch(() => {});

  if (channel.consumePendingAckRevoke('om_no_ack_dl')) {
    fail(`9: download_attachment with no matching ack must NOT mark pending-revoke`);
  }
  if (channel.getPendingAckRevokeSize() !== 0) {
    fail(`9: pendingAckRevokes should remain empty, got size ${channel.getPendingAckRevokeSize()}`);
  }
  passed++;
}

// 10. Positive control: reply DOES mark pending when the reply_to
//     IS a recently-recorded inbound (race protection correctly
//     opted in via markIfMissing=true + isRecentInbound=true).
{
  const { channel } = setupHandlers();
  const reply = handlers.get('reply');
  if (!reply) fail(`10: reply handler missing`);

  // v1.0.53 #159/#160: register the inbound first so the
  // isRecentInbound gate fires true.
  channel.recordInboundId('om_race_target');

  await reply({
    chat_id: 'chat_test',
    text: 'race-test',
    reply_to: 'om_race_target',
  });

  if (!channel.consumePendingAckRevoke('om_race_target')) {
    fail(`10: reply with recorded inbound MUST mark pending-revoke (race protection)`);
  }
  passed++;
}

// 11. #161 followup: channel-side .then() consume integration. The
//     pure-helper contract (tests 1-4) and the reply-call-site mark
//     (tests 5, 10) cover the input side. This test exercises the
//     OUTPUT side — `onAckCreated` (the extracted .then() body)
//     consumes the mark and triggers a late-revoke delete instead
//     of storing in the Map. Without this test, a refactor that
//     flipped the consume/store order, dropped the early return, or
//     removed the consume branch would pass tests 1-10.
{
  const ch = new LarkChannel();
  const deleteCalls: any[] = [];
  // Swap the client with a deletion-recording mock. messageReaction.delete
  // is the only call onAckCreated makes on the late-revoke path.
  (ch as any).client = {
    im: { v1: { messageReaction: {
      delete: async (args: any) => {
        deleteCalls.push(args);
        return { data: {} };
      },
    } } },
  };

  // Pre-mark pending — simulates `reply.revokeAckFor` having run
  // before the ack-create's .then() landed.
  ch.markPendingAckRevoke('om_late_revoke');
  if (!(ch as any).pendingAckRevokes.has('om_late_revoke')) {
    fail(`11a: setup — pending mark should be set`);
  }

  // Fire onAckCreated as the .then() would. Synchronous body, but
  // the inner withFeishuRetry().catch() is async — give it a tick.
  ch.onAckCreated('om_late_revoke', 'rxn_late');
  await new Promise(r => setTimeout(r, 30));

  // Verify:
  //  - delete fired with the right reaction_id
  //  - ack entry NOT stored (the race-protection point)
  //  - pending mark consumed
  if (deleteCalls.length !== 1) {
    fail(`11b: late-revoke delete should fire exactly once, got ${deleteCalls.length}`);
  }
  if (deleteCalls[0].path.message_id !== 'om_late_revoke') {
    fail(`11b: wrong message_id in delete, got ${deleteCalls[0].path.message_id}`);
  }
  if (deleteCalls[0].path.reaction_id !== 'rxn_late') {
    fail(`11b: wrong reaction_id in delete, got ${deleteCalls[0].path.reaction_id}`);
  }
  if (ch.getAckReactions().has('om_late_revoke')) {
    fail(`11c: ack entry should NOT be stored on the race path — got entry, race protection failed`);
  }
  if (ch.consumePendingAckRevoke('om_late_revoke')) {
    fail(`11d: pending mark should have been consumed by onAckCreated`);
  }
  passed++;
}

// 11b. #161 followup: control case — onAckCreated WITHOUT a pending
//      mark stores normally (no late-revoke, ack entry persists).
//      This pins the "non-race" path so a regression that always
//      took the late-revoke branch would be caught.
{
  const ch = new LarkChannel();
  const deleteCalls: any[] = [];
  (ch as any).client = {
    im: { v1: { messageReaction: {
      delete: async (args: any) => {
        deleteCalls.push(args);
        return { data: {} };
      },
    } } },
  };

  // No pending mark — normal storage path
  ch.onAckCreated('om_normal_ack', 'rxn_normal');
  await new Promise(r => setTimeout(r, 30));

  if (deleteCalls.length !== 0) {
    fail(`11b-control: delete must NOT fire without a pending mark, got ${deleteCalls.length} calls`);
  }
  const entry = ch.getAckReactions().get('om_normal_ack');
  if (!entry) fail(`11b-control: ack entry MUST be stored on the normal path`);
  if (entry!.reactionId !== 'rxn_normal') {
    fail(`11b-control: wrong reactionId stored, got ${entry!.reactionId}`);
  }
  if (typeof entry!.addedAt !== 'number') {
    fail(`11b-control: addedAt must be set (powers TTL backstop)`);
  }
  passed++;
}

// ── Part F: #159 + #160 — recentInboundIds TTL cache + isRecentInbound ──

// 12. recordInboundId + isRecentInbound contract: roundtrip true.
{
  const ch = new LarkChannel();
  ch.recordInboundId('om_inbound_1');
  if (!ch.isRecentInbound('om_inbound_1')) {
    fail(`12: recorded id MUST be recent`);
  }
  if (ch.isRecentInbound('om_never_recorded')) {
    fail(`12: unrecorded id MUST NOT be recent`);
  }
  // Empty id defensively rejected
  if (ch.isRecentInbound('')) fail(`12: empty id must be rejected`);
  passed++;
}

// 13. #159 fix end-to-end: react with markIfMissing=true (hypothetical
//     future caller — current react still uses default false). But the
//     gate's contract is testable directly: if a tool DID pass
//     markIfMissing=true with a non-inbound id, the gate fails closed.
//     Simulate by calling revokeAckFor's contract via reply with a
//     non-inbound reply_to (test 5b above also covers this).
//
//     Here we directly verify the channel.isRecentInbound branch
//     against a known non-inbound id and a known inbound id, end-to-end
//     through the gate path.
{
  const { channel } = setupHandlers();
  const reply = handlers.get('reply');

  // Recorded inbound — marks pending
  channel.recordInboundId('om_inbound_e2e');
  await reply!({ chat_id: 'chat_test', text: 'x', reply_to: 'om_inbound_e2e' });
  if (!channel.consumePendingAckRevoke('om_inbound_e2e')) {
    fail(`13: recorded inbound MUST mark pending`);
  }

  // Not recorded — does NOT mark
  await reply!({ chat_id: 'chat_test', text: 'y', reply_to: 'om_unknown' });
  if (channel.consumePendingAckRevoke('om_unknown')) {
    fail(`13: unrecorded id MUST NOT mark pending`);
  }
  passed++;
}

console.log(`ack-reaction batch smoke: ${passed}/${passed} PASS`);
