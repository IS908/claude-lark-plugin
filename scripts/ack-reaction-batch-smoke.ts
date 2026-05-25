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

// 4. Filling past PENDING_REVOKE_CAP (500) evicts oldest first.
{
  const ch = new LarkChannel();
  // Mark CAP + 5 entries
  for (let i = 0; i < 505; i++) ch.markPendingAckRevoke(`msg_${i}`);
  if (ch.getPendingAckRevokeSize() !== 500) {
    fail(`4: size should be capped at 500, got ${ch.getPendingAckRevokeSize()}`);
  }
  // The first 5 should have been evicted
  if (ch.consumePendingAckRevoke('msg_0')) fail(`4: oldest entry msg_0 should be evicted`);
  if (ch.consumePendingAckRevoke('msg_4')) fail(`4: msg_4 should be evicted`);
  // msg_5 should still be present (boundary)
  if (!ch.consumePendingAckRevoke('msg_5')) fail(`4: msg_5 should NOT be evicted`);
  // Latest entry preserved
  if (!ch.consumePendingAckRevoke('msg_504')) fail(`4: latest entry msg_504 should be present`);
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

// 5. Reply tool with reply_to to a message that has NO ack yet (race
//    scenario): revokeAckFor logs and marks pending. Subsequent
//    consume returns true.
{
  const { channel } = setupHandlers();
  const reply = handlers.get('reply');
  if (!reply) fail(`5: reply handler missing`);

  // Send a reply with reply_to but no pre-existing ack — should mark
  // pending (consume returns true after) instead of silently no-op.
  await reply({
    chat_id: 'chat_test',
    text: 'hi',
    reply_to: 'om_no_ack_yet',
  });

  if (!channel.consumePendingAckRevoke('om_no_ack_yet')) {
    fail(`5: revokeAckFor should have marked 'om_no_ack_yet' as pending-revoke`);
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

// ── Part E: download_attachment revokes ack ──

// 8. download_attachment with matching ack → revoke fires.
{
  const { ackReactions, client } = setupHandlers();
  const download = handlers.get('download_attachment');
  if (!download) fail(`8: download_attachment handler missing`);

  ackReactions.set('om_dl_target', { reactionId: 'rxn_dl', addedAt: Date.now() });

  // download will fail (mock returns minimal data which writeSdkResource
  // will reject) but the finally must still fire.
  await download({
    message_id: 'om_dl_target',
    file_key: 'file_test',
    file_name: 'test.txt',
  }).catch(() => {});

  // Even if the download path errored, revoke must have fired
  const deleteCall = client.calls.find(c => c.method === 'messageReaction.delete');
  if (!deleteCall) fail(`8: download_attachment should revoke ack on completion (success OR failure)`);
  if (deleteCall!.args.path.reaction_id !== 'rxn_dl') {
    fail(`8: wrong reaction_id in revoke, got ${deleteCall!.args.path.reaction_id}`);
  }
  if (ackReactions.has('om_dl_target')) {
    fail(`8: ack entry should be removed after revoke`);
  }
  passed++;
}

// 9. download_attachment with NO matching ack → must NOT mark pending
//    (same R1-followup rationale as react above — message_id parameter
//    isn't guaranteed to be inbound).
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
  passed++;
}

// 10. Positive control: reply DOES mark pending (race protection
//     correctly opted in via markIfMissing=true).
{
  const { channel } = setupHandlers();
  const reply = handlers.get('reply');
  if (!reply) fail(`10: reply handler missing`);

  await reply({
    chat_id: 'chat_test',
    text: 'race-test',
    reply_to: 'om_race_target',
  });

  if (!channel.consumePendingAckRevoke('om_race_target')) {
    fail(`10: reply with no matching ack MUST mark pending-revoke (race protection)`);
  }
  passed++;
}

console.log(`ack-reaction batch smoke: ${passed}/${passed} PASS`);
