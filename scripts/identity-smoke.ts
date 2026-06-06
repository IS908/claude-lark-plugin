/**
 * IdentitySession smoke test — runs as part of `npm test`.
 * Exits non-zero if any assertion fails.
 */
import { IdentitySession, TERMINAL_CHAT_ID } from '../src/identity-session.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// 1. set/get same chat, no thread
{
  const s = new IdentitySession(() => null);
  s.setCaller('chat_A', undefined, 'ou_alice');
  if (s.getCaller('chat_A') !== 'ou_alice') fail('basic chat get');
}

// 2. thread-scoped entry takes precedence over chat-scoped
{
  const s = new IdentitySession(() => null);
  s.setCaller('chat_A', undefined, 'ou_chat');
  s.setCaller('chat_A', 't1', 'ou_thread');
  if (s.getCaller('chat_A', 't1') !== 'ou_thread') fail('thread precedence');
  if (s.getCaller('chat_A') !== 'ou_chat') fail('chat entry still present');
}

// 3. getCaller falls back from thread to chat when thread entry missing
{
  const s = new IdentitySession(() => null);
  s.setCaller('chat_A', undefined, 'ou_chat');
  if (s.getCaller('chat_A', 'no-such-thread') !== 'ou_chat') fail('fallback to chat');
}

// 4. terminal sentinel uses owner fallback
{
  const s = new IdentitySession(() => 'ou_owner');
  if (s.getCaller(TERMINAL_CHAT_ID) !== 'ou_owner') fail('terminal fallback');
}

// 5. terminal sentinel returns null when no owner configured
{
  const s = new IdentitySession(() => null);
  if (s.getCaller(TERMINAL_CHAT_ID) !== null) fail('terminal null when unset');
}

// 6. unknown chat returns null
{
  const s = new IdentitySession(() => null);
  if (s.getCaller('chat_unknown') !== null) fail('unknown chat');
}

// 7. stale entry is not returned; cleanup removes it
{
  const s = new IdentitySession(() => null, 10); // 10ms ttl
  s.setCaller('chat_A', undefined, 'ou_alice');
  await new Promise((r) => setTimeout(r, 30));
  if (s.getCaller('chat_A') !== null) fail('stale should return null');
  s.cleanup();
  if (s._size() !== 0) fail('cleanup should remove stale');
}

// 8. overwrite refreshes
{
  const s = new IdentitySession(() => null);
  s.setCaller('chat_A', undefined, 'ou_alice');
  s.setCaller('chat_A', undefined, 'ou_bob');
  if (s.getCaller('chat_A') !== 'ou_bob') fail('overwrite');
}

// 9. getOwner returns the static ownerFallback (v1.0.14, for save_skill #84).
//    Independent of any session entries — pure passthrough of the fallback.
{
  const s = new IdentitySession(() => 'ou_owner_static');
  if (s.getOwner() !== 'ou_owner_static') fail('getOwner returns ownerFallback');
  // Session entries do NOT influence getOwner — it's the OWNER, not the
  // current caller for some chat.
  s.setCaller('chat_X', undefined, 'ou_someone_else');
  if (s.getOwner() !== 'ou_owner_static') fail('getOwner ignores session entries');
}

// 10. getOwner returns null when no OWNER configured.
{
  const s = new IdentitySession(() => null);
  if (s.getOwner() !== null) fail('getOwner null when ownerFallback returns null');
}

// 11. doc:<token> with no setCaller binding → null (no shortcut to owner anymore)
{
  const s = new IdentitySession(() => 'ou_owner');
  if (s.getCaller('doc:doxcnXXX') !== null) {
    fail('11: doc: prefix must NOT short-circuit to owner — caller is bound at event-time via setCaller');
  }
}

// 12. doc:<token> with setCaller binding → returns the bound user (event-time identity preserved).
// Post-N-5: doc: chat_ids MUST be keyed per-comment, so this test binds via (chat, comment_id).
{
  const s = new IdentitySession(() => 'ou_owner');
  s.setCaller('doc:doxcnXXX', 'cmt_1', 'ou_from_user');
  if (s.getCaller('doc:doxcnXXX', 'cmt_1') !== 'ou_from_user') {
    fail('12: doc: chat_id must resolve to the setCaller-bound user, not owner');
  }
}

