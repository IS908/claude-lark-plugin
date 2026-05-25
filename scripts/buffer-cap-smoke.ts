/**
 * ConversationBuffer cap smoke test (v1.0.38, closes #110 part 2).
 *
 * Direct unit test of the hard-cap force-flush added to
 * `ConversationBuffer.record`. Pre-fix, anything that kept resetting
 * the inactivity timer (e.g. the now-fixed cron-into-buffer bleed)
 * would let the per-chat buffer grow unbounded. The cap is the
 * belt-and-suspenders backstop.
 */

// Make the inactivity timer effectively never fire in this test so the
// hard cap is the only trigger we observe. ConversationBuffer takes the
// cap via constructor `{ maxMessages: 5 }` (ESM hoisting makes the
// env-set-here-import-below pattern unreliable for the cap default).
process.env.LARK_INACTIVITY_HOURS = '99';

import { ConversationBuffer } from '../src/memory/buffer.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let testNum = 0;

// 1. Under-cap pushes do NOT trigger flush
{
  const buf = new ConversationBuffer({ maxMessages: 5 });
  let flushFires = 0;
  buf.setFlushHandler(async () => { flushFires++; });
  for (let i = 0; i < 4; i++) {
    buf.record('chat_under', {
      role: 'user',
      senderId: 'u',
      text: `m${i}`,
      timestamp: new Date().toISOString(),
    });
  }
  // Synchronous record returns; force-flush is fire-and-forget. Let
  // microtasks settle so any spurious flush has a chance to fire.
  await new Promise((r) => setImmediate(r));
  if (flushFires !== 0) fail(`1: under-cap (4 of 5) should not flush, fired ${flushFires}`);
  if (buf.getMessages('chat_under').length !== 4) {
    fail(`1: buffer should hold 4 messages, got ${buf.getMessages('chat_under').length}`);
  }
  testNum++;
}

// 2. At-cap push triggers force-flush (cap=5, push 5th → flush)
{
  const buf = new ConversationBuffer({ maxMessages: 5 });
  let flushFires = 0;
  let flushedMessages: any[] = [];
  buf.setFlushHandler(async (chatId, messages) => {
    flushFires++;
    flushedMessages = messages;
  });
  for (let i = 0; i < 5; i++) {
    buf.record('chat_atcap', {
      role: 'user',
      senderId: 'u',
      text: `m${i}`,
      timestamp: new Date().toISOString(),
    });
  }
  // Let the fire-and-forget flush settle (it's async via the flush
  // handler). One microtask drain is sufficient for our synchronous
  // mock handler.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  if (flushFires !== 1) fail(`2: at-cap (5 of 5) should flush exactly once, fired ${flushFires}`);
  if (flushedMessages.length !== 5) {
    fail(`2: flush should receive all 5 messages, got ${flushedMessages.length}`);
  }
  // After flush, buffer should be empty
  if (buf.getMessages('chat_atcap').length !== 0) {
    fail(`2: buffer should be empty post-flush, has ${buf.getMessages('chat_atcap').length}`);
  }
  testNum++;
}

// 3. Over-cap pushes don't double-flush (idempotent via `flushing` guard)
{
  const buf = new ConversationBuffer({ maxMessages: 5 });
  let flushFires = 0;
  buf.setFlushHandler(async () => {
    flushFires++;
    // Simulate a slow flush — gives concurrent record() calls a window
    await new Promise((r) => setTimeout(r, 50));
  });
  // Push 5 (triggers flush — flush handler is now in flight)
  for (let i = 0; i < 5; i++) {
    buf.record('chat_concurrent', {
      role: 'user',
      senderId: 'u',
      text: `initial-${i}`,
      timestamp: new Date().toISOString(),
    });
  }
  // While the flush is in flight, push more — these should short-circuit
  // at the `flushing.has` guard (line 30 in record), NOT trigger a 2nd flush
  for (let i = 0; i < 5; i++) {
    buf.record('chat_concurrent', {
      role: 'user',
      senderId: 'u',
      text: `during-${i}`,
      timestamp: new Date().toISOString(),
    });
  }
  // Wait for the slow flush to complete
  await new Promise((r) => setTimeout(r, 100));
  if (flushFires !== 1) {
    fail(`3: concurrent pushes during flush must NOT trigger second flush, fired ${flushFires}`);
  }
  testNum++;
}

// 4. After flush completes, new pushes accumulate fresh
{
  const buf = new ConversationBuffer({ maxMessages: 5 });
  let flushFires = 0;
  buf.setFlushHandler(async () => { flushFires++; });

  // Round 1: fill to cap → flush
  for (let i = 0; i < 5; i++) {
    buf.record('chat_round', {
      role: 'user',
      senderId: 'u',
      text: `r1-${i}`,
      timestamp: new Date().toISOString(),
    });
  }
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  if (flushFires !== 1) fail(`4: first round should flush once`);

  // Round 2: push 3 more → no flush (under cap)
  for (let i = 0; i < 3; i++) {
    buf.record('chat_round', {
      role: 'user',
      senderId: 'u',
      text: `r2-${i}`,
      timestamp: new Date().toISOString(),
    });
  }
  await new Promise((r) => setImmediate(r));
  if (flushFires !== 1) fail(`4: under-cap second round should NOT trigger another flush`);
  if (buf.getMessages('chat_round').length !== 3) {
    fail(`4: second round buffer should hold 3 messages, got ${buf.getMessages('chat_round').length}`);
  }
  testNum++;
}

