/**
 * Per-thread sequential message queue.
 * Messages in the same (chatId, threadId) pair are processed sequentially.
 * Messages in different chats or different threads in the same chat are
 * processed in parallel — this lets independent thread conversations proceed
 * without blocking each other.
 */
export class MessageQueue {
  private chains = new Map<string, Promise<void>>();

  private key(chatId: string, threadId?: string): string {
    // Use || instead of ?? so empty strings also fall back to '_'
    return `${chatId}::${threadId || '_'}`;
  }

  /**
   * Number of conversation chains currently in flight. Resolved chains
   * self-delete in enqueue's finally. NOTE: a chain resolves when its
   * handler returns — for inbound messages that is when the channel
   * NOTIFICATION is dispatched, not when Claude's turn finishes. The
   * #190 "quiet" gate treats this as a best-effort signal, not an
   * in-flight-turn invariant.
   */
  get pending(): number {
    return this.chains.size;
  }

  enqueue(
    chatId: string,
    threadId: string | undefined,
    handler: () => Promise<void>
  ): void {
    const k = this.key(chatId, threadId);
    const prev = this.chains.get(k) ?? Promise.resolve();
    const next = prev
      .then(handler)
      .catch((err) => {
        console.error(`[queue] Error processing message in ${k}:`, err);
      })
      .finally(() => {
        // Clean up resolved chains to prevent unbounded Map growth
        if (this.chains.get(k) === next) {
          this.chains.delete(k);
        }
      });
    this.chains.set(k, next);
  }
}
