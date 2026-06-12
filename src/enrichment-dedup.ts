/**
 * Enrichment-injection dedup (#189).
 *
 * `enrichWithMemory` used to inject the same-shaped <memory_context>
 * slab (profile, mentioned profiles, episodes, skills) on EVERY inbound
 * message. On a hot thread the previous turn's copy is still sitting in
 * the Claude Code main loop's conversation history, so re-injecting an
 * identical block is pure duplication — it inflates every later turn's
 * accumulated-history cost without adding semantic value.
 *
 * Mechanism: per-conversation-scope content-hash dedup with a TTL
 * window. A block is injected iff
 *   - its dedup key was never seen in this scope, OR
 *   - its content hash changed since the last injection, OR
 *   - the last injection is older than the window.
 *
 * This single mechanism replaces the per-block-type follow-up rules
 * table from the original #189 strawman (see the issue discussion):
 *   - profile changes mid-thread re-inject automatically (hash change),
 *   - a new episode written by a mid-thread flush is a new key,
 *   - group multi-user threads work because the profile dedup key
 *     embeds the profile owner's id — user B's first message in a hot
 *     thread still injects B's profile even though A's was suppressed.
 *
 * TTL semantics are ABSOLUTE, not sliding: a suppressed check does NOT
 * refresh the timestamp, so every block is re-injected at least once
 * per window even on a continuously-hot thread. This bounds the
 * staleness exposure to Claude-Code-side compaction / `/clear` /
 * restart — events the plugin cannot observe (verified in the #190
 * discussion: there is no programmatic signal for them). The window is
 * the knob that trades token savings against that re-grounding risk.
 *
 * State is in-memory only. Plugin restart ⇒ full re-injection on every
 * scope — exactly the desired recovery behavior (#189 open question 1).
 */

import { createHash } from 'node:crypto';
import { wrapEnrichmentSection } from './prompts.js';

export interface DedupBlock {
  /** Envelope type attr: profile | mentioned_profile | thread_episode | chat_episode | skill */
  kind: string;
  /** Envelope label attr (may carry volatile parts like scores — NOT hashed) */
  label: string | undefined;
  /** Envelope body — the content that gets hashed for dedup */
  body: string;
  /**
   * Stable identity of the block within a scope, e.g. `profile:<ownerId>`,
   * `thread_episode:<file>`, `skill:<slug>`. Volatile attributes (search
   * score, date tag) must NOT leak into this key.
   */
  dedupKey: string;
  /**
   * When true, a suppressed block renders as a ~150-byte stub envelope
   * instead of disappearing. Used for profile blocks, whose total
   * absence is semantically ambiguous — Claude could read "no profile
   * block" as "this user has no profile" and e.g. call
   * what_do_you_know redundantly. Episodes/skills omit silently:
   * absence of search hits is the normal case for them.
   */
  stubOnSuppress?: boolean;
}

export interface DedupDecision {
  block: DedupBlock;
  /** false ⇒ unchanged within the window — suppress (or stub) */
  inject: boolean;
}

export interface RenderStats {
  injectedCount: number;
  /** Body bytes of injected blocks (envelope overhead excluded). */
  injectedBytes: number;
  suppressedCount: number;
  /** Body bytes that would have been injected without dedup. */
  suppressedBytes: number;
  stubCount: number;
  /**
   * Bytes of the emitted stub parts (envelope included) — the real
   * cost paid on the suppressed path. Net saving per turn is
   * `suppressedBytes - stubBytes`; reporting both keeps the
   * measurement honest (round-2 review finding 6).
   */
  stubBytes: number;
}

interface Entry {
  hash: string;
  /** Timestamp of the last INJECTION (not the last check) — absolute TTL. */
  at: number;
}

/**
 * Body used for stubbed (suppressed) blocks. Deliberately angle-bracket
 * free: `escapeEnvelopeBody` only neutralizes closing envelope tags, so
 * keeping the stub free of tag-like text avoids any interaction with
 * the #114 escaping rules. Wording tells Claude exactly where the full
 * content lives.
 */
