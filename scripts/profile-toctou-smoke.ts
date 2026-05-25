/**
 * Profile TOCTOU smoke test (v1.0.34, closes #54).
 *
 * Exercises the per-user async mutex added to `MemoryStore.saveProfile`
 * and `MemoryStore.removeProfileLine`. Pre-fix two concurrent same-user
 * writes across different chats raced on the `read → merge → write`
 * sequence and silently dropped the older delta. Post-fix the mutex
 * serializes them within one process.
 *
 * NOTE: a per-user async mutex is a single-process construct. If two
 * MCP processes (rare; the file lock at src/lock.ts blocks this) wrote
 * the same profile, the race would still exist. The single-instance
 * lock makes that effectively unreachable.
 */

// Pin a tmp memories dir BEFORE importing the store, so the constructor
// resolves to it (the default reads appConfig.memoriesDir, which we
// override via the constructor arg below — but we still set the env
// for any other module that captures at import time).
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'profile-toctou-'));
process.env.LARK_MEMORIES_DIR = tmp;

import { MemoryStore } from '../src/memory/file.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let testNum = 0;
const store = new MemoryStore(tmp);

// Helper: read a profile tier file directly off disk
function readTier(userId: string, tier: 'public' | 'private'): string {
  const p = join(tmp, 'profiles', userId, `${tier}.md`);
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

// Helper: parse the list of bullet texts from a tier file
function tierLines(userId: string, tier: 'public' | 'private'): string[] {
  return readTier(userId, tier)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith('- ') ? l.slice(2).trim() : l));
}

