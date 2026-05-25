/**
 * Reply tool raw-card path smoke test — runs as part of `npm test`.
 * Uses a mock Lark client to verify the card param behavior without network.
 * Exits non-zero if any assertion fails.
 */
import { registerTools } from '../src/tools.js';
import type { MemoryStore } from '../src/memory/file.js';
import { IdentitySession } from '../src/identity-session.js';
import { pruneStaleAcksImpl, ACK_TTL_MS } from '../src/channel.js';
import type { LarkChannel, AckRevokeClient } from '../src/channel.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// ── Mock helpers ──

/** Capture calls to the mock Lark client */
const apiCalls: { method: string; args: any }[] = [];

function mockLarkClient() {
  return {
    im: {
      v1: {
        message: {
          create: async (args: any) => {
            apiCalls.push({ method: 'message.create', args });
            return { data: { message_id: 'mock_msg_001' } };
          },
          reply: async (args: any) => {
            apiCalls.push({ method: 'message.reply', args });
            return { data: { message_id: 'mock_msg_002' } };
          },
        },
        messageReaction: {
          create: async (args: any) => {
            apiCalls.push({ method: 'messageReaction.create', args });
          },
          delete: async (args: any) => {
            apiCalls.push({ method: 'messageReaction.delete', args });
          },
        },
        image: {
          create: async () => ({ data: { image_key: 'img_mock' } }),
          get: async () => Buffer.from('fake'),
        },
        file: {
          create: async () => ({ data: { file_key: 'file_mock' } }),
        },
        messageResource: {
          get: async () => Buffer.from('fake'),
        },
      },
    },
  };
}

/** Minimal no-op MemoryStore (matches the real class shape; methods reply-card doesn't use are still present as no-ops). */
const noopMemory = {
  healthCheck: async () => true,
  getProfile: async () => null,
  saveProfile: async () => {},
  searchEpisodes: async () => [],
  saveEpisode: async () => {},
  listEpisodes: async () => [],
  deleteEpisodes: async () => {},
  searchSkills: async () => [],
  saveSkill: async () => {},
} as unknown as MemoryStore;

/** ConversationBuffer that records calls */
function makeBuffer() {
  const recorded: any[] = [];
  return {
    recorded,
    record(chatId: string, entry: any) { recorded.push({ chatId, entry }); },
    flush: async () => {},
    startAutoFlush: () => {},
    stopAutoFlush: () => {},
  };
}

// ── Capture registered tool handlers via a fake McpServer ──

const handlers = new Map<string, (args: any) => Promise<any>>();

const fakeServer = {
  registerTool(name: string, _config: any, handler: any) {
    handlers.set(name, handler);
  },
};

// ── Tests ──