// 13. doc:<token> with non-owner setCaller binding → returns non-owner (security regression test).
// Post-N-5: per-comment keyed.
{
  const s = new IdentitySession(() => 'ou_owner');
  s.setCaller('doc:doxcnXXX', 'cmt_1', 'ou_alice');
  if (s.getCaller('doc:doxcnXXX', 'cmt_1') === 'ou_owner') {
    fail('13: SECURITY: doc: chat_id must NOT silently elevate non-owner to owner identity');
  }
}

// 14. LRU cap: oldest entry evicted when capacity exceeded (PR #182 round 5 N-1)
{
  const s = new IdentitySession(() => 'ou_owner', 3600_000, { maxSize: 3 });
  s.setCaller('chat_a', 't1', 'ou_alice');
  s.setCaller('chat_b', 't2', 'ou_bob');
  s.setCaller('chat_c', 't3', 'ou_carol');
  if (s.getCaller('chat_a', 't1') !== 'ou_alice') fail('14: alice should still be present at capacity');
  s.setCaller('chat_d', 't4', 'ou_dave'); // triggers eviction of oldest (alice)
  if (s.getCaller('chat_a', 't1') !== null) fail('14: LRU should evict oldest entry on capacity overflow');
  if (s.getCaller('chat_d', 't4') !== 'ou_dave') fail('14: new entry must be present');
}

// 15. doc: chat_id without thread_id throws — invariant lock-in (PR #182 round 5 N-5)
{
  const s = new IdentitySession(() => 'ou_owner');
  let threw = false;
  try {
    s.setCaller('doc:abc', undefined, 'ou_someone');
  } catch (e: any) {
    threw = true;
    if (!/non-undefined thread_id/i.test(e.message)) fail('15: error message should explain the invariant');
  }
  if (!threw) fail('15: doc: chat_id without thread_id must throw');
}

// 16. maxSize=0 is clamped to 1 (corner-case defense — PR #182 round 6 M-3).
// Without the clamp, the LRU loop on an empty map skips eviction (no oldest
// to delete) and the first insert lands → effective cap is "1 slot, not 0".
// The clamp makes the corner explicit so the cap is always effective.
{
  const s = new IdentitySession(() => 'ou_owner', 3600_000, { maxSize: 0 });
  s.setCaller('doc:a', 'c1', 'ou_alice');
  s.setCaller('doc:b', 'c2', 'ou_bob');
  // Only 1 slot available; the first entry should have been evicted.
  if (s.getCaller('doc:a', 'c1') !== null) fail('16: maxSize=0 must clamp to 1 (oldest evicted)');
  if (s.getCaller('doc:b', 'c2') !== 'ou_bob') fail('16: most recent must be present');
}

// 17. SECURITY: maxSize=NaN falls back to DEFAULT (PR #182 round-7 M-2 + round-8 I-2).
//   Pre-fix: `this.maxSize = Math.max(1, NaN) === NaN`. LRU check `size >= NaN`
//   is always false → cap silently disabled. Post-fix: Number.isFinite guard
//   substitutes DEFAULT_MAX_SIZE so the cap survives.
//
//   Round-8 I-2: the earlier "insert 10, assert size===10" smoke passed both
//   pre- and post-fix (10 entries land either way). _maxSize() accessor lets
//   us assert the cap itself is finite and equals the default.
{
  const s = new IdentitySession(() => 'ou_owner', 3600_000, { maxSize: NaN as unknown as number });
  const actual = s._maxSize();
  if (!Number.isFinite(actual)) fail(`17: SECURITY: NaN maxSize must fall back to a finite default, got ${actual}`);
  if (actual !== 5000) fail(`17: maxSize fallback should be DEFAULT_MAX_SIZE=5000, got ${actual}`);
}

// 17a. SECURITY: maxSize=Infinity also falls back to DEFAULT (round-8 I-2 walkthrough).
//   `Math.max(1, Infinity) === Infinity` → `size >= Infinity` is always false →
//   cap effectively disabled. Number.isFinite rejects Infinity too, so the
//   same fallback path covers this corner symmetrically.
{
  const s = new IdentitySession(() => 'ou_owner', 3600_000, { maxSize: Infinity });
  const actual = s._maxSize();
  if (!Number.isFinite(actual)) fail(`17a: Infinity must fall back to a finite default`);
  if (actual !== 5000) fail(`17a: Infinity fallback should be DEFAULT_MAX_SIZE=5000, got ${actual}`);
}

console.log('identity smoke: 18/18 PASS');
