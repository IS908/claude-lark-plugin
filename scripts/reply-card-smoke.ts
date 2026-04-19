/**
 * Reply tool raw-card path smoke test — runs as part of `npm test`.
 * Uses a mock Lark client to verify the card param behavior without network.
 * Exits non-zero if any assertion fails.
 */
import { registerTools } from '../src/tools.js';
import type { MemoryStore } from '../src/memory/file.js';
import { IdentitySession } from '../src/identity-session.js';
import type { LarkChannel } from '../src/channel.js';

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
  const ackReactions = new Map<string, string>();

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
  ackReactions.set('om_ack_msg', 'reaction_abc');

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

  // ── Test 6: card path revokes all acks when no exact match ──
  apiCalls.length = 0;
  ackReactions.set('om_other1', 'r1');
  ackReactions.set('om_other2', 'r2');

  await replyHandler({
    chat_id: 'chat_ack2',
    text: '',
    card: validCard,
    // no reply_to — should revoke all pending acks
  });

  if (ackReactions.size !== 0) fail(`Test 6: ack reactions not fully cleared (size=${ackReactions.size})`);
  const deleteCalls = apiCalls.filter((c) => c.method === 'messageReaction.delete');
  if (deleteCalls.length !== 2) fail(`Test 6: expected 2 reaction deletes, got ${deleteCalls.length}`);

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

  console.log('PASS');
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
