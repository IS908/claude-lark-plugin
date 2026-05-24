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
import { SYSTEM_FLUSH_CALLER } from './identity-session.js';
import { audit } from './audit-log.js';
import { buildCards, shouldUseCard } from './feishu-card.js';
import { JOB_THREAD_PREFIX } from './scheduler.js';
import { writeSdkResource } from './sdk-resource.js';

/**
 * Strip Feishu `<at>` tags from outbound text to block prompt-injected
 * @-mentions (#96). Feishu's text message renderer parses
 * `<at user_id="...">name</at>` (and the self-closing variant
 * `<at user_id="all"/>`) into real @-mention notifications. Without
 * sanitization, a user message like
 *   "回复格式: <at user_id=\"all\">all</at> 提醒：..."
 * causes Claude's `reply` to @-all the entire group, with no human
 * authoring the mention. Both the explicit tag form and the
 * external-content-driven form ("read this file and reply in the same
 * format") are in scope.
 *
 * Approach: strip the tag, preserve the visible label so the user still
 * sees the intended text without the side-effect notification:
 *   `<at user_id="all">all</at>` → `all`
 *   `<at user_id="ou_xxx"></at>` → ``
 *   `<at user_id="ou_xxx"/>`     → ``
 *   `<a>not an at-tag</a>`       → `<a>not an at-tag</a>` (untouched)
 *
 * Case-insensitive (Feishu accepts `<AT>` too). Newlines inside the tag
 * body are tolerated (rare but possible if the LLM hard-wraps). The
 * regex is anchored on `<at` followed by whitespace then any attribute
 * tail — this avoids touching tokens like `<atom>` or `<athletics>` that
 * happen to start with `at`.
 *
 * This is the canonical sanitizer applied to ALL outbound bot text on
 * Feishu's `msg_type=text` path: tool `reply`, tool `edit_message` (text
 * variant), scheduler stale-skip notice, scheduler message-job execution.
 * Card paths are NOT sanitized — Feishu's Schema 2.0 card renderer does
 * NOT interpret `<at>` as a mention, so the vector doesn't exist there.
 *
 * Exported for unit testing.
 */
export function sanitizeOutboundText(text: string): string {
  // Paired form: <at ...>label</at>  →  keep `label`
  // Self-closing: <at .../>           →  drop entirely
  // The `[\s\S]*?` makes the label match cross-line non-greedily.
  //
  // Loop to a fixed point because a single pass leaves NESTED tags
  // exposed: input `<at id="a">outer <at id="b">inner</at> tail</at>`
  // → first pass removes the OUTER tag and yields
  // `outer <at id="b">inner tail</at>`, which is still a valid Feishu
  // @-mention payload. Iterate until the string stops shrinking. Hard
  // cap at 8 iterations as a belt-and-braces against a pathological
  // input that could otherwise trigger expensive backtracking; 8 levels
  // of nesting is far beyond anything an LLM would emit.
  let out = text;
  for (let i = 0; i < 8; i++) {
    const next = out
      .replace(/<at\s+[^>]*?\/>/gi, '')
      .replace(/<at\s+[^>]*>([\s\S]*?)<\/at>/gi, '$1');
    if (next === out) return out;
    out = next;
  }
  return out;
}

