/**
 * reply_doc_comment / create_doc_comment smoke test.
 * Spec: docs/superpowers/specs/2026-06-06-doc-comment-channel-design.md §10.4
 */
process.env.LARK_APP_ID = process.env.LARK_APP_ID ?? 'cli_test';
process.env.LARK_APP_SECRET = process.env.LARK_APP_SECRET ?? 'secret';
process.env.LARK_OWNER_OPEN_ID = 'ou_owner_test';

import { registerDocCommentTools } from '../src/tools.js';
import { IdentitySession } from '../src/identity-session.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function makeHarness(opts: { ownerFallback?: () => string | null } = {}) {
  const session = new IdentitySession(opts.ownerFallback ?? (() => 'ou_owner_test'));
  const fileCommentReplyCalls: any[] = [];
  const fileCommentCreateCalls: any[] = [];
  const client = {
    drive: {
      fileCommentReply: {
        create: async (req: any) => {
          fileCommentReplyCalls.push(req);
          return { data: { reply_id: 'reply_xyz', content: { elements: req.data.content.elements } } };
        },
      },
      fileComment: {
        create: async (req: any) => {
          fileCommentCreateCalls.push(req);
          return { data: { comment_id: 'cmt_new' } };
        },
      },
    },
  };
  const registered: Record<string, any> = {};
  const fakeServer = {
    tool: (name: string, _schema: any, handler: any) => { registered[name] = handler; },
  };
  registerDocCommentTools({
    server: fakeServer as any,
    client: client as any,
    identitySession: session,
  });
  return { session, registered, fileCommentReplyCalls, fileCommentCreateCalls };
}

// 1. owner caller via terminal chat_id → reply succeeds
{
  const h = makeHarness();
  const r = await h.registered.reply_doc_comment({
    chat_id: '__terminal__',
    doc_token: 'dox_a',
    comment_id: 'cmt_a',
    content: 'hello',
    file_type: 'docx',
  });
  if (r?.isError) fail(`1: owner via terminal should pass, got error: ${JSON.stringify(r)}`);
  if (h.fileCommentReplyCalls.length !== 1) fail(`1: expected 1 API call`);
  const call = h.fileCommentReplyCalls[0];
  if (call.path?.file_token !== 'dox_a') fail(`1: file_token wrong`);
  if (call.path?.comment_id !== 'cmt_a') fail(`1: comment_id wrong`);
  if (call.params?.file_type !== 'docx') fail(`1: file_type wrong`);
  const els = call.data?.content?.elements ?? [];
  if (els.length === 0 || els[0].type !== 'text_run') fail(`1: elements not built correctly`);
}

// 2. non-owner caller in real chat → denied
{
  const h = makeHarness();
  h.session.setCaller('oc_real', undefined, 'ou_not_owner');
  const r = await h.registered.reply_doc_comment({
    chat_id: 'oc_real',
    doc_token: 'dox_a',
    comment_id: 'cmt_a',
    content: 'hello',
    file_type: 'docx',
  });
  if (!r?.isError) fail(`2: non-owner must be denied`);
  if (h.fileCommentReplyCalls.length !== 0) fail(`2: API should not be called`);
}

console.error(`PASS: 2 cases (owner gate)`);