// 5. Per-chat independence: chat A at cap triggers flush, chat B unaffected
{
  const buf = new ConversationBuffer({ maxMessages: 5 });
  const flushes: string[] = [];
  buf.setFlushHandler(async (chatId) => { flushes.push(chatId); });

  // Fill chat A to cap
  for (let i = 0; i < 5; i++) {
    buf.record('chat_A', {
      role: 'user',
      senderId: 'u',
      text: `a${i}`,
      timestamp: new Date().toISOString(),
    });
  }
  // Push only 2 to chat B
  for (let i = 0; i < 2; i++) {
    buf.record('chat_B', {
      role: 'user',
      senderId: 'u',
      text: `b${i}`,
      timestamp: new Date().toISOString(),
    });
  }
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  if (flushes.length !== 1 || flushes[0] !== 'chat_A') {
    fail(`5: only chat_A should flush, got ${JSON.stringify(flushes)}`);
  }
  if (buf.getMessages('chat_B').length !== 2) {
    fail(`5: chat_B should still hold 2 messages, got ${buf.getMessages('chat_B').length}`);
  }
  testNum++;
}

// ── Part B: replaceLastAssistant (#111 fix) ──────────────────────

// 6. Replace latest assistant entry; user entries above untouched
{
  const buf = new ConversationBuffer({ maxMessages: 100 });
  buf.record('chat_r', { role: 'user', senderId: 'u', text: 'q', timestamp: 't1' });
  buf.record('chat_r', { role: 'assistant', senderId: 'bot', text: 'old answer', timestamp: 't2' });

  const ok = buf.replaceLastAssistant('chat_r', 'new answer');
  if (!ok) fail(`6: replaceLastAssistant should return true on success`);

  const msgs = buf.getMessages('chat_r');
  if (msgs.length !== 2) fail(`6: count unchanged, got ${msgs.length}`);
  if (msgs[0].text !== 'q') fail(`6: user entry must be untouched`);
  if (msgs[1].text !== 'new answer') fail(`6: assistant entry should be updated, got ${msgs[1].text}`);
  if (msgs[1].role !== 'assistant') fail(`6: role preserved`);
  if (msgs[1].timestamp === 't2') fail(`6: timestamp should be refreshed`);
  testNum++;
}

// 7. Multi-turn — replace only the LATEST assistant, earlier assistants untouched
{
  const buf = new ConversationBuffer({ maxMessages: 100 });
  buf.record('chat_m', { role: 'user', senderId: 'u', text: 'q1', timestamp: 't1' });
  buf.record('chat_m', { role: 'assistant', senderId: 'bot', text: 'a1', timestamp: 't2' });
  buf.record('chat_m', { role: 'user', senderId: 'u', text: 'q2', timestamp: 't3' });
  buf.record('chat_m', { role: 'assistant', senderId: 'bot', text: 'a2', timestamp: 't4' });

  buf.replaceLastAssistant('chat_m', 'a2-edited');
  const msgs = buf.getMessages('chat_m');
  if (msgs[1].text !== 'a1') fail(`7: earlier assistant 'a1' must be untouched, got ${msgs[1].text}`);
  if (msgs[3].text !== 'a2-edited') fail(`7: latest assistant should be edited`);
  testNum++;
}

// 8. No-op cases return false
{
  const buf = new ConversationBuffer({ maxMessages: 100 });
  // 8a: chat with no buffer
  if (buf.replaceLastAssistant('chat_none', 'whatever')) {
    fail(`8a: missing chat → false`);
  }
  // 8b: buffer with only user entries
  buf.record('chat_user_only', { role: 'user', senderId: 'u', text: 'q', timestamp: 't' });
  if (buf.replaceLastAssistant('chat_user_only', 'whatever')) {
    fail(`8b: user-only buffer → false`);
  }
  // Verify user entry was NOT mutated
  const msgs = buf.getMessages('chat_user_only');
  if (msgs[0].text !== 'q') fail(`8b: user entry must stay`);
  testNum++;
}

