import { z } from 'zod';
import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from './config.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryProvider } from './memory/interface.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { BotMessageTracker } from './channel.js';

/**
 * Register all 6 MCP tools on the server.
 */
export function registerTools(
  server: McpServer,
  client: Lark.Client,
  memoryProvider: MemoryProvider,
  conversationBuffer?: ConversationBuffer,
  ackReactions?: Map<string, string>,
  botMessageTracker?: BotMessageTracker
): void {
  // ── 1. reply ──
  server.registerTool(
    'reply',
    {
      description:
        'Send a text reply to a Feishu chat. Supports optional images (≤10 MB) or files (≤30 MB). Long text is auto-chunked.',
      inputSchema: z.object({
        chat_id: z.string().describe('The chat ID to reply in'),
        text: z.string().describe('The text content to send'),
        reply_to: z.string().optional().describe('Message ID to reply to (quoted reply)'),
        files: z
          .array(
            z.object({
              path: z.string().describe('Local file path'),
              type: z.enum(['image', 'file']).describe('Attachment type'),
            })
          )
          .optional()
          .describe('Optional attachments'),
      }),
    },
    async ({ chat_id, text, reply_to, files }) => {
      const chunks = chunkText(text, appConfig.textChunkLimit);

      for (let i = 0; i < chunks.length; i++) {
        try {
          let resp: any;
          if (reply_to && i === 0) {
            // First chunk as a quoted reply
            resp = await client.im.v1.message.reply({
              path: { message_id: reply_to },
              data: {
                content: JSON.stringify({ text: chunks[i] }),
                msg_type: 'text',
              },
            });
          } else {
            resp = await client.im.v1.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chat_id,
                content: JSON.stringify({ text: chunks[i] }),
                msg_type: 'text',
              },
            });
          }
          const sentId = resp?.data?.message_id;
          if (sentId && botMessageTracker) botMessageTracker.add(sentId);
        } catch (err: any) {
          const apiError = err?.response?.data ?? err?.data;
          if (apiError?.code && apiError?.msg) {
            console.error(`[tools] Feishu API error [${apiError.code}]: ${apiError.msg}`);
            throw new Error(`Feishu API [${apiError.code}]: ${apiError.msg}`);
          }
          console.error(`[tools] send message failed:`, err?.message ?? String(err));
          throw err;
        }
      }

      // Upload and send attachments if any
      if (files?.length) {
        for (const file of files) {
          try {
            const fileData = await fs.readFile(file.path);
            if (file.type === 'image') {
              const resp = await client.im.v1.image.create({
                data: {
                  image_type: 'message',
                  image: fileData as any,
                },
              });
              const imageKey = (resp as any)?.data?.image_key ?? (resp as any)?.image_key;
              if (imageKey) {
                await client.im.v1.message.create({
                  params: { receive_id_type: 'chat_id' },
                  data: {
                    receive_id: chat_id,
                    content: JSON.stringify({ image_key: imageKey }),
                    msg_type: 'image',
                  },
                });
              }
            } else {
              // For file uploads, use im.v1.file.create
              const resp = await client.im.v1.file.create({
                data: {
                  file_type: 'stream',
                  file_name: path.basename(file.path),
                  file: fileData as any,
                },
              });
              const fileKey = (resp as any)?.data?.file_key ?? (resp as any)?.file_key;
              if (fileKey) {
                await client.im.v1.message.create({
                  params: { receive_id_type: 'chat_id' },
                  data: {
                    receive_id: chat_id,
                    content: JSON.stringify({
                      file_key: fileKey,
                      file_name: path.basename(file.path),
                    }),
                    msg_type: 'file',
                  },
                });
              }
            }
          } catch (err) {
            console.error(`[tools] Failed to upload file ${file.path}:`, err);
          }
        }
      }

      // Record assistant response in buffer for distillation
      conversationBuffer?.record(chat_id, {
        role: 'assistant',
        senderId: 'bot',
        text: text.slice(0, 500), // truncate for buffer efficiency
        timestamp: new Date().toISOString(),
      });

      // Revoke ack reaction — try reply_to first, then scan all pending acks
      if (ackReactions && ackReactions.size > 0) {
        const msgId = reply_to || '';
        const reactionId = msgId ? ackReactions.get(msgId) : undefined;
        if (reactionId) {
          // Exact match on reply_to
          ackReactions.delete(msgId);
          client.im.v1.messageReaction.delete({
            path: { message_id: msgId, reaction_id: reactionId },
          }).catch(() => {});
        } else {
          // Fallback: revoke all pending acks (handles case where Claude didn't pass reply_to)
          for (const [mid, rid] of ackReactions.entries()) {
            ackReactions.delete(mid);
            client.im.v1.messageReaction.delete({
              path: { message_id: mid, reaction_id: rid },
            }).catch(() => {});
          }
        }
      }

      return {
        content: [{ type: 'text' as const, text: `Sent ${chunks.length} message(s)` }],
      };
    }
  );

  // ── 2. edit_message ──
  server.registerTool(
    'edit_message',
    {
      description: 'Edit a previously sent bot message (text or card_markdown).',
      inputSchema: z.object({
        message_id: z.string().describe('The message ID to edit'),
        text: z.string().describe('New content'),
        format: z
          .enum(['text', 'card_markdown'])
          .default('text')
          .describe('Format of the content'),
      }),
    },
    async ({ message_id, text, format }) => {
      if (format === 'card_markdown') {
        await client.im.v1.message.patch({
          path: { message_id },
          data: {
            content: Lark.messageCard.defaultCard({
              title: '',
              content: text,
            }),
          },
        });
      } else {
        await client.im.v1.message.patch({
          path: { message_id },
          data: {
            content: JSON.stringify({ text }),
          },
        });
      }

      return {
        content: [{ type: 'text' as const, text: `Edited message ${message_id}` }],
      };
    }
  );

  // ── 3. react ──
  server.registerTool(
    'react',
    {
      description: 'Add an emoji reaction to a message.',
      inputSchema: z.object({
        message_id: z.string().describe('The message ID to react to'),
        emoji: z.string().describe('Emoji type (e.g., "THUMBSUP", "SMILE", "HEART")'),
      }),
    },
    async ({ message_id, emoji }) => {
      await client.im.v1.messageReaction.create({
        path: { message_id },
        data: {
          reaction_type: { emoji_type: emoji },
        },
      });

      return {
        content: [{ type: 'text' as const, text: `Added ${emoji} reaction to ${message_id}` }],
      };
    }
  );

  // ── 4. download_attachment ──
  server.registerTool(
    'download_attachment',
    {
      description: 'Download an attachment (image, file, audio, video) from a message to local inbox.',
      inputSchema: z.object({
        message_id: z.string().describe('The message ID containing the attachment'),
        file_key: z.string().describe('The file key of the attachment'),
      }),
    },
    async ({ message_id, file_key }) => {
      const inboxDir = appConfig.inboxDir;
      await fs.mkdir(inboxDir, { recursive: true });
      try {
        let data: any;
        if (file_key.startsWith('img_')) {
          data = await client.im.v1.image.get({
            path: { image_key: file_key },
          });
        } else {
          data = await client.im.v1.messageResource.get({
            path: { message_id, file_key },
            params: { type: 'file' },
          });
        }
        if (data) {
          const filePath = path.join(inboxDir, file_key);
          await fs.writeFile(filePath, data as any);
          return { content: [{ type: 'text' as const, text: `Downloaded to ${filePath}` }] };
        }
      } catch (err: any) {
        const apiError = err?.response?.data ?? err?.data;
        if (apiError?.code && apiError?.msg) {
          console.error(`[tools] download failed [${apiError.code}]: ${apiError.msg}`);
          return { content: [{ type: 'text' as const, text: `Feishu API [${apiError.code}]: ${apiError.msg}` }], isError: true };
        }
        console.error(`[tools] download failed:`, err?.message ?? String(err));
      }
      return { content: [{ type: 'text' as const, text: 'Failed to download attachment' }], isError: true };
    }
  );

  // ── 5. save_memory ──
  server.registerTool(
    'save_memory',
    {
      description:
        'Save a memory entry for cross-session recall. Only save durable, reusable facts — user preferences, communication style, key decisions, ongoing projects, resolved problems. Do NOT save pleasantries, failed attempts, ephemeral details, or conversation filler.',
      inputSchema: z.object({
        type: z
          .enum(['profile', 'chat', 'thread'])
          .describe(
            'Memory type: "profile" for user preferences/facts, "chat" for conversation summary, "thread" for thread-level summary'
          ),
        content: z.string().describe('The memory content to save (concise, factual)'),
        reason: z.string().describe('Why this is worth remembering'),
        chat_id: z.string().optional().describe('Chat ID (required for chat/thread type)'),
        thread_id: z.string().optional().describe('Thread ID (required for thread type)'),
        open_id: z.string().optional().describe('User open_id (required for profile type)'),
      }),
    },
    async ({ type, content, reason, chat_id, thread_id, open_id }) => {
      if (type === 'profile') {
        if (!open_id) {
          return {
            content: [{ type: 'text' as const, text: 'open_id is required for profile type' }],
            isError: true,
          };
        }
        await memoryProvider.saveProfile(open_id, content);
        return {
          content: [
            { type: 'text' as const, text: `Saved profile for ${open_id}. Reason: ${reason}` },
          ],
        };
      }

      if (!chat_id) {
        return {
          content: [{ type: 'text' as const, text: 'chat_id is required for chat/thread type' }],
          isError: true,
        };
      }

      await memoryProvider.saveEpisode(type, content, {
        chatId: chat_id,
        threadId: thread_id,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Saved ${type} episode for chat ${chat_id}. Reason: ${reason}`,
          },
        ],
      };
    }
  );

  // ── 6. save_skill ──
  server.registerTool(
    'save_skill',
    {
      description:
        'Save a reusable procedure as a global skill. Skills are searchable across all users and chats. Use for repeatable workflows, deployment procedures, troubleshooting guides, etc.',
      inputSchema: z.object({
        name: z.string().describe('Short skill name (e.g., "deploy-service")'),
        description: z.string().describe('One-line description of what this skill does'),
        content: z.string().describe('The full procedure/instructions'),
        chat_id: z.string().optional().describe('Chat ID where this skill was created (for context)'),
      }),
    },
    async ({ name, description, content, chat_id }) => {
      await memoryProvider.saveSkill(name, description, content);
      return {
        content: [{ type: 'text' as const, text: `Saved skill "${name}": ${description}` }],
      };
    }
  );
}

/**
 * Split long text into chunks, respecting paragraph/line/word boundaries.
 */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;

    // Try to split at paragraph boundary
    const paraIdx = remaining.lastIndexOf('\n\n', limit);
    if (paraIdx > limit * 0.3) {
      splitAt = paraIdx + 2;
    }

    // Try newline
    if (splitAt === -1) {
      const nlIdx = remaining.lastIndexOf('\n', limit);
      if (nlIdx > limit * 0.3) {
        splitAt = nlIdx + 1;
      }
    }

    // Try space
    if (splitAt === -1) {
      const spIdx = remaining.lastIndexOf(' ', limit);
      if (spIdx > limit * 0.3) {
        splitAt = spIdx + 1;
      }
    }

    // Hard split
    if (splitAt === -1) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}
