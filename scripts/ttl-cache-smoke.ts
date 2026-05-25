/**
 * TTLCache smoke test (v1.0.36, closes #109 part 1 — nameCache /
 * chatTypeCache bounding). Direct unit test of the pure TTL + LRU
 * cache class; the channel.ts integration is verified by code review
 * (the only change at the call site is the type of `this.nameCache` /
 * `this.chatTypeCache`).
 */

import { TTLCache } from '../src/ttl-cache.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let testNum = 0;
const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

// 1. set + get within TTL → returns value
{
  let now = NOW;
  const c = new TTLCache<string, string>({ maxSize: 10, ttlMs: HOUR_MS, nowFn: () => now });
  c.set('a', 'alpha');
  if (c.get('a') !== 'alpha') fail(`1: fresh get must return value`);
  testNum++;
}

// 2. get past TTL → undefined + lazy evict
{
  let now = NOW;
  const c = new TTLCache<string, string>({ maxSize: 10, ttlMs: HOUR_MS, nowFn: () => now });
  c.set('a', 'alpha');
  now = NOW + HOUR_MS + 1; // 1ms past TTL
  if (c.get('a') !== undefined) fail(`2: expired entry must return undefined`);
  if (c.size !== 0) fail(`2: expired get must lazy-evict (size=${c.size})`);
  testNum++;
}

// 3. Boundary: get at exactly ttlMs from set → returns value
//    (strict `>` for expiry, matches isMissedRunStale / gcInbox convention)
{
  let now = NOW;
  const c = new TTLCache<string, string>({ maxSize: 10, ttlMs: HOUR_MS, nowFn: () => now });
  c.set('a', 'alpha');
  now = NOW + HOUR_MS; // exactly at threshold
  if (c.get('a') !== 'alpha') fail(`3: at-threshold get must return value (strict >)`);
  testNum++;
}

// 4. LRU cap: maxSize=3, insert 5 → only 3 newest remain
{
  let now = NOW;
  const c = new TTLCache<string, string>({ maxSize: 3, ttlMs: HOUR_MS, nowFn: () => now });
  for (let i = 0; i < 5; i++) c.set(`k${i}`, `v${i}`);
  if (c.get('k0') !== undefined) fail(`4: oldest k0 should be evicted`);
  if (c.get('k1') !== undefined) fail(`4: k1 should be evicted`);
  if (c.get('k2') !== 'v2') fail(`4: k2 should survive`);
  if (c.get('k3') !== 'v3') fail(`4: k3 should survive`);
  if (c.get('k4') !== 'v4') fail(`4: k4 should survive`);
  testNum++;
}

// 5. Update existing key resets its position to the tail (it's re-
//    inserted, not in-place updated)
{
  let now = NOW;
  const c = new TTLCache<string, string>({ maxSize: 3, ttlMs: HOUR_MS, nowFn: () => now });
  c.set('a', '1');
  c.set('b', '2');
  c.set('c', '3');
  // Re-set a → moves to tail
  c.set('a', '1-updated');
  // Now insert d → should evict b (the now-oldest), not a
  c.set('d', '4');
  if (c.get('b') !== undefined) fail(`5: b should be evicted after a's re-insert`);
  if (c.get('a') !== '1-updated') fail(`5: a should survive with updated value`);
  if (c.get('c') !== '3') fail(`5: c should survive`);
  if (c.get('d') !== '4') fail(`5: d should survive`);
  testNum++;
}

// 6. touchOnGet=true → reading bumps to tail, preventing eviction
{
  let now = NOW;
  const c = new TTLCache<string, string>({
    maxSize: 3,
    ttlMs: HOUR_MS,
    touchOnGet: true,
    nowFn: () => now,
  });
  c.set('a', '1');
  c.set('b', '2');
  c.set('c', '3');
  // Touch a — moves to tail
  if (c.get('a') !== '1') fail(`6: get of fresh value should return`);
  // Insert d — evicts b (oldest after a's touch)
  c.set('d', '4');
  if (c.get('b') !== undefined) fail(`6: b should be evicted (a was touched)`);
  if (c.get('a') !== '1') fail(`6: a survived via touchOnGet`);
  testNum++;
}