export const UNCHANGED_STUB_BODY =
  '(unchanged — full content was injected in an earlier memory_context block of this conversation; rely on that copy)';

/** Label suffix appended to stubbed blocks so the envelope self-describes. */
export const UNCHANGED_LABEL_TAG = 'unchanged';

/**
 * Outer-scope LRU cap. Each scope is one (chatId, threadId) conversation;
 * 2000 covers any realistic deployment (cf. IdentitySession's 5000 cap
 * over the same conversation population — different key shape: dedup
 * matches MessageQueue's `::` keys, IdentitySession uses `#`) while
 * bounding a pathological thread-id flood to ~2000 × a handful of
 * small entries.
 */
const DEFAULT_MAX_SCOPES = 2000;

/**
 * Inner per-scope key cap. Keys accumulate as different episodes/skills
 * rotate through search results over a long-lived thread; expired
 * entries are pruned lazily on touch, and this cap backstops a scope
 * that somehow accumulates more live keys than maxSearchResults
 * arithmetic should ever produce.
 */
const MAX_KEYS_PER_SCOPE = 64;

export class EnrichmentDedup {
  /** scopeKey → (dedupKey → Entry). Map iteration order gives us LRU. */
  private scopes = new Map<string, Map<string, Entry>>();

  constructor(
    private readonly windowMs: number,
    private readonly maxScopes: number = DEFAULT_MAX_SCOPES,
    /** Injectable clock for tests. */
    private readonly now: () => number = Date.now,
    /** Injectable inner cap for tests (round-2 review finding 5). */
    private readonly maxKeysPerScope: number = MAX_KEYS_PER_SCOPE,
  ) {}

  /** windowMs <= 0 disables dedup entirely (pre-#189 behavior). */
  get enabled(): boolean {
    return this.windowMs > 0;
  }

  /**
   * Same key shape as MessageQueue (`chatId::threadId`, empty/undefined
   * threadId collapsed to `_`) — round-2 review finding 7: the queue is
   * what serializes turns per conversation, so the dedup scope must
   * partition IDENTICALLY or two queue-concurrent conversations could
   * share one scope (the only construction where a wrong suppress is
   * structurally possible). The earlier `chatId#threadId` shape aliased
   * `("a#b", undefined)` with `("a", "b")`; `::` matches the queue and
   * `#`-free Feishu id charsets make even that alias unreachable today.
   */
  private scopeKeyOf(chatId: string, threadId: string | undefined): string {
    return `${chatId}::${threadId || '_'}`;
  }

  /**
   * Drop all dedup state for one (chatId, threadId) scope so the next
   * inbound re-injects everything.
   *
   * Called when a turn's enriched message FAILED to reach Claude after
   * `filter()` already recorded its blocks as injected (forward error,
   * missing handler). Without this, the next turn would suppress
   * blocks the model has never actually seen — a stub pointing at a
   * history copy that doesn't exist. Over-invalidation (dropping
   * entries from earlier successful turns too) is safe: it costs one
   * re-injection, never correctness.
   */
  invalidateScope(chatId: string, threadId: string | undefined): void {
    this.scopes.delete(this.scopeKeyOf(chatId, threadId));
  }

