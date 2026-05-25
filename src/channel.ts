import * as Lark from '@larksuiteoapi/node-sdk';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appConfig } from './config.js';
import { enrichmentPrompt, wrapEnrichmentSection } from './prompts.js';
import { MessageQueue } from './queue.js';
import { LARK_ID_REGEX } from './tools.js';
import type { MemoryStore } from './memory/file.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { IdentitySession } from './identity-session.js';
import { TERMINAL_CHAT_ID } from './identity-session.js';
import { writeSdkResource } from './sdk-resource.js';

const DEBUG_LOG = path.join(os.homedir(), '.claude', 'channels', 'lark', 'debug.log');

/**
 * Ack-reaction TTL (#85): an ack older than this is considered orphaned
 * and gets force-revoked by `pruneStaleAcks`. 5 minutes is long enough
 * to span a slow reply (the longest Claude turn we'd expect under
 * normal load) and short enough that an orphaned ack doesn't stay on
 * the user's message for an annoying duration.
 */
export const ACK_TTL_MS = 5 * 60 * 1000;

/**
 * How often `pruneStaleAcks` runs. 60s is the same cadence as the
 * scheduler tick; faster doesn't help (an orphan only matters once it
 * exceeds ACK_TTL_MS) and would just spend CPU iterating the Map.
 */
export const ACK_PRUNE_INTERVAL_MS = 60_000;

/**
 * Minimal client surface needed by {@link pruneStaleAcksImpl}. Decoupling
 * via this interface (rather than depending on the full Lark.Client type)
 * lets the smoke test pass a mock without constructing a real SDK client
 * (which would need LARK_APP_ID / LARK_APP_SECRET env).
 */
export interface AckRevokeClient {
  im: { v1: { messageReaction: { delete: (args: any) => Promise<any> } } };
}

/**
 * Pure-function implementation of the ack TTL prune (#85). Iterates the
 * Map and, for each entry older than `maxAgeMs`, removes it AND fires a
 * best-effort `messageReaction.delete` so the orphaned emoji is also
 * cleaned up on Feishu's side. Returns the number of entries pruned.
 *
 * Race-safety: a concurrent normal-path revoke for the same entry is
 * benign — both deletes target the same reaction_id; Feishu returns 404
 * on the second one and `.catch` swallows it. The Map.delete inside a
 * for...entries() iteration is safe per spec — the deleted entry is
 * either visited or skipped depending on iteration position, never
 * causes the iterator to throw.
 */
export function pruneStaleAcksImpl(
  ackReactions: Map<string, { reactionId: string; addedAt: number }>,
  client: AckRevokeClient,
  now: number,
  maxAgeMs: number,
): number {
  let pruned = 0;
  for (const [messageId, entry] of ackReactions.entries()) {
    if (now - entry.addedAt > maxAgeMs) {
      ackReactions.delete(messageId);
      client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: entry.reactionId },
      }).catch(() => {});
      pruned++;
    }
  }
  return pruned;
}
function debugLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(DEBUG_LOG, line); } catch {}
  console.error(msg);
}

/**
 * Build a Lark SDK logger that routes every level to stderr. The SDK's default
 * logger writes to stdout via `console.log`, which would corrupt MCP JSON-RPC
 * framing on the stdio transport. Every `new Lark.<Client|EventDispatcher|WSClient>(...)`
 * MUST be constructed with this logger — enforced statically by
 * `scripts/check-sdk-loggers.ts`.
 *
 * Levels implemented: info / warn / error / debug / trace — the canonical
 * Lark SDK set. If a future SDK version introduces a new level (e.g.
 * verbose, fatal), this factory will need to be extended; otherwise the
 * SDK would throw a TypeError on the missing method.
 */
function makeSdkLogger(prefix: string) {
  return {
    info: (...args: any[]) => console.error(`[${prefix}]`, ...args),
    warn: (...args: any[]) => console.error(`[${prefix}][warn]`, ...args),
    error: (...args: any[]) => console.error(`[${prefix}][error]`, ...args),
    debug: (...args: any[]) => console.error(`[${prefix}][debug]`, ...args),
    trace: (...args: any[]) => console.error(`[${prefix}][trace]`, ...args),
  };
}

/**
 * Whitelist check with OR semantics:
 * - Neither list configured → allow all
 * - Only user list → gate on user only
 * - Only chat list → gate on chat only
 * - Both lists → allow when user OR chat matches (either list whitelists the message)
 */
export function passesWhitelist(senderId: string, chatId: string): boolean {
  const userConfigured = appConfig.allowedUserIds.length > 0;
  const chatConfigured = appConfig.allowedChatIds.length > 0;
  if (!userConfigured && !chatConfigured) return true;
  const userOk = userConfigured && appConfig.allowedUserIds.includes(senderId);
  const chatOk = chatConfigured && appConfig.allowedChatIds.includes(chatId);
  return userOk || chatOk;
}

export interface LarkMessage {
  messageId: string;
  chatId: string;
  chatType: string; // 'p2p' | 'group'
  senderId: string;
  senderName?: string;
  chatName?: string;
  text: string;
  messageType: string;
  parentId?: string;
  parentContent?: string;
  threadId?: string;
  mentions?: Array<{ id: string; name: string }>;
  /** True when this bot's open_id appears in mentions. Forwarded to Claude as meta.bot_mentioned. */
  botMentioned?: boolean;
  attachments?: Array<{ fileKey: string; fileName: string; fileType: string }>;
  rawContent: string;
  imagePath?: string;
  imagePaths?: string[];
}

/**
 * Resolve Feishu's @_user_N placeholders in a text body to `@<name>` using
 * the mentions array. mentions[N-1] corresponds to @_user_N (1-indexed).
 *
 * If the mention has no name (user privacy settings, masked) the placeholder
 * is kept verbatim — a synthetic alias would be misleading.
 * Out-of-range indices (defensive) are also kept verbatim.
 *
 * Does NOT touch @_all or any other Feishu-specific placeholder; only matches
 * /@_user_(\d+)/.
 */
