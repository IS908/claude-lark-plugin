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

// 10. Invalid constructor args throw
{
  let threw = 0;
  try { new TTLCache({ maxSize: 0, ttlMs: HOUR_MS }); } catch { threw++; }
  try { new TTLCache({ maxSize: -1, ttlMs: HOUR_MS }); } catch { threw++; }
  try { new TTLCache({ maxSize: 10, ttlMs: -1 }); } catch { threw++; }
  if (threw !== 3) fail(`10: invalid args must throw, got ${threw}/3 throws`);
  testNum++;
}

// 11. ttlMs=0 → every read past the set returns undefined (deliberate
//     "always expire" knob; not generally useful but the math should
//     work consistently)
{
  let now = NOW;
  const c = new TTLCache<string, string>({ maxSize: 10, ttlMs: 0, nowFn: () => now });
  c.set('a', 'alpha');
  // Same tick — `now - addedAt === 0`, NOT > 0, so survives (strict >).
  if (c.get('a') !== 'alpha') fail(`11: same-tick get with ttl=0 survives (strict >)`);
  now = NOW + 1;
  if (c.get('a') !== undefined) fail(`11: 1ms after set with ttl=0 expires`);
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
