/**
 * handleCommentEvent smoke test — drive.notice.comment_add_v1 dispatch.
 * Spec: docs/superpowers/specs/2026-06-06-doc-comment-channel-design.md §10.2
 */
process.env.LARK_APP_ID = process.env.LARK_APP_ID ?? 'cli_test';
process.env.LARK_APP_SECRET = process.env.LARK_APP_SECRET ?? 'secret';

import { handleCommentEvent, type CommentEventDeps } from '../src/channel.js';
import { IdentitySession } from '../src/identity-session.js';
import { MessageQueue } from '../src/queue.js';
import { TTLCache } from '../src/ttl-cache.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function makeEvent(overrides: Partial<{ event_id: string; is_mentioned: boolean;
  file_token: string; comment_id: string; reply_id?: string;
  from_open_id: string; to_open_id: string; }> = {}) {
  const {
    event_id = 'evt_' + Math.random().toString(36).slice(2, 10),
    is_mentioned = true,
    file_token = 'dox_test',
    comment_id = 'cmt_001',
    reply_id,
    from_open_id = 'ou_sender',
    to_open_id = 'ou_bot',
  } = overrides;
  return {
    header: { event_id, event_type: 'drive.notice.comment_add_v1' },
    event: {
      notice_meta: {
        file_type: 'docx',
        file_token,
        comment_id,
        reply_id,
        is_mentioned,
        from_user_id: { open_id: from_open_id },
        to_user_id: { open_id: to_open_id },
      },
    },
  };
}

function makeDeps(overrides: Partial<CommentEventDeps> = {}): CommentEventDeps & {
  handlerCalls: any[]; commentGetCalls: any[]; metaCalls: any[];
} {
  const handlerCalls: any[] = [];
  const commentGetCalls: any[] = [];
  const metaCalls: any[] = [];
  const session = new IdentitySession(() => 'ou_owner_for_test');
  const deps: CommentEventDeps = {
    botOpenId: 'ou_bot',
    seenEventIds: new TTLCache<string, true>({ maxSize: 500, ttlMs: 60 * 60_000 }),
    identitySession: session,
    queue: new MessageQueue(),
    messageHandler: async (m) => { handlerCalls.push(m); },
    resolveUserName: async (openId) => `name_for_${openId}`,
    client: {
      drive: {
        fileComment: {
          get: async (params: any) => {
            commentGetCalls.push(params);
            return {
              data: {
                quote: 'quoted text',
                reply_list: { items: [{ reply_id: params.path.comment_id, content: { text: 'body' } }] },
              },
            };
          },
        },
        meta: {
          batchQuery: async (params: any) => {
            metaCalls.push(params);
            return { data: { metas: [{ doc_token: 'dox_test', title: 'Test Doc' }] } };
          },
        },
      },
    } as any,
    ...overrides,
  };
  return Object.assign(deps, { handlerCalls, commentGetCalls, metaCalls });
}

// 1. dedup: same event_id processed twice → handler called once
{
  const deps = makeDeps();
  const evt = makeEvent({ event_id: 'evt_dup' });
  await handleCommentEvent(evt, deps);
  await handleCommentEvent(evt, deps);
  if (deps.handlerCalls.length !== 1) fail(`1: expected 1 handler call, got ${deps.handlerCalls.length}`);
}

// 2. is_mentioned=false dropped
{
  const deps = makeDeps();
  await handleCommentEvent(makeEvent({ is_mentioned: false }), deps);
  if (deps.handlerCalls.length !== 0) fail(`2: is_mentioned=false should drop`);
  if (deps.commentGetCalls.length !== 0) fail(`2: should not pre-fetch`);
}

// 3. to_user_id != bot dropped (defensive)
{
  const deps = makeDeps();
  await handleCommentEvent(makeEvent({ to_open_id: 'ou_other_user' }), deps);
  if (deps.handlerCalls.length !== 0) fail(`3: to_user_id mismatch should drop`);
}

// 4. from_user_id == bot dropped (loop prevention)
{
  const deps = makeDeps();
  await handleCommentEvent(makeEvent({ from_open_id: 'ou_bot' }), deps);
  if (deps.handlerCalls.length !== 0) fail(`4: bot's own comment must be dropped`);
}