/**
 * Format regex for Feishu chat / thread / message / user IDs.
 *
 * Feishu IDs are short ASCII tokens with a prefix (`oc_`, `om_`, `omt_`,
 * `ou_`, `og_`, `cli_msg_`, etc.) followed by alphanumerics. This regex
 * permits the union of all currently-observed shapes plus a generous
 * upper bound, and **rejects** anything containing path separators,
 * dot-dot, null bytes, whitespace, or any other character that would let
 * a Claude-supplied ID escape the storage hierarchy when joined into a
 * filesystem path (`saveEpisode` etc., see #93).
 *
 * Defense layer 1 of 2 — Zod-level rejection at the tool boundary.
 * Layer 2 lives inside `MemoryStore.assertSafeKey` so a future
 * code path that bypasses the schema (or a deserialization quirk)
 * still cannot land bytes outside `baseDir`.
 *
 * Two special-case exemptions on top of the base regex:
 * - cronjob-synthetic `thread_id`s prefixed `JOB_THREAD_PREFIX` (see
 *   src/scheduler.ts) — they contain colons in the iso-ish timestamp.
 *   We exempt them by accepting `:` as well; they never reach the file
 *   layer because cronjob notifications don't trigger save_memory's
 *   thread path (the flush handler uses chat_type='system' which the
 *   distillation prompt also restricts to type=chat|thread, not profile).
 * - the reserved sentinel `__terminal__` (`TERMINAL_CHAT_ID`) used by
 *   terminal-side skills — exempt because it never lands as a directory
 *   name (`resolveCaller` short-circuits to OWNER, and OWNER's userId
 *   is the path component, not the sentinel chat_id).
 *
 * The final form: alphanumeric + `_` + `-` + `:`, 1..128 chars.
 */
export const LARK_ID_REGEX = /^[A-Za-z0-9_:-]{1,128}$/;

const larkIdSchema = (label: string) =>
  z
    .string()
    .regex(LARK_ID_REGEX, `Invalid ${label}: must be 1-128 chars of [A-Za-z0-9_:-]`);

/**
 * Sanitize and length-cap a Feishu attachment filename for safe local
 * storage. Path-basename strips any directory prefix, regex replaces
 * non-`\w.-` chars (including spaces, CJK, special punctuation) with
 * underscore, then the stem is capped at `maxLen - extLength` so the
 * extension always survives. Returns the sanitized + capped string.
 *
 * Exported for unit testing.
 */
