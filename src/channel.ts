import * as Lark from '@larksuiteoapi/node-sdk';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appConfig } from './config.js';
import { MessageQueue } from './queue.js';
import type { MemoryProvider } from './memory/interface.js';
import type { ConversationBuffer } from './memory/buffer.js';

const DEBUG_LOG = path.join(os.homedir(), '.claude', 'channels', 'lark', 'debug.log');
function debugLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(DEBUG_LOG, line); } catch {}
  console.error(msg);
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
  attachments?: Array<{ fileKey: string; fileName: string; fileType: string }>;
  rawContent: string;
}

type MessageHandler = (message: LarkMessage) => Promise<void>;

export class LarkChannel {
  private client: Lark.Client;
  private nameCache = new Map<string, string>(); // open_id/chat_id → display name
  private botOpenId: string = '';
  private wsClient: Lark.WSClient | null = null;
  private queue = new MessageQueue();
  private messageHandler: MessageHandler | null = null;
  private memoryProvider: MemoryProvider | null = null;
  private conversationBuffer: ConversationBuffer | null = null;

  constructor() {
    // Custom logger to redirect all SDK output to stderr (stdout is reserved for MCP JSON-RPC)
    const sdkLogger = {
      info: (...args: any[]) => console.error('[lark-sdk]', ...args),
      warn: (...args: any[]) => console.error('[lark-sdk][warn]', ...args),
      error: (...args: any[]) => console.error('[lark-sdk][error]', ...args),
      debug: (...args: any[]) => console.error('[lark-sdk][debug]', ...args),
      trace: (...args: any[]) => console.error('[lark-sdk][trace]', ...args),
    };
    this.client = new Lark.Client({
      appId: appConfig.appId,
      appSecret: appConfig.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
      logger: sdkLogger,
    });
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  setMemoryProvider(provider: MemoryProvider): void {
    this.memoryProvider = provider;
  }

  setConversationBuffer(buffer: ConversationBuffer): void {
    this.conversationBuffer = buffer;
  }

  getClient(): Lark.Client {
    return this.client;
  }

  async start(): Promise<void> {
    // Fetch bot's own open_id for filtering group @mentions
    await this.fetchBotOpenId();

    debugLog('[channel] Registering event dispatcher...');
    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        debugLog(`[channel] Event received: im.message.receive_v1`);
        try {
          await this.handleMessageEvent(data);
        } catch (err) {
          console.error('[channel] Error handling message event:', err);
        }
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: appConfig.appId,
      appSecret: appConfig.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      logger: {
        info: (...args: any[]) => console.error('[lark-ws]', ...args),
        warn: (...args: any[]) => console.error('[lark-ws][warn]', ...args),
        error: (...args: any[]) => console.error('[lark-ws][error]', ...args),
        debug: (...args: any[]) => console.error('[lark-ws][debug]', ...args),
        trace: (...args: any[]) => console.error('[lark-ws][trace]', ...args),
      },
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

    // Debug: log raw event structure to understand sender/mentions shape
    debugLog(`[channel][debug] sender: ${JSON.stringify(sender)}`);
    debugLog(`[channel][debug] chatType=${chatType} chatId=${chatId} messageType=${messageType}`);
    if (mentions) debugLog(`[channel][debug] mentions: ${JSON.stringify(mentions)}`);

    // Resolve sender display name (from event data or cache)
    const senderName = await this.resolveUserName(senderId, sender);

    // Whitelist filtering
    if (appConfig.allowedUserIds.length > 0 && !appConfig.allowedUserIds.includes(senderId)) {
      return;
    }
    if (appConfig.allowedChatIds.length > 0 && !appConfig.allowedChatIds.includes(chatId)) {
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

    // Parse message text
    const text = this.extractText(rawContent, messageType);

    // Parse mentions
    const parsedMentions = (mentions ?? []).map((m: any) => ({
      id: m.id?.open_id ?? m.id?.union_id ?? '',
      name: m.name ?? '',
    }));

    // Parse attachments
    const attachments = this.extractAttachments(message);

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
      attachments,
      rawContent,
    };

    // Fetch parent message content if this is a quoted reply
    if (parentId) {
      try {
        const parentMsg = await this.client.im.v1.message.get({
          path: { message_id: parentId },
        });
        if (parentMsg?.data?.items?.[0]?.body?.content) {
          larkMessage.parentContent = this.extractText(
            parentMsg.data.items[0].body.content,
            parentMsg.data.items[0].msg_type ?? 'text'
          );
        }
      } catch {
        // Parent message fetch failed; continue without it
      }
    }

    // Enqueue for sequential per-chat processing
    this.queue.enqueue(chatId, async () => {
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
    if (!this.memoryProvider) return msg.text;

    const parts: string[] = [];

    // 1. User profile (hot injection)
    const profile = await this.memoryProvider.getProfile(msg.senderId).catch(() => null);
    if (profile) {
      parts.push(`[User Profile]\n${profile}`);
    }

    // 2. Mentioned user profiles
    if (msg.mentions?.length) {
      for (const mention of msg.mentions) {
        if (mention.id && mention.id !== msg.senderId) {
          const mentionProfile = await this.memoryProvider.getProfile(mention.id).catch(() => null);
          if (mentionProfile) {
            parts.push(`[Mentioned User: ${mention.name}]\n${mentionProfile}`);
          }
        }
      }
    }

    // 3. Thread episodes (if in a thread)
    if (msg.threadId) {
      const threadEps = await this.memoryProvider
        .searchEpisodes(msg.text, { chatId: msg.chatId, threadId: msg.threadId })
        .catch(() => []);
      for (const ep of threadEps) {
        parts.push(`[Thread Context ${ep.timestamp}]\n${ep.content}`);
      }
    }

    // 4. Chat episodes (cold injection)
    const chatEps = await this.memoryProvider
      .searchEpisodes(msg.text, { chatId: msg.chatId })
      .catch(() => []);
    for (const ep of chatEps) {
      parts.push(`[Past Context ${ep.timestamp}]\n${ep.content}`);
    }

    // 5. Skills (cold injection, if relevant)
    const skills = await this.memoryProvider.searchSkills(msg.text).catch(() => []);
    for (const skill of skills) {
      parts.push(`[Skill: ${skill.name}]\n${skill.content}`);
    }

    // Assemble
    if (parts.length === 0) return msg.text;

    const memoryContext = parts.join('\n\n');
    const parentContext = msg.parentContent
      ? `\n[Quoted Message]\n${msg.parentContent}\n`
      : '';

    return `[Memory Context]\n${memoryContext}\n${parentContext}\n[Current Message]\nFrom: ${msg.senderId} in ${msg.chatId}\n${msg.text}`;
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
