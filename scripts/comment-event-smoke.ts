/**
 * handleCommentEvent smoke test — drive.notice.comment_add_v1 dispatch.
 * Spec: docs/superpowers/specs/2026-06-06-doc-comment-channel-design.md §10.2
 */
process.env.LARK_APP_ID = process.env.LARK_APP_ID ?? 'cli_test';
process.env.LARK_APP_SECRET = process.env.LARK_APP_SECRET ?? 'secret';
// #187: appConfig is built at module load, so the env var has to be set
// BEFORE the `appConfig` import line below. We default to THUMBSUP so the
// smoke is deterministic regardless of the dev's local env; case 22
// explicitly mutates `appConfig.docCommentAckEmoji` to test the empty-disables
// contract.
process.env.LARK_DOC_COMMENT_ACK_EMOJI = process.env.LARK_DOC_COMMENT_ACK_EMOJI ?? 'THUMBSUP';

import { handleCommentEvent, type CommentEventDeps } from '../src/channel.js';
import { IdentitySession } from '../src/identity-session.js';
import { MessageQueue } from '../src/queue.js';
import { TTLCache } from '../src/ttl-cache.js';
import { appConfig } from '../src/config.js';

// Whitelist gate is now applied to doc-comment events (PR #182 round 4 C1).
// ES module imports are hoisted — we cannot influence appConfig via process.env
// before the config.ts module evaluates. Mutate the loaded list directly.
// Include all the open_ids that existing cases (and new ones) use so they
// continue to reach the handler; case 15 uses an explicitly-excluded one.
appConfig.allowedUserIds.push('ou_bot', 'ou_sender', 'ou_op', 'ou_owner_for_test', 'ou_alice', 'ou_bob');

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
  // Match the real Lark SDK EventDispatcher.register payload shape (issue #183).
  // event_id / comment_id / reply_id / is_mentioned live AT ROOT, not nested under
  // notice_meta or event. notice_meta also lives at root. Pre-v1.1.1 this factory
  // duplicated the buggy nesting in handleCommentEvent, so all 20 cases were
  // green while production was 100% broken — same family as #180.
  return {
    schema: '2.0',
    event_id,
    token: '',
    create_time: '1780000000000',
    event_type: 'drive.notice.comment_add_v1',
    tenant_key: 'tenant_test',
    app_id: 'cli_test_app_id',
    comment_id,
    reply_id,
    is_mentioned,
    notice_meta: {
      file_type: 'docx',
      file_token,
      notice_type: reply_id ? 'add_reply' : 'add_comment',
      from_user_id: { open_id: from_open_id, union_id: 'on_test_from', user_id: null },
      to_user_id: { open_id: to_open_id, union_id: 'on_test_to', user_id: null },
    },
  };
}

