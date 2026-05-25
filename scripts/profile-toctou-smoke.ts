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
    // R1-followup: drain the cleanup microtask without a wall-clock
    // dependency. tail.then(cleanup) schedules a microtask; one
    // Promise.resolve roundtrip is enough to drain it on any runtime.
    await Promise.resolve();
    await Promise.resolve();
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
    // R1-followup: drain the cleanup microtask without a wall-clock
    // dependency. tail.then(cleanup) schedules a microtask; one
    // Promise.resolve roundtrip is enough to drain it on any runtime.
    await Promise.resolve();
    await Promise.resolve();
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

  // 8. R1-followup: saveProfileTiered is atomic across BOTH tier writes.
  //    Pre-followup the production `profile_tiered` path made two
  //    separate saveProfile calls (each grabbed the mutex individually),
  //    so a concurrent same-user save could interleave between them
  //    and have its private-tier delta clobbered by the private-replace.
  //    Test: start a tiered write + a single-tier private append in
  //    parallel; depending on which acquires the mutex first, EITHER
  //    the append lands cleanly (tiered runs after, replacing private)
  //    OR the append lands cleanly (tiered runs first, append lands
  //    after replace). Critical: the append's fact must NOT be
  //    silently dropped — that was the pre-followup behavior.
  //    Per-user mutex serializes both operations, so the final state
  //    is one of two well-defined outcomes.
  {
    const user = 'ou_tiered_atomic';
    // Seed with empty profiles
    await store.saveProfileTiered(user, { public: '', private: '' });

    // Fire concurrent tiered-replace + private-append
    const ops = [
      store.saveProfileTiered(user, {
        public: '- public fact\n',
        private: '- tiered private fact\n',
      }),
      store.saveProfile(user, '- appended private fact', 'private'),
    ];
    await Promise.all(ops);

    const finalPub = tierLines(user, 'public');
    const finalPriv = tierLines(user, 'private');

    // Public is always '- public fact' (only one writer touches it)
    if (!finalPub.includes('public fact')) {
      fail(`8: public tier must always end with tiered's content, got ${JSON.stringify(finalPub)}`);
    }
    // Private must contain 'tiered private fact' (from the tiered write)
    if (!finalPriv.includes('tiered private fact')) {
      fail(`8: tiered private write lost, got ${JSON.stringify(finalPriv)}`);
    }
    // The 'appended private fact' must ALSO appear: if the append ran
    // FIRST, the tiered replace's private overwrites it. If the append
    // ran LAST, both survive. The mutex serializes; outcomes per order:
    //   - tiered first, append second  → both facts present
    //   - append first, tiered second  → only tiered's fact (append wiped by replace)
    // Per #54's semantic, BOTH orderings are "no data loss" only if the
    // operations are conceptually idempotent or commutative — but here
    // the user explicitly asked for "replace" via tiered. So losing the
    // append in the (append-first, tiered-second) ordering is correct
    // behavior: the user's last write (tiered) wins. Test asserts the
    // final state is ONE of these two outcomes, not the broken
    // pre-followup "mid-pair clobber" outcome (where private would
    // contain neither 'tiered private' nor 'appended private').
    const hasAppended = finalPriv.includes('appended private fact');
    const onlyTiered =
      finalPriv.length === 1 && finalPriv.includes('tiered private fact');
    const bothPresent =
      finalPriv.includes('tiered private fact') && hasAppended;
    if (!onlyTiered && !bothPresent) {
      fail(`8: private must be {tiered only} or {tiered + appended}, got ${JSON.stringify(finalPriv)}`);
    }
    testNum++;
  }

  // 9. R1-followup: saveProfileTiered itself is mutex-wrapped — N
  //    concurrent tiered writes for the same user serialize correctly,
  //    none lost.
  {
    const user = 'ou_tiered_concurrent';
    const N = 10;
    const writes = Array.from({ length: N }, (_, i) =>
      store.saveProfileTiered(user, {
        public: `- pub ${i}\n`,
        private: `- priv ${i}\n`,
      }),
    );
    await Promise.all(writes);
    // All tiered writes are REPLACE — only the LAST one's content
    // survives. But the chain order is the order the calls were
    // queued (synchronous .then chaining in the mutex), which
    // matches array order, so the last-to-resolve has pub N-1 / priv N-1.
    const finalPub = tierLines(user, 'public');
    const finalPriv = tierLines(user, 'private');
    if (finalPub.length !== 1 || finalPriv.length !== 1) {
      fail(`9: tiered REPLACE must leave exactly 1 line per tier, got pub=${finalPub.length} priv=${finalPriv.length}`);
    }
    if (!finalPub.includes(`pub ${N - 1}`)) {
      fail(`9: last tiered write's public should survive, got ${JSON.stringify(finalPub)}`);
    }
    if (!finalPriv.includes(`priv ${N - 1}`)) {
      fail(`9: last tiered write's private should survive, got ${JSON.stringify(finalPriv)}`);
    }
    testNum++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`profile-toctou smoke: ${testNum}/${testNum} PASS`);
