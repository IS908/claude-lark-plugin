/**
 * Per-chat sequential message queue.
 * Messages in the same chat are processed sequentially.
 * Messages in different chats are processed in parallel.
 */
export class MessageQueue {
  private chains = new Map<string, Promise<void>>();

  enqueue(chatId: string, handler: () => Promise<void>): void {
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const next = prev
      .then(handler)
      .catch((err) => {
        console.error(`[queue] Error processing message in chat ${chatId}:`, err);
      })
      .finally(() => {
        // Clean up resolved chains to prevent unbounded Map growth
        if (this.chains.get(chatId) === next) {
          this.chains.delete(chatId);
        }
      });
    this.chains.set(chatId, next);
  }
}
