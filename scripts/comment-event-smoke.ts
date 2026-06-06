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
        metas: {
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

console.error(`PASS: 1 case (dedup)`);