// 5. add_comment (no reply_id): pre-fetch + envelope has <body> not <parent>
{
  const deps = makeDeps();
  await handleCommentEvent(makeEvent({ comment_id: 'cmt_5', reply_id: undefined }), deps);
  if (deps.commentGetCalls.length !== 1) fail(`5: expected 1 fileComment.get call`);
  const call = deps.commentGetCalls[0];
  if (call.path?.comment_id !== 'cmt_5') fail(`5: comment_id not passed`);
  if (call.path?.file_token !== 'dox_test') fail(`5: file_token not passed`);
  if (deps.handlerCalls.length !== 1) fail(`5: expected 1 handler call`);
  const msg = deps.handlerCalls[0];
  if (!msg.text.includes('<body>')) fail(`5: envelope missing <body>: ${msg.text.slice(0, 200)}`);
  if (msg.text.includes('<parent>')) fail(`5: add_comment must not have <parent>`);
}

// 7. pre-fetch throws → handler still called with <fetch_error>, event not dropped
{
  const failingClient = {
    drive: {
      fileComment: { get: async () => { throw new Error('feishu boom'); } },
      meta: { batchQuery: async () => ({ data: { metas: [] } }) },
    },
  };
  const deps = makeDeps({ client: failingClient as any });
  await handleCommentEvent(makeEvent({ comment_id: 'cmt_7' }), deps);
  if (deps.handlerCalls.length !== 1) fail(`7: handler should still fire on fetch error`);
  if (!deps.handlerCalls[0].text.includes('<fetch_error>')) fail(`7: envelope missing <fetch_error>`);
}

// 8. doc_title fetch failure → no doc_title attribute, handler still called
{
  const noTitleClient = {
    drive: {
      fileComment: {
        get: async (params: any) => ({
          data: { quote: '', reply_list: { items: [{ reply_id: params.path.comment_id, content: { text: 'b' } }] } },
        }),
      },
      meta: { batchQuery: async () => { throw new Error('meta boom'); } },
    },
  };
  const deps = makeDeps({ client: noTitleClient as any });
  await handleCommentEvent(makeEvent({ comment_id: 'cmt_8' }), deps);
  if (deps.handlerCalls.length !== 1) fail(`8: handler should fire even when title fetch fails`);
  if (deps.handlerCalls[0].text.includes('doc_title=')) fail(`8: doc_title must be omitted on failure`);
}

// 7a. ampersand in operator name escaped exactly once
{
  const deps = makeDeps({ resolveUserName: async () => 'AT&T Engineering' });
  await handleCommentEvent(makeEvent({ comment_id: 'cmt_7a' }), deps);
  const text = deps.handlerCalls[0].text;
  if (!text.includes('operator="AT&amp;T Engineering"')) {
    fail(`7a: ampersand not escaped exactly once: ${text.slice(0, 300)}`);
  }
  if (text.includes('&amp;amp;')) fail(`7a: double-escaped: ${text.slice(0, 300)}`);
}

// 7b. quote char in operator escaped without &-double-encoding
{
  const deps = makeDeps({ resolveUserName: async () => 'Bob "the builder"' });
  await handleCommentEvent(makeEvent({ comment_id: 'cmt_7b' }), deps);
  const text = deps.handlerCalls[0].text;
  if (!text.includes('operator="Bob &quot;the builder&quot;"')) {
    fail(`7b: quote not escaped correctly: ${text.slice(0, 300)}`);
  }
  if (text.includes('&amp;quot;')) fail(`7b: quote re-escaped: ${text.slice(0, 300)}`);
}

// 6. add_reply: <parent> = reply_list[0], <body> = matched reply
{
  const replyClient = {
    drive: {
      fileComment: {
        get: async () => ({ data: {
          quote: 'q',
          reply_list: { items: [
            { reply_id: 'cmt_6_parent', content: { text: 'parent body' } },
            { reply_id: 'cmt_6_r1', content: { text: 'first reply body' } },
            { reply_id: 'cmt_6_r2', content: { text: 'target reply body' } },
          ]},
        } }),
      },
      meta: { batchQuery: async () => ({ data: { metas: [{ title: 'D' }] } }) },
    },
  };
  const deps = makeDeps({ client: replyClient as any });
  await handleCommentEvent(makeEvent({
    comment_id: 'cmt_6_parent', reply_id: 'cmt_6_r2',
  }), deps);
  const text = deps.handlerCalls[0]?.text ?? '';
  if (!text.includes('<parent>parent body</parent>')) fail(`6: parent wrong: ${text.slice(0,300)}`);
  if (!text.includes('<body>target reply body</body>')) fail(`6: body wrong: ${text.slice(0,300)}`);
}

