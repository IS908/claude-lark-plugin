import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from '../config.js';

export interface BufferedMessage {
  role: 'user' | 'assistant';
  senderId: string;
  text: string;
  timestamp: string;
}

type FlushHandler = (chatId: string, messages: BufferedMessage[]) => Promise<void>;

/**
 * Per-chat conversation buffer (Layer 1 — short-term/working memory).
 * Tracks raw messages and manages auto-flush timers.
 */
export class ConversationBuffer {
  private buffers = new Map<string, BufferedMessage[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  private flushing = new Set<string>(); // guard against re-entry during flush
  private flushHandler: FlushHandler | null = null;
  /**
   * Hard cap on per-chat buffer entries (#110). Pre-fix only the
   * inactivity timer bounded the buffer; cron output (or any high-
   * cadence writer) could keep resetting the timer indefinitely and
   * grow the buffer unbounded. Cap defaults to `appConfig.bufferMaxMessages`;
   * constructor override exists for tests (ESM hoisting prevents the
   * smoke test from changing the env-derived default at script start).
   */
  private readonly maxMessages: number;

  constructor(opts?: { maxMessages?: number }) {
    this.maxMessages = opts?.maxMessages ?? appConfig.bufferMaxMessages;
  }

  setFlushHandler(handler: FlushHandler): void {
    this.flushHandler = handler;
  }

  record(chatId: string, message: BufferedMessage): void {
    // Don't record or reset timer during an active flush (prevents re-entry loops)
    if (this.flushing.has(chatId)) return;

    if (!this.buffers.has(chatId)) {
      this.buffers.set(chatId, []);
    }
    this.buffers.get(chatId)!.push(message);
    this.resetTimer(chatId);

    // #110 fix: hard-cap backstop. The inactivity-timer-based flush
    // is the primary trigger, but anything that keeps resetting the
    // timer (e.g. a regression that re-introduces cron-into-buffer
    // bleed, or a chat with sub-inactivity-window cadence) would
    // otherwise let the buffer grow unbounded. Once we hit the cap,
    // force-flush even if the timer hasn't expired. Best-effort —
    // triggerFlush is async + idempotent against `this.flushing`
    // guard, so calling it here doesn't double-fire.
    const buf = this.buffers.get(chatId)!;
    if (buf.length >= this.maxMessages) {
      // Fire-and-forget — record() is sync (downstream callers don't
      // await it). The flush sets `this.flushing` synchronously
      // inside triggerFlush before the first await, so concurrent
      // record() calls during the flush will short-circuit at the
      // `flushing.has` check at the top of this method.
      void this.triggerFlush(chatId);
    }
  }

  getMessages(chatId: string): BufferedMessage[] {
    return this.buffers.get(chatId) ?? [];
  }

  clear(chatId: string): void {
    this.buffers.delete(chatId);
    this.clearTimer(chatId);
  }

  /**
   * Re-arm flush timers on startup by scanning persisted episode directories.
   * If a chat's most recent episode is older than LARK_INACTIVITY_HOURS, trigger flush.
   */
  async rearmFromDisk(): Promise<void> {
    const episodesDir = path.join(appConfig.memoriesDir, 'episodes');
    try {
      const chatDirs = await fs.readdir(episodesDir);
      const thresholdMs = appConfig.inactivityHours * 60 * 60 * 1000;
      const now = Date.now();

      for (const chatId of chatDirs) {
        const chatDir = path.join(episodesDir, chatId);
        const stat = await fs.stat(chatDir);
        if (!stat.isDirectory()) continue;

        // Check the most recent episode file
        const files = await fs.readdir(chatDir);
        const mdFiles = files.filter(f => f.endsWith('.md'));
        if (mdFiles.length === 0) continue;

        // Find latest mtime
        let latestMs = 0;
        for (const f of mdFiles) {
          const fStat = await fs.stat(path.join(chatDir, f));
          if (fStat.mtimeMs > latestMs) latestMs = fStat.mtimeMs;
        }

        // If last episode is older than threshold, the chat was active before restart
        // and may have unflushed context — arm a timer
        if (now - latestMs < thresholdMs * 2) {
          // Chat was recently active; set a timer in case new messages arrive
          this.resetTimer(chatId);
          console.error(`[buffer] Re-armed flush timer for chat ${chatId}`);
        }
      }
    } catch {
      // episodes dir may not exist yet — that's fine
    }
  }

  private resetTimer(chatId: string): void {
    this.clearTimer(chatId);

    const timeoutMs = appConfig.inactivityHours * 60 * 60 * 1000;
    const timer = setTimeout(async () => {
      await this.triggerFlush(chatId);
    }, timeoutMs);

    // Don't hold the process open for flush timers
    timer.unref();
    this.timers.set(chatId, timer);
  }

  private clearTimer(chatId: string): void {
    const existing = this.timers.get(chatId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(chatId);
    }
  }

  private async triggerFlush(chatId: string): Promise<void> {
    const messages = this.buffers.get(chatId);
    if (!messages || messages.length === 0) return;
    if (this.flushing.has(chatId)) return; // already flushing

    console.error(`[buffer] Auto-flush triggered for chat ${chatId} (${messages.length} messages)`);

    this.flushing.add(chatId);
    try {
      if (this.flushHandler) {
        await this.flushHandler(chatId, [...messages]);
      }
    } catch (err) {
      console.error(`[buffer] Flush failed for chat ${chatId}:`, err);
    } finally {
      this.flushing.delete(chatId);
    }

    this.buffers.delete(chatId);
    this.timers.delete(chatId);
  }
}
