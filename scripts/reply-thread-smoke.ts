/**
 * Reply tool thread-routing smoke test — runs as part of `npm test`.
 * Uses a mock Lark client to verify that follow-up messages (multi-chunk
 * text, multi-card, attachments) correctly stay in the source message's
 * thread when `thread_id` is present, and fall through to `message.create`
 * otherwise.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../src/tools.js';
import type { MemoryStore } from '../src/memory/file.js';
import { IdentitySession } from '../src/identity-session.js';
import type { LarkChannel } from '../src/channel.js';
import { JOB_THREAD_PREFIX } from '../src/scheduler.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;
const apiCalls: { method: string; args: any }[] = [];

function mockClient() {
  return {
    im: {
      v1: {
        message: {
          create: async (args: any) => {
            apiCalls.push({ method: 'message.create', args });
            return { data: { message_id: `created_${apiCalls.length}` } };
          },
          reply: async (args: any) => {
            apiCalls.push({ method: 'message.reply', args });
            return { data: { message_id: `replied_${apiCalls.length}` } };
          },
        },
        messageReaction: {
          create: async () => {},
          delete: async () => {},
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

function makeBuffer() {
  return {
    record() {},
    flush: async () => {},
    startAutoFlush: () => {},
    stopAutoFlush: () => {},
  };
}

const handlers = new Map<string, (args: any) => Promise<any>>();
const fakeServer = {
  registerTool(name: string, _config: any, handler: any) {
    handlers.set(name, handler);
  },
};

async function setup() {
  apiCalls.length = 0;
  const client = mockClient();
  const botTracker = {
    ids: new Set<string>(),
    add(id: string) { this.ids.add(id); },
    has(id: string) { return this.ids.has(id); },
  };
  const identitySession = new IdentitySession(() => null);
  identitySession.setCaller('chat_grp', 'thread_abc', 'ou_caller');
  identitySession.setCaller('chat_p2p', undefined, 'ou_caller');
  const fakeChannel = { isPrivateChat: () => true } as unknown as LarkChannel;

  registerTools(
    fakeServer as any,
    client as any,
    noopMemory,
    identitySession,
    fakeChannel,
    makeBuffer() as any,
    new Map<string, string>(),
    botTracker as any,
    undefined,
  );

  const reply = handlers.get('reply');
  if (!reply) fail('reply handler not registered');
  return { reply };
}

// A fixture image on disk for attachment tests
const fixDir = mkdtempSync(join(tmpdir(), 'reply-thread-fix-'));
const imgPath = join(fixDir, 'fake.png');
writeFileSync(imgPath, Buffer.from('fake-png-bytes'));

// ── 1. Thread + image: image must go via reply(..., reply_in_thread=true) ──
{
  const { reply } = await setup();
  await reply({
    chat_id: 'chat_grp',
    text: 'here is the image',
    reply_to: 'om_user1',
    thread_id: 'thread_abc',
    files: [{ path: imgPath, type: 'image' }],
  });
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  if (createCalls.length !== 0) {
    fail(`1: expected 0 message.create in thread mode, got ${createCalls.length}`);
  }
  // 1 for text, 1 for image — both via reply
  if (replyCalls.length !== 2) {
    fail(`1: expected 2 message.reply, got ${replyCalls.length}`);
  }
  const imageCall = replyCalls[1];
  if (imageCall.args.path.message_id !== 'om_user1') {
    fail(`1: image reply path.message_id wrong: ${imageCall.args.path.message_id}`);
  }
  if (imageCall.args.data.reply_in_thread !== true) {
    fail(`1: image reply missing reply_in_thread=true, got ${JSON.stringify(imageCall.args.data)}`);
  }
  if (imageCall.args.data.msg_type !== 'image') {
    fail(`1: image reply msg_type wrong: ${imageCall.args.data.msg_type}`);
  }
  passed++;
}

// ── 2. P2P + image: image must still use message.create (no reply_in_thread) ──
{
  const { reply } = await setup();
  await reply({
    chat_id: 'chat_p2p',
    text: 'here is the image',
    reply_to: 'om_p2p1',
    // no thread_id — P2P
    files: [{ path: imgPath, type: 'image' }],
  });
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  // text chunk 0 → reply; image → create (no thread)
  if (replyCalls.length !== 1) fail(`2: expected 1 message.reply, got ${replyCalls.length}`);
  if (createCalls.length !== 1) fail(`2: expected 1 message.create (image), got ${createCalls.length}`);
  const imgCreate = createCalls[0];
  if (imgCreate.args.data.msg_type !== 'image') {
    fail(`2: image create msg_type wrong: ${imgCreate.args.data.msg_type}`);
  }
  if ('reply_in_thread' in imgCreate.args.data) {
    fail(`2: P2P image create must NOT carry reply_in_thread`);
  }
  passed++;
}

// ── 3. Thread + long text (multi-chunk): chunks 2..N use reply_in_thread ──
{
  const { reply } = await setup();
  // Force text path + multi-chunk (text > LARK_TEXT_CHUNK_LIMIT = 4000)
  const big = 'a'.repeat(9000);
  await reply({
    chat_id: 'chat_grp',
    text: big,
    reply_to: 'om_user2',
    thread_id: 'thread_abc',
    format: 'text',
  });
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  if (createCalls.length !== 0) {
    fail(`3: expected 0 message.create in thread mode, got ${createCalls.length}`);
  }
  if (replyCalls.length < 2) {
    fail(`3: expected multi-chunk replies (>=2), got ${replyCalls.length}`);
  }
  // First call is the bare quote-reply; subsequent must carry reply_in_thread
  if ('reply_in_thread' in replyCalls[0].args.data) {
    fail(`3: first chunk must not carry reply_in_thread`);
  }
  for (let i = 1; i < replyCalls.length; i++) {
    if (replyCalls[i].args.data.reply_in_thread !== true) {
      fail(`3: chunk ${i} missing reply_in_thread=true`);
    }
  }
  passed++;
}

// ── 4. No reply_to + thread_id (shouldStayInThread guard) ─────────────
// When effectiveReplyTo cannot be resolved (no reply_to, no tracker), the
// follow-up must NOT try to call message.reply with an empty path — it
// should fall through to message.create to avoid SDK errors.
{
  const { reply } = await setup();
  await reply({
    chat_id: 'chat_grp',
    text: 'one line',
    thread_id: 'thread_abc',
    // no reply_to, no tracker configured in setup
    files: [{ path: imgPath, type: 'image' }],
  });
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  if (replyCalls.length !== 0) {
    fail(`4: expected no reply calls without effectiveReplyTo, got ${replyCalls.length}`);
  }
  // 1 text + 1 image, both create
  if (createCalls.length !== 2) {
    fail(`4: expected 2 message.create, got ${createCalls.length}`);
  }
  passed++;
}

// ── 5. Thread + file attachment ──────────────────────────────────
{
  const { reply } = await setup();
  const filePath = join(fixDir, 'doc.txt');
  writeFileSync(filePath, 'hello');
  await reply({
    chat_id: 'chat_grp',
    text: 'here is the file',
    reply_to: 'om_user3',
    thread_id: 'thread_abc',
    files: [{ path: filePath, type: 'file' }],
  });
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  const fileReply = replyCalls.find((c) => c.args.data.msg_type === 'file');
  if (!fileReply) fail('5: file attachment not sent via reply');
  if (fileReply.args.data.reply_in_thread !== true) {
    fail('5: file attachment missing reply_in_thread=true');
  }
  passed++;
}

// ── 6. Thread + multi-card (format=card): cards 2..N use reply_in_thread ──
{
  const { reply } = await setup();
  // Force cards path via format='card'; exceed CARD_SIZE_LIMIT (25KB) with
  // multiple markdown elements to actually trigger multi-card split.
  // Use repeated markdown blocks so each becomes a separate element.
  const block = '# heading\n\n' + 'x'.repeat(2000) + '\n\n';
  const multiCardText = block.repeat(20); // ~40KB, forces >=2 cards
  await reply({
    chat_id: 'chat_grp',
    text: multiCardText,
    reply_to: 'om_user4',
    thread_id: 'thread_abc',
    format: 'card',
  });
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  if (createCalls.length !== 0) {
    fail(`6: expected 0 message.create in thread mode, got ${createCalls.length}`);
  }
  // At least 2 card chunks expected
  if (replyCalls.length < 2) {
    fail(`6: expected multi-card replies (>=2), got ${replyCalls.length}`);
  }
  if ('reply_in_thread' in replyCalls[0].args.data) {
    fail(`6: first card must not carry reply_in_thread`);
  }
  for (let i = 1; i < replyCalls.length; i++) {
    if (replyCalls[i].args.data.reply_in_thread !== true) {
      fail(`6: card ${i} missing reply_in_thread=true`);
    }
    if (replyCalls[i].args.data.msg_type !== 'interactive') {
      fail(`6: card ${i} msg_type wrong: ${replyCalls[i].args.data.msg_type}`);
    }
  }
  passed++;
}

// ── 7. Synthetic cronjob thread_id must NOT trigger reply_in_thread ──
// Regression guard: cronjob dispatches inject thread_id="job-<id>-<ts>"
// as an IdentitySession isolation key. That value does not correspond to
// a real Feishu thread. If the reply tool treated it like one and emitted
// reply_in_thread:true against a real reply_to, Feishu would fabricate a
// new thread around that earlier message — an unintended side effect.
{
  const { reply } = await setup();
  await reply({
    chat_id: 'chat_grp',
    text: 'cron output',
    reply_to: 'om_some_earlier_msg',
    thread_id: `${JOB_THREAD_PREFIX}example-1700000000000`,
    files: [{ path: imgPath, type: 'image' }],
  });
  const createCalls = apiCalls.filter((c) => c.method === 'message.create');
  const replyCalls = apiCalls.filter((c) => c.method === 'message.reply');
  // text chunk 0 quote-replies (reply without flag); image falls through to create
  if (replyCalls.length !== 1) fail(`7: expected 1 reply (text chunk 0), got ${replyCalls.length}`);
  if ('reply_in_thread' in replyCalls[0].args.data) {
    fail(`7: first chunk must not carry reply_in_thread even for cronjob thread`);
  }
  if (createCalls.length !== 1) fail(`7: expected 1 create (image), got ${createCalls.length}`);
  if ('reply_in_thread' in createCalls[0].args.data) {
    fail(`7: create must not carry reply_in_thread`);
  }
  if (createCalls[0].args.data.msg_type !== 'image') {
    fail(`7: create msg_type wrong: ${createCalls[0].args.data.msg_type}`);
  }
  passed++;
}

console.log(`reply-thread smoke: ${passed}/7 PASS`);
