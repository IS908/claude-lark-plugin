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
    // R2-followup: nullish-coalescing accepts 0 (false-ish but not
    // null), which would make `length >= 0` true on the very first
    // push — force-flush on every record. The env path is guarded by
    // `optionalPositiveNumber` (#109 hardening), but the constructor
    // override path bypassed that. Reject non-positive override here
    // and snap back to the env-default with the same shape.
    const override = opts?.maxMessages;
    if (override != null && override <= 0) {
      throw new Error(`ConversationBuffer: maxMessages must be > 0, got ${override}`);
    }
    this.maxMessages = override ?? appConfig.bufferMaxMessages;
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

  /**
   * Replace the most-recent assistant entry's text in the given chat's
   * buffer (#111). Walks backwards from the end of the buffer.
   *
   * Use case: `edit_message` tool — when Claude patches a previously
   * sent bot message, the buffer's stored assistant text becomes
   * stale; this keeps distillation aligned with what the user
   * actually saw.
   *
   * Returns true iff an assistant entry was found and updated. Returns
   * false for:
   *  - chat has no buffer (nothing was ever recorded)
   *  - buffer exists but has no assistant entries (only user messages)
   *  - the buffer is mid-flush (skipped — the distillation snapshot was
   *    already taken via `[...messages]` before the await; mutating
   *    afterwards would land in a buffer that's about to be wiped by
   *    `triggerFlush`'s cleanup, so the edit would be silently lost)
   *
   * NOTE: this is the simplest possible fix shape — only catches the
   * most-recent assistant entry. If Claude edits a much-earlier
   * message (e.g. patching a card from 50 turns ago), this won't
   * find it. The common case (correct-the-mistake-Claude-just-made)
   * is covered; precise per-message-id tracking is filed as a future
   * improvement if needed.
   */
  replaceLastAssistant(chatId: string, newText: string): boolean {
    if (this.flushing.has(chatId)) return false;
    const arr = this.buffers.get(chatId);
    if (!arr) return false;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].role === 'assistant') {
        arr[i] = {
          ...arr[i],
          text: newText,
          timestamp: new Date().toISOString(),
        };
        return true;
      }
    }
    return false;
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