// 9. Mid-flush short-circuit — edit must not land in a buffer that's
//    about to be wiped by triggerFlush's post-await cleanup. This is
//    the explicit safety the implementation documents.
{
  const buf = new ConversationBuffer({ maxMessages: 100 });
  let flushStarted = false;
  let flushResume!: () => void;
  const flushBlock = new Promise<void>((r) => { flushResume = r; });
  buf.setFlushHandler(async () => {
    flushStarted = true;
    await flushBlock; // hold the flush so we can edit mid-flight
  });

  buf.record('chat_flush', { role: 'user', senderId: 'u', text: 'q', timestamp: 't1' });
  buf.record('chat_flush', { role: 'assistant', senderId: 'bot', text: 'old', timestamp: 't2' });

  // Trigger flush via the private method (force a deterministic test).
  // We can't use cap here without filling 100 entries; use direct call.
  const flushP = (buf as any).triggerFlush('chat_flush');
  // Let the flush handler enter (sets flushStarted = true)
  await new Promise((r) => setImmediate(r));
  if (!flushStarted) fail(`9: flush should have started`);

  // While mid-flush, try replaceLastAssistant — must return false
  const ok = buf.replaceLastAssistant('chat_flush', 'edited');
  if (ok) fail(`9: replaceLastAssistant during flush must return false`);

  // Release the flush
  flushResume();
  await flushP;
  testNum++;
}

// 10. #148 fix: atomic cleanup-and-release ordering. The pre-fix
//     shape moved buffers.delete OUTSIDE the finally block, so a
//     theoretical interleaving between gate-release and cleanup
//     could lose a concurrent record(). V8 single-threaded JS makes
//     this not exploitable today, but the fix codifies the contract:
//     after triggerFlush returns, a fresh record() lands cleanly in
//     a NEW buffer/timer pair (proves cleanup-then-release was
//     atomic). Test exercises the full lifecycle.
{
  const buf = new ConversationBuffer({ maxMessages: 100 });
  let flushCount = 0;
  buf.setFlushHandler(async () => { flushCount++; });

  buf.record('chat_cleanup', { role: 'user', senderId: 'u', text: 'a', timestamp: 't1' });
  buf.record('chat_cleanup', { role: 'user', senderId: 'u', text: 'b', timestamp: 't2' });

  await (buf as any).triggerFlush('chat_cleanup');
  if (flushCount !== 1) fail(`10: flush should fire exactly once, got ${flushCount}`);

  // Post-flush state: old buffer wiped, gate released
  if (buf.getMessages('chat_cleanup').length !== 0) {
    fail(`10: buffer should be empty post-flush, got ${buf.getMessages('chat_cleanup').length}`);
  }
  if ((buf as any).flushing.has('chat_cleanup')) {
    fail(`10: flushing gate must be released post-flush`);
  }
  if ((buf as any).timers.has('chat_cleanup')) {
    fail(`10: timer entry must be cleared post-flush`);
  }

  // A new record() now should land cleanly in a fresh buffer + arm a new timer.
  buf.record('chat_cleanup', { role: 'user', senderId: 'u', text: 'fresh', timestamp: 't3' });
  if (buf.getMessages('chat_cleanup').length !== 1) {
    fail(`10: post-flush record() must create fresh entry, got ${buf.getMessages('chat_cleanup').length}`);
  }
  if (!(buf as any).timers.has('chat_cleanup')) {
    fail(`10: post-flush record() must arm new timer`);
  }

  testNum++;
}

// 11. #148 fix: record() DURING a held flush is still dropped (the
//     pre-existing re-entry guard preserved). Confirms the cleanup
//     reordering didn't accidentally relax the during-flush drop
//     semantics — flushing.delete is still LAST, so any record()
//     before the finally completes hits the `flushing.has` guard.
{
  const buf = new ConversationBuffer({ maxMessages: 100 });
  let flushResume!: () => void;
  const flushBlock = new Promise<void>((r) => { flushResume = r; });
  let flushHandlerEntered = false;
  buf.setFlushHandler(async () => {
    flushHandlerEntered = true;
    await flushBlock;
  });

  buf.record('chat_drop', { role: 'user', senderId: 'u', text: 'a', timestamp: 't1' });

  const flushP = (buf as any).triggerFlush('chat_drop');
  await new Promise((r) => setImmediate(r));
  if (!flushHandlerEntered) fail(`11: flush should have entered handler`);

  // While the flush is held, record() must be dropped (existing contract).
  buf.record('chat_drop', { role: 'user', senderId: 'u', text: 'during-flush', timestamp: 't2' });
  // The dropped message must NOT appear in the buffer (still empty during flush)
  if (buf.getMessages('chat_drop').length !== 1) {
    // Note: buffer still has the ORIGINAL 'a' since cleanup hasn't fired yet
    fail(`11: buffer should still have original during flush, got ${buf.getMessages('chat_drop').length}`);
  }
  if (buf.getMessages('chat_drop').some(m => m.text === 'during-flush')) {
    fail(`11: during-flush record() must be dropped (not appear in buffer)`);
  }

  flushResume();
  await flushP;

  // Post-flush: original wiped, drop confirmed never landed
  if (buf.getMessages('chat_drop').length !== 0) {
    fail(`11: post-flush buffer should be empty, got ${buf.getMessages('chat_drop').length}`);
  }

  testNum++;
}

console.log(`buffer-cap smoke: ${testNum}/${testNum} PASS`);