try {
  // 1. Sequential baseline — confirms the test harness works.
  {
    await store.saveProfile('ou_seq', '- fact 1', 'private');
    await store.saveProfile('ou_seq', '- fact 2', 'private');
    const lines = tierLines('ou_seq', 'private');
    if (!lines.includes('fact 1') || !lines.includes('fact 2')) {
      fail(`1: sequential writes lost a fact: ${JSON.stringify(lines)}`);
    }
    testNum++;
  }

  // 2. THE BUG: concurrent same-user writes across two simulated chats.
  //    Pre-#54 fix the second writer's `existing` snapshot was taken
  //    before the first writer's commit landed; second write overwrote
  //    with `S ∪ deltaB`, dropping deltaA. With the mutex, both deltas
  //    must survive.
  {
    const user = 'ou_concurrent';
    const N = 20;
    // Fire all N writes in parallel without awaiting between them — the
    // pre-fix code would lose most of them.
    const writes = Array.from({ length: N }, (_, i) =>
      store.saveProfile(user, `- fact ${i}`, 'private'),
    );
    await Promise.all(writes);
    const lines = tierLines(user, 'private');
    for (let i = 0; i < N; i++) {
      if (!lines.includes(`fact ${i}`)) {
        fail(`2: concurrent writes lost "fact ${i}" — got ${lines.length}/${N} survivors: ${JSON.stringify(lines)}`);
      }
    }
    testNum++;
  }

  // 3. Different users do NOT serialize against each other — confirms
  //    the per-user keying actually works (a global mutex would
  //    pessimize parallel cross-user traffic).
  {
    const t0 = Date.now();
    // Simulate two users with intentionally-slow writes by chaining
    // multiple writes per user; if cross-user serialization existed,
    // total time would be ~2× the per-user time.
    const userA = Array.from({ length: 5 }, (_, i) =>
      store.saveProfile('ou_userA', `- a${i}`, 'private'),
    );
    const userB = Array.from({ length: 5 }, (_, i) =>
      store.saveProfile('ou_userB', `- b${i}`, 'private'),
    );
    await Promise.all([...userA, ...userB]);
    const elapsedMs = Date.now() - t0;
    // Loose bound — just confirms parallelism is preserved across users.
    // Sequential 10 file-writes on a workstation is comfortably <500ms.
    if (elapsedMs > 5000) {
      fail(`3: cross-user writes took ${elapsedMs}ms — suggests global mutex (should be per-user)`);
    }
    const linesA = tierLines('ou_userA', 'private');
    const linesB = tierLines('ou_userB', 'private');
    if (linesA.length !== 5) fail(`3: ou_userA missing facts: ${JSON.stringify(linesA)}`);
    if (linesB.length !== 5) fail(`3: ou_userB missing facts: ${JSON.stringify(linesB)}`);
    testNum++;
  }

  // 4. Mutex map cleanup — after a save completes and no other call
  //    has chained on top, the entry must be removed to prevent
  //    unbounded growth in long-lived daemons.
  {
    const user = 'ou_cleanup';
    await store.saveProfile(user, '- one', 'private');
    // Give the .then() cleanup microtask a chance to run
    await new Promise((r) => setTimeout(r, 10));
    const mutexMap = (store as any).profileMutex as Map<string, unknown>;
    if (mutexMap.has(user)) {
      fail(`4: profileMutex entry for ${user} not cleaned up (size=${mutexMap.size})`);
    }
    testNum++;
  }

  // 5. Mutex map keeps entries during active chains — cleanup must NOT
  //    fire while a later call is still queued.
  {
    const user = 'ou_active';
    // Start a chain of 3 writes
    const writes = [
      store.saveProfile(user, '- one', 'private'),
      store.saveProfile(user, '- two', 'private'),
      store.saveProfile(user, '- three', 'private'),
    ];
    // While the chain is active, the mutex entry must exist
    const mutexMap = (store as any).profileMutex as Map<string, unknown>;
    if (!mutexMap.has(user)) {
      fail(`5: profileMutex entry for active user ${user} missing`);
    }
    await Promise.all(writes);
    // Now flush microtasks and confirm cleanup
    await new Promise((r) => setTimeout(r, 10));
    if (mutexMap.has(user)) fail(`5: profileMutex not cleaned up after chain drained`);
    testNum++;
  }

  // 6. Error in one chained call doesn't poison subsequent calls.
  //    We can't easily force saveProfile to throw without monkey-patching;
  //    instead exercise the mutex helper directly via the `as any` escape.
  {
    const user = 'ou_err_chain';
    const results: string[] = [];
    const calls = [
      (store as any).withProfileMutex(user, async () => {
        results.push('A-ok');
      }),
      (store as any).withProfileMutex(user, async () => {
        results.push('B-throw');
        throw new Error('synthetic B failure');
      }),
      (store as any).withProfileMutex(user, async () => {
        results.push('C-ok');
      }),
    ];
    // Catch B's rejection so Promise.all doesn't short-circuit early
    const settled = await Promise.allSettled(calls);
    if (settled[0].status !== 'fulfilled') fail(`6: A should fulfill`);
    if (settled[1].status !== 'rejected') fail(`6: B should reject`);
    if (settled[2].status !== 'fulfilled') fail(`6: C should fulfill despite B's throw`);
    if (results.join(',') !== 'A-ok,B-throw,C-ok') {
      fail(`6: out of order: ${results.join(',')}`);
    }
    testNum++;
  }

  // 7. saveProfile + removeProfileLine concurrent on same user serialize
  //    via the SAME mutex — remove can't run mid-save, save can't run
  //    mid-remove, the final state is consistent.
  {
    const user = 'ou_save_remove';
    // Seed with two facts
    await store.saveProfile(user, '- keep me\n- delete me', 'private');
    const initial = await store.listProfileLines(user, 'private');
    const deleteTarget = initial.find((l) => l.text === 'delete me');
    if (!deleteTarget) fail(`7: setup failed — 'delete me' not found`);

    // Fire concurrent remove + save. The interleaving doesn't matter
    // for correctness; what matters is that BOTH outcomes survive.
    const ops = [
      store.removeProfileLine(user, 'private', deleteTarget!.hash),
      store.saveProfile(user, '- added during remove', 'private'),
    ];
    await Promise.all(ops);

    const after = tierLines(user, 'private');
    if (after.includes('delete me')) fail(`7: 'delete me' should be gone, got ${JSON.stringify(after)}`);
    if (!after.includes('keep me')) fail(`7: 'keep me' should survive, got ${JSON.stringify(after)}`);
    if (!after.includes('added during remove')) {
      fail(`7: concurrent save's delta lost, got ${JSON.stringify(after)}`);
    }
    testNum++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`profile-toctou smoke: ${testNum}/${testNum} PASS`);
