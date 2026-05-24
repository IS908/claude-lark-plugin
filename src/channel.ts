import * as Lark from '@larksuiteoapi/node-sdk';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appConfig } from './config.js';
import { enrichmentPrompt, wrapEnrichmentSection } from './prompts.js';
import { MessageQueue } from './queue.js';
import type { MemoryStore } from './memory/file.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { IdentitySession } from './identity-session.js';
import { TERMINAL_CHAT_ID } from './identity-session.js';
import { writeSdkResource } from './sdk-resource.js';

const DEBUG_LOG = path.join(os.homedir(), '.claude', 'channels', 'lark', 'debug.log');
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
function passesWhitelist(senderId: string, chatId: string): boolean {
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

export class BotMessageTracker {
  private ids: string[] = [];
  private set = new Set<string>();
  private readonly maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  add(messageId: string): void {
    if (this.set.has(messageId)) return;
    this.set.add(messageId);
    this.ids.push(messageId);
    while (this.ids.length > this.maxSize) {
      const oldest = this.ids.shift()!;
      this.set.delete(oldest);
    }
  }

  has(messageId: string): boolean {
    return this.set.has(messageId);
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
  private ackReactions = new Map<string, string>(); // messageId → reactionId
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

  getAckReactions(): Map<string, string> {
    return this.ackReactions;
  }

  getBotMessageTracker(): BotMessageTracker {
    return this.botMessageTracker;
  }

  getLatestMessageTracker(): LatestMessageTracker {
    return this.latestMessageTracker;
  }

  async start(): Promise<void> {
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

    // In group chats, only process messages that @mention the bot
    if (chatType === 'group') {
      if (!mentions || mentions.length === 0) {
        debugLog(`[channel] Ignoring group message: no mentions`);
        return;
      }
      // If we know the bot's open_id, match precisely; otherwise accept any mention
      if (this.botOpenId) {
        const botMentioned = mentions.some(
          (m: any) => (m.id?.open_id ?? m.id?.union_id) === this.botOpenId
        );
        if (!botMentioned) {
          debugLog(`[channel] Ignoring group message: bot not @mentioned`);
          return;
        }
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
        if (reactionId) this.ackReactions.set(messageId, reactionId);
      }).catch(() => {});
    }

    // Parse mentions
    const parsedMentions: Array<{ id: string; name: string }> = (mentions ?? []).map(
      (m: any) => ({
        id: m.id?.open_id ?? m.id?.union_id ?? '',
        name: m.name ?? '',
      }),
    );

    // Detect whether this bot was among the mentioned users — forwarded to
    // Claude as meta.bot_mentioned so Claude has a text-independent signal
    // when multiple users are @mentioned in the same message.
    const botMentioned = this.botOpenId
      ? parsedMentions.some((m) => m.id === this.botOpenId)
      : parsedMentions.length > 0; // fallback: same heuristic as the group-filter

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
        if (imageKey) {
          const downloaded = await this.downloadImage(imageKey, messageId);
          if (downloaded) imagePath = downloaded;
        }
      } catch {
        debugLog(`[channel] Failed to parse image content for auto-download`);
      }
    } else if (messageType === 'post') {
      try {
        const parsed = JSON.parse(rawContent);
        const content = parsed.content ?? parsed.zh_cn?.content ?? parsed.en_us?.content ?? [];
        const downloadedPaths: string[] = [];
        for (const line of content) {
          for (const node of line as any[]) {
            if (node.tag === 'img' && node.image_key) {
              const downloaded = await this.downloadImage(node.image_key, messageId);
              if (downloaded) downloadedPaths.push(downloaded);
            }
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

    // Only process reactions on messages the bot sent
    if (!this.botMessageTracker.has(messageId)) return;

    // Whitelist filtering (reaction events carry no chat_id, so pass '')
    if (!passesWhitelist(operatorId, '')) {
      debugLog(`[channel] Reaction from ${operatorId} rejected by whitelist`);
      return;
    }

    const senderName = await this.resolveUserName(operatorId);

    const larkMessage: LarkMessage = {
      messageId,
      chatId: '',
      chatType: 'reaction',
      senderId: operatorId,
      senderName: senderName || undefined,
      text: `(reacted with ${emojiType} to message ${messageId})`,
      messageType: 'reaction',
      rawContent: JSON.stringify(data),
    };

    if (this.messageHandler) {
      await this.messageHandler(larkMessage);
    }
  }

  /**
   * Fetch the bot's own open_id via the bot info API.
   * Used to filter group messages — only process those that @mention this bot.
   */
  private async fetchBotOpenId(): Promise<void> {
    try {
      const resp = await this.client.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      });
      const openId = (resp as any)?.bot?.open_id;
      if (openId) {
        this.botOpenId = openId;
        debugLog(`[channel] Bot open_id resolved: ${openId}`);
      } else {
        console.error('[channel] Warning: could not resolve bot open_id from /bot/v3/info');
      }
    } catch (err) {
      console.error('[channel] Warning: failed to fetch bot info:', err);
    }
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