// 14. reply_id not in reply_list → body marked unknown, no throw
{
  const partialClient = {
    drive: {
      fileComment: {
        get: async () => ({ data: {
          reply_list: { items: [{ reply_id: 'cmt_14_parent', content: { text: 'p' } }] },
        } }),
      },
      meta: { batchQuery: async () => ({ data: { metas: [] } }) },
    },
  };
  const deps = makeDeps({ client: partialClient as any });
  await handleCommentEvent(makeEvent({
    comment_id: 'cmt_14_parent', reply_id: 'cmt_14_missing',
  }), deps);
  if (deps.handlerCalls.length !== 1) fail(`14: handler should fire`);
  const text = deps.handlerCalls[0].text;
  if (!text.includes('<body unknown="true">')) fail(`14: body should be marked unknown: ${text.slice(0,300)}`);
}

// 9. enqueue called with chatKey = "doc:<file_token>"
{
  const enqueueCalls: any[] = [];
  const deps = makeDeps();
  deps.queue = {
    enqueue: (chatId: string, threadId: any, task: () => Promise<void>) => {
      enqueueCalls.push({ chatId, threadId });
      return task();
    },
  } as any;
  await handleCommentEvent(makeEvent({ file_token: 'dox_specific' }), deps);
  if (enqueueCalls.length !== 1) fail(`9: expected 1 enqueue`);
  if (enqueueCalls[0].chatId !== 'doc:dox_specific') fail(`9: chatId wrong: ${enqueueCalls[0].chatId}`);
  if (enqueueCalls[0].threadId !== undefined) fail(`9: threadId should be undefined`);
}

// 10. setCaller invoked inside queue task with synthetic chat_id and operator
{
  const calls: any[] = [];
  const deps = makeDeps();
  const orig = deps.identitySession.setCaller.bind(deps.identitySession);
  deps.identitySession.setCaller = (chatId, threadId, userId) => {
    calls.push({ chatId, threadId, userId });
    return orig(chatId, threadId, userId);
  };
  await handleCommentEvent(makeEvent({ file_token: 'dox_X', from_open_id: 'ou_op' }), deps);
  if (calls.length !== 1) fail(`10: expected 1 setCaller`);
  if (calls[0].chatId !== 'doc:dox_X') fail(`10: chatId wrong`);
  if (calls[0].userId !== 'ou_op') fail(`10: userId wrong`);
}

// 11. handler receives LarkMessage with chatType === 'doc_comment'
{
  const deps = makeDeps();
  await handleCommentEvent(makeEvent(), deps);
  const msg = deps.handlerCalls[0];
  if (msg.chatType !== 'doc_comment') fail(`11: chatType: ${msg.chatType}`);
  if (msg.messageType !== 'doc_comment') fail(`11: messageType: ${msg.messageType}`);
  if (msg.chatId !== 'doc:dox_test') fail(`11: chatId on LarkMessage wrong`);
}

// 12. quote === '' → no <selected_text> tag
{
  const noQuote = {
    drive: {
      fileComment: { get: async () => ({ data: { quote: '', reply_list: { items: [{ reply_id: 'cmt_001', content: { text: 'x' } }] } } }) },
      meta: { batchQuery: async () => ({ data: { metas: [] } }) },
    },
  };
  const deps = makeDeps({ client: noQuote as any });
  await handleCommentEvent(makeEvent(), deps);
  const text = deps.handlerCalls[0].text;
  if (text.includes('<selected_text')) fail(`12: empty quote should omit tag, got: ${text.slice(0,200)}`);
}

// 13. operator name with markup chars is escaped in envelope attrs
{
  const deps = makeDeps({
    resolveUserName: async () => '<script>alert(1)</script>',
  });
  await handleCommentEvent(makeEvent(), deps);
  const text = deps.handlerCalls[0].text;
  if (text.includes('<script>')) fail(`13: operator name not escaped: ${text.slice(0,300)}`);
  if (!text.includes('&lt;script&gt;')) fail(`13: expected escaped marker missing`);
}

console.error(`PASS: 16 cases (filters + pre-fetch happy + fetch errors + escape ordering + add_reply + unknown body + queue + setCaller + chatType + quote + escape)`);