export function resolveMentionPlaceholders(
  text: string,
  mentions: Array<{ id: string; name: string }> | undefined,
): string {
  if (!text || !mentions || mentions.length === 0) return text;
  return text.replace(/@_user_(\d+)/g, (match, n) => {
    const idx = Number(n) - 1;
    const m = mentions[idx];
    if (!m || !m.name) return match;
    return `@${m.name}`;
  });
}

type MessageHandler = (message: LarkMessage) => Promise<void>;

/**
 * Per-message metadata kept alongside the tracked id (#80).
 *
 * Reaction events from Feishu carry `message_id` but NOT `chat_id` (see
 * `handleReactionEvent`). Pre-v1.0.32 the tracker only stored ids in a
 * Set, so `handleReactionEvent` had to call `passesWhitelist(operatorId, '')`
 * and built `larkMessage.chatId = ''`. That:
 *   1. broke any whitelist config that set only `LARK_ALLOWED_CHAT_IDS`
 *      (the chat-id check was `chatConfigured && [...].includes('')` → false)
 *   2. left identity unbound — sensitive MCP tools called from the
 *      reaction's Claude turn would `resolveCaller('','')` → null → fail
 *
 * Storing `{chatId, threadId}` keyed by message_id lets the reaction
 * handler reconstitute both fields when an emoji lands on a previously-
 * sent bot message.
 */
export interface BotMessageMeta {
  chatId: string;
  threadId?: string;
}

export class BotMessageTracker {
  private ids: string[] = [];
  private meta = new Map<string, BotMessageMeta>();
  private readonly maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  /**
   * Track a bot-sent message id and the chat it landed in. `chatId` is
   * required (#80): the reaction handler needs it to whitelist-check and
   * bind identity. Callers that don't have a chatId (cronjob and
   * edit_message historically) should be migrated to pass one — tracked
   * separately as #81.
   *
   * First-add-wins semantic on duplicate `messageId` — matches the
   * pre-#80 `Set.has()` semantic. Feishu message_ids are globally
   * unique per the SDK contract, so the first chatId IS the only true
   * chatId; a duplicate `add` with a different chatId would indicate a
   * caller bug rather than a legitimate update, and silently ignoring
   * it is safer than letting bad state replace good.
   */
  add(messageId: string, chatId: string, threadId?: string): void {
    if (this.meta.has(messageId)) return;
    this.meta.set(messageId, { chatId, threadId });
    this.ids.push(messageId);
    while (this.ids.length > this.maxSize) {
      const oldest = this.ids.shift()!;
      this.meta.delete(oldest);
    }
  }

  has(messageId: string): boolean {
    return this.meta.has(messageId);
  }

  /**
   * Look up the chat / thread the tracked message was sent into.
   * Returns undefined for unknown / evicted ids. (#80)
   */
  get(messageId: string): BotMessageMeta | undefined {
    return this.meta.get(messageId);
  }
}

/**
 * Records the latest inbound user message per (chatId, threadId) pair.
 * Used by the reply tool to auto-correct reply_to when Claude omits it in
 * concurrent thread scenarios.
 */
export interface TrackedMessage {
  messageId: string;
  threadId?: string;
  timestamp: number;
}

export class LatestMessageTracker {
  private map = new Map<string, TrackedMessage>();
  private readonly ttlMs: number;

  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  private key(chatId: string, threadId?: string): string {
    // Use || instead of ?? so empty strings also fall back to '_'
    return `${chatId}::${threadId || '_'}`;
  }

  record(chatId: string, msg: TrackedMessage): void {
    this.map.set(this.key(chatId, msg.threadId), msg);
  }

  getLatest(chatId: string, threadId?: string): TrackedMessage | undefined {
    const m = this.map.get(this.key(chatId, threadId));
    if (!m) return undefined;
    if (Date.now() - m.timestamp > this.ttlMs) {
      this.map.delete(this.key(chatId, threadId));
      return undefined;
    }
    return m;
  }
}

/**
 * Pure decision: should this group-chat message be processed by the
 * bot? (#86, #55 fix — fail-safe default when botOpenId is unknown.)
 *
 * Returns true iff the message has at least one mention AND we know
 * the bot's open_id AND the bot is among the mentions. Returns false
 * (rejects) when botOpenId is empty — better silent during startup
 * race than spammy unsolicited replies in every group.
 *
 * Exported for testing.
 */
export function shouldAcceptGroupMention(
  mentions: Array<{ id?: { open_id?: string; union_id?: string } }> | null | undefined,
  botOpenId: string,
): boolean {
  if (!mentions || mentions.length === 0) return false;
  if (!botOpenId) return false; // fail-safe: don't process when bot id is unknown
  return mentions.some((m) => (m.id?.open_id ?? m.id?.union_id) === botOpenId);
}

/**
 * Pure decision: is the bot among the parsed mentions? Forwarded to
 * Claude as `meta.bot_mentioned`. Fail-safe default when botOpenId is
 * unknown (#86 — pre-fix returned `parsedMentions.length > 0` which
 * biased Claude toward replying to any group mention even when the bot
 * wasn't actually addressed).
 *
 * Exported for testing.
 */
export function computeBotMentioned(
  parsedMentions: Array<{ id: string }>,
  botOpenId: string,
): boolean {
  if (!botOpenId) return false;
  return parsedMentions.some((m) => m.id === botOpenId);
}

export class LarkChannel {
  private client: Lark.Client;
  private nameCache = new Map<string, string>(); // open_id/chat_id → display name
  private chatTypeCache = new Map<string, 'p2p' | 'group'>(); // chatId → type (populated from inbound events)
  private botOpenId: string = '';
  private wsClient: Lark.WSClient | null = null;
  private queue = new MessageQueue();
  private messageHandler: MessageHandler | null = null;
  private memoryStore: MemoryStore | null = null;
  private conversationBuffer: ConversationBuffer | null = null;
  private identitySession: IdentitySession | null = null;
  /**
   * Tracks pending ack reactions (the MeMeMe emoji bot adds on receive to
   * signal "I'm processing this"). Keyed by inbound `message_id`; value
   * carries the Feishu `reaction_id` (needed for the revoke API) and the
   * insert timestamp (for the TTL backstop in `pruneStaleAcks`).
   *
   * Lifecycle:
   *  - `handleMessageEvent` adds an entry after the ack reaction lands.
   *  - `reply` tool revokes the entry in its `finally` block (#85 fix),
   *    so ack always clears whether the send succeeded or threw.
   *  - `pruneStaleAcks` (timer in `start()`) sweeps anything older than
   *    `ACK_TTL_MS` and best-effort revokes, so any escaped entry doesn't
   *    sit on the user's message forever or leak Map memory.
   */
  private ackReactions = new Map<string, { reactionId: string; addedAt: number }>();
  private ackPruneTimer: NodeJS.Timeout | null = null;
  /** Guards `start()` against double-invocation (R1-followup on #85). */
  private started = false;
  private botMessageTracker = new BotMessageTracker(appConfig.botMessageTrackerSize);
  private latestMessageTracker = new LatestMessageTracker();