function makeDeps(overrides: Partial<CommentEventDeps> = {}): CommentEventDeps & {
  handlerCalls: any[]; commentRepliesListCalls: any[]; commentListCalls: any[]; metaCalls: any[];
  reactionCalls: any[];
} {
  const handlerCalls: any[] = [];
  // v1.1.2 (#185): handleCommentEvent now calls fileCommentReply.list (for
  // body + parentBody) + fileComment.list (for quote) in parallel, replacing
  // the old fileComment.get. The recorder arrays track each separately so
  // tests can assert which endpoints fired.
  const commentRepliesListCalls: any[] = [];
  const commentListCalls: any[] = [];
  const metaCalls: any[] = [];
  // #187 v1.2.0: client.request is the adapter handleCommentEvent uses for
  // the v2 comments/reaction endpoint (POST /drive/v2/files/.../comments/reaction).
  // Recorded here so cases 20/21/22 can assert URL / method / body.
  const reactionCalls: any[] = [];
  const session = new IdentitySession(() => 'ou_owner_for_test');
  const deps: CommentEventDeps = {
    botOpenId: 'ou_bot',
    seenEventIds: new TTLCache<string, true>({ maxSize: 500, ttlMs: 60 * 60_000 }),
    identitySession: session,
    queue: new MessageQueue(),
    messageHandler: async (m) => { handlerCalls.push(m); },
    resolveUserName: async (openId) => `name_for_${openId}`,
    client: {
      request: async (req: any) => {
        reactionCalls.push(req);
        return { data: {} };
      },
      drive: {
        fileCommentReply: {
          list: async (params: any) => {
            commentRepliesListCalls.push(params);
            return {
              data: {
                // Per Feishu data model (verified in #185): items[0] is the
                // original comment body; subsequent items are reply chain.
                items: [
                  {
                    reply_id: params.path.comment_id,
                    content: { elements: [{ type: 'text_run', text_run: { text: 'body' } }] },
                  },
                ],
                has_more: false,
              },
            };
          },
        },
        fileComment: {
          list: async (params: any) => {
            commentListCalls.push(params);
            return {
              data: {
                items: [
                  {
                    comment_id: 'cmt_001',  // matches default makeEvent comment_id
                    quote: 'quoted text',
                    is_whole: false,
                    reply_list: { replies: [] },
                  },
                ],
                has_more: false,
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
  return Object.assign(deps, { handlerCalls, commentRepliesListCalls, commentListCalls, metaCalls, reactionCalls });
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
  if (deps.commentRepliesListCalls.length !== 0) fail(`2: should not pre-fetch (replies.list)`);
  if (deps.commentListCalls.length !== 0) fail(`2: should not pre-fetch (comment.list)`);
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

// 5. add_comment (no reply_id): pre-fetch fires BOTH list endpoints + envelope
// has <body> not <parent>. v1.1.2 (#185): pre-fix called fileComment.get once;
// post-fix calls fileCommentReply.list (for body) + fileComment.list (for quote)
// in parallel.
{
  const deps = makeDeps();
  await handleCommentEvent(makeEvent({ comment_id: 'cmt_5', reply_id: undefined }), deps);
  if (deps.commentRepliesListCalls.length !== 1) fail(`5: expected 1 fileCommentReply.list call`);
  if (deps.commentListCalls.length !== 1) fail(`5: expected 1 fileComment.list call (for quote)`);
  const repliesCall = deps.commentRepliesListCalls[0];
  if (repliesCall.path?.comment_id !== 'cmt_5') fail(`5: comment_id not passed to replies.list`);
  if (repliesCall.path?.file_token !== 'dox_test') fail(`5: file_token not passed to replies.list`);
  const commentsCall = deps.commentListCalls[0];
  if (commentsCall.path?.file_token !== 'dox_test') fail(`5: file_token not passed to comment.list`);
  if (deps.handlerCalls.length !== 1) fail(`5: expected 1 handler call`);
  const msg = deps.handlerCalls[0];
  if (!msg.text.includes('<body>')) fail(`5: envelope missing <body>: ${msg.text.slice(0, 200)}`);
  if (msg.text.includes('<parent>')) fail(`5: add_comment must not have <parent>`);
}

// 7. pre-fetch throws → handler still called with <fetch_error>, event not dropped.
// v1.1.2 (#185): both fileCommentReply.list and fileComment.list run in parallel
// via Promise.allSettled (round-1 review I-1). Both rejecting hits the dual-failure
// branch that surfaces <fetch_error>. We mock both throwing to lock in this
// dual-rejection behavior; case 7c covers the partial-failure (replies OK,
// comments fail) path that v1.1.1's Promise.all would have incorrectly wiped.
{
  const failingClient = {
    request: async () => ({ data: {} }),
    drive: {
      fileCommentReply: { list: async () => { throw new Error('feishu replies boom'); } },
      fileComment: { list: async () => { throw new Error('feishu comments boom'); } },
      meta: { batchQuery: async () => ({ data: { metas: [] } }) },
    },
  };
  const deps = makeDeps({ client: failingClient as any });
  await handleCommentEvent(makeEvent({ comment_id: 'cmt_7' }), deps);
  if (deps.handlerCalls.length !== 1) fail(`7: handler should still fire on fetch error`);
  if (!deps.handlerCalls[0].text.includes('<fetch_error>')) fail(`7: envelope missing <fetch_error>`);
}

// 8. doc_title fetch failure → no doc_title attribute, handler still called.
// v1.1.2 (#185): replies + comments come from the two list endpoints.
{
  const noTitleClient = {
    request: async () => ({ data: {} }),
    drive: {
      fileCommentReply: {
        list: async (params: any) => ({
          data: {
            items: [
              {
                reply_id: params.path.comment_id,
                content: { elements: [{ type: 'text_run', text_run: { text: 'b' } }] },
              },
            ],
            has_more: false,
          },
        }),
      },
      fileComment: {
        list: async () => ({
          data: { items: [{ comment_id: 'cmt_8', quote: '', is_whole: false, reply_list: { replies: [] } }], has_more: false },
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

// 6. add_reply: <parent> = items[0] (original comment), <body> = matched reply
// from items[]. v1.1.2 (#185): items[] now comes from fileCommentReply.list,
// preserving the Feishu data model where items[0] is the original comment body.
{
  const replyClient = {
    request: async () => ({ data: {} }),
    drive: {
      fileCommentReply: {
        list: async () => ({
          data: {
            items: [
              { reply_id: 'cmt_6_parent', content: { elements: [{ type: 'text_run', text_run: { text: 'parent body' } }] } },
              { reply_id: 'cmt_6_r1', content: { elements: [{ type: 'text_run', text_run: { text: 'first reply body' } }] } },
              { reply_id: 'cmt_6_r2', content: { elements: [{ type: 'text_run', text_run: { text: 'target reply body' } }] } },
            ],
            has_more: false,
          },
        }),
      },
      fileComment: {
        list: async () => ({
          data: {
            items: [{ comment_id: 'cmt_6_parent', quote: 'q', is_whole: false, reply_list: { replies: [] } }],
            has_more: false,
          },
        }),
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
  // PR #186 round 1 M-4: the mock already returns `quote: 'q'` on the matching
  // comment_id, so the envelope should render `<selected_text>q</selected_text>`.
  // Previously this case only asserted parent/body — the quote leg was uncovered.
  if (!text.includes('<selected_text>q</selected_text>')) fail(`6: quote should render as selected_text: ${text.slice(0,300)}`);
}

// 14. reply_id not in fileCommentReply.list items → body marked unknown, no throw.
// v1.1.2 (#185): items[] is the new shape. The matching reply_id is absent,
// so body falls through to undefined → envelope renders <body unknown="true">.
{
  const partialClient = {
    request: async () => ({ data: {} }),
    drive: {
      fileCommentReply: {
        list: async () => ({
          data: {
            items: [
              { reply_id: 'cmt_14_parent', content: { elements: [{ type: 'text_run', text_run: { text: 'p' } }] } },
            ],
            has_more: false,
          },
        }),
      },
      fileComment: {
        list: async () => ({ data: { items: [], has_more: false } }),
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

// 9. enqueue called with chatKey = "doc:<file_token>" and threadKey = comment_id
// (PR #182 round 4 I1: per-comment keying lets concurrent comments on the same
// doc process in parallel and avoids session overwrites.)
{
  const enqueueCalls: any[] = [];
  const deps = makeDeps();
  deps.queue = {
    enqueue: (chatId: string, threadId: any, task: () => Promise<void>) => {
      enqueueCalls.push({ chatId, threadId });
      return task();
    },
  } as any;
  await handleCommentEvent(
    makeEvent({ file_token: 'dox_specific', comment_id: 'cmt_specific' }),
    deps,
  );
  if (enqueueCalls.length !== 1) fail(`9: expected 1 enqueue`);
  if (enqueueCalls[0].chatId !== 'doc:dox_specific') fail(`9: chatId wrong: ${enqueueCalls[0].chatId}`);
  if (enqueueCalls[0].threadId !== 'cmt_specific') fail(`9: threadId must be comment_id, got ${enqueueCalls[0].threadId}`);
}

// 10. setCaller invoked inside queue task with synthetic chat_id, comment_id, operator
{
  const calls: any[] = [];
  const deps = makeDeps();
  const orig = deps.identitySession.setCaller.bind(deps.identitySession);
  deps.identitySession.setCaller = (chatId, threadId, userId) => {
    calls.push({ chatId, threadId, userId });
    return orig(chatId, threadId, userId);
  };
  await handleCommentEvent(
    makeEvent({ file_token: 'dox_X', comment_id: 'cmt_10', from_open_id: 'ou_op' }),
    deps,
  );
  if (calls.length !== 1) fail(`10: expected 1 setCaller`);
  if (calls[0].chatId !== 'doc:dox_X') fail(`10: chatId wrong`);
  if (calls[0].threadId !== 'cmt_10') fail(`10: threadId must be comment_id, got ${calls[0].threadId}`);
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

// 12. quote === '' → no <selected_text> tag.
// v1.1.2 (#185): quote now comes from fileComment.list's matching item.
{
  const noQuote = {
    request: async () => ({ data: {} }),
    drive: {
      fileCommentReply: {
        list: async () => ({
          data: {
            items: [
              { reply_id: 'cmt_001', content: { elements: [{ type: 'text_run', text_run: { text: 'x' } }] } },
            ],
            has_more: false,
          },
        }),
      },
      fileComment: {
        list: async () => ({
          data: {
            items: [{ comment_id: 'cmt_001', quote: '', is_whole: false, reply_list: { replies: [] } }],
            has_more: false,
          },
        }),
      },
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

// 15. SECURITY: doc-comment event from non-whitelisted user is dropped (PR #182 round 4 C1)
{
  const deps = makeDeps();
  await handleCommentEvent(
    makeEvent({ from_open_id: 'ou_excluded_outsider' }),  // not in LARK_ALLOWED_USER_IDS
    deps,
  );
  if (deps.handlerCalls.length !== 0) fail(`15: SECURITY: non-whitelisted sender must be dropped`);
  if (deps.commentRepliesListCalls.length !== 0) fail(`15: SECURITY: pre-fetch must not run for whitelisted-out user (replies.list)`);
  if (deps.commentListCalls.length !== 0) fail(`15: SECURITY: pre-fetch must not run for whitelisted-out user (comment.list)`);
}

// 17. I-1: chat-list-only config must NOT block doc-comment events. Pre-fix
// passesWhitelist required matching LARK_ALLOWED_CHAT_IDS, but the synthetic
// `doc:<token>` chat_id can never match, so every event was silently dropped.
{
  const savedUsers = [...appConfig.allowedUserIds];
  const savedChats = [...appConfig.allowedChatIds];
  appConfig.allowedUserIds.length = 0; // empty user list → gate falls open
  appConfig.allowedChatIds.push('oc_unrelated_chat'); // chat list set but irrelevant for doc-comment

  try {
    const deps = makeDeps();
    await handleCommentEvent(
      makeEvent({ from_open_id: 'ou_random_user' }), // not in any list
      deps,
    );
    if (deps.handlerCalls.length !== 1) {
      fail(`17: I-1: chat-list-only must NOT block doc-comment (got ${deps.handlerCalls.length} handler calls)`);
    }
  } finally {
    appConfig.allowedUserIds.length = 0;
    appConfig.allowedUserIds.push(...savedUsers);
    appConfig.allowedChatIds.length = 0;
    appConfig.allowedChatIds.push(...savedChats);
  }
}

// 18. I-1: when LARK_ALLOWED_USER_IDS is set, the user gate still applies
// (duplicate of case 15's semantics, but here for explicit I-1 coverage).
{
  const deps = makeDeps();
  await handleCommentEvent(
    makeEvent({ from_open_id: 'ou_excluded_outsider' }), // not in user list
    deps,
  );
  if (deps.handlerCalls.length !== 0) fail(`18: I-1: user list still gates when configured`);
}

// 16. SECURITY: concurrent events on the same doc don't overwrite each other's
// session entries (PR #182 round 4 I1). Pre-fix, both events shared the
// (doc:<token>, undefined) session slot and the second event clobbered the first.
{
  const deps = makeDeps();
  // Alice's event
  await handleCommentEvent(
    makeEvent({ file_token: 'dox_race', comment_id: 'cmt_alice', from_open_id: 'ou_alice' }),
    deps,
  );
  // Bob's event for same doc, different comment
  await handleCommentEvent(
    makeEvent({ file_token: 'dox_race', comment_id: 'cmt_bob', from_open_id: 'ou_bob' }),
    deps,
  );
  // Both should resolve independently
  const aliceCaller = deps.identitySession.getCaller('doc:dox_race', 'cmt_alice');
  const bobCaller = deps.identitySession.getCaller('doc:dox_race', 'cmt_bob');
  if (aliceCaller !== 'ou_alice') fail(`16: alice's session lost (got ${aliceCaller})`);
  if (bobCaller !== 'ou_bob') fail(`16: bob's session lost (got ${bobCaller})`);
}

// 19. SECURITY/UX: anchored (is_whole=false) comment pre-fetches via list endpoints (#185)
//   Pre-fix path used fileComment.get which 404s for anchored comments (the
//   typical UX for @-mentioning the bot inside a docx — user highlights text
//   + types @bot). Whole-doc comments worked; anchored ones returned
//   <fetch_error>404</fetch_error> with empty <body>. Post-fix uses
//   fileCommentReply.list + fileComment.list which work for BOTH is_whole
//   variants. This case locks in the new endpoints firing AND quote retrieval
//   from the matching comment item AND body extraction from the replies item.
{
  let repliesCalled = false;
  let commentsCalled = false;
  const deps = makeDeps({
    client: {
      request: async () => ({ data: {} }),
      drive: {
        fileCommentReply: {
          list: async (_params: any) => {
            repliesCalled = true;
            return {
              data: {
                items: [
                  { reply_id: 'cmt_19_target', content: { elements: [{ type: 'text_run', text_run: { text: 'anchored body' } }] } },
                ],
                has_more: false,
              },
            };
          },
        },
        fileComment: {
          list: async (_params: any) => {
            commentsCalled = true;
            return {
              data: {
                items: [
                  { comment_id: 'cmt_19_target', is_whole: false, quote: 'highlighted text', reply_list: { replies: [] } },
                ],
                has_more: false,
              },
            };
          },
        },
        meta: { batchQuery: async () => ({ data: { metas: [{ title: 'Anchored Doc' }] } }) },
      },
    } as any,
  });
  await handleCommentEvent(makeEvent({ comment_id: 'cmt_19_target' }), deps);
  if (!repliesCalled) fail('19: fileCommentReply.list must be called');
  if (!commentsCalled) fail('19: fileComment.list must be called (for quote)');
  const text = deps.handlerCalls[0]?.text ?? '';
  if (!text.includes('<body>anchored body</body>')) fail(`19: anchored body missing: ${text.slice(0,300)}`);
  if (!text.includes('<selected_text>highlighted text</selected_text>')) {
    fail(`19: quote should surface as selected_text: ${text.slice(0,300)}`);
  }
}

// 7c. PR #186 round 1 M-3: partial failure (replies succeeds, comments fails).
//   Quote is auxiliary; quote-only failure must NOT wipe body delivery (the
//   pre-I-1 Promise.all code would have surfaced <fetch_error> and an empty
//   body here). Post-I-1 Promise.allSettled lets the resolved body render and
//   omits <selected_text> without poisoning the envelope.
{
  const partialClient = {
    request: async () => ({ data: {} }),
    drive: {
      fileCommentReply: {
        list: async () => ({
          data: {
            items: [
              { reply_id: 'cmt_001', content: { elements: [{ type: 'text_run', text_run: { text: 'body delivered' } }] } },
            ],
            has_more: false,
          },
        }),
      },
      fileComment: {
        list: async () => { throw new Error('comments list rate-limited'); },
      },
      meta: { batchQuery: async () => ({ data: { metas: [{ title: 'D' }] } }) },
    },
  };
  const deps = makeDeps({ client: partialClient as any });
  await handleCommentEvent(makeEvent({ comment_id: 'cmt_001' }), deps);
  const text = deps.handlerCalls[0]?.text ?? '';
  if (text.includes('<fetch_error>')) fail(`7c: quote-only failure must NOT surface fetch_error: ${text.slice(0,300)}`);
  if (!text.includes('<body>body delivered</body>')) fail(`7c: body must render despite quote failure: ${text.slice(0,300)}`);
  if (text.includes('<selected_text>')) fail(`7c: quote-only failure must omit selected_text: ${text.slice(0,300)}`);
}

// 20. ack: add_reply event triggers react on event.reply_id in parallel with pre-fetch (#187)
{
  const deps = makeDeps();
  await handleCommentEvent(makeEvent({
    comment_id: 'cmt_20_parent',
    reply_id: 'cmt_20_target',
  }), deps);
  if (deps.reactionCalls.length !== 1) fail(`20: expected 1 reaction call, got ${deps.reactionCalls.length}`);
  const call = deps.reactionCalls[0];
  if (call.method !== 'POST') fail(`20: method wrong: ${call.method}`);
  if (!String(call.url).includes('/drive/v2/files/dox_test/comments/reaction')) fail(`20: url wrong: ${call.url}`);
  if (call.params?.file_type !== 'docx') fail(`20: file_type wrong`);
  if (call.data?.action !== 'add') fail(`20: action wrong: ${call.data?.action}`);
  if (call.data?.reaction_type !== 'THUMBSUP') fail(`20: reaction_type wrong: ${call.data?.reaction_type}`);
  if (call.data?.reply_id !== 'cmt_20_target') fail(`20: reply_id should be event.reply_id, got ${call.data?.reply_id}`);
}

// 21. ack: add_comment event triggers react on items[0].reply_id from fileCommentReply.list (#187)
{
  const reactionCalls: any[] = [];
  const customClient: any = {
    request: async (req: any) => {
      reactionCalls.push(req);
      return { data: {} };
    },
    drive: {
      fileCommentReply: {
        list: async () => ({
          data: {
            items: [
              { reply_id: 'cmt_21_first_reply', content: { elements: [{ type: 'text_run', text_run: { text: 'comment body' } }] } },
            ],
            has_more: false,
          },
        }),
      },
      fileComment: {
        list: async () => ({
          data: { items: [{ comment_id: 'cmt_21', is_whole: true, reply_list: { replies: [] } }], has_more: false },
        }),
      },
      meta: { batchQuery: async () => ({ data: { metas: [{ title: 'D' }] } }) },
    },
  };
  const deps = makeDeps({ client: customClient });
  await handleCommentEvent(makeEvent({
    comment_id: 'cmt_21',
    reply_id: undefined,  // add_comment
  }), deps);
  if (reactionCalls.length !== 1) fail(`21: expected 1 reaction call, got ${reactionCalls.length}`);
  if (reactionCalls[0].data?.reply_id !== 'cmt_21_first_reply') {
    fail(`21: add_comment ack should use items[0].reply_id, got ${reactionCalls[0].data?.reply_id}`);
  }
}

// 22. ack: empty LARK_DOC_COMMENT_ACK_EMOJI disables the react entirely (#187)
{
  // Save+restore so other cases aren't affected. Mutating appConfig in-place
  // is the cross-smoke convention here (same pattern as case 17 for the
  // whitelist arrays).
  const saved = appConfig.docCommentAckEmoji;
  (appConfig as any).docCommentAckEmoji = '';
  try {
    const deps = makeDeps();
    await handleCommentEvent(makeEvent({
      comment_id: 'cmt_22',
      reply_id: 'cmt_22_target',
    }), deps);
    if (deps.reactionCalls.length !== 0) fail(`22: empty ack emoji must skip react entirely, got ${deps.reactionCalls.length}`);
  } finally {
    (appConfig as any).docCommentAckEmoji = saved;
  }
}

console.error(`PASS: 25 cases (filters + whitelist + pre-fetch happy + fetch errors + escape ordering + add_reply + unknown body + queue + setCaller + chatType + quote + escape + session race + chat-list-only doc-comment + user-list gate + anchored is_whole=false #185 + partial-failure allSettled #186 + doc-comment ack #187)`);
