import * as Lark from '@larksuiteoapi/node-sdk';
import { appConfig } from './config.js';
import { MessageQueue } from './queue.js';
import type { MemoryProvider } from './memory/interface.js';
import type { ConversationBuffer } from './memory/buffer.js';

export interface LarkMessage {
  messageId: string;
  chatId: string;
  chatType: string; // 'p2p' | 'group'
  senderId: string;
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
  private wsClient: Lark.WSClient | null = null;
  private queue = new MessageQueue();
  private messageHandler: MessageHandler | null = null;
  private memoryProvider: MemoryProvider | null = null;
  private conversationBuffer: ConversationBuffer | null = null;

  constructor() {
    this.client = new Lark.Client({
      appId: appConfig.appId,
      appSecret: appConfig.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
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
    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
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
    });

    this.wsClient.start({ eventDispatcher });
    console.error('[channel] lark channel: connected to Feishu via WebSocket');
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

    // Whitelist filtering
    if (appConfig.allowedUserIds.length > 0 && !appConfig.allowedUserIds.includes(senderId)) {
      return;
    }
    if (appConfig.allowedChatIds.length > 0 && !appConfig.allowedChatIds.includes(chatId)) {
      return;
    }

    // In group chats, only respond to @bot messages
    // Feishu marks bot mentions with id.open_id matching the bot's open_id,
    // or with mention_type === 'at_bot'. We also accept @_all.
    if (chatType === 'group') {
      if (!mentions || mentions.length === 0) return;
      const hasBotMention = mentions.some(
        (m: any) =>
          m.key === '@_all' ||
          m.id?.open_id === '' || // fallback: empty open_id indicates bot in some SDK versions
          m.name === '' // bot mentions sometimes have empty name
      );
      if (!hasBotMention) return;
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

    // Build message object
    const larkMessage: LarkMessage = {
      messageId,
      chatId,
      chatType,
      senderId,
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