// 7. has() respects TTL (uses get under the hood)
{
  let now = NOW;
  const c = new TTLCache<string, string>({ maxSize: 10, ttlMs: HOUR_MS, nowFn: () => now });
  c.set('a', 'alpha');
  if (!c.has('a')) fail(`7: has on fresh entry`);
  now = NOW + HOUR_MS + 1;
  if (c.has('a')) fail(`7: has on expired entry must return false`);
  testNum++;
}

// 8. delete() removes immediately
{
  const c = new TTLCache<string, string>({ maxSize: 10, ttlMs: HOUR_MS });
  c.set('a', 'alpha');
  if (!c.delete('a')) fail(`8: delete should return true for existing`);
  if (c.get('a') !== undefined) fail(`8: deleted entry should be gone`);
  if (c.delete('missing')) fail(`8: delete should return false for missing`);
  testNum++;
}

// 9. clear() empties the cache
{
  const c = new TTLCache<string, string>({ maxSize: 10, ttlMs: HOUR_MS });
  for (let i = 0; i < 5; i++) c.set(`k${i}`, `v${i}`);
  c.clear();
  if (c.size !== 0) fail(`9: clear should empty cache, size=${c.size}`);
  testNum++;
}

// 10. Invalid constructor args throw — R1-followup tightens ttlMs > 0
//     (was ≥ 0 pre-followup). `ttlMs=0` was useless (write-only cache)
//     and a rate-limit risk for the contact-API-backed nameCache.
{
  let threw = 0;
  try { new TTLCache({ maxSize: 0, ttlMs: HOUR_MS }); } catch { threw++; }
  try { new TTLCache({ maxSize: -1, ttlMs: HOUR_MS }); } catch { threw++; }
  try { new TTLCache({ maxSize: 10, ttlMs: -1 }); } catch { threw++; }
  try { new TTLCache({ maxSize: 10, ttlMs: 0 }); } catch { threw++; }
  if (threw !== 4) fail(`10: invalid args must throw, got ${threw}/4 throws`);
  testNum++;
}

// 11. R1-followup: has() is now PURE (no lazy evict, no touch). Pre-
//     followup it delegated to get() which mutated the Map. A future
//     contributor writing `if (cache.has(k)) cache.get(k)` would have
//     unexpectedly double-promoted with touchOnGet=true, or double-
//     evicted on expired entries.
{
  let now = NOW;
  const c = new TTLCache<string, string>({
    maxSize: 10,
    ttlMs: HOUR_MS,
    touchOnGet: true,
    nowFn: () => now,
  });
  c.set('a', 'alpha');
  const sizeBefore = c.size;
  // Multiple has() calls must not mutate
  if (!c.has('a')) fail(`11: has on fresh entry`);
  if (!c.has('a')) fail(`11: has on fresh entry (2nd call)`);
  if (c.size !== sizeBefore) fail(`11: has must not mutate size`);

  // Expired entry: has must return false but NOT evict (next get()
  // will do that). Check that the underlying Map still holds the
  // entry post-has.
  now = NOW + HOUR_MS + 1;
  if (c.has('a')) fail(`11: has on expired must return false`);
  // Access internal map to verify no eviction happened (white-box test).
  const internalMap = (c as any).map as Map<string, unknown>;
  if (!internalMap.has('a')) fail(`11: has must not evict expired entries (saw eviction)`);
  // get() does the eviction (lazy sweep)
  c.get('a');
  if (internalMap.has('a')) fail(`11: get() should evict the expired entry`);
  testNum++;
}

// 12. maxSize=1 — every set replaces
{
  const c = new TTLCache<string, string>({ maxSize: 1, ttlMs: HOUR_MS });
  c.set('a', 'alpha');
  c.set('b', 'beta');
  if (c.get('a') !== undefined) fail(`12: a should be evicted by b`);
  if (c.get('b') !== 'beta') fail(`12: b should be present`);
  if (c.size !== 1) fail(`12: size cap=1`);
  testNum++;
}

console.log(`ttl-cache smoke: ${testNum}/${testNum} PASS`);