  /**
   * Decide inject/suppress for each block, updating dedup state.
   * Order of `blocks` is preserved in the returned decisions.
   *
   * Scope = (chatId, threadId). Dedup is deliberately NOT cross-thread
   * even though all threads share one main-loop session: per-thread
   * scoping matches the follow-up definition in #189 and keeps the
   * "what did the model already see in THIS conversation" reasoning
   * local. Cross-thread duplicates re-inject — conservative, correct.
   */
  filter(chatId: string, threadId: string | undefined, blocks: DedupBlock[]): DedupDecision[] {
    if (!this.enabled || blocks.length === 0) {
      return blocks.map(block => ({ block, inject: true }));
    }

    const scopeKey = this.scopeKeyOf(chatId, threadId);
    const now = this.now();

    let scope = this.scopes.get(scopeKey);
    if (!scope) {
      // LRU-evict the oldest scope when at capacity (insertion order).
      if (this.scopes.size >= this.maxScopes) {
        const oldest = this.scopes.keys().next().value;
        if (oldest !== undefined) this.scopes.delete(oldest);
      }
      scope = new Map<string, Entry>();
      this.scopes.set(scopeKey, scope);
    } else {
      // Refresh this scope's LRU position.
      this.scopes.delete(scopeKey);
      this.scopes.set(scopeKey, scope);
      // Lazy prune: drop entries whose injection is older than the
      // window — they would re-inject anyway, no point keeping them.
      for (const [k, e] of scope) {
        if (now - e.at >= this.windowMs) scope.delete(k);
      }
    }

    const decisions: DedupDecision[] = [];
    for (const block of blocks) {
      // 128-bit truncation: collision-resistance headroom against an
      // adversarially-crafted second preimage (block bodies are
      // user-derived content). 64 bits would already require ~2^64
      // work for a targeted match, but the extra 16 bytes per entry
      // are free at this cache's scale.
      const hash = createHash('sha256').update(block.body).digest('hex').slice(0, 32);
      const prev = scope.get(block.dedupKey);

      if (prev !== undefined && prev.hash === hash && now - prev.at < this.windowMs) {
        decisions.push({ block, inject: false });
        // Do NOT refresh `at` — absolute TTL (see module doc). DO
        // refresh the entry's insertion position (round-2 review
        // finding 2): without this, the profile entry — pushed first
        // every turn, suppressed for the whole window — stays the
        // insertion-oldest while episode/skill keys churn in behind
        // it, so the inner-cap backstop would evict the highest-value
        // entry first. Position refresh and TTL are orthogonal.
        scope.delete(block.dedupKey);
        scope.set(block.dedupKey, prev);
        continue;
      }

      // Inject path: record the injection. Backstop the inner cap by
      // evicting the oldest entry (insertion order) when full.
      if (scope.size >= this.maxKeysPerScope && !scope.has(block.dedupKey)) {
        const oldest = scope.keys().next().value;
        if (oldest !== undefined) scope.delete(oldest);
      }
      scope.set(block.dedupKey, { hash, at: now });
      decisions.push({ block, inject: true });
    }
    return decisions;
  }
}

/**
 * Render dedup decisions into envelope-wrapped parts (#189).
 *
 * Pure assembly — every emitted part, including stubs, goes through
 * `wrapEnrichmentSection` so the #114 trust-boundary envelope and body
 * escaping apply uniformly (issue #189 open question 5: no exceptions
 * on the suppressed path).
 *
 * Returns the parts in the original block order plus byte-accounting
 * stats for the measurement debug log.
 */
export function renderEnrichmentParts(decisions: DedupDecision[]): {
  parts: string[];
  stats: RenderStats;
} {
  const parts: string[] = [];
  const stats: RenderStats = {
    injectedCount: 0,
    injectedBytes: 0,
    suppressedCount: 0,
    suppressedBytes: 0,
    stubCount: 0,
    stubBytes: 0,
  };

  for (const { block, inject } of decisions) {
    if (inject) {
      parts.push(wrapEnrichmentSection(block.kind, block.label, block.body));
      stats.injectedCount++;
      stats.injectedBytes += Buffer.byteLength(block.body, 'utf-8');
      continue;
    }

    stats.suppressedCount++;
    stats.suppressedBytes += Buffer.byteLength(block.body, 'utf-8');

    if (block.stubOnSuppress) {
      const stubLabel = block.label ? `${block.label} · ${UNCHANGED_LABEL_TAG}` : UNCHANGED_LABEL_TAG;
      const stub = wrapEnrichmentSection(block.kind, stubLabel, UNCHANGED_STUB_BODY);
      parts.push(stub);
      stats.stubCount++;
      stats.stubBytes += Buffer.byteLength(stub, 'utf-8');
    }
  }

  return { parts, stats };
}
