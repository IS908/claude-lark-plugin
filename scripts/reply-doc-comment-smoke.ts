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
    registerTool: (name: string, _config: any, handler: any) => { registered[name] = handler; },
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

// 3. doc:<token> route with owner bound via setCaller (simulates event-time flow when owner @-mentions bot)
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_test', undefined, 'ou_owner_test');
  const r = await h.registered.reply_doc_comment({
    chat_id: 'doc:dox_test',
    doc_token: 'dox_test',
    comment_id: 'cmt_a',
    content: 'ok',
    file_type: 'docx',
  });
  if (r?.isError) fail(`3: owner bound via setCaller should pass: ${JSON.stringify(r)}`);
}

// 3a. doc:<token> route with non-owner bound via setCaller → denied (security regression)
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_test', undefined, 'ou_alice');
  const r = await h.registered.reply_doc_comment({
    chat_id: 'doc:dox_test',
    doc_token: 'dox_test',
    comment_id: 'cmt_a',
    content: 'ok',
    file_type: 'docx',
  });
  if (!r?.isError) fail(`3a: SECURITY: non-owner bound to doc: chat_id must be denied`);
  if (h.fileCommentReplyCalls.length !== 0) fail(`3a: API must not be called`);
}

// 4. terminal chat_id with no LARK_OWNER_OPEN_ID → denied
{
  const session = new IdentitySession(() => null);
  const registered: Record<string, any> = {};
  const fakeServer = { registerTool: (n: string, _c: any, h: any) => { registered[n] = h; } };
  const dummyClient = { drive: { fileCommentReply: { create: async () => ({ data: {} }) }, fileComment: { create: async () => ({}) } } };
  registerDocCommentTools({ server: fakeServer as any, client: dummyClient as any, identitySession: session });
  const r = await registered.reply_doc_comment({
    chat_id: '__terminal__', doc_token: 'd', comment_id: 'c', content: 'x', file_type: 'docx',
  });
  if (!r?.isError) fail(`4: terminal without owner must deny`);
}

// 5. Feishu API generic failure → error returned with message preserved
{
  const session = new IdentitySession(() => 'ou_owner_test');
  const registered: Record<string, any> = {};
  const fakeServer = { registerTool: (n: string, _c: any, h: any) => { registered[n] = h; } };
  const failingClient = { drive: {
    fileCommentReply: { create: async () => { const e: any = new Error('feishu generic boom'); throw e; } },
    fileComment: { create: async () => ({}) },
  }};
  registerDocCommentTools({ server: fakeServer as any, client: failingClient as any, identitySession: session });
  const r = await registered.reply_doc_comment({
    chat_id: '__terminal__', doc_token: 'd', comment_id: 'c', content: 'x', file_type: 'docx',
  });
  if (!r?.isError) fail(`5: expected error`);
  if (!r.content[0].text.includes('feishu generic boom')) fail(`5: original error message lost`);
}

// 6. permission_denied (code 1069302) → clear hint
{
  const session = new IdentitySession(() => 'ou_owner_test');
  const registered: Record<string, any> = {};
  const fakeServer = { registerTool: (n: string, _c: any, h: any) => { registered[n] = h; } };
  const deniedClient = { drive: {
    fileCommentReply: { create: async () => { const e: any = new Error('blocked'); e.code = 1069302; throw e; } },
    fileComment: { create: async () => ({}) },
  }};
  registerDocCommentTools({ server: fakeServer as any, client: deniedClient as any, identitySession: session });
  const r = await registered.reply_doc_comment({
    chat_id: '__terminal__', doc_token: 'd', comment_id: 'c', content: 'x', file_type: 'docx',
  });
  if (!r?.isError) fail(`6: expected error`);
  if (!/collaborator|allow.*comment/i.test(r.content[0].text)) fail(`6: hint missing: ${r.content[0].text}`);
}

// 7. empty content → tool-level error
{
  const h = makeHarness();
  const r = await h.registered.reply_doc_comment({
    chat_id: '__terminal__', doc_token: 'd', comment_id: 'c', content: '', file_type: 'docx',
  });
  if (!r?.isError) fail(`7: empty content must be rejected at tool layer`);
}

