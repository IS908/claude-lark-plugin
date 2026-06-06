/**
 * In-memory mapping from (chat_id, thread_id?) to the Feishu open_id of the
 * current caller. Populated by channel.ts on inbound messages and by
 * scheduler.ts when a cronjob fires. Consumed by sensitive MCP tools so they
 * never need to trust Claude-declared identity arguments.
 *
 * Intentionally not persisted — the next inbound message or cronjob tick will
 * re-populate relevant entries, so crash/restart is safe.
 *
 * Terminal invocations (e.g. /lark:jobs) pass the reserved chat_id
 * `__terminal__` which resolves through the owner fallback.
 *
 * SECURITY NOTE: the __terminal__ sentinel is a trust-but-verify fallback.
 * A socially-engineered prompt could theoretically instruct Claude to pass
 * __terminal__ from a Feishu-triggered turn, escalating to operator
 * privileges. Defense in depth:
 *   1. MCP server instructions (index.ts) tell Claude to use the chat_id
 *      from notification metadata verbatim and never substitute sentinels.
 *   2. Phase 3 adds audit logging so any such attempt leaves a trail.
 *   3. Future work may add server-side heuristic (reject __terminal__ when
 *      there is a fresh real-chat session entry within the last N seconds).
 * The sentinel is not exposed in any notification metadata, so Claude would
 * need to invent the string on its own — practical risk is low.
 */

export const TERMINAL_CHAT_ID = '__terminal__';

/**
 * Sentinel caller for buffer auto-flush turns (#66). The flush is a
 * system-initiated, chat-level distillation — no user triggered it. We
 * bind this synthetic caller before the flush notification so the
 * server-side `resolveCaller` gate passes and `save_memory(type=chat|thread)`
 * can persist.
 *
 * NOT a valid profile owner — `save_memory(type=profile)` rejects this
 * sentinel server-side (system has no user identity to attribute private
 * data to). The flush prompt also instructs Claude not to attempt profile
 * writes during flush turns; this constant is the second line of defense.
 *
 * `resolveCaller` in tools.ts further restricts the sentinel to only
 * `save_memory` — any other sensitive tool (`create_job`, `forget_memory`,
 * etc.) is denied to prevent sentinel-attributed records that no real
 * user could later address.
 *
 * Audit log entries for system-flush writes carry caller=`__system_flush__`,
 * making the data lineage greppable.
 *
 * Operator constraint: `LARK_OWNER_OPEN_ID` MUST NOT equal this value.
 * If it did, terminal invocations would resolve through `ownerFallback()`
 * to the sentinel and inherit the sentinel's restrictive guard — the
 * operator would be locked out of every sensitive tool except save_memory.
 * Realistic risk near zero (Feishu open_ids are `ou_*`), but documented
 * for completeness.
 */
export const SYSTEM_FLUSH_CALLER = '__system_flush__';

/**
 * Synthetic chat_id prefix used to route doc-comment events through the
 * IdentitySession. The format is `doc:<file_token>`.
 *
 * IMPORTANT: this is a naming convention only — there is NO short-circuit
 * in `getCaller` that maps `doc:` prefix to a specific identity. The caller
 * is bound at event-time by `setCaller("doc:<file_token>", comment_id,
 * from_user_id.open_id)` in `handleCommentEvent` — keyed per-comment to
 * avoid cross-event session races on the same doc (PR #182 round 4 I1,
 * commit `b87657c`). Resolved through the normal session-map lookup.
 * Tools that require owner identity (e.g. `reply_doc_comment`) check the
 * resolved caller against `getOwner()` explicitly.
 *
 * An earlier version of this PR had a `chatId.startsWith(DOC_CHAT_ID_PREFIX)
 * → ownerFallback()` shortcut. That shortcut bypassed the server-derived
 * identity model and was removed — see PR #182 review.
 */
export const DOC_CHAT_ID_PREFIX = 'doc:';

interface SessionEntry {
  userId: string;
  updatedAt: number;
}

export class IdentitySession {
  private map = new Map<string, SessionEntry>();

  constructor(
    private readonly ownerFallback: () => string | null,
    private readonly maxAgeMs: number = 3600_000,
  ) {}

  private key(chatId: string, threadId?: string): string {
    return threadId ? `${chatId}#${threadId}` : chatId;
  }

  setCaller(chatId: string, threadId: string | undefined, userId: string): void {
    this.map.set(this.key(chatId, threadId), { userId, updatedAt: Date.now() });
  }

  /**
   * Returns the current caller for the given chat/thread, or null if none.
   * Prefers the thread-specific entry; falls back to chat-level.
   * Special-cases the terminal sentinel to the owner fallback.
   */
  getCaller(chatId: string, threadId?: string): string | null {
    if (chatId === TERMINAL_CHAT_ID) {
      return this.ownerFallback();
    }
    if (threadId) {
      const entry = this.map.get(this.key(chatId, threadId));
      if (entry && !this.isStale(entry)) return entry.userId;
    }
    const chatEntry = this.map.get(this.key(chatId));
    if (chatEntry && !this.isStale(chatEntry)) return chatEntry.userId;
    return null;
  }

  /**
   * Return the configured operator OWNER (`LARK_OWNER_OPEN_ID`), or null.
   *
   * Consumers (e.g. save_skill — #84) use this when they need the OWNER
   * identity independent of the per-message caller — for instance, to
   * include in an error hint about restarting for legacy-skill migration.
   * Does NOT consult the session map; this is the static fallback, not
   * the current caller.
   */
  getOwner(): string | null {
    return this.ownerFallback();
  }

  /** Drop entries older than maxAgeMs. Safe to call periodically. */
  cleanup(): void {
    for (const [k, v] of this.map.entries()) {
      if (this.isStale(v)) this.map.delete(k);
    }
  }

  private isStale(entry: SessionEntry): boolean {
    return Date.now() - entry.updatedAt > this.maxAgeMs;
  }

  /** Test-only helper. */
  _size(): number {
    return this.map.size;
  }
}