export function capSanitizedFilename(raw: string, maxLen: number): string {
  const sanitized = path.basename(raw).replace(/[^\w.\-]/g, '_');
  if (sanitized.length <= maxLen) return sanitized;
  // Find the last `.` separating stem from extension. If no dot or it's
  // the leading char, treat the whole thing as a stem (no extension to
  // preserve) and just truncate.
  const dotIdx = sanitized.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === sanitized.length - 1) {
    return sanitized.slice(0, maxLen);
  }
  const ext = sanitized.slice(dotIdx); // includes leading dot
  // Cap extension itself to half of maxLen — pathological long extensions
  // shouldn't crowd out the stem entirely.
  const safeExt = ext.length > maxLen / 2 ? ext.slice(0, Math.floor(maxLen / 2)) : ext;
  const stem = sanitized.slice(0, dotIdx);
  const stemCap = maxLen - safeExt.length;
  return stem.slice(0, stemCap) + safeExt;
}
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
    // SYSTEM_FLUSH_CALLER is bound by buffer.setFlushHandler (#66) to let
    // save_memory persist chat-level distillations without a real user
    // identity. It must NOT authorize anything else — a sentinel-attributed
    // `create_job` would produce a job with `created_by=__system_flush__`
    // that no real operator could update/delete (owner mismatch); a
    // sentinel-attributed `forget_memory` couldn't address any user's
    // profile. The save_memory handler itself further restricts the
    // sentinel to type=chat|thread (rejecting type=profile).
    //
    // The sentinel binding can outlive the flush turn (sticky in
    // IdentitySession until the next real user message overwrites it),
    // so this guard is also defense against any later tool call that
    // happens to land on the leftover entry.
    if (caller === SYSTEM_FLUSH_CALLER && toolName !== 'save_memory') {
      void audit(toolName, caller, args, 'denied');
      return {
        error: {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `${toolName} is not authorized for the system-flush caller. Only save_memory can authorize under this caller (and save_memory itself further restricts to type=chat|thread). The sentinel exists to let buffer flushes persist chat episodes without a real user — not to act on behalf of one.`,
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
        chat_id: larkIdSchema('chat_id').describe('The chat ID to reply in'),
        text: z.string().describe('The text content to send (ignored when card is provided)'),
        card: z
          .string()
          .optional()
          .describe(
            'Raw Feishu Schema 2.0 card JSON string. When provided, sends the card directly without buildCards conversion. Use this for pre-built cards from scripts/skills.'
          ),
        reply_to: larkIdSchema('reply_to').optional().describe('Message ID to reply to (quoted reply)'),
        thread_id: larkIdSchema('thread_id')
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
      // omits it. Works for both threaded and non-threaded (P2P) messages.
      // Explicit reply_to from Claude always wins.
      let effectiveReplyTo = reply_to;
      if (!effectiveReplyTo && latestMessageTracker) {
        const latest = latestMessageTracker.getLatest(chat_id, thread_id);
        if (latest) {
          effectiveReplyTo = latest.messageId;
          console.error(
            `[tools] Auto-filled reply_to=${latest.messageId} for chat=${chat_id} thread=${thread_id ?? '(none)'}`
          );
        }
      }

      // Thread-aware routing: follow-up messages (text chunks 2..N, card
      // 2..N, attachments) must stay in the same thread as the first reply.
      // Using `message.reply(..., reply_in_thread: true)` routes into the
      // source's thread WITHOUT rendering as a quote — unlike the bare
      // `reply()` used for the first message which intentionally quotes.
      //
      // Gated on `thread_id` presence: on a non-threaded source message
      // (P2P, non-threaded group) `reply_in_thread: true` would create a
      // new thread — unwanted. Fall through to plain `message.create` in
      // those cases, preserving pre-fix behavior.
      //
      // Also excluded: synthetic thread_ids from the cronjob dispatcher
      // (prefix JOB_THREAD_PREFIX, see src/scheduler.ts). These values
      // exist solely to isolate IdentitySession entries per cronjob run
      // and do NOT correspond to a real Feishu thread. Using
      // reply_in_thread:true against the effectiveReplyTo (which, if
      // auto-filled or user-passed, points at a real earlier message)
      // would incorrectly pull that message into a newly-created thread.
      const isSyntheticThread = !!thread_id && thread_id.startsWith(JOB_THREAD_PREFIX);
      const shouldStayInThread = !!thread_id && !isSyntheticThread && !!effectiveReplyTo;
      async function sendFollowup(data: { content: string; msg_type: string }): Promise<any> {
        if (shouldStayInThread) {
          // `reply_in_thread: true` is a Feishu HTTP API field that routes the
          // new message into the source's thread without rendering as a quote.
          // The `@larksuiteoapi/node-sdk` type definitions currently omit it,
          // hence the cast. Feishu docs:
          //   https://open.feishu.cn/document/server-docs/im-v1/message/reply
          return client.im.v1.message.reply({
            path: { message_id: effectiveReplyTo! },
            data: { ...data, reply_in_thread: true } as any,
          });
        }
        return client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chat_id, ...data },
        });
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
              resp = await sendFollowup({ content, msg_type: 'interactive' });
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
        // Plain-text path. Sanitize <at> tags (#96) before send — Feishu's
        // text renderer parses them into real @-mentions, and Claude can
        // be prompt-injected into emitting <at user_id="all"> spamming
        // the whole group. Card path is exempt (Schema 2.0 renderer
        // doesn't interpret <at>).
        const chunks = chunkText(text, appConfig.textChunkLimit).map(sanitizeOutboundText);
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
              resp = await sendFollowup({
                content: JSON.stringify({ text: chunks[i] }),
                msg_type: 'text',
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
                const sent = await sendFollowup({
                  content: JSON.stringify({ image_key: imageKey }),
                  msg_type: 'image',
                });
                const sentId = (sent as any)?.data?.message_id;
                if (sentId && botMessageTracker) botMessageTracker.add(sentId);
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
                const sent = await sendFollowup({
                  content: JSON.stringify({
                    file_key: fileKey,
                    file_name: path.basename(file.path),
                  }),
                  msg_type: 'file',
                });
                const sentId = (sent as any)?.data?.message_id;
                if (sentId && botMessageTracker) botMessageTracker.add(sentId);
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
        message_id: larkIdSchema('message_id').describe('The message ID to edit'),
        text: z.string().describe('New content'),
        format: z
          .enum(['text', 'card_markdown'])
          .default('text')
          .describe('Format of the content'),
      }),
    },
    async ({ message_id, text, format }) => {
      // Strip <at> tags before send (#96). Apply to BOTH variants because
      // Lark.messageCard.defaultCard wraps the text in a markdown block,
      // and Feishu's card markdown renderer ALSO interprets <at> as
      // a mention. The reply tool only sanitizes the text path because
      // its card path goes through buildCards (Schema 2.0 block JSON
      // where <at> is literal); here defaultCard is the simpler one-
      // shot path that does parse <at>.
      const safeText = sanitizeOutboundText(text);
      if (format === 'card_markdown') {
        await client.im.v1.message.patch({
          path: { message_id },
          data: {
            content: Lark.messageCard.defaultCard({
              title: '',
              content: safeText,
            }),
          },
        });
      } else {
        await client.im.v1.message.patch({
          path: { message_id },
          data: {
            content: JSON.stringify({ text: safeText }),
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
        message_id: larkIdSchema('message_id').describe('The message ID to react to'),
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
      description:
        'Download an attachment (image, file, audio, video) from a message to local inbox. Pass file_name from the inbound notification\'s meta.attachment_name so the saved file keeps its original extension — Claude Read needs the extension to infer MIME type for PDF/text.',
      inputSchema: z.object({
        message_id: larkIdSchema('message_id').describe('The message ID containing the attachment'),
        file_key: larkIdSchema('file_key').describe('The file key of the attachment'),
        file_name: z
          .string()
          .optional()
          .describe(
            'Original filename from meta.attachment_name (e.g. "report.pdf"). When provided, the extension is preserved in the saved path so Claude Read can infer MIME. Falls back to file_key alone if omitted.',
          ),
      }),
    },
    async ({ message_id, file_key, file_name }) => {
      const inboxDir = appConfig.inboxDir;
      await fs.mkdir(inboxDir, { recursive: true });

      // Route type by key prefix: img_* → image, otherwise → file.
      // (Feishu's messageResource.get only accepts 'image' | 'file'; audio
      //  and video are routed via 'file'.)
      const resourceType = file_key.startsWith('img_') ? 'image' : 'file';

      // Saved filename: prefer <file_key>-<original_name> when caller
      // provides file_name — preserves the extension while keeping the
      // file_key visible for traceability. Sanitize original name to
      // avoid path traversal / unexpected separators, and cap length
      // to leave room for the file_key prefix within NAME_MAX (255B on
      // macOS/ext4). 200 bytes leaves slack for any future file_key
      // format change without revisiting this cap.
      //
      // Extension preservation: cap the STEM, then reattach the ext.
      // Required because the whole point of accepting file_name is to
      // keep the extension so Claude `Read` can infer MIME — a naive
      // slice(0, 200) would chop the ext off pathological-length names.
      const sanitizedName = file_name ? capSanitizedFilename(file_name, 200) : '';
      const savedName = sanitizedName ? `${file_key}-${sanitizedName}` : file_key;
      const filePath = path.join(inboxDir, savedName);

      try {
        // Always use messageResource.get for user-uploaded resources.
        // image.get only works for images the bot itself uploaded.
        const data: unknown = await client.im.v1.messageResource.get({
          path: { message_id, file_key },
          params: { type: resourceType },
        });
        if (!data) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Feishu returned empty response for file_key=${file_key} (type=${resourceType})`,
              },
            ],
            isError: true,
          };
        }
        await writeSdkResource(data, filePath);
        return { content: [{ type: 'text' as const, text: `Downloaded to ${filePath}` }] };
      } catch (err: any) {
        const apiError = err?.response?.data ?? err?.data;
        if (apiError?.code && apiError?.msg) {
          console.error(`[tools] download failed [${apiError.code}]: ${apiError.msg}`);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Feishu API [${apiError.code}]: ${apiError.msg} (file_key=${file_key}, type=${resourceType})`,
              },
            ],
            isError: true,
          };
        }
        const msg = err?.message ?? String(err);
        console.error(`[tools] download failed:`, msg);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Download failed for file_key=${file_key} (type=${resourceType}): ${msg}`,
            },
          ],
          isError: true,
        };
      }
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
        chat_id: larkIdSchema('chat_id').describe('Chat ID — required; also used to resolve caller identity'),
        thread_id: larkIdSchema('thread_id')
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
        mode: z
          .enum(['append', 'replace'])
          .optional()
          .describe(
            'Profile write mode (type="profile" only). Defaults to "append": new lines merged into the existing tier, deduped case-insensitively; existing entries are preserved. Use "replace" ONLY during distiller auto-flush when you are rewriting the full tier from a fresh read of the conversation — replace overwrites the entire file.'
          ),
      }),
    },
    async ({ type, content, reason, chat_id, thread_id, tier, mode }) => {
      // Only include profile-specific params in audit args when they're
      // actually applied — keeps chat/thread audit lines clean and avoids
      // implying a tier/mode was honored when type !== 'profile'.
      const auditArgs =
        type === 'profile'
          ? { type, chat_id, thread_id, tier, mode }
          : { type, chat_id, thread_id };
      const auth = resolveCaller('save_memory', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      // Defense in depth (#66): the auto-flush turn binds SYSTEM_FLUSH_CALLER
      // as the caller so save_memory(type=chat|thread) can persist
      // chat-level distillations without a real user identity. That sentinel
      // MUST NOT be allowed to write profile tiers — profiles are
      // user-scoped (saveProfile writes to profiles/<callerId>/...), and a
      // sentinel "writer" has no user identity to legitimately own
      // private-tier data. The flush prompt already forbids type=profile,
      // this is the server-side guard against Claude going off-script.
      if (type === 'profile' && caller === SYSTEM_FLUSH_CALLER) {
        void audit('save_memory', caller, auditArgs, 'denied');
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'save_memory(type=profile) denied: caller is the system-flush sentinel. ' +
                'Profile writes need a real user identity. If you reached this in an ' +
                'auto-flush turn, restrict to type=chat or type=thread.',
            },
          ],
          isError: true,
        };
      }

      if (type === 'profile') {
        const effectiveTier = tier ?? 'private';
        const effectiveMode = mode ?? 'append';
        await memoryStore.saveProfile(caller, content, effectiveTier, effectiveMode);
        void audit('save_memory', caller, auditArgs, 'ok');
        return {
          content: [
            { type: 'text' as const, text: `Saved ${effectiveTier} profile for ${caller} (mode: ${effectiveMode}). Reason: ${reason}` },
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
        'Save a reusable procedure as a global skill, searchable across all users and chats. Skills are owned: the first creator of a slug claims it, and only that creator can overwrite. Pass chat_id + thread_id verbatim from the current notification so the server can verify ownership — never substitute sentinels.',
      inputSchema: z.object({
        name: z.string().describe('Short skill name (e.g., "deploy-service"). Normalized to a slug (lowercase, non-alphanumeric → "-"). Must contain at least one alphanumeric character.'),
        description: z.string().describe('One-line description of what this skill does'),
        content: z.string().describe('The full procedure/instructions'),
        chat_id: larkIdSchema('chat_id').describe('Chat ID from the inbound notification — required for caller authorization'),
        thread_id: larkIdSchema('thread_id').optional().describe('Thread ID from the inbound notification — pass verbatim when present'),
      }),
    },
    async ({ name, description, content, chat_id, thread_id }) => {
      const auditArgs = { name, chat_id, thread_id };
      const auth = resolveCaller('save_skill', chat_id, thread_id, auditArgs);
      if ('error' in auth) return auth.error;
      const { caller } = auth;

      const result = await memoryStore.saveSkill(name, description, content, {
        caller,
        ownerOpenId: identitySession.getOwner(),
      });
      if (!result.ok) {
        void audit('save_skill', caller, auditArgs, 'denied');
        return {
          isError: true,
          content: [{ type: 'text' as const, text: result.message }],
        };
      }
      void audit('save_skill', caller, auditArgs, 'ok');
      return {
        content: [
          {
            type: 'text' as const,
            text: `${result.action === 'created' ? 'Saved' : 'Updated'} skill "${result.slug}": ${description}`,
          },
        ],
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
        target_chat_id: larkIdSchema('target_chat_id')
          .describe('Chat ID that receives job output. Used by scheduler delivery and list_jobs visibility filter.'),
        model: z
          .string()
          .optional()
          .describe('Model override for prompt-type jobs (e.g. "sonnet", "haiku", "opus"). When set, the subagent executing this job uses the specified model instead of the default.'),
        chat_id: larkIdSchema('chat_id')
          .describe('Chat ID where this create_job call was triggered — used to resolve caller identity and to populate origin_chat_id'),
        thread_id: larkIdSchema('thread_id')
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
      }),
    },
    async ({ name, type, schedule, prompt, content, target_chat_id, model, chat_id, thread_id }) => {
      const auditArgs = { name, type, schedule, target_chat_id, model, chat_id, thread_id };
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
          ...(model ? { model } : {}),
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
        chat_id: larkIdSchema('chat_id').describe('Chat ID where this list call is acting from'),
        thread_id: larkIdSchema('thread_id')
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
        const modelNote = j.meta.model ? ` | Model: ${j.meta.model}` : '';
        return `${statusIcon} **${j.meta.id}** (${j.meta.type}) — ${j.meta.schedule_human}\n   Next: ${j.runtime.next_run_at} | Last: ${lastRun} | Runs: ${j.runtime.run_count}${modelNote}${error}`;
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
        id: larkIdSchema('id').describe('Job ID'),
        status: z.enum(['active', 'paused']).optional().describe('Set status'),
        schedule: z.string().optional().describe('New cron expression or alias'),
        prompt: z.string().optional().describe('New prompt (type=prompt)'),
        content: z.string().optional().describe('New content (type=message)'),
        name: z.string().optional().describe('New display name'),
        model: z
          .string()
          .optional()
          .describe('Model override for prompt-type jobs (e.g. "sonnet", "haiku", "opus"). Pass empty string to clear.'),
        chat_id: larkIdSchema('chat_id').describe('Chat ID where this update call is acting from'),
        thread_id: larkIdSchema('thread_id')
          .optional()
          .describe(
            'Thread ID from the current notification\'s metadata. Required whenever present — the server resolves caller identity from (chat_id, thread_id); omitting it falls back to chat-level and will silently attribute the call to the wrong user in cronjob turns.'
          ),
      }),
    },
    async ({ id, status, schedule, prompt, content, name, model, chat_id, thread_id }) => {
      const auditArgs = { id, status, schedule, name, model, chat_id, thread_id };
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
      if (model !== undefined) job.meta.model = model || undefined; // empty string clears
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
        id: larkIdSchema('id').describe('Job ID to delete'),
        chat_id: larkIdSchema('chat_id').describe('Chat ID where this delete call is acting from'),
        thread_id: larkIdSchema('thread_id')
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
        chat_id: larkIdSchema('chat_id').describe('Chat ID where this call is acting from'),
        thread_id: larkIdSchema('thread_id')
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
        chat_id: larkIdSchema('chat_id').describe('Chat ID where this call is acting from'),
        thread_id: larkIdSchema('thread_id')
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