// 8. content >1000 chars → buildCommentElements throws, tool returns error
{
  const h = makeHarness();
  const r = await h.registered.reply_doc_comment({
    chat_id: '__terminal__', doc_token: 'd', comment_id: 'c',
    content: 'x'.repeat(1500), file_type: 'docx',
  });
  if (!r?.isError) fail(`8: oversized content must error`);
  if (!/exceeds/i.test(r.content[0].text)) fail(`8: error msg should mention exceeds: ${r.content[0].text}`);
}

// 9. create_doc_comment owner pass + non-owner deny
{
  const h = makeHarness();
  const okR = await h.registered.create_doc_comment({
    chat_id: '__terminal__',
    doc_token: 'dox_new',
    content: 'top-level comment',
    file_type: 'docx',
  });
  if (okR?.isError) fail(`9a: owner must pass: ${JSON.stringify(okR)}`);
  if (h.fileCommentCreateCalls.length !== 1) fail(`9a: expected create call`);

  h.session.setCaller('oc_other', undefined, 'ou_not_owner');
  const denyR = await h.registered.create_doc_comment({
    chat_id: 'oc_other',
    doc_token: 'dox_new',
    content: 'x',
    file_type: 'docx',
  });
  if (!denyR?.isError) fail(`9b: non-owner must deny`);
}

// 10. SECURITY: chat_id=doc:A but doc_token=B → denied (cross-doc binding violation)
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_A', undefined, 'ou_owner_test');
  const r = await h.registered.reply_doc_comment({
    chat_id: 'doc:dox_A',
    doc_token: 'dox_B',         // wrong doc!
    comment_id: 'cmt_x',
    content: 'malicious',
    file_type: 'docx',
  });
  if (!r?.isError) fail(`10: SECURITY: cross-doc binding violation must be denied`);
  if (!/mismatch/i.test(r.content[0].text)) fail(`10: error msg should mention mismatch: ${r.content[0].text}`);
  if (h.fileCommentReplyCalls.length !== 0) fail(`10: API must not be called`);
}

// 11. SECURITY: same check for create_doc_comment
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_A', undefined, 'ou_owner_test');
  const r = await h.registered.create_doc_comment({
    chat_id: 'doc:dox_A',
    doc_token: 'dox_B',         // wrong doc!
    content: 'malicious top-level',
    file_type: 'docx',
  });
  if (!r?.isError) fail(`11: SECURITY: create_doc_comment cross-doc binding must be denied`);
  if (!/mismatch/i.test(r.content[0].text)) fail(`11: error msg should mention mismatch: ${r.content[0].text}`);
  if (h.fileCommentCreateCalls.length !== 0) fail(`11: API must not be called`);
}

// 12. terminal chat_id allows arbitrary doc_token (operator escape hatch)
{
  const h = makeHarness();
  const r = await h.registered.reply_doc_comment({
    chat_id: '__terminal__',
    doc_token: 'dox_arbitrary',  // any doc — owner is in CLI context
    comment_id: 'cmt_x',
    content: 'cli-driven reply',
    file_type: 'docx',
  });
  if (r?.isError) fail(`12: terminal must allow arbitrary doc_token: ${JSON.stringify(r)}`);
  if (h.fileCommentReplyCalls.length !== 1) fail(`12: expected 1 API call`);
}

// 13. matching binding passes (regression — make sure we didn't break the happy path)
{
  const h = makeHarness();
  h.session.setCaller('doc:dox_real', undefined, 'ou_owner_test');
  const r = await h.registered.reply_doc_comment({
    chat_id: 'doc:dox_real',
    doc_token: 'dox_real',       // matches
    comment_id: 'cmt_x',
    content: 'happy path',
    file_type: 'docx',
  });
  if (r?.isError) fail(`13: matching doc: binding must pass: ${JSON.stringify(r)}`);
  if (h.fileCommentReplyCalls.length !== 1) fail(`13: expected 1 API call`);
}

console.error(`PASS: 14 cases (owner gate + error paths + create + doc: security regression + doc_token binding)`);