  constructor() {
    this.client = new Lark.Client({
      appId: appConfig.appId,
      appSecret: appConfig.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
      logger: makeSdkLogger('lark-sdk'),
    });
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  setMemoryStore(store: MemoryStore): void {
    this.memoryStore = store;
  }

  setIdentitySession(session: IdentitySession): void {
    this.identitySession = session;
  }

  /**
   * Returns true if the given chat_id should be treated as a private
   * (caller-only visible) chat for rendering-visibility purposes.
   *
   * - Real p2p chats: inferred from inbound event chat_type, cached.
   * - Terminal sentinel: treated as private (the operator is the sole viewer).
   * - Unknown chat_ids: default to false (treat as group) to bias the filter
   *   toward less exposure when we have no signal.
   */
  isPrivateChat(chatId: string): boolean {
    if (chatId === TERMINAL_CHAT_ID) return true;
    return this.chatTypeCache.get(chatId) === 'p2p';
  }

  setConversationBuffer(buffer: ConversationBuffer): void {
    this.conversationBuffer = buffer;
  }

  getClient(): Lark.Client {
    return this.client;
  }

  getAckReactions(): Map<string, { reactionId: string; addedAt: number }> {
    return this.ackReactions;
  }

  getBotMessageTracker(): BotMessageTracker {
    return this.botMessageTracker;
  }

  getLatestMessageTracker(): LatestMessageTracker {
    return this.latestMessageTracker;
  }

  async start(): Promise<void> {
    // R1-followup on #85: guard against double-invocation. Pre-fix a
    // second start() call would arm a second ackPruneTimer and a second
    // wsClient — leaking timers AND opening duplicate WebSockets. No
    // current call site does this (main() calls start once), but the
    // guard is cheap and removes a future-regression footgun.
    if (this.started) {
      console.error('[channel] start() called twice; ignoring second call');
      return;
    }
    this.started = true;

    // Fetch bot's own open_id for filtering group @mentions
    await this.fetchBotOpenId();

    debugLog('[channel] Registering event dispatcher...');
    // EventDispatcher's default logger writes to stdout, which would corrupt
    // MCP JSON-RPC framing the moment it logs "event-dispatch is ready".
    // Redirect to stderr like Client and WSClient.
    const eventDispatcher = new Lark.EventDispatcher({
      loggerLevel: Lark.LoggerLevel.info,
      logger: makeSdkLogger('lark-events'),
    }).register({
      'im.message.receive_v1': async (data: any) => {
        debugLog(`[channel] Event received: im.message.receive_v1`);
        try {
          await this.handleMessageEvent(data);
        } catch (err) {
          console.error('[channel] Error handling message event:', err);
        }
      },
    }).register({
      'im.message.reaction.created_v1': async (data: any) => {
        debugLog(`[channel] Event received: im.message.reaction.created_v1`);
        try {
          await this.handleReactionEvent(data);
        } catch (err) {
          console.error('[channel] Error handling reaction event:', err);
        }
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: appConfig.appId,
      appSecret: appConfig.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      logger: makeSdkLogger('lark-ws'),
    });

    this.wsClient.start({ eventDispatcher });
    debugLog('[channel] lark channel: connected to Feishu via WebSocket');

    // #85 fix: TTL backstop for ackReactions. The normal lifecycle revokes
    // acks in `reply`'s finally block (handles partial-send failures), but
    // events outside that path can still leave an entry orphaned: the bot
    // received a message but Claude never called `reply` for that exact
    // message_id (e.g. cron-only turn that doesn't reply, hook block,
    // model abandoned the turn, etc.). Without this prune, those entries
    // sit on the user's message visually forever AND leak Map memory in
    // a long-running daemon. ACK_PRUNE_INTERVAL_MS controls how often
    // we scan; ACK_TTL_MS is the staleness threshold.
    // R2-audit followup: wrap the setInterval callback in try/catch.
    // pruneStaleAcksImpl can't realistically throw today (Map.delete
    // during entries() iteration is spec-safe, NaN arithmetic falls
    // through), but a synchronous throw inside the callback would
    // propagate to uncaughtException → process.exit(1) per
    // src/index.ts. Defense in depth against a future regression.
    this.ackPruneTimer = setInterval(() => {
      try {
        this.pruneStaleAcks(ACK_TTL_MS);
      } catch (err) {
        console.error('[channel] pruneStaleAcks threw (swallowed to keep timer alive):', err);
      }
    }, ACK_PRUNE_INTERVAL_MS);
    // .unref() so the timer never holds the process open by itself; if
    // everything else stops, Node can exit even with the timer pending.
    this.ackPruneTimer.unref?.();
  }

  /**
   * Partial shutdown hook (R1-followup on #85; scope clarified per
   * R2-audit). Clears the ackPrune timer and resets the `started` flag.
   *
   * Does NOT close `this.wsClient`. The Lark SDK's WSClient has no
   * documented synchronous close API, and process exit (the default
   * `main()` shutdown path) releases the socket. A future caller that
   * wants true re-init across stop()/start() will need to extend this
   * to wsClient teardown — current production has no such caller, so
   * this method exists only to release the ackPrune timer for tests.
   *
   * Idempotent — safe to call multiple times.
   *
   * NOTE: do not pair this with a subsequent `start()` in the same
   * process while the WSClient is still subscribed (you'll get
   * duplicate event handling). Filed as the unstated half of #136
   * if/when a real re-init use case emerges.
   */
  stop(): void {
    if (this.ackPruneTimer) {
      clearInterval(this.ackPruneTimer);
      this.ackPruneTimer = null;
    }
    this.started = false;
  }

  /**
   * Instance-method wrapper around {@link pruneStaleAcksImpl}. The pure
   * function lives at module scope so smoke tests can exercise it
   * without instantiating a full LarkChannel (which needs LARK_APP_ID /
   * LARK_APP_SECRET to construct the SDK client).
   */
  pruneStaleAcks(maxAgeMs: number): number {
    const pruned = pruneStaleAcksImpl(this.ackReactions, this.client, Date.now(), maxAgeMs);
    if (pruned > 0) {
      console.error(
        `[channel] pruneStaleAcks: revoked ${pruned} stale ack(s) older than ${maxAgeMs}ms`,
      );
    }
    return pruned;
  }

  private async handleMessageEvent(data: any): Promise<void> {
    const { message, sender } = data;
    const {
      message_id: messageId,
      chat_id: chatId,
      chat_type: chatType,
      content: rawContent,
      message_type: messageType,
      parent_id: parentId,
      root_id: threadId,
      mentions,
    } = message;

    const senderId = sender?.sender_id?.open_id ?? '';

    // Resolve sender display name (from event data or cache)
    const senderName = await this.resolveUserName(senderId, sender);

    // Whitelist filtering (OR semantics when both lists are set)
    if (!passesWhitelist(senderId, chatId)) {
      debugLog(`[channel] Message from ${senderId} in ${chatId} rejected by whitelist`);
      return;
    }

    // In group chats, only process messages that @mention the bot.
    // Pre-v1.0.25, missing botOpenId fell through and accepted ANY
    // group mention (#55 + #86). Now via the shared
    // shouldAcceptGroupMention helper: deny by default when bot's id
    // is unknown (startup race / fetch failure) — better silent than
    // spammy unsolicited replies in every group. The fetchBotOpenId
    // path is hardened with retries + background re-fetch so the
    // missing-id state is short-lived.
    if (chatType === 'group') {
      if (!shouldAcceptGroupMention(mentions, this.botOpenId)) {
        debugLog(
          `[channel] Ignoring group message: ` +
          (!mentions || mentions.length === 0
            ? 'no mentions'
            : !this.botOpenId
              ? 'botOpenId not yet known (startup race or fetch failure)'
              : 'bot not @mentioned'),
        );
        return;
      }
      debugLog(`[channel] Group message with @mention, processing`);
    }

    // Record latest inbound message for this (chat, thread) — used by reply tool
    // to auto-correct reply_to in concurrent thread scenarios.
    this.latestMessageTracker.record(chatId, {
      messageId,
      threadId,
      timestamp: Date.now(),
    });

    // Fire-and-forget ack reaction (Typing for P2P, MeMeMe for group @bot)
    const ackEmoji = chatType === 'p2p' ? 'Typing' : appConfig.ackEmoji;
    if (ackEmoji) {
      this.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: ackEmoji } },
      }).then((resp: any) => {
        const reactionId = resp?.data?.reaction_id;
        if (reactionId) {
          // addedAt timestamp powers the TTL backstop (#85): pruneStaleAcks
          // sweeps entries older than ACK_TTL_MS so anything that escaped
          // the normal revoke path doesn't sit on the user's message
          // forever or leak Map memory.
          this.ackReactions.set(messageId, { reactionId, addedAt: Date.now() });
        }
      }).catch(() => {});
    }

    // Parse mentions
    const parsedMentions: Array<{ id: string; name: string }> = (mentions ?? []).map(
      (m: any) => ({
        id: m.id?.open_id ?? m.id?.union_id ?? '',
        name: m.name ?? '',
      }),
    );

    // Detect whether this bot was among the mentioned users — forwarded
    // to Claude as meta.bot_mentioned. Same fail-safe default as the
    // group-filter above (#86 fix): when botOpenId is unknown, return
    // false rather than the pre-v1.0.25 "any mention counts" heuristic
    // that biased Claude toward replying.
    const botMentioned = computeBotMentioned(parsedMentions, this.botOpenId);

    // Parse message text, resolving @_user_N placeholders to @<name>
    const text = resolveMentionPlaceholders(
      this.extractText(rawContent, messageType),
      parsedMentions,
    );

    // Parse attachments
    const attachments = this.extractAttachments(message);

    // Auto-download images
    let imagePath: string | undefined;
    let imagePaths: string[] | undefined;

    if (messageType === 'image') {
      try {
        const parsed = JSON.parse(rawContent);
        const imageKey = parsed.image_key;
        // Validate imageKey shape before passing into path construction
        // (R2-audit followup on #108 — same class as #93). Feishu image
        // keys are `img_xxx` alphanumeric; reject anything that could
        // escape the inbox dir via path-join collapse.
        if (typeof imageKey === 'string' && LARK_ID_REGEX.test(imageKey)) {
          const downloaded = await this.downloadImage(imageKey, messageId);
          if (downloaded) imagePath = downloaded;
        } else if (imageKey) {
          debugLog(`[channel] Rejected malformed image_key=${String(imageKey).slice(0, 40)} for ${messageId}`);
        }
      } catch {
        debugLog(`[channel] Failed to parse image content for auto-download`);
      }
    } else if (messageType === 'post') {
      try {
        const parsed = JSON.parse(rawContent);
        const content = parsed.content ?? parsed.zh_cn?.content ?? parsed.en_us?.content ?? [];
        // Collect all img nodes first; run downloads concurrently with
        // allSettled so a single oversized / failed image (e.g. one of
        // three exceeds LARK_MAX_DOWNLOAD_BYTES) does NOT drop the
        // siblings (R2-audit followup #3 on #108). Also concurrent
        // download keeps the worst-case wait at ONE downloadTimeoutMs
        // rather than N × downloadTimeoutMs serial.
        const imageKeys: string[] = [];
        for (const line of content) {
          for (const node of line as any[]) {
            if (node.tag === 'img' && typeof node.image_key === 'string') {
              if (LARK_ID_REGEX.test(node.image_key)) {
                imageKeys.push(node.image_key);
              } else {
                debugLog(`[channel] Rejected malformed post image_key=${String(node.image_key).slice(0, 40)} for ${messageId}`);
              }
            }
          }
        }
        const settled = await Promise.allSettled(
          imageKeys.map((k) => this.downloadImage(k, messageId)),
        );
        const downloadedPaths: string[] = [];
        for (const r of settled) {
          if (r.status === 'fulfilled' && r.value) downloadedPaths.push(r.value);
          else if (r.status === 'rejected') {
            debugLog(`[channel] Post image download failed: ${r.reason}`);
          }
        }
        if (downloadedPaths.length === 1) {
          imagePath = downloadedPaths[0];
        } else if (downloadedPaths.length > 1) {
          imagePaths = downloadedPaths;
        }
      } catch {
        debugLog(`[channel] Failed to parse post content for image auto-download`);
      }
    }

    // Resolve chat name for group chats
    const chatName = chatType === 'group' ? await this.resolveChatName(chatId) : '';

    // Build message object
    const larkMessage: LarkMessage = {
      messageId,
      chatId,
      chatType,
      senderId,
      senderName: senderName || undefined,
      chatName: chatName || undefined,
      text,
      messageType,
      parentId,
      threadId,
      mentions: parsedMentions,
      botMentioned,
      attachments,
      rawContent,
      imagePath,
      imagePaths,
    };

    // Fetch parent message content if this is a quoted reply
    if (parentId) {
      try {
        const parentMsg = await this.client.im.v1.message.get({
          path: { message_id: parentId },
        });
        const parentItem = parentMsg?.data?.items?.[0];
        if (parentItem?.body?.content) {
          // Parent-message mentions may arrive either as the receive-event
          // shape (`id: { open_id, union_id, user_id }`) or, in some API
          // responses, as a flat string. Normalize both so name-based
          // resolution works and `id` never stringifies to "[object Object]".
          const parentMentions: Array<{ id: string; name: string }> = (
            parentItem.mentions ?? []
          ).map((m: any) => ({
            id:
              m.id?.open_id ??
              m.id?.union_id ??
              (typeof m.id === 'string' ? m.id : ''),
            name: m.name ?? '',
          }));
          larkMessage.parentContent = resolveMentionPlaceholders(
            this.extractText(parentItem.body.content, parentItem.msg_type ?? 'text'),
            parentMentions,
          );
        }
      } catch {
        // Parent message fetch failed; continue without it
      }
    }

    // Cache chat type for later lookups (e.g. list_jobs visibility filter).
    if (chatType === 'p2p' || chatType === 'group') {
      this.chatTypeCache.set(chatId, chatType);
    }

    // Enqueue for sequential per-chat processing
    this.queue.enqueue(chatId, threadId, async () => {
      // Bind identity for this chat/thread so MCP tools can resolve the
      // true caller without trusting Claude-declared identity arguments.
      this.identitySession?.setCaller(chatId, threadId, senderId);

      // Record in conversation buffer
      this.conversationBuffer?.record(chatId, {
        role: 'user',
        senderId,
        text: larkMessage.text,
        timestamp: new Date().toISOString(),
      });

      // Build memory-enriched context
      const enrichedText = await this.enrichWithMemory(larkMessage);

      // Forward to handler with enriched context
      const enrichedMessage = { ...larkMessage, text: enrichedText };

      if (this.messageHandler) {
        await this.messageHandler(enrichedMessage);
      }
    });
  }

  private async enrichWithMemory(msg: LarkMessage): Promise<string> {
    if (!this.memoryStore) return msg.text;

    const parts: string[] = [];

    // Build search query — enhance short messages with recent buffer context
    let searchQuery = msg.text;
    if (msg.text.length < 15 && this.conversationBuffer) {
      const recent = this.conversationBuffer.getMessages(msg.chatId).slice(-3);
      const context = recent.map(m => m.text).join(' ');
      if (context.length > 0) {
        searchQuery = `${context} ${msg.text}`;
      }
    }

    // Every enrichment section below is wrapped in a <memory_context>
    // envelope (#114). The envelope marks the content as DATA so Claude
    // does not execute imperatives buried inside stored profiles /
    // episodes / skill descriptions / mentioned-user profiles — those
    // are all derived from user input and the episode path is in a
    // self-reinforcing loop (user msg → distill → episode → enrichment
    // → Claude). The preamble at the top of `enrichmentPrompt` tells
    // Claude how to read these blocks.

    // 1. User profile (hot injection — always loaded)
    // The caller is the sender themselves, so they see both public and private tiers.
    const profile = await this.memoryStore
      .getProfile(msg.senderId, msg.senderId)
      .catch(() => null);
    if (profile) {
      parts.push(wrapEnrichmentSection('profile', `self:${msg.senderId}`, profile));
    }

    // 2. Mentioned user profiles (hot injection)
    // Caller is the sender, not the mentioned user, so only the public tier is loaded.
    if (msg.mentions?.length) {
      for (const mention of msg.mentions) {
        if (mention.id && mention.id !== msg.senderId) {
          const mentionProfile = await this.memoryStore
            .getProfile(mention.id, msg.senderId)
            .catch(() => null);
          if (mentionProfile) {
            parts.push(
              wrapEnrichmentSection('mentioned_profile', `${mention.name} (${mention.id})`, mentionProfile),
            );
          }
        }
      }
    }

    // R1-audit followup on #115: scoreTag formatter guards against
    // NaN / Infinity from a future score-normalization regression.
    // Number.isFinite(undefined) returns false, so the chain naturally
    // handles missing scores as "no score tag".
    const scoreTag = (score: number | undefined): string =>
      typeof score === 'number' && Number.isFinite(score) ? `score:${score.toFixed(2)} · ` : '';

    // 3. Thread episodes (cold injection — semantic search with score filtering)
    if (msg.threadId) {
      const threadEps = await this.memoryStore
        .searchEpisodes(searchQuery, { chatId: msg.chatId, threadId: msg.threadId })
        .catch(() => []);
      const filtered = threadEps.filter(ep => ep.score === undefined || ep.score >= appConfig.minSearchScore);
      for (const ep of filtered) {
        const dateTag = ep.timestamp.slice(0, 10);
        parts.push(wrapEnrichmentSection('thread_episode', `${scoreTag(ep.score)}${dateTag}`, ep.content));
      }
    }

    // 4. Chat episodes (cold injection — semantic search with score filtering)
    const chatEps = await this.memoryStore
      .searchEpisodes(searchQuery, { chatId: msg.chatId })
      .catch(() => []);
    const filteredChat = chatEps.filter(ep => ep.score === undefined || ep.score >= appConfig.minSearchScore);
    for (const ep of filteredChat) {
      const dateTag = ep.timestamp.slice(0, 10);
      parts.push(wrapEnrichmentSection('chat_episode', `${scoreTag(ep.score)}${dateTag}`, ep.content));
    }

    // 5. Skills (cold injection — inject name + sanitized description + path)
    //    Skill description is creator-controlled free text (#84 limited
    //    create authority; OWNER themselves can still be social-engineered
    //    into save_skill via prompt injection). Cap at 200 chars and
    //    collapse newlines so a multi-line "description" can't smuggle
    //    extra context into the envelope.
    const skills = await this.memoryStore.searchSkills(searchQuery).catch(() => []);
    const filteredSkills = skills.filter(s => s.score === undefined || s.score >= appConfig.minSearchScore);
    const SKILL_DESC_MAX = 200;
    for (const skill of filteredSkills) {
      const skillScoreTag = typeof skill.score === 'number' && Number.isFinite(skill.score)
        ? ` · score:${skill.score.toFixed(2)}`
        : '';
      const skillPath = `${appConfig.memoriesDir}/skills/${skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
      const safeDesc = (skill.description ?? '')
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, SKILL_DESC_MAX);
      parts.push(
        wrapEnrichmentSection(
          'skill',
          `${skill.name}${skillScoreTag}`,
          `${safeDesc}\n→ ${skillPath}`,
        ),
      );
    }

    // Assemble.
    // R1-audit followup on #115: the prior `if (parts.length === 0)
    // return msg.text` shortcut skipped the envelope ENTIRELY even
    // when `msg.parentContent` (the quoted-message body) was non-
    // empty. parentContent is fetched from Feishu — content authored
    // by some user — so a quoted-reply attack would bypass #114's
    // fix when the sender has no other stored memory. Now: enter the
    // wrap path whenever EITHER stored parts OR parentContent exists.
    if (parts.length === 0 && !msg.parentContent) return msg.text;

    return enrichmentPrompt(
      parts.join('\n\n'),
      msg.parentContent,
      msg.senderId,
      msg.chatId,
      msg.text
    );
  }

  /**
   * Download an image by image_key and save to inboxDir.
   * Returns the absolute path to the saved file, or undefined on failure.
   *
   * Uses messageResource.get because image.get can only download images that
   * the bot itself uploaded — not images users send to the bot.
   */
  private async downloadImage(imageKey: string, messageId: string): Promise<string | undefined> {
    // Bounded-time inline download (#108 fix, v1.0.20). Pre-fix this
    // was a naked `await` inside handleMessageEvent, so a 30MB image
    // could stall the event-loop processing of NEW messages from
    // OTHER users in the same chat / other chats — observed 5–30s
    // "bot ignored me" latency in active groups. Now: race against
    // LARK_DOWNLOAD_TIMEOUT_MS (default 10s). On timeout the inline
    // path returns undefined so the channel notification fires WITHOUT
    // image_path; the actual download continues in the background and
    // may still complete in time for Claude's Read tool to find it.
    try {
      mkdirSync(appConfig.inboxDir, { recursive: true });
      const filename = `${Date.now()}-${imageKey}.png`;
      const filePath = path.join(appConfig.inboxDir, filename);

      // Defense in depth (R2-audit followup #1 on #108): even though
      // the inbound parse layer now validates imageKey via LARK_ID_REGEX,
      // the storage call site asserts the resolved path stays inside
      // inboxDir — any future code path that bypasses the parse-time
      // check still cannot land bytes outside the configured inbox.
      const inboxResolved = path.resolve(appConfig.inboxDir) + path.sep;
      if (!path.resolve(filePath).startsWith(inboxResolved)) {
        debugLog(`[channel] downloadImage path escape blocked: ${filePath}`);
        return undefined;
      }

      const downloadPromise = (async () => {
        const resp = await this.client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: imageKey },
          params: { type: 'image' },
        } as any);
        if (!resp) return undefined;
        await writeSdkResource(resp, filePath, { maxBytes: appConfig.maxDownloadBytes });
        debugLog(`[channel] Downloaded image ${imageKey} → ${filePath}`);
        return filePath;
      })();

      // The timeout doesn't abort the underlying SDK call (the Lark
      // SDK does not expose AbortController); it just bounds how long
      // the event handler waits. The download keeps running and the
      // file appears in inbox once it completes — Claude's Read tool
      // can still pick it up if the operator's prompt comes after.
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          debugLog(
            `[channel] Image ${imageKey} download exceeded ${appConfig.downloadTimeoutMs}ms — continuing in background`,
          );
          resolve(undefined);
        }, appConfig.downloadTimeoutMs);
      });

      // Detach errors from background continuation so they don't
      // become unhandled rejections after the timeout fires.
      downloadPromise.catch((err) => {
        debugLog(`[channel] Background image download ${imageKey} failed: ${err}`);
      });

      const result = await Promise.race([downloadPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);
      return result;
    } catch (err) {
      debugLog(`[channel] Failed to download image ${imageKey}: ${err}`);
      return undefined;
    }
  }

  /**
   * Handle reaction events on bot messages.
   * Forwards emoji reactions to Claude as a special message type.
   */
  private async handleReactionEvent(data: any): Promise<void> {
    const messageId = data?.message_id ?? '';
    // emoji_type is Feishu-supplied; for standard emojis it's a short
    // ASCII codename (e.g. "THUMBSUP"), but tenant-custom emojis can
    // carry arbitrary characters including envelope-breaking markup.
    // The reaction text is injected into Claude context at line below;
    // restrict to a safe shape and label anything else as a generic
    // placeholder so it can't smuggle markup into the prompt (#114).
    const rawEmoji = data?.reaction_type?.emoji_type ?? '';
    const emojiType = /^[A-Za-z0-9_-]{1,64}$/.test(rawEmoji) ? rawEmoji : '<custom-emoji>';
    const operatorType = data?.operator_type ?? '';
    // app reactions: operator_type=app; user reactions: operator_type=user, user_id.open_id=ou_xxx
    const operatorId = data?.user_id?.open_id ?? '';

    // Ignore bot's own reactions (operator_type=app means the bot itself)
    if (operatorType === 'app') return;

    // Only process reactions on messages the bot sent. The tracker entry
    // (#80) also gives us back the chatId/threadId Feishu's reaction
    // payload omits — we need both for whitelist evaluation and identity
    // binding below.
    const target = this.botMessageTracker.get(messageId);
    if (!target) {
      // R1-followup on this PR: emit a breadcrumb so an operator
      // debugging "why didn't my reaction register on the old bot
      // card" doesn't have to guess at the silent return. Tracker is
      // bounded at LARK_BOT_MESSAGE_TRACKER_SIZE (default 500); a
      // reaction on an evicted or pre-tracker-startup bot message
      // ends up here.
      debugLog(
        `[channel] Reaction dropped: bot message ${messageId} not in tracker (stale, evicted, or sent before tracker started)`,
      );
      return;
    }
    const { chatId: targetChatId, threadId: targetThreadId } = target;

    // Whitelist filtering — now with the REAL chatId from the tracker.
    // Pre-#80 fix this passed empty string, which made
    // `chatConfigured && [...].includes('')` always false → every
    // reaction was rejected if the operator only had a chat whitelist
    // (a common config). Now the chatId is plumbed through.
    if (!passesWhitelist(operatorId, targetChatId)) {
      debugLog(
        `[channel] Reaction from ${operatorId} in ${targetChatId} rejected by whitelist`,
      );
      return;
    }

    // Resolve sender name BEFORE queuing — name resolution is async I/O
    // (Feishu contact API + name cache) and isn't part of the per-chat
    // serialized work. Pre-queue keeps the queued task itself short and
    // CPU-bound; same shape as the reply-handler's text formatting
    // happening before the in-flight send.
    const senderName = await this.resolveUserName(operatorId);

    const larkMessage: LarkMessage = {
      messageId,
      chatId: targetChatId,
      threadId: targetThreadId,
      chatType: 'reaction',
      senderId: operatorId,
      senderName: senderName || undefined,
      text: `(reacted with ${emojiType} to message ${messageId})`,
      messageType: 'reaction',
      rawContent: JSON.stringify(data),
    };

    // R1-followup on this PR: route the reaction through the per-chat
    // MessageQueue (instead of dispatching directly). Pre-fix, an
    // inbound message and a reaction in the SAME chat could be processed
    // in parallel — both called `setCaller(chatId, undefined, ...)`,
    // racing on the chat-level identity entry. If user A's in-flight
    // Claude turn (multi-second tool calls) was still pending when user
    // B's reaction landed, B's `setCaller` would overwrite A's, and A's
    // subsequent `save_memory(chat_id, thread_id=undefined)` would
    // resolve to B → misattributed write.
    //
    // Queueing makes the reaction wait its turn in the same per-chat
    // chain `handleMessageEvent` uses (queue.enqueue at line 730), so
    // setCaller / messageHandler run serially with any pending inbound
    // message work for that chat. setCaller runs INSIDE the queued task
    // so the identity binding happens at the moment of dispatch, not
    // at event-receive time.
    this.queue.enqueue(targetChatId, targetThreadId, async () => {
      this.identitySession?.setCaller(targetChatId, targetThreadId, operatorId);
      if (this.messageHandler) {
        await this.messageHandler(larkMessage);
      }
    });
  }

  /**
   * Fetch the bot's own open_id via the bot info API. Used to filter
   * group messages — only those that @mention this bot are forwarded
   * to Claude.
   *
   * v1.0.25 (#86, #55) hardening:
   * - **Startup retry**: 5 attempts with 2s linear backoff. Network
   *   blips / Feishu 5xx during the initial fetch are common; failing
   *   over to the empty `botOpenId` state would silence ALL group
   *   @-mentions until next process restart (the new fail-safe is
   *   deny-by-default).
   * - **Background re-fetch**: if startup retries all fail, schedule
   *   a periodic re-fetch every 5 minutes for the next hour so the
   *   bot can recover without restart if the underlying issue clears
   *   (network, transient permission). Stops on first success or
   *   after the cap.
   *
   * Pre-fix the function tried once and swallowed any error; combined
   * with the old "accept any mention" fallback, a single startup fetch
   * failure meant the bot would noisy-reply to EVERY @mention in EVERY
   * group for the entire process lifetime.
   */
  private async fetchBotOpenId(): Promise<void> {
    const MAX_STARTUP_ATTEMPTS = 5;
    const STARTUP_RETRY_DELAY_MS = 2000;
    for (let attempt = 1; attempt <= MAX_STARTUP_ATTEMPTS; attempt++) {
      if (await this.tryFetchBotOpenIdOnce(attempt, MAX_STARTUP_ATTEMPTS)) return;
      if (attempt < MAX_STARTUP_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, STARTUP_RETRY_DELAY_MS));
      }
    }
    console.error(
      `[channel] WARNING: botOpenId not resolved after ${MAX_STARTUP_ATTEMPTS} startup attempts. ` +
      `Group @-mentions will be REJECTED (fail-safe — better silent than spammy). ` +
      `Scheduling background re-fetch every 5 minutes for the next hour.`,
    );
    this.startBackgroundBotIdRefetch();
  }

  /**
   * Single attempt to fetch the bot's open_id. Returns true on success,
   * false on any failure (transient or permanent). Logs at the level
   * appropriate for the attempt number — last attempt and background
   * retries log at error, intermediate startup attempts at debug.
   */
  private async tryFetchBotOpenIdOnce(attempt: number, totalAttempts: number): Promise<boolean> {
    try {
      const resp = await this.client.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      });
      const openId = (resp as any)?.bot?.open_id;
      if (openId) {
        this.botOpenId = openId;
        console.error(`[channel] Bot open_id resolved: ${openId} (attempt ${attempt}/${totalAttempts})`);
        return true;
      }
      console.error(
        `[channel] /bot/v3/info attempt ${attempt}/${totalAttempts}: response had no bot.open_id`,
      );
      return false;
    } catch (err) {
      const level = attempt === totalAttempts ? '[channel] ERROR' : '[channel]';
      console.error(`${level} fetchBotOpenId attempt ${attempt}/${totalAttempts} failed:`, err);
      return false;
    }
  }

  /**
   * Background re-fetch loop — runs every 5 minutes for up to 1 hour
   * after startup retries all failed. Stops on first success. Capped
   * so a permanently-broken setup doesn't burn API quota indefinitely.
   */
  private startBackgroundBotIdRefetch(): void {
    const BG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const BG_MAX_ATTEMPTS = 12; // 1 hour total
    let bgAttempt = 0;
    const tick = async () => {
      bgAttempt++;
      if (this.botOpenId) return; // resolved by some other code path; stop
      const ok = await this.tryFetchBotOpenIdOnce(bgAttempt, BG_MAX_ATTEMPTS);
      if (ok) {
        console.error(
          `[channel] Background re-fetch succeeded on attempt ${bgAttempt} — group @-mentions are now active.`,
        );
        return;
      }
      if (bgAttempt >= BG_MAX_ATTEMPTS) {
        console.error(
          `[channel] Background re-fetch gave up after ${BG_MAX_ATTEMPTS} attempts (~1 hour). ` +
          `Group @-mentions will remain REJECTED until process restart. ` +
          `Check Feishu app permissions (im:bot scope) and network.`,
        );
        return;
      }
      // .unref() so the dangling background timer doesn't keep the
      // event loop alive on its own — graceful shutdowns can exit
      // cleanly. R1-audit cosmetic on #86.
      setTimeout(() => { void tick(); }, BG_INTERVAL_MS).unref();
    };
    setTimeout(() => { void tick(); }, BG_INTERVAL_MS).unref();
  }

  /**
   * Resolve a user's display name. Tries event data first, then API, then cache.
   * Falls back to a truncated open_id if all else fails.
   */
  private async resolveUserName(openId: string, _sender?: any): Promise<string> {
    if (!openId) return '';

    // Check cache
    const cached = this.nameCache.get(openId);
    if (cached) return cached;

    // Try contact API (requires contact:contact.base:readonly permission)
    try {
      const resp = await this.client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      const name = (resp?.data as any)?.user?.name;
      if (name) {
        this.nameCache.set(openId, name);
        return name;
      }
    } catch {
      // Permission not granted or API failed; fall through
    }

    // Fallback: generate a stable short alias from the open_id
    const alias = this.generateAlias(openId);
    this.nameCache.set(openId, alias);
    return alias;
  }

  /**
   * Generate a stable alias like "user_e4338bc" from an ID string.
   * Uses the last 7 chars of the ID which are unique per user.
   */
  private generateAlias(id: string): string {
    const suffix = id.slice(-7);
    return `user_${suffix}`;
  }

  /**
   * Resolve a chat's display name. Caches the result.
   */
  private async resolveChatName(chatId: string): Promise<string> {
    if (!chatId) return '';

    const cached = this.nameCache.get(chatId);
    if (cached) return cached;

    try {
      const resp = await this.client.im.v1.chat.get({
        path: { chat_id: chatId },
      });
      const name = (resp?.data as any)?.name;
      if (name) {
        this.nameCache.set(chatId, name);
        return name;
      }
    } catch {
      // Chat name fetch failed; fall through to alias
    }

    // Fallback: chat_xxx alias
    const alias = `chat_${chatId.slice(-7)}`;
    this.nameCache.set(chatId, alias);
    return alias;
  }

  private extractText(rawContent: string, messageType: string): string {
    try {
      const parsed = JSON.parse(rawContent);
      switch (messageType) {
        case 'text':
          return parsed.text ?? rawContent;
        case 'post': {
          // Rich text: extract plain text from all content nodes
          const lines: string[] = [];
          const content = parsed.content ?? parsed.zh_cn?.content ?? parsed.en_us?.content ?? [];
          for (const line of content) {
            const texts = (line as any[])
              .filter((node: any) => node.tag === 'text' || node.tag === 'a')
              .map((node: any) => node.text ?? node.href ?? '');
            lines.push(texts.join(''));
          }
          return lines.join('\n') || rawContent;
        }
        case 'image':
          return '[Image]';
        case 'file':
          return `[File: ${parsed.file_name ?? 'attachment'}]`;
        case 'audio':
          return '[Audio]';
        case 'video':
          return '[Video]';
        case 'interactive':
          return parsed.title?.content ?? parsed.header?.title?.content ?? '[Interactive Card]';
        default:
          return parsed.text ?? rawContent;
      }
    } catch {
      return rawContent;
    }
  }

  private extractAttachments(message: any): Array<{ fileKey: string; fileName: string; fileType: string }> {
    const attachments: Array<{ fileKey: string; fileName: string; fileType: string }> = [];
    try {
      const parsed = JSON.parse(message.content ?? '{}');
      const msgType = message.message_type ?? message.msg_type;

      if (msgType === 'image' && parsed.image_key) {
        attachments.push({ fileKey: parsed.image_key, fileName: 'image.png', fileType: 'image' });
      } else if (msgType === 'file' && parsed.file_key) {
        attachments.push({
          fileKey: parsed.file_key,
          fileName: parsed.file_name ?? 'file',
          fileType: 'file',
        });
      } else if (msgType === 'audio' && parsed.file_key) {
        attachments.push({ fileKey: parsed.file_key, fileName: 'audio', fileType: 'audio' });
      } else if (msgType === 'video' && parsed.file_key) {
        attachments.push({ fileKey: parsed.file_key, fileName: 'video', fileType: 'video' });
      }
    } catch {
      // ignore parse errors
    }
    return attachments;
  }
}
