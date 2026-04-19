import { z } from 'zod';
import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from './config.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryStore } from './memory/file.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { BotMessageTracker, LatestMessageTracker, LarkChannel } from './channel.js';
import type { IdentitySession } from './identity-session.js';
import { audit } from './audit-log.js';
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
 * Register all MCP tools on the server.
 */
export function registerTools(
  server: McpServer,
  client: Lark.Client,
  memoryStore: MemoryStore,
  identitySession: IdentitySession,
  channel: LarkChannel,
  conversationBuffer?: ConversationBuffer,
  ackReactions?: Map<string, string>,
  botMessageTracker?: BotMessageTracker,
  latestMessageTracker?: LatestMessageTracker
): void {
  /**
   * Resolve the true caller for a sensitive tool invocation via the server-side
   * IdentitySession. Returns either `{ caller }` on success or `{ error }` —
   * an MCP tool result to return directly — on failure. This deliberately
   * ignores any Claude-declared identity parameters.
   *
   * Denials are audit-logged here so callers only need to log 'ok' in their
   * success path.
   */
  function resolveCaller(
    toolName: string,
    chat_id: string | undefined,
    thread_id: string | undefined,
    args: Record<string, unknown>,
  ):
    | { caller: string }
    | { error: { isError: true; content: { type: 'text'; text: string }[] } } {
    if (!chat_id) {
      void audit(toolName, null, args, 'denied');
      return {
        error: {
          isError: true,
          content: [{ type: 'text' as const, text: 'chat_id is required for this tool' }],
        },
      };
    }
    const caller = identitySession.getCaller(chat_id, thread_id);
    if (!caller) {
      void audit(toolName, null, args, 'denied');
      return {
        error: {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `No active identity session for chat ${chat_id}. This tool requires an inbound Feishu message to establish caller identity, or a terminal invocation with LARK_OWNER_OPEN_ID set.`,
            },
          ],
        },
      };
    }
    return { caller };
  }
  // ── 1. reply ──
  server.registerTool(
    'reply',
    {
      description:
        'Send a reply to a Feishu chat. Plain text by default; long or markdown-rich content auto-renders as a Feishu card. Pass "card" param with raw Schema 2.0 JSON to send a pre-built card directly.',
      inputSchema: z.object({
        chat_id: z.string().describe('The chat ID to reply in'),
        text: z.string().describe('The text content to send (ignored when card is provided)'),
        card: z
          .string()
          .optional()
          .describe(
            'Raw Feishu Schema 2.0 card JSON string. When provided, sends the card directly without buildCards conversion. Use this for pre-built cards from scripts/skills.'
          ),
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
          .describe('Optional attachments (ignored when card is provided)'),
      }),
    },
    async ({ chat_id, text, card, reply_to, thread_id, format, footer, files }) => {
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

      // Helper: record in buffer + revoke ack (shared by card & normal paths)
      function recordAndRevokeAck(replyText: string) {
        conversationBuffer?.record(chat_id, {
          role: 'assistant',
          senderId: 'bot',
          text: replyText.slice(0, 500),
          timestamp: new Date().toISOString(),
        });

        if (ackReactions && ackReactions.size > 0) {
          const msgId = effectiveReplyTo || '';
          const reactionId = msgId ? ackReactions.get(msgId) : undefined;
          if (reactionId) {
            ackReactions.delete(msgId);
            client.im.v1.messageReaction.delete({
              path: { message_id: msgId, reaction_id: reactionId },
            }).catch(() => {});
          } else {
            for (const [mid, rid] of ackReactions.entries()) {
              ackReactions.delete(mid);
              client.im.v1.messageReaction.delete({
                path: { message_id: mid, reaction_id: rid },
              }).catch(() => {});
            }
          }
        }
      }

      // Raw card JSON path — bypass buildCards entirely
      if (card) {
        let cardObj: object;
        try {
          cardObj = JSON.parse(card);
        } catch {
          return {
            content: [{ type: 'text' as const, text: 'Invalid card JSON' }],
            isError: true,
          };
        }
        const content = JSON.stringify(cardObj);
        try {
          let resp: any;
          if (effectiveReplyTo) {
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
            console.error(`[tools] Feishu API error [${apiError.code}]: ${apiError.msg}`);
            throw new Error(`Feishu API [${apiError.code}]: ${apiError.msg}`);
          }
          throw err;
        }

        recordAndRevokeAck((text || '[card]'));

        return {
          content: [{ type: 'text' as const, text: 'Sent 1 card message' }],
        };
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

      recordAndRevokeAck(text);

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
        // Always use messageResource.get for user-uploaded resources.
        // image.get only works for images the bot itself uploaded.
        // Route type by key prefix: img_* → image, otherwise → file.
        const resourceType = file_key.startsWith('img_') ? 'image' : 'file';
        const data: any = await client.im.v1.messageResource.get({
          path: { message_id, file_key },
          params: { type: resourceType },
        });
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
        'Save a memory entry for cross-session recall. Only save durable, reusable facts — user preferences, communication style, key decisions, ongoing projects, resolved problems. Do NOT save pleasantries, failed attempts, ephemeral details, or conversation filler. Profile writes always save facts about the CALLER of this tool (i.e. the Feishu user whose message triggered the current turn) — you cannot save profile facts about a different user. For profile writes, pass tier="public" only for facts that are safe for anyone mentioning this user to see (job title, tech stack, team); everything else defaults to "private" (owner-only).',
      inputSchema: z.object({
        type: z
          .enum(['profile', 'chat', 'thread'])
          .describe(
            'Memory type: "profile" for facts about the caller, "chat" for conversation summary, "thread" for thread-level summary'
          ),
        content: z.string().describe('The memory content to save (concise, factual)'),
        reason: z.string().describe('Why this is worth remembering'),
        chat_id: z.string().describe('Chat ID — required; also used to resolve caller identity'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — both for server-side caller resolution (omitting it silently attributes the call to the wrong user in cronjob turns) and when type="thread".'
          ),
        tier: z
          .enum(['public', 'private'])
          .optional()
          .describe(
            'Profile tier (type="profile" only). "public": safe for others to see when they @mention this user (job title, tech stack, team). "private": owner-only (preferences, ongoing work, emotional state, etc.). Defaults to "private" when omitted — err on the side of less exposure.'
          ),
      }),
    },
    async ({ type, content, reason, chat_id, thread_id, tier }) => {
      const auditArgs = { type, chat_id, thread_id, tier };
      const auth = resolveCaller('save_memory', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      if (type === 'profile') {
        const effectiveTier = tier ?? 'private';
        await memoryStore.saveProfile(caller, content, effectiveTier);
        void audit('save_memory', caller, auditArgs, 'ok');
        return {
          content: [
            { type: 'text' as const, text: `Saved ${effectiveTier} profile for ${caller}. Reason: ${reason}` },
          ],
        };
      }

      await memoryStore.saveEpisode(type, content, {
        chatId: chat_id,
        threadId: thread_id,
      });
      void audit('save_memory', caller, auditArgs, 'ok');

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
    async ({ name, description, content }) => {
      await memoryStore.saveSkill(name, description, content);
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
        'Create a scheduled cronjob. Use type="message" for fixed content (deterministic) or type="prompt" for Claude-executed tasks (best-effort). For critical notifications use message type. The creator identity is derived from the server-side session — you cannot create a job "on behalf of" another user.',
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
        target_chat_id: z
          .string()
          .describe('Chat ID that receives job output. Used by scheduler delivery and list_jobs visibility filter.'),
        chat_id: z
          .string()
          .describe('Chat ID where this create_job call was triggered — used to resolve caller identity and to populate origin_chat_id'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
      }),
    },
    async ({ name, type, schedule, prompt, content, target_chat_id, chat_id, thread_id }) => {
      const auditArgs = { name, type, schedule, target_chat_id, chat_id, thread_id };
      const auth = resolveCaller('create_job', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

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
          origin_chat_id: chat_id,
          status: 'active',
          created_by: caller,
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
      void audit('create_job', caller, auditArgs, 'ok');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Created job "${id}" (${scheduleHuman}, tz=${appConfig.cronTimezone}). Next run: ${nextRunAt}`,
          },
        ],
      };
    }
  );

  // ── list_jobs ──
  server.registerTool(
    'list_jobs',
    {
      description:
        'List cronjobs visible in the current chat. Filter follows the rendering-visibility principle: in a private chat the caller sees all jobs they created; in a group chat everyone sees jobs that deliver output to that group (with prompt bodies redacted for non-owners).',
      inputSchema: z.object({
        status: z
          .enum(['active', 'paused', 'all'])
          .optional()
          .default('all')
          .describe('Filter by status'),
        chat_id: z.string().describe('Chat ID where this list call is acting from'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
      }),
    },
    async ({ status, chat_id, thread_id }) => {
      const auditArgs = { status, chat_id, thread_id };
      const auth = resolveCaller('list_jobs', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const jobs = await listAllJobs();
      const byStatus =
        status === 'all' ? jobs : jobs.filter((j) => j.meta.status === status);

      const isPrivate = channel.isPrivateChat(chat_id);
      const visible = byStatus.filter((j) => {
        if (isPrivate) return j.meta.created_by === caller;
        return j.meta.target_chat_id === chat_id;
      });

      if (visible.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No jobs found.' }],
        };
      }

      const lines = visible.map((j) => {
        const statusIcon = j.meta.status === 'active' ? '✅' : '⏸️';
        const lastRun = j.runtime.last_run_at
          ? new Date(j.runtime.last_run_at).toLocaleString()
          : 'never';
        const error = j.runtime.last_error ? ` ⚠️ ${j.runtime.last_error}` : '';
        const isOwner = j.meta.created_by === caller;

        // Group audit view — redact free-form content for non-owners.
        // Keep created_by and schedule so the group retains accountability.
        if (!isPrivate && !isOwner) {
          return `${statusIcon} **${j.meta.id}** (${j.meta.type}) — ${j.meta.schedule_human}\n   By: ${j.meta.created_by} | Next: ${j.runtime.next_run_at}`;
        }
        return `${statusIcon} **${j.meta.id}** (${j.meta.type}) — ${j.meta.schedule_human}\n   Next: ${j.runtime.next_run_at} | Last: ${lastRun} | Runs: ${j.runtime.run_count}${error}`;
      });

      void audit('list_jobs', caller, auditArgs, 'ok');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Timezone: ${appConfig.cronTimezone}\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    }
  );

  // ── update_job ──
  server.registerTool(
    'update_job',
    {
      description:
        'Update a cronjob — change schedule, content, pause, or resume. Only the job owner can mutate a job.',
      inputSchema: z.object({
        id: z.string().describe('Job ID'),
        status: z.enum(['active', 'paused']).optional().describe('Set status'),
        schedule: z.string().optional().describe('New cron expression or alias'),
        prompt: z.string().optional().describe('New prompt (type=prompt)'),
        content: z.string().optional().describe('New content (type=message)'),
        name: z.string().optional().describe('New display name'),
        chat_id: z.string().describe('Chat ID where this update call is acting from'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
      }),
    },
    async ({ id, status, schedule, prompt, content, name, chat_id, thread_id }) => {
      const auditArgs = { id, status, schedule, name, chat_id, thread_id };
      const auth = resolveCaller('update_job', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const job = await readJob(id);
      if (!job) {
        return {
          content: [{ type: 'text' as const, text: `Job "${id}" not found.` }],
          isError: true,
        };
      }
      if (job.meta.created_by !== caller) {
        void audit('update_job', caller, auditArgs, 'denied');
        return {
          content: [
            {
              type: 'text' as const,
              text: `You are not the owner of "${id}". Only ${job.meta.created_by} can update it.`,
            },
          ],
          isError: true,
        };
      }

      // Validate schedule first (before mutating any fields) so a bad
      // schedule returns an error with the job left untouched.
      let expandedSchedule: { cron: string; human: string } | null = null;
      if (schedule !== undefined) {
        try {
          expandedSchedule = expandSchedule(schedule);
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

      // All inputs validated — apply updates
      if (name !== undefined) job.meta.name = name;
      if (prompt !== undefined) job.meta.prompt = prompt;
      if (content !== undefined) job.meta.content = content;
      if (expandedSchedule) {
        job.meta.schedule = expandedSchedule.cron;
        job.meta.schedule_human = expandedSchedule.human;
        job.runtime.next_run_at = computeNextRun(expandedSchedule.cron);
      }
      if (status !== undefined) {
        job.meta.status = status;
        if (status === 'active' && !schedule) {
          // Recompute next_run_at when resuming
          job.runtime.next_run_at = computeNextRun(job.meta.schedule);
        }
      }

      await writeJob(job);
      void audit('update_job', caller, auditArgs, 'ok');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated job "${id}". Status: ${job.meta.status}, Next run: ${job.runtime.next_run_at} (tz=${appConfig.cronTimezone})`,
          },
        ],
      };
    }
  );

  // ── delete_job ──
  server.registerTool(
    'delete_job',
    {
      description: 'Delete a cronjob permanently. Only the job owner can delete.',
      inputSchema: z.object({
        id: z.string().describe('Job ID to delete'),
        chat_id: z.string().describe('Chat ID where this delete call is acting from'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
      }),
    },
    async ({ id, chat_id, thread_id }) => {
      const auditArgs = { id, chat_id, thread_id };
      const auth = resolveCaller('delete_job', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const existing = await readJob(id);
      if (!existing) {
        return {
          content: [{ type: 'text' as const, text: `Job "${id}" not found.` }],
          isError: true,
        };
      }
      if (existing.meta.created_by !== caller) {
        void audit('delete_job', caller, auditArgs, 'denied');
        return {
          content: [
            {
              type: 'text' as const,
              text: `You are not the owner of "${id}". Only ${existing.meta.created_by} can delete it.`,
            },
          ],
          isError: true,
        };
      }

      const deleted = await deleteJobFile(id);
      if (!deleted) {
        return {
          content: [{ type: 'text' as const, text: `Job "${id}" not found.` }],
          isError: true,
        };
      }
      void audit('delete_job', caller, auditArgs, 'ok');
      return {
        content: [{ type: 'text' as const, text: `Deleted job "${id}".` }],
      };
    }
  );

  // ── what_do_you_know ──
  server.registerTool(
    'what_do_you_know',
    {
      description:
        "List what the bot has stored in the caller's profile. Output is filtered by current-chat rendering visibility (path B): in a private chat both public and private tiers are rendered; in a group chat only the public tier — because the reply is visible to the whole group. Each returned line has a short hash that forget_memory uses to target the exact line.",
      inputSchema: z.object({
        chat_id: z.string().describe('Chat ID where this call is acting from'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
      }),
    },
    async ({ chat_id, thread_id }) => {
      const auditArgs = { chat_id, thread_id };
      const auth = resolveCaller('what_do_you_know', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const isPrivate = channel.isPrivateChat(chat_id);
      const pub = await memoryStore.listProfileLines(caller, 'public');
      const priv = isPrivate ? await memoryStore.listProfileLines(caller, 'private') : [];

      const renderSection = (tier: string, lines: { hash: string; text: string }[]) =>
        lines.length === 0
          ? `_${tier}: (empty)_`
          : `**${tier}:**\n${lines.map((l) => `- [${l.hash}] ${l.text}`).join('\n')}`;

      const parts = [renderSection('public', pub)];
      if (isPrivate) parts.push(renderSection('private', priv));

      const footer = isPrivate
        ? '\n\n_Use `forget_memory(hash, tier)` to remove a line._'
        : '\n\n_Private tier hidden in this group. Ask in private chat to see both tiers._';

      void audit('what_do_you_know', caller, auditArgs, 'ok');
      return {
        content: [
          {
            type: 'text' as const,
            text: `What I've stored about you:\n\n${parts.join('\n\n')}${footer}`,
          },
        ],
      };
    }
  );

  // ── forget_memory ──
  server.registerTool(
    'forget_memory',
    {
      description:
        "Remove a specific line from the caller's profile. Always caller-scoped — you can only forget things about yourself. Optionally promotes the removed line into a persistent L2 rule so future distillations classify similar content as private.",
      inputSchema: z.object({
        chat_id: z.string().describe('Chat ID where this call is acting from'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
        hash: z.string().describe('Short 8-char line hash obtained from what_do_you_know'),
        tier: z
          .enum(['public', 'private'])
          .default('public')
          .describe('Which tier the line lives in. Default "public" since that is where misclassifications are externally visible.'),
        promote_to_rule: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, also append the removed line's text to privacy-rules.md under '## Always private' so future distillations classify similar content as private. Use when the removal reflects a durable preference ('I never want anything like this public') rather than a one-off cleanup."
          ),
      }),
    },
    async ({ chat_id, thread_id, hash, tier, promote_to_rule }) => {
      const auditArgs = { chat_id, thread_id, hash, tier, promote_to_rule };
      const auth = resolveCaller('forget_memory', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const lines = await memoryStore.listProfileLines(caller, tier);
      const target = lines.find((l) => l.hash === hash);
      if (!target) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `No line with hash "${hash}" in ${tier} tier. Call what_do_you_know to list current lines.`,
            },
          ],
        };
      }

      const removed = await memoryStore.removeProfileLine(caller, tier, hash);
      if (!removed) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Failed to remove line "${hash}".` }],
        };
      }

      // Line removal above is the primary effect; rule promotion is
      // a best-effort enhancement. If addL2Rule fails, don't undo the
      // removal — just report the partial outcome so the user knows.
      let tail = '';
      if (promote_to_rule) {
        try {
          const { addL2Rule } = await import('./privacy-rules.js');
          await addL2Rule(target.text, 'Always private');
          tail = ' Also appended to privacy-rules.md under "Always private" — future distillations will classify similar content accordingly.';
        } catch (err) {
          tail = ` (Warning: removal succeeded but failed to append rule to privacy-rules.md: ${err instanceof Error ? err.message : String(err)}. You can add the rule manually.)`;
        }
      }

      void audit('forget_memory', caller, auditArgs, 'ok');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Removed "${target.text}" from ${tier} profile.${tail}`,
          },
        ],
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
