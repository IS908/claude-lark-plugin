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

console.log(`buffer-cap smoke: ${testNum}/${testNum} PASS`);
