import { z } from 'zod';
import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from './config.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryProvider } from './memory/interface.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { BotMessageTracker, LatestMessageTracker } from './channel.js';
import { buildCards, shouldUseCard } from './feishu-card.js';
import {
  sanitizeJobId,
  expandSchedule,
  computeNextRun,
  readJob,
  writeJob,
  deleteJob as deleteJobFile,
  listAllJobs,
  jobExists,
  type JobFile,
} from './job-store.js';

/**
 * Register all 6 MCP tools on the server.
 */
export function registerTools(
  server: McpServer,
  client: Lark.Client,
  memoryProvider: MemoryProvider,
  conversationBuffer?: ConversationBuffer,
  ackReactions?: Map<string, string>,
  botMessageTracker?: BotMessageTracker,
  latestMessageTracker?: LatestMessageTracker
): void {
  // ── 1. reply ──
  server.registerTool(
    'reply',
    {
      description:
        'Send a reply to a Feishu chat. Plain text by default; long or markdown-rich content auto-renders as a Feishu card. Supports optional images (≤10 MB) or files (≤30 MB).',
      inputSchema: z.object({
        chat_id: z.string().describe('The chat ID to reply in'),
        text: z.string().describe('The text content to send'),
        reply_to: z.string().optional().describe('Message ID to reply to (quoted reply)'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the <channel> meta. Pass this when replying to a threaded message — the plugin will auto-fill reply_to if you omit it, ensuring the reply lands in the correct thread.'
          ),
        format: z
          .enum(['text', 'card'])
          .optional()
          .describe(
            'Output format. Omit for heuristic auto-detection: text with markdown features (headings/code blocks/tables/lists/bold) or length > 500 chars renders as a Feishu card. Set to "text" or "card" to override.'
          ),
        footer: z
          .string()
          .optional()
          .describe(
            'Optional small footnote appended at the bottom of the card (e.g. token usage, duration). Ignored when sending as plain text.'
          ),
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
    async ({ chat_id, text, reply_to, thread_id, format, footer, files }) => {
      // Auto-correct reply_to from the plugin's per-thread tracker when Claude
      // omits it but passes thread_id. Explicit reply_to from Claude always wins.
      let effectiveReplyTo = reply_to;
      if (!effectiveReplyTo && thread_id && latestMessageTracker) {
        const latest = latestMessageTracker.getLatest(chat_id, thread_id);
        if (latest) {
          effectiveReplyTo = latest.messageId;
          console.error(
            `[tools] Auto-filled reply_to=${latest.messageId} for thread ${thread_id}`
          );
        }
      }

      // Dispatch: card path vs plain-text path
      const useCard =
        format === 'card' || (format !== 'text' && shouldUseCard(text));

      let sentCount = 0;

      if (useCard) {
        const cards = buildCards(text, { footer });
        sentCount = cards.length;
        for (let i = 0; i < cards.length; i++) {
          const content = JSON.stringify(cards[i]);
          try {
            let resp: any;
            if (i === 0 && effectiveReplyTo) {
              resp = await client.im.v1.message.reply({
                path: { message_id: effectiveReplyTo },
                data: { content, msg_type: 'interactive' },
              });
            } else {
              resp = await client.im.v1.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                  receive_id: chat_id,
                  content,
                  msg_type: 'interactive',
                },
              });
            }
            const sentId = resp?.data?.message_id;
            if (sentId && botMessageTracker) botMessageTracker.add(sentId);
          } catch (err: any) {
            const apiError = err?.response?.data ?? err?.data;
            if (apiError?.code && apiError?.msg) {
              console.error(
                `[tools] Feishu API error [${apiError.code}]: ${apiError.msg}`
              );
              throw new Error(
                `Feishu API [${apiError.code}]: ${apiError.msg}`
              );
            }
            console.error(
              `[tools] send card failed:`,
              err?.message ?? String(err)
            );
            throw err;
          }
        }
      } else {
        // Plain-text path (existing behavior)
        const chunks = chunkText(text, appConfig.textChunkLimit);
        sentCount = chunks.length;
        for (let i = 0; i < chunks.length; i++) {
          try {
            let resp: any;
            if (effectiveReplyTo && i === 0) {
              resp = await client.im.v1.message.reply({
                path: { message_id: effectiveReplyTo },
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
              console.error(
                `[tools] Feishu API error [${apiError.code}]: ${apiError.msg}`
              );
              throw new Error(
                `Feishu API [${apiError.code}]: ${apiError.msg}`
              );
            }
            console.error(
              `[tools] send message failed:`,
              err?.message ?? String(err)
            );
            throw err;
          }
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

      // Revoke ack reaction — try effective reply_to first, then scan all pending acks
      if (ackReactions && ackReactions.size > 0) {
        const msgId = effectiveReplyTo || '';
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
        content: [{ type: 'text' as const, text: `Sent ${sentCount} message(s)` }],
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

  // ── create_job ──
  server.registerTool(
    'create_job',
    {
      description:
        'Create a scheduled cronjob. Use type="message" for fixed content (deterministic) or type="prompt" for Claude-executed tasks (best-effort). For critical notifications use message type.',
      inputSchema: z.object({
        name: z.string().describe('Job display name (can be Chinese)'),
        type: z.enum(['prompt', 'message']).describe('Job type'),
        schedule: z
          .string()
          .describe(
            'Cron expression or alias: "0 9 * * 1-5", "every 30m", "daily at 09:00", "weekdays at 09:00", "weekly on mon at 09:00"'
          ),
        prompt: z
          .string()
          .optional()
          .describe('Prompt for Claude to execute (type=prompt)'),
        content: z
          .string()
          .optional()
          .describe('Fixed message content (type=message)'),
        target_chat_id: z.string().describe('Chat ID to send results to'),
        created_by: z
          .string()
          .optional()
          .describe('Creator open_id (auto-filled from channel context if omitted)'),
      }),
    },
    async ({ name, type, schedule, prompt, content, target_chat_id, created_by }) => {
      // Validate type-specific fields
      if (type === 'prompt' && !prompt) {
        return {
          content: [{ type: 'text' as const, text: 'prompt is required for type=prompt' }],
          isError: true,
        };
      }
      if (type === 'message' && !content) {
        return {
          content: [{ type: 'text' as const, text: 'content is required for type=message' }],
          isError: true,
        };
      }

      // Expand schedule alias and validate
      let cron: string;
      let scheduleHuman: string;
      try {
        const expanded = expandSchedule(schedule);
        cron = expanded.cron;
        scheduleHuman = expanded.human;
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid schedule expression: ${err?.message ?? schedule}`,
            },
          ],
          isError: true,
        };
      }

      // Generate ID
      const id = sanitizeJobId(name);
      if (await jobExists(id)) {
        return {
          content: [
            { type: 'text' as const, text: `Job "${id}" already exists. Use a different name or delete the existing job first.` },
          ],
          isError: true,
        };
      }

      const nextRunAt = computeNextRun(cron);

      const job: JobFile = {
        meta: {
          id,
          name,
          type,
          schedule: cron,
          schedule_human: scheduleHuman,
          ...(type === 'prompt' ? { prompt } : { content, msg_type: 'text' }),
          target_chat_id,
          status: 'active',
          created_by: created_by ?? '',
          created_at: new Date().toISOString(),
        },
        runtime: {
          last_run_at: null,
          next_run_at: nextRunAt,
          run_count: 0,
          last_error: null,
        },
      };

      await writeJob(job);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Created job "${id}" (${scheduleHuman}). Next run: ${nextRunAt}`,
          },
        ],
      };
    }
  );

  // ── list_jobs ──
  server.registerTool(
    'list_jobs',
    {
      description: 'List all cronjobs and their status.',
      inputSchema: z.object({
        status: z
          .enum(['active', 'paused', 'all'])
          .optional()
          .default('all')
          .describe('Filter by status'),
      }),
    },
    async ({ status }) => {
      const jobs = await listAllJobs();
      const filtered =
        status === 'all' ? jobs : jobs.filter((j) => j.meta.status === status);

      if (filtered.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No jobs found.' }],
        };
      }

      const lines = filtered.map((j) => {
        const statusIcon = j.meta.status === 'active' ? '✅' : '⏸️';
        const lastRun = j.runtime.last_run_at
          ? new Date(j.runtime.last_run_at).toLocaleString()
          : 'never';
        const error = j.runtime.last_error ? ` ⚠️ ${j.runtime.last_error}` : '';
        return `${statusIcon} **${j.meta.id}** (${j.meta.type}) — ${j.meta.schedule_human}\n   Next: ${j.runtime.next_run_at} | Last: ${lastRun} | Runs: ${j.runtime.run_count}${error}`;
      });

      return {
        content: [{ type: 'text' as const, text: lines.join('\n\n') }],
      };
    }
  );

  // ── update_job ──
  server.registerTool(
    'update_job',
    {
      description:
        'Update a cronjob — change schedule, content, pause, or resume.',
      inputSchema: z.object({
        id: z.string().describe('Job ID'),
        status: z.enum(['active', 'paused']).optional().describe('Set status'),
        schedule: z.string().optional().describe('New cron expression or alias'),
        prompt: z.string().optional().describe('New prompt (type=prompt)'),
        content: z.string().optional().describe('New content (type=message)'),
        name: z.string().optional().describe('New display name'),
      }),
    },
    async ({ id, status, schedule, prompt, content, name }) => {
      const job = await readJob(id);
      if (!job) {
        return {
          content: [{ type: 'text' as const, text: `Job "${id}" not found.` }],
          isError: true,
        };
      }

      if (name !== undefined) job.meta.name = name;
      if (prompt !== undefined) job.meta.prompt = prompt;
      if (content !== undefined) job.meta.content = content;

      // Update schedule if provided
      if (schedule !== undefined) {
        try {
          const expanded = expandSchedule(schedule);
          job.meta.schedule = expanded.cron;
          job.meta.schedule_human = expanded.human;
          job.runtime.next_run_at = computeNextRun(expanded.cron);
        } catch (err: any) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid schedule: ${err?.message ?? schedule}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Update status
      if (status !== undefined) {
        job.meta.status = status;
        if (status === 'active' && !schedule) {
          // Recompute next_run_at when resuming
          job.runtime.next_run_at = computeNextRun(job.meta.schedule);
        }
      }

      await writeJob(job);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated job "${id}". Status: ${job.meta.status}, Next run: ${job.runtime.next_run_at}`,
          },
        ],
      };
    }
  );

  // ── delete_job ──
  server.registerTool(
    'delete_job',
    {
      description: 'Delete a cronjob permanently.',
      inputSchema: z.object({
        id: z.string().describe('Job ID to delete'),
      }),
    },
    async ({ id }) => {
      const deleted = await deleteJobFile(id);
      if (!deleted) {
        return {
          content: [{ type: 'text' as const, text: `Job "${id}" not found.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: `Deleted job "${id}".` }],
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
