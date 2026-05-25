/**
 * TTL + LRU cache (#109). The daemon's `nameCache` (open_id → display
 * name) and `chatTypeCache` (chat_id → 'p2p' | 'group') were both bare
 * `Map<string, string>`s with no eviction. In an org-wide bot
 * (thousands of users, hundreds of chats) they grew monotonically — a
 * months-long deployment would silently retain every name the bot ever
 * resolved.
 *
 * This class is the bounded replacement. Two policies, both applied on
 * every `get`:
 *
 * 1. **TTL**: an entry whose `addedAt + ttlMs < now` is treated as
 *    expired. `get` returns `undefined` and lazily evicts (cheap — no
 *    background sweep needed for caches whose hits dominate misses).
 *
 * 2. **LRU cap**: when `set` would push the Map past `maxSize`, the
 *    oldest entry (insertion order via `keys().next()`) is evicted.
 *    This is FIFO-by-insertion (a real LRU would re-insert on every
 *    `get`); good enough for these caches where access pattern is
 *    uniform-ish (no specific entry gets re-hit far more than others
 *    in a chat-scale deployment).
 *
 * Optional `touchOnGet=true` upgrades to true LRU by re-inserting on
 * read. Default false (cheap FIFO works for the existing call sites
 * and avoids the hidden side-effect that "reading mutates").
 *
 * Not async, not concurrency-safe across multiple writers (Node is
 * single-threaded; all calls happen on the event loop). Tests pass
 * `now` explicitly for deterministic age checks.
 */
export class TTLCache<K, V> {
  private map = new Map<K, { value: V; addedAt: number }>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly touchOnGet: boolean;
  /** Test hook: override the time source. Defaults to Date.now. */
  private readonly nowFn: () => number;

  constructor(opts: {
    maxSize: number;
    ttlMs: number;
    touchOnGet?: boolean;
    nowFn?: () => number;
  }) {
    if (opts.maxSize < 1) {
      throw new Error(`TTLCache: maxSize must be ≥ 1, got ${opts.maxSize}`);
    }
    if (opts.ttlMs < 0) {
      throw new Error(`TTLCache: ttlMs must be ≥ 0, got ${opts.ttlMs}`);
    }
    this.maxSize = opts.maxSize;
    this.ttlMs = opts.ttlMs;
    this.touchOnGet = opts.touchOnGet ?? false;
    this.nowFn = opts.nowFn ?? Date.now;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.nowFn() - entry.addedAt > this.ttlMs) {
      // Expired — lazy evict.
      this.map.delete(key);
      return undefined;
    }
    if (this.touchOnGet) {
      // Re-insert to bump to the most-recent FIFO position.
      this.map.delete(key);
      this.map.set(key, entry);
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    // If key already present, delete first so re-insert moves it to
    // the tail (consistent with a "fresh write" semantic).
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest by insertion order.
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, { value, addedAt: this.nowFn() });
  }

  has(key: K): boolean {
    // Defer to get() so the TTL check fires.
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /**
   * Current entry count (including expired-but-not-yet-evicted). For
   * observability / tests. Real size after sweep would require a full
   * iteration; the count returned here is an upper bound.
   */
  get size(): number {
    return this.map.size;
  }
}