async function run() {
  const client = mockLarkClient();
  const botTrackerAdded: string[] = [];
  const botTracker = {
    ids: new Set<string>(),
    maxSize: 500,
    set: new Set<string>(),
    add(id: string) { botTrackerAdded.push(id); this.ids.add(id); },
    has(id: string) { return this.ids.has(id); },
  };
  const buffer = makeBuffer();
  // v1.0.30 (#85): ackReactions is now { reactionId, addedAt }, not bare string,
  // so the TTL backstop in channel.pruneStaleAcks has timestamps to work with.
  const ackReactions = new Map<string, { reactionId: string; addedAt: number }>();

  // Register tools (captures handlers via fake server)
  const identitySession = new IdentitySession(() => null);
  // Bind a fake caller so resolveCaller-gated tools can be exercised.
  identitySession.setCaller('chat_001', undefined, 'ou_reply_smoke');
  const fakeChannel = { isPrivateChat: () => true } as unknown as LarkChannel;

  registerTools(
    fakeServer as any,
    client as any,
    noopMemory,
    identitySession,
    fakeChannel,
    buffer as any,
    ackReactions,
    botTracker as any,
    undefined,
  );

  const replyHandler = handlers.get('reply');
  if (!replyHandler) fail('replyHandler not captured');

  const validCard = JSON.stringify({ type: 'template', data: { template_id: 't1' } });

  // ── Test 1: valid card JSON → message.create with msg_type=interactive ──
  apiCalls.length = 0;
  botTrackerAdded.length = 0;
  buffer.recorded.length = 0;

  const r1 = await replyHandler({
    chat_id: 'chat_001',
    text: '',
    card: validCard,
  });

  if (r1.isError) fail(`Test 1: unexpected error: ${r1.content[0].text}`);
  if (r1.content[0].text !== 'Sent 1 card message') fail(`Test 1: wrong result: ${r1.content[0].text}`);

  const createCall = apiCalls.find((c) => c.method === 'message.create');
  if (!createCall) fail('Test 1: message.create not called');
  if (createCall.args.data.msg_type !== 'interactive') fail('Test 1: msg_type should be interactive');

  const sentContent = JSON.parse(createCall.args.data.content);
  if (sentContent.type !== 'template') fail('Test 1: card content not passed through');

  if (botTrackerAdded.length !== 1 || botTrackerAdded[0] !== 'mock_msg_001') {
    fail(`Test 1: botTracker not updated: ${JSON.stringify(botTrackerAdded)}`);
  }

  // ── Test 2: invalid card JSON → isError ──
  apiCalls.length = 0;
  const r2 = await replyHandler({
    chat_id: 'chat_001',
    text: '',
    card: 'not json{{{',
  });

  if (!r2.isError) fail('Test 2: should return isError for bad JSON');
  if (!r2.content[0].text.includes('Invalid card JSON')) fail('Test 2: wrong error text');
  if (apiCalls.length !== 0) fail('Test 2: should not call API on bad JSON');

  // ── Test 3: card with reply_to → message.reply ──
  apiCalls.length = 0;
  botTrackerAdded.length = 0;

  const r3 = await replyHandler({
    chat_id: 'chat_001',
    text: '',
    card: validCard,
    reply_to: 'om_reply_123',
  });

  if (r3.isError) fail('Test 3: unexpected error');
  const replyCall = apiCalls.find((c) => c.method === 'message.reply');
  if (!replyCall) fail('Test 3: message.reply not called');
  if (replyCall.args.path.message_id !== 'om_reply_123') fail('Test 3: wrong reply_to');

  // ── Test 4: card path records in conversationBuffer ──
  apiCalls.length = 0;
  buffer.recorded.length = 0;

  await replyHandler({
    chat_id: 'chat_buf',
    text: 'some text',
    card: validCard,
  });

  if (buffer.recorded.length !== 1) fail(`Test 4: buffer not recorded (got ${buffer.recorded.length})`);
  if (buffer.recorded[0].chatId !== 'chat_buf') fail('Test 4: wrong chatId in buffer');
  if (buffer.recorded[0].entry.role !== 'assistant') fail('Test 4: wrong role in buffer');

  // ── Test 5: card path revokes ack reactions (exact match) ──
  apiCalls.length = 0;
  ackReactions.set('om_ack_msg', { reactionId: 'reaction_abc', addedAt: Date.now() });

  await replyHandler({
    chat_id: 'chat_ack',
    text: '',
    card: validCard,
    reply_to: 'om_ack_msg',
  });

  if (ackReactions.size !== 0) fail(`Test 5: ack reactions not cleared (size=${ackReactions.size})`);
  const deleteCall = apiCalls.find((c) => c.method === 'messageReaction.delete');
  if (!deleteCall) fail('Test 5: messageReaction.delete not called');
  if (deleteCall.args.path.reaction_id !== 'reaction_abc') fail('Test 5: wrong reaction_id');

  // ── Test 6: NO bulk-wipe when reply_to doesn't match (#85 fix) ──
  //   Pre-v1.0.30: a reply without reply_to (or with a stale/wrong
  //   reply_to) called the bulk-wipe branch and deleted EVERY other
  //   user's pending ack in the Map — cross-chat, cross-user. A single
  //   misrouted reply could erase every "I'm processing it" emoji.
  //   Post-fix: silent no-op + stderr breadcrumb; TTL backstop in
  //   channel.pruneStaleAcks cleans orphans.
  apiCalls.length = 0;
  ackReactions.set('om_other1', { reactionId: 'r1', addedAt: Date.now() });
  ackReactions.set('om_other2', { reactionId: 'r2', addedAt: Date.now() });

  const errors6: string[] = [];
  const origError6 = console.error;
  console.error = (...args: unknown[]) => { errors6.push(args.map(String).join(' ')); };
  try {
    await replyHandler({
      chat_id: 'chat_ack2',
      text: '',
      card: validCard,
      // no reply_to — used to bulk-wipe; now must no-op
    });
  } finally {
    console.error = origError6;
  }

  if (ackReactions.size !== 2) {
    fail(`Test 6: other-user acks must be preserved (got size=${ackReactions.size})`);
  }
  const deleteCalls6 = apiCalls.filter((c) => c.method === 'messageReaction.delete');
  if (deleteCalls6.length !== 0) {
    fail(`Test 6: NO reactions should be deleted (got ${deleteCalls6.length})`);
  }
  if (!errors6.some((e) => /revokeAckFor/.test(e) && /no message_id/.test(e))) {
    fail(`Test 6: must log stderr breadcrumb on no-match; got: ${errors6.join(' | ')}`);
  }
  // Cleanup for subsequent tests
  ackReactions.clear();

  // ── Test 7: card with empty text uses '[card]' fallback in buffer ──
  buffer.recorded.length = 0;

  await replyHandler({
    chat_id: 'chat_no_text',
    text: '',
    card: validCard,
  });

  if (buffer.recorded[0].entry.text !== '[card]') {
    fail(`Test 7: expected '[card]' fallback, got '${buffer.recorded[0].entry.text}'`);
  }

  // ── Test 8: no card param → normal text path ──
  apiCalls.length = 0;
  buffer.recorded.length = 0;

  const r8 = await replyHandler({
    chat_id: 'chat_normal',
    text: 'hello plain text',
  });

  if (r8.isError) fail('Test 8: unexpected error');
  const normalCreate = apiCalls.find(
    (c) => c.method === 'message.create' && c.args.data.msg_type === 'text'
  );
  if (!normalCreate) fail('Test 8: plain text path should use msg_type=text');

  // ── Test 9: partial-failure leak — ack STILL revoked when send throws (#85) ──
  //   Pre-v1.0.30: recordAndRevokeAck was called ONLY after every send
  //   succeeded. A thrown card / text-chunk / attachment error left the
  //   user's MeMeMe emoji on their message permanently AND leaked the
  //   ackReactions Map entry. With Stop-hook strong-replay, the bot was
  //   forced to retry → ack count grew unbounded per retry storm.
  //   Post-fix: try/finally wraps the send body so revokeAckFor runs
  //   on success, on thrown error, and on early-return alike.
  {
    apiCalls.length = 0;
    ackReactions.clear();
    ackReactions.set('om_throw_test', { reactionId: 'r_throw', addedAt: Date.now() });

    // Hot-swap message.reply to throw a Feishu-shaped 500 once
    const origReply = client.im.v1.message.reply;
    let replyCount = 0;
    client.im.v1.message.reply = async (args: any) => {
      apiCalls.push({ method: 'message.reply', args });
      replyCount++;
      const err: any = new Error('Feishu API [500]: synthetic server error');
      err.response = { data: { code: 500, msg: 'synthetic server error' } };
      throw err;
    };

    let threw = false;
    try {
      await replyHandler({
        chat_id: 'chat_throw_test',
        text: 'hello',
        reply_to: 'om_throw_test',
      });
    } catch {
      threw = true;
    } finally {
      client.im.v1.message.reply = origReply;
    }

    if (!threw) fail(`Test 9: expected reply to propagate the synthetic 500`);
    // CRITICAL assertion: ack must be revoked despite the throw.
    if (ackReactions.size !== 0) {
      fail(`Test 9: ack must be revoked on thrown send (got size=${ackReactions.size})`);
    }
    const delCalls9 = apiCalls.filter((c) => c.method === 'messageReaction.delete');
    if (delCalls9.length !== 1) {
      fail(`Test 9: expected 1 messageReaction.delete in finally, got ${delCalls9.length}`);
    }
    if (delCalls9[0].args.path.reaction_id !== 'r_throw') {
      fail(`Test 9: wrong reaction_id revoked: ${delCalls9[0].args.path.reaction_id}`);
    }
  }

  // ── Tests 10-12: pruneStaleAcks TTL backstop (#85) ──
  //   Pure-function tests exercising pruneStaleAcksImpl directly so
  //   they don't need a real LarkChannel (which needs LARK_APP_ID env
  //   to construct an SDK client). Verifies stale entries are removed
  //   AND best-effort revoked via messageReaction.delete.

  // 10. Fresh entry preserved; stale entry pruned + revoked.
  {
    const ackPrune = new Map<string, { reactionId: string; addedAt: number }>();
    const now = 1_700_000_000_000;
    ackPrune.set('msg_fresh', { reactionId: 'r_fresh', addedAt: now - 60_000 });        // 1 min old → kept
    ackPrune.set('msg_stale', { reactionId: 'r_stale', addedAt: now - 10 * 60_000 });    // 10 min old → pruned

    const deletes10: any[] = [];
    const mockClient: AckRevokeClient = {
      im: { v1: { messageReaction: { delete: async (args: any) => { deletes10.push(args); } } } },
    };

    const pruned = pruneStaleAcksImpl(ackPrune, mockClient, now, ACK_TTL_MS);

    if (pruned !== 1) fail(`Test 10: expected 1 pruned, got ${pruned}`);
    if (ackPrune.size !== 1) fail(`Test 10: fresh entry should remain (size=${ackPrune.size})`);
    if (!ackPrune.has('msg_fresh')) fail(`Test 10: msg_fresh must be preserved`);
    if (ackPrune.has('msg_stale')) fail(`Test 10: msg_stale must be removed`);
    if (deletes10.length !== 1) fail(`Test 10: expected 1 messageReaction.delete, got ${deletes10.length}`);
    if (deletes10[0].path.message_id !== 'msg_stale') fail(`Test 10: wrong target message_id`);
    if (deletes10[0].path.reaction_id !== 'r_stale') fail(`Test 10: wrong target reaction_id`);
  }

  // 11. All-fresh case: nothing pruned, no API calls.
  {
    const ackPrune = new Map<string, { reactionId: string; addedAt: number }>();
    const now = 1_700_000_000_000;
    ackPrune.set('msg_a', { reactionId: 'r_a', addedAt: now - 10_000 });
    ackPrune.set('msg_b', { reactionId: 'r_b', addedAt: now - 60_000 });

    const deletes11: any[] = [];
    const mockClient: AckRevokeClient = {
      im: { v1: { messageReaction: { delete: async (args: any) => { deletes11.push(args); } } } },
    };

    const pruned = pruneStaleAcksImpl(ackPrune, mockClient, now, ACK_TTL_MS);

    if (pruned !== 0) fail(`Test 11: all-fresh should prune 0, got ${pruned}`);
    if (ackPrune.size !== 2) fail(`Test 11: both entries should remain`);
    if (deletes11.length !== 0) fail(`Test 11: no API calls when nothing stale`);
  }

  // 12. Boundary: entry exactly at ACK_TTL_MS old is NOT stale (strict >).
  {
    const ackPrune = new Map<string, { reactionId: string; addedAt: number }>();
    const now = 1_700_000_000_000;
    ackPrune.set('msg_exact', { reactionId: 'r_exact', addedAt: now - ACK_TTL_MS });
    ackPrune.set('msg_over', { reactionId: 'r_over', addedAt: now - ACK_TTL_MS - 1 });

    const mockClient: AckRevokeClient = {
      im: { v1: { messageReaction: { delete: async () => {} } } },
    };

    const pruned = pruneStaleAcksImpl(ackPrune, mockClient, now, ACK_TTL_MS);

    if (pruned !== 1) fail(`Test 12: only over-threshold should prune (got ${pruned})`);
    if (!ackPrune.has('msg_exact')) fail(`Test 12: exactly-at-threshold must be kept (strict >)`);
    if (ackPrune.has('msg_over')) fail(`Test 12: just-over-threshold must be pruned`);
  }

  // 13. Empty Map: returns 0, no API calls (safety check for the
  //     setInterval idle case).
  {
    const ackPrune = new Map<string, { reactionId: string; addedAt: number }>();
    const deletes13: any[] = [];
    const mockClient: AckRevokeClient = {
      im: { v1: { messageReaction: { delete: async (args: any) => { deletes13.push(args); } } } },
    };
    const pruned = pruneStaleAcksImpl(ackPrune, mockClient, Date.now(), ACK_TTL_MS);
    if (pruned !== 0) fail(`Test 13: empty map must return 0 (got ${pruned})`);
    if (deletes13.length !== 0) fail(`Test 13: empty map must skip API calls`);
  }

  // 14. Delete API throws → swallowed; prune count still reflects removed entries.
  //     Guards against a future regression where a Feishu error in revoke
  //     propagates and aborts the prune mid-iteration.
  {
    const ackPrune = new Map<string, { reactionId: string; addedAt: number }>();
    const now = 1_700_000_000_000;
    ackPrune.set('msg_stale_1', { reactionId: 'r1', addedAt: now - 10 * 60_000 });
    ackPrune.set('msg_stale_2', { reactionId: 'r2', addedAt: now - 10 * 60_000 });

    const mockClient: AckRevokeClient = {
      im: { v1: { messageReaction: { delete: async () => {
        throw new Error('synthetic Feishu 500');
      } } } },
    };

    let threw = false;
    let pruned = 0;
    try {
      pruned = pruneStaleAcksImpl(ackPrune, mockClient, now, ACK_TTL_MS);
    } catch {
      threw = true;
    }
    if (threw) fail(`Test 14: prune must not throw when revoke API throws`);
    if (pruned !== 2) fail(`Test 14: prune count should be 2 despite revoke throws (got ${pruned})`);
    if (ackPrune.size !== 0) fail(`Test 14: both entries should still be removed from Map`);
  }

  console.log('PASS');
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
