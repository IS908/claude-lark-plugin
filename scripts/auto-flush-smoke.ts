/**
 * Auto-flush caller-binding smoke test — runs as part of `npm test`.
 *
 * Verifies the v1.0.8 fix for #66:
 *   - SYSTEM_FLUSH_CALLER sentinel is exported with the documented value.
 *   - setCaller(chatId, undefined, SYSTEM_FLUSH_CALLER) followed by
 *     save_memory(type='chat') succeeds end-to-end (the bug being fixed:
 *     pre-1.0.8 this denied because resolveCaller returned null in
 *     threaded contexts).
 *   - The server-side guard rejects save_memory(type='profile') when the
 *     caller is the sentinel, even though resolveCaller succeeds — system
 *     has no user identity to attribute private-tier data to.
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// Route audit log to a tmpdir BEFORE importing audit-log.js (it reads env at import).
const tmp = mkdtempSync(join(tmpdir(), 'auto-flush-smoke-'));
process.env.LARK_AUDIT_LOG = join(tmp, 'audit.log');
process.env.LARK_PRIVACY_RULES_FILE = join(tmp, 'privacy-rules.md');

const { IdentitySession, SYSTEM_FLUSH_CALLER } = await import('../src/identity-session.js');
const { MemoryStore } = await import('../src/memory/file.js');
const { registerTools } = await import('../src/tools.js');
import type { LarkChannel } from '../src/channel.js';

let passed = 0;

// ── 1. SYSTEM_FLUSH_CALLER constant value ──
if (SYSTEM_FLUSH_CALLER !== '__system_flush__') {
  fail(`1: SYSTEM_FLUSH_CALLER should be "__system_flush__", got "${SYSTEM_FLUSH_CALLER}"`);
}
passed++;

// ── 2. setCaller + getCaller roundtrips the sentinel ──
{
  const s = new IdentitySession(() => null);
  s.setCaller('oc_x', undefined, SYSTEM_FLUSH_CALLER);
  if (s.getCaller('oc_x') !== SYSTEM_FLUSH_CALLER) {
    fail(`2: roundtrip failed, got ${s.getCaller('oc_x')}`);
  }
  passed++;
}

// ── Setup for tool-integration tests ──

const memRoot = join(tmp, 'memory');
const memoryStore = new MemoryStore(memRoot);

const handlers = new Map<string, (args: any) => Promise<any>>();
const fakeServer = {
  registerTool(name: string, _config: any, handler: any) {
    handlers.set(name, handler);
  },
};

const identitySession = new IdentitySession(() => null);
// v1.0.44 #136: stub new ack-pending methods (no-op for these tests)
const fakeChannel = {
  isPrivateChat: () => false,
  markPendingAckRevoke: (_: string) => {},
  consumePendingAckRevoke: (_: string) => false,
  // v1.0.53 #159/#160: stub (not exercised by auto-flush tests)
  isRecentInbound: (_: string) => false,
} as unknown as LarkChannel;

// Minimal mock Lark client — save_memory doesn't actually use it but
// registerTools signature requires one.
const mockClient = {
  im: {
    v1: {
      message: { create: async () => ({}), reply: async () => ({}) },
      messageReaction: { create: async () => {}, delete: async () => {} },
      image: { create: async () => ({}), get: async () => Buffer.from('') },
      file: { create: async () => ({}) },
      messageResource: { get: async () => Readable.from([]) },
    },
  },
};

registerTools(
  fakeServer as any,
  mockClient as any,
  memoryStore,
  identitySession,
  fakeChannel,
  { record() {}, flush: async () => {}, startAutoFlush: () => {}, stopAutoFlush: () => {} } as any,
  new Map<string, string>(),
  { ids: new Set(), add() {}, has: () => false } as any,
  undefined,
);

const saveMemory = handlers.get('save_memory');
if (!saveMemory) fail('save_memory handler not registered');

// ── 3. save_memory(type=chat) succeeds with SYSTEM_FLUSH_CALLER ──
// This is the actual #66 bug: pre-1.0.8, resolveCaller returned null for
// (chat, no threadId) when user's entry was at (chat, threadId), and the
// call was denied. With v1.0.8's flush-handler setCaller, the call now
// resolves to the sentinel and the episode persists.
{
  identitySession.setCaller('oc_thread_chat', undefined, SYSTEM_FLUSH_CALLER);
  const r = await saveMemory!({
    type: 'chat',
    content: 'distilled summary of the conversation',
    reason: 'auto-flush after inactivity',
    chat_id: 'oc_thread_chat',
    // no thread_id — mirrors what the flush notification provides
  });
  if (r.isError) {
    fail(`3: save_memory(type=chat) should succeed with system caller, got error: ${JSON.stringify(r.content)}`);
  }
  // Episode file actually written?
  const episodesDir = join(memRoot, 'episodes', 'oc_thread_chat');
  if (!existsSync(episodesDir)) {
    fail(`3: episode directory not created at ${episodesDir}`);
  }
  const files = readdirSync(episodesDir).filter((f) => f.endsWith('.md'));
  if (files.length !== 1) fail(`3: expected 1 episode file, got ${files.length}`);
  const content = readFileSync(join(episodesDir, files[0]), 'utf-8');
  if (!content.includes('distilled summary')) fail(`3: episode content lost`);
  passed++;
}

// ── 4. save_memory(type=profile) DENIED with SYSTEM_FLUSH_CALLER ──
// Defense in depth: even if Claude goes off-script and tries to write a
// profile during a flush turn, the server rejects.
{
  identitySession.setCaller('oc_thread_chat', undefined, SYSTEM_FLUSH_CALLER);
  const r = await saveMemory!({
    type: 'profile',
    content: 'user likes tea',
    reason: 'inferred during flush',
    chat_id: 'oc_thread_chat',
    tier: 'private',
  });
  if (!r.isError) fail(`4: save_memory(type=profile) must be denied for system caller`);
  const txt = r.content[0].text as string;
  if (!/system-flush sentinel/.test(txt)) {
    fail(`4: error must mention sentinel, got: ${txt}`);
  }
  // No profile written to disk for the sentinel "user"
  const sentinelProfileDir = join(memRoot, 'profiles', SYSTEM_FLUSH_CALLER);
  if (existsSync(sentinelProfileDir)) {
    fail(`4: sentinel must not have a profile directory`);
  }
  passed++;
}

// Audit log writes are fire-and-forget (`void audit(...)` inside tools.ts).
// Wait briefly for the queued appendFile calls to land before reading.
// Retry-loop up to 1s — should land in <50ms on a healthy disk.
async function waitForAuditLog(): Promise<string> {
  const auditPath = process.env.LARK_AUDIT_LOG!;
  for (let i = 0; i < 20; i++) {
    if (existsSync(auditPath)) {
      const contents = readFileSync(auditPath, 'utf-8');
      if (contents.includes('denied') && contents.includes('ok')) return contents;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const final = existsSync(auditPath) ? readFileSync(auditPath, 'utf-8') : '(file missing)';
  fail(`audit log never reached expected state. Last contents:\n${final}`);
}

const auditLog = await waitForAuditLog();

// ── 5. Audit log records the denial ──
{
  if (!auditLog.includes('denied')) fail(`5: audit log should record denial`);
  if (!auditLog.includes(SYSTEM_FLUSH_CALLER)) {
    fail(`5: audit log should record the sentinel caller`);
  }
  passed++;
}

// ── 6. save_memory(type=chat) audit shows sentinel as caller (operator can grep) ──
{
  const okLine = auditLog.split('\n').find((l) => l.includes('ok') && l.includes(SYSTEM_FLUSH_CALLER));
  if (!okLine) fail(`6: audit log should record ok save with sentinel caller. Got:\n${auditLog}`);
  passed++;
}

// ── 7. Other sensitive tools are denied for SYSTEM_FLUSH_CALLER ──
// Defense: the sentinel is bound only to let save_memory persist chat
// episodes during a flush. It must not authorize create_job /
// forget_memory / etc. — any such call would produce records owned by
// or addressing the sentinel, which no real user can later
// update/delete/inspect. resolveCaller centralises this guard.
{
  const createJob = handlers.get('create_job');
  if (!createJob) fail('7: create_job handler not registered');

  identitySession.setCaller('oc_thread_chat', undefined, SYSTEM_FLUSH_CALLER);
  const r = await createJob!({
    name: 'rogue-job',
    type: 'message',
    schedule: 'every 5m',
    content: 'hi',
    target_chat_id: 'oc_thread_chat',
    chat_id: 'oc_thread_chat',
    // no thread_id — mirrors what a flush turn would have
  });
  if (!r.isError) fail(`7: create_job must be denied for system caller, got: ${JSON.stringify(r.content)}`);
  const txt = r.content[0].text as string;
  if (!/system-flush caller|sentinel/i.test(txt)) {
    fail(`7: error should explain sentinel restriction, got: ${txt}`);
  }
  passed++;
}

// ── 8. forget_memory also denied for SYSTEM_FLUSH_CALLER ──
{
  const forgetMemory = handlers.get('forget_memory');
  if (!forgetMemory) fail('8: forget_memory handler not registered');

  identitySession.setCaller('oc_thread_chat', undefined, SYSTEM_FLUSH_CALLER);
  const r = await forgetMemory!({
    hash: 'deadbeef',
    tier: 'private',
    chat_id: 'oc_thread_chat',
  });
  if (!r.isError) fail(`8: forget_memory must be denied for system caller, got: ${JSON.stringify(r.content)}`);
  passed++;
}

// ── 9. #87 fix (v1.0.24): thread-scoped flush binding does NOT pollute
//      the chat-level slot, so a concurrent tool call resolving via
//      chat-level fallback on the SAME chat resolves to the LAST real
//      user — not the sentinel. Pre-fix the binding was at chat-level
//      and lingered past the flush turn, causing create_job (and any
//      tool that resolves via chat-level fallback) to be silently
//      denied with the confusing "not authorized for system-flush
//      caller" error after every auto-flush.
//
//      Models the production v1.0.24 flow:
//        1. A real user message binds (chatId, undefined) → user_alice.
//        2. Buffer auto-flush fires: handler binds (chatId, flushKey)
//           → SENTINEL. NOTE: thread-scoped, not chat-level.
//        3. Verify: getCaller(chatId, flushKey) → SENTINEL ✓
//                    getCaller(chatId, undefined) → user_alice ✓
//                    getCaller(chatId, 'some_other_thread') → user_alice ✓
//                      (because that thread isn't bound, falls back to
//                       chat-level, which is STILL user_alice not SENTINEL)
{
  const s = new IdentitySession(() => null);

  // Step 1: real user message
  s.setCaller('oc_chat_a', undefined, 'ou_alice');
  if (s.getCaller('oc_chat_a') !== 'ou_alice') {
    fail('9-setup: chat-level slot should be ou_alice after real user message');
  }

  // Step 2: auto-flush (production: const flushKey = `flush-${Date.now()}`)
  const flushKey = `flush-${Date.now()}`;
  s.setCaller('oc_chat_a', flushKey, SYSTEM_FLUSH_CALLER);

  // Step 3: assertions
  // 3a: flush-scoped resolution hits sentinel (save_memory during flush turn works)
  if (s.getCaller('oc_chat_a', flushKey) !== SYSTEM_FLUSH_CALLER) {
    fail(`9: flush-scoped getCaller should return sentinel, got ${s.getCaller('oc_chat_a', flushKey)}`);
  }
  // 3b: chat-level fallback returns the real user, NOT sentinel
  //     (this is the #87 fix — pre-fix this returned SENTINEL)
  if (s.getCaller('oc_chat_a', undefined) !== 'ou_alice') {
    fail(`9: chat-level slot must NOT be polluted; got ${s.getCaller('oc_chat_a', undefined)}`);
  }
  // 3c: arbitrary-thread fallback also returns real user via chat-level
  //     (the production scenario: cronjob synth thread or any new thread
  //      not yet bound)
  if (s.getCaller('oc_chat_a', 'oc_some_new_thread') !== 'ou_alice') {
    fail(`9: unbound thread should fall through to chat-level ou_alice, got ${s.getCaller('oc_chat_a', 'oc_some_new_thread')}`);
  }
  passed++;
}

// ── 10. R1-audit followup on #87: the flushPrompt template now
//        interpolates the flushKey into Claude's save_memory call
//        instruction, so Claude doesn't need to remember to surface
//        thread_id from notification meta. Pre-followup, the prompt
//        omitted thread_id → if Claude followed the explicit template
//        literally (no thread_id), save_memory's resolveCaller would
//        fall back to the chat-level slot → return the LAST REAL USER
//        instead of the sentinel → audit log falsely attributes the
//        save to that user.
{
  const { buildFlushPrompt } = await import('../src/memory/distiller.js');
  const flushKey = 'flush-1748000000000';
  const prompt = buildFlushPrompt(
    'oc_test',
    [{ role: 'user', senderId: 'ou_alice', text: 'hi', timestamp: '2026-05-25T00:00:00Z' }],
    flushKey,
  );
  // The prompt MUST tell Claude to pass thread_id="<flushKey>".
  if (!prompt.includes(`thread_id="${flushKey}"`)) {
    fail(`10: prompt must instruct Claude to pass thread_id="${flushKey}"; got:\n${prompt.slice(0, 500)}`);
  }
  // And it must explain WHY (so a future prompt edit doesn't accidentally drop it).
  if (!/audit log will falsely attribute/i.test(prompt) && !/required/i.test(prompt)) {
    fail(`10: prompt should explain WHY thread_id is required; got:\n${prompt.slice(0, 500)}`);
  }
  passed++;
}

rmSync(tmp, { recursive: true, force: true });

console.log(`auto-flush smoke: ${passed}/10 PASS`);
