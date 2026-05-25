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
import { JOB_THREAD_PREFIX } from '../src/scheduler.js';

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
          patch: async (args: any) => {
            // #111: edit_message uses message.patch. Mock returns empty
            // data (Feishu's actual response shape per SDK types).
            apiCalls.push({ method: 'message.patch', args });
            return { data: {} };
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
    // #111: mock replaceLastAssistant — mutates the most recent assistant
    // entry in `recorded` for the given chatId. Production ConversationBuffer
    // walks its own internal buffer; we mirror the semantics on `recorded`
    // so the smoke test can observe the buffer-mirror behavior.
    replaceLastAssistant(chatId: string, newText: string): boolean {
      for (let i = recorded.length - 1; i >= 0; i--) {
        const r = recorded[i];
        if (r.chatId === chatId && r.entry.role === 'assistant') {
          r.entry.text = newText;
          r.entry.timestamp = new Date().toISOString();
          return true;
        }
      }
      return false;
    },
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
  // v1.0.32 (#80): BotMessageTracker.add now requires chatId (+ optional
  // threadId). Tests verify the call sites pass them through correctly.
  const botTrackerAdded: { id: string; chatId: string; threadId?: string }[] = [];
  const botTracker = {
    ids: new Set<string>(),
    maxSize: 500,
    set: new Set<string>(),
    meta: new Map<string, { chatId: string; threadId?: string }>(),
    add(id: string, chatId: string, threadId?: string) {
      botTrackerAdded.push({ id, chatId, threadId });
      this.ids.add(id);
      this.meta.set(id, { chatId, threadId });
    },
    has(id: string) { return this.ids.has(id); },
    get(id: string) { return this.meta.get(id); },
  };
  const buffer = makeBuffer();
  // v1.0.30 (#85): ackReactions is now { reactionId, addedAt }, not bare string,
  // so the TTL backstop in channel.pruneStaleAcks has timestamps to work with.
  const ackReactions = new Map<string, { reactionId: string; addedAt: number }>();

  // Register tools (captures handlers via fake server)
  const identitySession = new IdentitySession(() => null);
  // Bind a fake caller so resolveCaller-gated tools can be exercised.
  identitySession.setCaller('chat_001', undefined, 'ou_reply_smoke');
  // v1.0.44 #136: revokeAckFor now calls channel.markPendingAckRevoke
  // when the Map has no entry — stub it as a no-op for these tests
  // (they're not testing the pending-revoke set-vs-revoke race; that
  // lives in scripts/ack-reaction-batch-smoke.ts).
  const fakeChannel = {
    isPrivateChat: () => true,
    markPendingAckRevoke: (_: string) => {},
    consumePendingAckRevoke: (_: string) => false,
    // v1.0.53 #159/#160: revokeAckFor's markIfMissing path now also
    // calls channel.isRecentInbound. Stub true so reply tool tests
    // that exercise the mark path keep working (they test reply's
    // ack-revoke contract, not the inbound-id gate).
    isRecentInbound: (_: string) => true,
  } as unknown as LarkChannel;

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

  if (botTrackerAdded.length !== 1 || botTrackerAdded[0].id !== 'mock_msg_001') {
    fail(`Test 1: botTracker not updated: ${JSON.stringify(botTrackerAdded)}`);
  }
  // v1.0.32 (#80): chatId must be plumbed through so reaction events can
  // resolve the chat from the tracked id.
  if (botTrackerAdded[0].chatId !== 'chat_001') {
    fail(`Test 1: botTracker should record chatId, got ${botTrackerAdded[0].chatId}`);
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

  // ── Test 8b: #110 fix — cron-originated reply does NOT record into buffer ──
  //   Pre-fix, every reply (including prompt-type cronjob replies) was
  //   recorded into the per-chat ConversationBuffer. A cronjob hitting
  //   an active chat reset the buffer's inactivity timer on every fire
  //   → auto-flush (default 3h) never triggered → buffer grew unboundedly,
  //   cron output got mixed with real user dialogue, eventual distillation
  //   was garbage.
  //
  //   Detection uses the JOB_THREAD_PREFIX synthetic id on thread_id.
  //   R1-followup: bind identities for BOTH threads up front so the
  //   sanity-check non-cron call has a valid caller; pre-fix the test
  //   had a stale ordering that made the sanity check effectively dead
  //   code (the first non-cron call was discarded before assertion).
  {
    const cronThread = `${JOB_THREAD_PREFIX}some-job-123`;
    identitySession.setCaller('chat_cron', cronThread, 'ou_cron_owner');
    identitySession.setCaller('chat_cron', 'thr_real_user', 'ou_real_user');

    // Sub-case a: cron-thread → buffer.recorded stays at 0, BUT the
    // Feishu send still happens (we're only suppressing the buffer
    // record, not the actual reply delivery — cron users still see
    // the message). R2-followup: assert apiCalls confirms send
    // happened so a future regression that disables both the record
    // AND the send is caught here.
    apiCalls.length = 0;
    buffer.recorded.length = 0;
    await replyHandler({
      chat_id: 'chat_cron',
      thread_id: cronThread,
      text: 'hourly status update from cron',
    });
    if (buffer.recorded.length !== 0) {
      fail(`8b-cron: cron-thread reply must NOT record (got ${buffer.recorded.length})`);
    }
    if (apiCalls.length === 0) {
      fail(`8b-cron: cron-thread reply must still SEND to Feishu (got 0 API calls)`);
    }

    // Sub-case b: non-cron thread → buffer.recorded === 1 AND send happens
    apiCalls.length = 0;
    buffer.recorded.length = 0;
    await replyHandler({
      chat_id: 'chat_cron',
      thread_id: 'thr_real_user',
      text: 'user-driven reply',
    });
    if (buffer.recorded.length !== 1) {
      fail(`8b-sanity: non-cron-thread reply MUST record (got ${buffer.recorded.length})`);
    }
    if (apiCalls.length === 0) {
      fail(`8b-sanity: non-cron-thread reply must SEND (got 0 API calls)`);
    }
  }

  // ── Test 8c: #111 — edit_message mirrors edit into ConversationBuffer ──
  //   Pre-fix, edit_message only patched Feishu and left the buffer
  //   holding pre-edit text → distillation flushed stale content into
  //   episodes. Fix: pass chat_id (and thread_id) to edit_message, and
  //   the handler calls conversationBuffer.replaceLastAssistant.
  {
    const editHandler = handlers.get('edit_message');
    if (!editHandler) fail('8c: edit_message handler not registered');
    identitySession.setCaller('chat_edit', undefined, 'ou_edit_user');

    // Seed: simulate a prior reply having recorded an assistant entry.
    buffer.recorded.length = 0;
    apiCalls.length = 0;
    await replyHandler({
      chat_id: 'chat_edit',
      text: '会议在 3 点',
    });
    if (buffer.recorded.length !== 1) {
      fail(`8c-seed: prior reply should have recorded an assistant entry (got ${buffer.recorded.length})`);
    }
    if (buffer.recorded[0].entry.text !== '会议在 3 点') {
      fail(`8c-seed: seeded text mismatch (got ${buffer.recorded[0].entry.text})`);
    }

    // Now edit — pass chat_id so the fix takes effect
    apiCalls.length = 0;
    const r = await editHandler({
      message_id: 'om_bot_card_001',
      text: '会议在 4 点',
      chat_id: 'chat_edit',
    });
    // Patch call landed
    const patchCall = apiCalls.find((c) => c.method === 'message.patch');
    if (!patchCall) fail(`8c: edit_message must call message.patch`);
    // Buffer's stored assistant entry should now reflect the edited text.
    // The mock's `record` pushes objects into `buffer.recorded`; the
    // backing entries are the same references (no defensive copy in
    // makeBuffer). So mutation via replaceLastAssistant should be visible.
    const latest = buffer.recorded[buffer.recorded.length - 1].entry;
    if (latest.text !== '会议在 4 点') {
      fail(`8c: buffer entry must reflect edited text (got ${latest.text})`);
    }
  }

  // ── Test 8d: #111 — edit_message WITHOUT chat_id silently no-ops on buffer ──
  //   Backward compat: existing callers that don't pass chat_id should
  //   still see the patch land on Feishu, just without buffer-mirroring
  //   (falls back to pre-fix behavior; no worse than before).
  {
    const editHandler = handlers.get('edit_message');
    identitySession.setCaller('chat_edit_nocid', undefined, 'ou_edit_user');

    buffer.recorded.length = 0;
    await replyHandler({
      chat_id: 'chat_edit_nocid',
      text: 'original text',
    });
    const beforeText = buffer.recorded[0].entry.text;
    if (beforeText !== 'original text') fail(`8d-seed: text mismatch`);

    apiCalls.length = 0;
    await editHandler({
      message_id: 'om_card_002',
      text: 'attempted edit',
      // chat_id intentionally omitted
    });
    const patchCall = apiCalls.find((c) => c.method === 'message.patch');
    if (!patchCall) fail(`8d: edit_message must still patch even without chat_id`);
    // Buffer unchanged
    if (buffer.recorded[0].entry.text !== 'original text') {
      fail(`8d: no chat_id → buffer must not be mirrored (got ${buffer.recorded[0].entry.text})`);
    }
  }

  // ── Test 8e: #111 — edit_message with cron-thread skips buffer mirror ──
  //   Same shape as 8b for the reply tool: cron-originated edits are
  //   not user dialogue and must not pollute the buffer.
  {
    const editHandler = handlers.get('edit_message');
    const cronThread = `${JOB_THREAD_PREFIX}edit-job-1`;
    identitySession.setCaller('chat_edit_cron', cronThread, 'ou_cron_owner');

    buffer.recorded.length = 0;
    // Seed a prior NON-cron assistant entry in this chat so we can
    // detect if the cron-edit incorrectly mutates it.
    identitySession.setCaller('chat_edit_cron', 'thr_real', 'ou_real');
    await replyHandler({
      chat_id: 'chat_edit_cron',
      thread_id: 'thr_real',
      text: 'real user reply',
    });
    if (buffer.recorded[0].entry.text !== 'real user reply') fail(`8e-seed: setup failed`);

    apiCalls.length = 0;
    await editHandler({
      message_id: 'om_card_003',
      text: 'cron-edit attempt',
      chat_id: 'chat_edit_cron',
      thread_id: cronThread,
    });
    // Patch landed
    if (!apiCalls.find((c) => c.method === 'message.patch')) {
      fail(`8e: cron edit must still patch Feishu`);
    }
    // Buffer's real-user entry MUST be untouched
    if (buffer.recorded[0].entry.text !== 'real user reply') {
      fail(`8e: cron-thread edit must NOT mutate real-user buffer entry (got ${buffer.recorded[0].entry.text})`);
    }
  }

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

  // 14. Delete API rejection (async-throw) is swallowed; prune count
  //     still reflects removed entries. R2-audit followup: the SYNC-throw
  //     case (a delete fn that throws BEFORE returning a promise) is
  //     also covered — the for-of loop catches via the surrounding
  //     try/catch? Actually no: pruneStaleAcksImpl does NOT wrap delete
  //     in a try/catch (only `.catch` on the returned promise). A
  //     synchronous throw from delete WOULD currently abort the loop.
  //     We cover the async case (the realistic Feishu SDK shape) here;
  //     the setInterval-wrapper try/catch added in the same followup
  //     prevents a sync-throw regression from crashing the process.
  {
    const ackPrune = new Map<string, { reactionId: string; addedAt: number }>();
    const now = 1_700_000_000_000;
    ackPrune.set('msg_stale_1', { reactionId: 'r1', addedAt: now - 10 * 60_000 });
    ackPrune.set('msg_stale_2', { reactionId: 'r2', addedAt: now - 10 * 60_000 });

    const mockClient: AckRevokeClient = {
      im: { v1: { messageReaction: { delete: async () => {
        // async-throw: SDK shape (returns a rejected promise). The pure
        // function's `.catch(() => {})` swallows this without affecting
        // iteration.
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
    if (threw) fail(`Test 14: prune must not throw when revoke API returns rejected promise`);
    if (pruned !== 2) fail(`Test 14: prune count should be 2 despite revoke rejections (got ${pruned})`);
    if (ackPrune.size !== 0) fail(`Test 14: both entries should still be removed from Map`);
  }

  // 15. R2-audit followup: confirm pruneStaleAcksImpl iterates the WHOLE
  //     Map even when many entries are stale (no early-exit, no
  //     reordering surprise from concurrent delete-during-iter). Tests 10
  //     and 14 each prune at most 2; this one prunes 5 to exercise the
  //     iterator under realistic load and asserts every entry was both
  //     removed from the Map AND fired a delete call.
  {
    const ackPrune = new Map<string, { reactionId: string; addedAt: number }>();
    const now = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      ackPrune.set(`msg_bulk_${i}`, { reactionId: `r_${i}`, addedAt: now - 10 * 60_000 });
    }
    const deletes15: any[] = [];
    const mockClient: AckRevokeClient = {
      im: { v1: { messageReaction: { delete: async (args: any) => { deletes15.push(args); } } } },
    };
    const pruned = pruneStaleAcksImpl(ackPrune, mockClient, now, ACK_TTL_MS);
    if (pruned !== 5) fail(`Test 15: expected all 5 pruned, got ${pruned}`);
    if (ackPrune.size !== 0) fail(`Test 15: Map should be empty (size=${ackPrune.size})`);
    if (deletes15.length !== 5) fail(`Test 15: expected 5 delete calls, got ${deletes15.length}`);
    // Verify every msg_bulk_i fired its delete (no skipped/duplicated).
    const seenIds = new Set(deletes15.map((d: any) => d.path.message_id));
    if (seenIds.size !== 5) fail(`Test 15: duplicate or missing delete targets: ${[...seenIds].join(',')}`);
  }

  console.log('PASS');
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
