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
import { parseTieredProfile } from './memory/distiller.js';
import { JOB_THREAD_PREFIX, PERMANENT_TARGET_CODES, getFeishuApiCode, getFeishuApiMsg } from './scheduler.js';
import { withFeishuRetry } from './feishu-retry.js';
import { writeSdkResource, WriteSdkResourceTooLargeError } from './sdk-resource.js';

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
  // Match either:
  //   <at>   (no attrs — Feishu's current renderer requires user_id so
  //          this is harmless today, but defense in depth against a
  //          future renderer leniency. R1-audit followup on #96.)
  //   <at attrs...>label</at>
  //   <at attrs.../>
  // The `(?:\s[^>]*)?` makes the attribute tail optional so bare `<at>`
  // is caught without false-positiving on `<atom>` / `<athletics>` —
  // those start with `at` followed by more letters, not `>` or `\s`.
  //
  // Self-closing replace runs first so a mixed-form payload like
  //   `<at id="x"/>foo</at>`
  // becomes `foo</at>` after self-close strip, then the orphan-tail
  // sweep at the end drops the dangling `</at>` so output stays clean.
  //
  // Loop to a fixed point because a single pass leaves NESTED tags
  // exposed: input `<at id="a">outer <at id="b">inner</at> tail</at>`
  // → first pass removes the OUTER tag and yields
  // `outer <at id="b">inner tail</at>`, which is still a valid Feishu
  // @-mention payload. Iterate until the string stops shrinking. Hard
  // cap at 8 iterations as a backtracking guard; 8 levels of nesting
  // is far beyond anything an LLM would emit.
  let out = text;
  for (let i = 0; i < 8; i++) {
    const next = out
      .replace(/<at(?:\s[^>]*)?\/>/gi, '')
      .replace(/<at(?:\s[^>]*)?>([\s\S]*?)<\/at>/gi, '$1');
    if (next === out) break;
    out = next;
  }
  // Orphan-tail sweep: any leftover `</at>` (e.g. from a mixed
  // self-closing+paired input, or a malformed half-tag) is purely
  // cosmetic noise — keep the output clean.
  return out.replace(/<\/at>/gi, '');
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

/**
 * Build the `forget_memory` tool-reply text. Pure function — extracted
 * (#88 R1-audit followup) so the singular vs plural-with-allTexts
 * branch logic is unit-testable without standing up the MCP server.
 *
 * Inputs:
 * - `result`: shape from `MemoryStore.removeProfileLine`
 *   (`{removed, sample, allTexts}`).
 * - `hash`: the user-supplied 8-char hash.
 * - `tier`: 'public' | 'private'.
 * - `tail`: optional promote-to-rule outcome string (may include
 *   a multi-rule warning when removed > 1).
 *
 * Contract:
 * - `removed === 1`: singular `Removed "<text>" from <tier> profile.<tail>`
 * - `removed >= 2`: plural with numbered list + recovery hint.
 * - `removed === 0`: caller should NOT call this — it's reserved for
 *   the success path.
 */
/**
 * If `err` is a Feishu API error indicating the target chat is
 * permanently unreachable from the bot's POV (bot kicked, chat
 * archived, no permission), return a tool-result object that defers
 * gracefully instead of throwing back into the MCP framework (#106).
 *
 * Pre-fix, reply throws on permanent target errors propagated to
 * Claude's turn as a generic exception; the Stop hook saw the inbound
 * still unanswered and forced Claude to retry reply on the next turn —
 * the same failing API call — until the turn budget was exhausted
 * (Case 2 in #106).
 *
 * The returned isError text embeds `[LARK_DEFER]` on its own line so
 * Claude can echo the sentinel in its own assistant text (per the Stop
 * hook's documented bypass at `hooks/enforce-lark-reply.mjs`). The
 * hook only scans assistant text blocks — NOT tool_result content —
 * so this is best-effort; Claude must cooperate. But the text also
 * names the failure mode plainly so Claude has every reason to defer
 * rather than re-call the same failing tool.
 *
 * Returns `null` for non-permanent errors so the caller can rethrow.
 */
export function handlePermanentTargetError(
  err: unknown,
  context: { tool: 'reply' | 'edit_message'; chat_id?: string; message_id?: string },
): { isError: true; content: { type: 'text'; text: string }[] } | null {
  const code = getFeishuApiCode(err);
  if (code === null || !PERMANENT_TARGET_CODES.has(code)) return null;
  const reason = getFeishuApiMsg(err);
  const target = context.chat_id ?? context.message_id ?? '<unknown>';
  console.error(
    `[tools] ${context.tool} hit permanent target error [${code}] on ${target}: ${reason}`,
  );
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text:
          `Target unreachable [${code}]: ${reason}.\n\n` +
          `This is a PERMANENT error — the bot is kicked / the chat is archived / permission was revoked. ` +
          `Retrying will hit the same code. To prevent the Stop hook from forcing a retry, emit the line below ` +
          `on its OWN line in your text output for this turn:\n\n[LARK_DEFER]\n\n` +
          `Then briefly explain to your operator (in chat-side text Claude sees, not bot-side reply) that the ` +
          `target became unreachable. Do not call reply / edit_message again on this target this turn.`,
      },
    ],
  };
}

export function formatForgetMemoryReply(
  result: { removed: number; sample: string | null; allTexts: string[] },
  hash: string,
  tier: 'public' | 'private',
  tail: string,
): string {
  if (result.removed === 1) {
    return `Removed "${result.sample}" from ${tier} profile.${tail}`;
  }
  const numbered = result.allTexts.map((t, i) => `  ${i + 1}) "${t}"`).join('\n');
  return (
    `Removed ${result.removed} lines sharing hash "${hash}" from ${tier} profile:\n${numbered}\n` +
    `If only one of these was the intended target, re-add the others with save_memory(type="profile", tier="${tier}", mode="append", content=...).${tail}`
  );
}

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
  ackReactions?: Map<string, { reactionId: string; addedAt: number }>,
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
        // #112 fix: wrap every send in withFeishuRetry so a Feishu
        // rate-limit (99991400 / 99991663 — common in busy groups
        // where the bot replies to multiple users in quick succession)
        // gets short-backoff retries instead of throwing immediately
        // and triggering a Stop-hook retry storm. Permanent target
        // errors (230002 chat-not-found, etc.) short-circuit via
        // isRetryableError(false), so we don't burn 3 retries on
        // a kicked-bot scenario.
        return withFeishuRetry(
          async () => {
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
          },
          { label: 'reply.followup' },
        );
      }

      // Helper: record the bot's reply text into the conversation buffer.
      // Called ONLY on successful send — a failed reply shouldn't pollute
      // the buffer with content the user never saw.
      //
      // Buffer stores what the USER ACTUALLY SAW — sanitize <at> on
      // record so the on-disk episode reflects Feishu's rendered
      // output (which post-#96 has no @-mention payloads). Without
      // this, a prompt-injected `<at>` in `replyText` would land in
      // the buffer → distilled into an episode .md → re-injected
      // into Claude's context on next enrichment, where Claude
      // might quote it again. Outbound sanitization catches the
      // re-emission, but storing the sanitized form is cleaner and
      // avoids audit-trail confusion (R2-audit followup on #96).
      function recordReply(replyText: string) {
        conversationBuffer?.record(chat_id, {
          role: 'assistant',
          senderId: 'bot',
          text: sanitizeOutboundText(replyText).slice(0, 500),
          timestamp: new Date().toISOString(),
        });
      }

      // Helper: revoke the ack reaction for a specific inbound message_id.
      // Called from `finally` so it ALWAYS runs (success or failure) — pre-#85
      // the revoke only fired on full success, so any thrown card-send / text-
      // chunk / attachment error would leave the ack emoji on the user's
      // message forever AND leak the Map entry.
      //
      // Bulk-wipe fix (#85): pre-fix the no-exact-match branch wiped the
      // ENTIRE Map (cross-chat, cross-user). One reply with a wrong/missing
      // reply_to could erase every other user's pending "I'm working on it"
      // ack. Post-fix: silent no-op with a stderr breadcrumb — the TTL
      // backstop in channel.pruneStaleAcks handles orphans.
      function revokeAckFor(messageId: string) {
        if (!ackReactions || ackReactions.size === 0) return;
        if (!messageId) {
          console.error(
            `[reply] revokeAckFor: no message_id to revoke against ` +
            `(reply called without reply_to; ${ackReactions.size} ack(s) ` +
            `remain pending, TTL backstop will clean up)`,
          );
          return;
        }
        const entry = ackReactions.get(messageId);
        if (!entry) {
          console.error(
            `[reply] revokeAckFor: no ack for message_id=${messageId} ` +
            `(may have been pruned by TTL or never set; ${ackReactions.size} ` +
            `other ack(s) left intact)`,
          );
          return;
        }
        ackReactions.delete(messageId);
        client.im.v1.messageReaction.delete({
          path: { message_id: messageId, reaction_id: entry.reactionId },
        }).catch(() => {});
      }

      // #85 fix: try/finally wraps the entire send body so revokeAckFor
      // runs whether we exit via success-return, early-return on input
      // validation failure, or a thrown send error from any of the
      // card-send / text-chunk / attachment paths. Pre-fix the revoke
      // only fired on full success → any thrown error left the user's
      // ack reaction stuck on their message forever AND leaked a Map
      // entry. The body below keeps its original indentation (versus
      // re-indenting ~200 lines) to keep the diff tight; the `try`
      // and `} finally {` lines mark the wrap boundary.
      try {
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
          // #112: retry-wrapped — rate-limit / 5xx auto-retry, permanent
          // target errors short-circuit (handlePermanentTargetError below).
          const resp: any = await withFeishuRetry(
            () => {
              if (effectiveReplyTo) {
                return client.im.v1.message.reply({
                  path: { message_id: effectiveReplyTo },
                  data: { content, msg_type: 'interactive' },
                });
              }
              return client.im.v1.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                  receive_id: chat_id,
                  content,
                  msg_type: 'interactive',
                },
              });
            },
            { label: 'reply.card.raw' },
          );
          const sentId = resp?.data?.message_id;
          if (sentId && botMessageTracker) botMessageTracker.add(sentId, chat_id, thread_id);
        } catch (err: any) {
          const defer = handlePermanentTargetError(err, { tool: 'reply', chat_id });
          if (defer) return defer;
          const apiError = err?.response?.data ?? err?.data;
          if (apiError?.code && apiError?.msg) {
            console.error(`[tools] Feishu API error [${apiError.code}]: ${apiError.msg}`);
            throw new Error(`Feishu API [${apiError.code}]: ${apiError.msg}`);
          }
          throw err;
        }

        recordReply((text || '[card]'));

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
            // #112: i===0 first-chunk reply is retry-wrapped (later
            // chunks go through sendFollowup which already wraps).
            const resp: any = (i === 0 && effectiveReplyTo)
              ? await withFeishuRetry(
                  () => client.im.v1.message.reply({
                    path: { message_id: effectiveReplyTo },
                    data: { content, msg_type: 'interactive' },
                  }),
                  { label: 'reply.card.first' },
                )
              : await sendFollowup({ content, msg_type: 'interactive' });
            const sentId = resp?.data?.message_id;
            if (sentId && botMessageTracker) botMessageTracker.add(sentId, chat_id, thread_id);
          } catch (err: any) {
            const defer = handlePermanentTargetError(err, { tool: 'reply', chat_id });
            if (defer) return defer;
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
            // #112: first-chunk reply retry-wrapped (later chunks go
            // through sendFollowup which already wraps).
            const resp: any = (effectiveReplyTo && i === 0)
              ? await withFeishuRetry(
                  () => client.im.v1.message.reply({
                    path: { message_id: effectiveReplyTo },
                    data: {
                      content: JSON.stringify({ text: chunks[i] }),
                      msg_type: 'text',
                    },
                  }),
                  { label: 'reply.text.first' },
                )
              : await sendFollowup({
                  content: JSON.stringify({ text: chunks[i] }),
                  msg_type: 'text',
                });
            const sentId = resp?.data?.message_id;
            if (sentId && botMessageTracker) botMessageTracker.add(sentId, chat_id, thread_id);
          } catch (err: any) {
            const defer = handlePermanentTargetError(err, { tool: 'reply', chat_id });
            if (defer) return defer;
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
                if (sentId && botMessageTracker) botMessageTracker.add(sentId, chat_id, thread_id);
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
                if (sentId && botMessageTracker) botMessageTracker.add(sentId, chat_id, thread_id);
              }
            }
          } catch (err) {
            console.error(`[tools] Failed to upload file ${file.path}:`, err);
          }
        }
      }

      recordReply(text);

      return {
        content: [{ type: 'text' as const, text: `Sent ${sentCount} message(s)` }],
      };
      } finally {
        // #85: ack ALWAYS revokes — success path, thrown send error,
        // early-return on bad input. effectiveReplyTo may be empty
        // (reply called without reply_to); revokeAckFor logs and
        // no-ops in that case, deferring orphan cleanup to the TTL
        // backstop in channel.pruneStaleAcks.
        revokeAckFor(effectiveReplyTo || '');
      }
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
      // #106 fix: wrap in try/catch. Pre-fix, edit_message had no error
      // handling at all — a Feishu API error (permission revoked, target
      // message deleted, bot kicked) propagated as a raw stack trace into
      // Claude's context, which is hard to act on and could re-trigger
      // Stop-hook remediation loops. Now: detect permanent target codes
      // and return a clean isError + LARK_DEFER hint; rethrow other
      // errors with the diagnostic shape reply uses.
      try {
        // #112: retry-wrap message.patch — rate-limit is just as
        // common on edits as on creates. Permanent target errors
        // (target message deleted, bot kicked) short-circuit via
        // isRetryableError(false) → no wasted retries.
        await withFeishuRetry(
          () => {
            if (format === 'card_markdown') {
              return client.im.v1.message.patch({
                path: { message_id },
                data: {
                  content: Lark.messageCard.defaultCard({
                    title: '',
                    content: safeText,
                  }),
                },
              });
            }
            return client.im.v1.message.patch({
              path: { message_id },
              data: {
                content: JSON.stringify({ text: safeText }),
              },
            });
          },
          { label: 'edit_message' },
        );
      } catch (err: any) {
        const defer = handlePermanentTargetError(err, { tool: 'edit_message', message_id });
        if (defer) return defer;
        const apiError = err?.response?.data ?? err?.data;
        if (apiError?.code && apiError?.msg) {
          console.error(`[tools] edit_message Feishu API error [${apiError.code}]: ${apiError.msg}`);
          throw new Error(`Feishu API [${apiError.code}]: ${apiError.msg}`);
        }
        console.error(`[tools] edit_message failed:`, err?.message ?? String(err));
        throw err;
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
      // #112: retry-wrap — same rate-limit exposure as the ack-reaction
      // path in channel.ts.
      await withFeishuRetry(
        () => client.im.v1.messageReaction.create({
          path: { message_id },
          data: {
            reaction_type: { emoji_type: emoji },
          },
        }),
        { label: 'react' },
      );

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
        await writeSdkResource(data, filePath, { maxBytes: appConfig.maxDownloadBytes });
        return { content: [{ type: 'text' as const, text: `Downloaded to ${filePath}` }] };
      } catch (err: any) {
        // Size-cap rejection is a recognizable error with a clean user-
        // facing message (#108 — pre-fix this would have been a generic
        // failure or worse, an OOM crash).
        if (err instanceof WriteSdkResourceTooLargeError) {
          console.error(`[tools] download rejected: ${err.message}`);
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  `Download rejected: file exceeds the ${err.maxBytes}-byte cap ` +
                  `(LARK_MAX_DOWNLOAD_BYTES). Either raise the limit in .env (for trusted senders) ` +
                  `or skip this attachment. file_key=${file_key}`,
              },
            ],
          };
        }
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
          .enum(['profile', 'profile_tiered', 'chat', 'thread'])
          .describe(
            'Memory type: "profile" for a single fact about the caller (specify tier + mode), "profile_tiered" for the full-tier replacement used by auto-flush distillation (content is a JSON object {public:[...], private:[...]}, server splits + applies L1 + writes both tiers atomically), "chat" for conversation summary, "thread" for thread-level summary.'
          ),
        content: z.string().describe('The memory content to save (concise, factual). For type="profile_tiered" this is a JSON string {"public": [...], "private": [...]}.'),
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
      if ((type === 'profile' || type === 'profile_tiered') && caller === SYSTEM_FLUSH_CALLER) {
        void audit('save_memory', caller, auditArgs, 'denied');
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `save_memory(type=${type}) denied: caller is the system-flush sentinel. ` +
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

      // profile_tiered: distiller auto-flush path (#97).
      //
      // Pre-v1.0.17 the distiller prompt told Claude to call save_memory
      // twice — once with tier='public' mode='replace', once with
      // tier='private' mode='replace'. With v1.0.13's L1 safety net
      // (#75), the FIRST call could redirect L1-hit lines from public
      // to private (append). Then the SECOND call's mode='replace' on
      // private would OVERWRITE that just-redirected content with
      // whatever Claude originally classified as private — silently
      // losing the redirected data. End state: an L1-hit fact (phone,
      // ID, credential) is gone from both tiers.
      //
      // Fix: one atomic server-side write using the existing (dead
      // pre-v1.0.17) parseTieredProfile helper. Claude submits a JSON
      // {"public":[...], "private":[...]}; the server runs L1 on the
      // public array (moving hits to private), then writes both tiers
      // in a single replace operation. Because the public array no
      // longer contains L1 hits, saveProfile's internal redirect
      // doesn't fire — the two replaces are independent and idempotent.
      if (type === 'profile_tiered') {
        // R1-audit hardening on PR #107 — refuse to write when the JSON
        // is structurally invalid. parseTieredProfile's fallback path
        // returns `{public:[], private:[raw blob]}` on parse failure,
        // which my v1.0.17 first cut then mass-REPLACED both tiers,
        // nuking the user's existing public profile on a single
        // transient LLM JSON hiccup. Soft-fail instead: validate shape
        // first, return a tool error if invalid, and let Claude retry
        // (or the operator inspect logs) rather than silently destroy.
        let parsed: { public?: unknown; private?: unknown };
        try {
          const raw = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
          parsed = JSON.parse(raw);
        } catch (err) {
          void audit('save_memory', caller, auditArgs, 'denied');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  `save_memory(type="profile_tiered") rejected: content is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
                  `Expected a {"public": [...], "private": [...]} object. No tiers were modified.`,
              },
            ],
          };
        }
        if (
          !parsed || typeof parsed !== 'object' ||
          !Array.isArray(parsed.public) || !Array.isArray(parsed.private)
        ) {
          void audit('save_memory', caller, auditArgs, 'denied');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  `save_memory(type="profile_tiered") rejected: JSON must be an object with BOTH "public" and "private" as arrays of strings. ` +
                  `No tiers were modified.`,
              },
            ],
          };
        }
        // R1-audit hardening: empty-both is a no-op rather than a
        // mass-truncate. The pre-v1.0.17 dual-call pattern naturally
        // skipped empty-array calls ("Skip either call if its array is
        // empty"); the new single-call default of "replace both" was
        // strictly more destructive. The distiller's intent for empty-
        // both is "produced no extractable facts this cycle", not
        // "wipe the user's profile". Preserve existing facts; future
        // explicit-nuke can be done via forget_memory or by editing the
        // file. Single-side empty (one tier had no facts but the other
        // produced facts) is still REPLACED — that's the intended
        // "fresh rewrite" semantic.
        const arrPublic = parsed.public as string[];
        const arrPrivate = parsed.private as string[];
        if (arrPublic.length === 0 && arrPrivate.length === 0) {
          void audit('save_memory', caller, auditArgs, 'ok');
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `save_memory(type="profile_tiered"): both arrays empty — no-op (existing profile preserved). Reason: ${reason}`,
              },
            ],
          };
        }
        // Re-run the L1 safety net via the existing helper (it accepts
        // a raw string for tolerance with the LLM, but we already
        // parsed; reconstruct from the parsed object so we don't
        // re-parse our own JSON.stringify).
        const tiered = parseTieredProfile(JSON.stringify({ public: arrPublic, private: arrPrivate }));
        // Sanitize embedded newlines in array elements (R1-audit nit #4).
        // A `\n` inside an element would create a multi-line bullet
        // that listProfileLines splits into orphan lines on read,
        // confusing what_do_you_know / forget_memory hash addressing.
        // Collapse runs of whitespace (including \n, \r, \t) to a
        // single space to keep one fact per line.
        const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
        const fmt = (arr: string[]) =>
          arr
            .map(oneLine)
            .filter(Boolean)
            .map((line) => (line.startsWith('-') ? line : `- ${line}`))
            .join('\n') +
          (arr.some((s) => oneLine(s).length > 0) ? '\n' : '');
        // v1.0.34 (R1-followup on #54): single atomic-pair write under
        // the per-user profile mutex. Pre-fix two sequential saveProfile
        // calls each grabbed the mutex independently — a cross-chat
        // save landing AFTER public-replace but BEFORE private-replace
        // would have its private-tier delta clobbered. The new
        // saveProfileTiered method serializes the pair under ONE mutex
        // acquisition so the public+private write is observable as
        // atomic to any other concurrent same-user save / remove.
        //
        // Residual: read paths (memory enrichment in src/channel.ts) are
        // still unqueued — a concurrent getProfile mid-pair sees
        // public-new + private-old for a sub-ms window. Acceptable for
        // an enrichment read (which is best-effort context); not for
        // the WRITE path where a lost delta is data loss.
        await memoryStore.saveProfileTiered(caller, {
          public: fmt(tiered.public),
          private: fmt(tiered.private),
        });
        void audit('save_memory', caller, auditArgs, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Saved tiered profile for ${caller}: ${tiered.public.length} public, ${tiered.private.length} private. Reason: ${reason}`,
            },
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
          .min(1, 'schedule cannot be empty')
          .max(200, 'schedule must be ≤ 200 chars')
          .refine((s) => s.trim().length > 0, { message: 'schedule must contain non-whitespace' })
          .describe(
            'Cron expression or alias: "0 9 * * 1-5", "every 30m", "daily at 09:00", "weekdays at 09:00", "weekly on mon at 09:00". Must be non-empty. "every Nm" requires N in {1,2,3,4,5,6,10,12,15,20,30}; "every Nh" requires N in {1,2,3,4,6,8,12} (divisors of 60 / 24 — otherwise the actual cadence diverges from the human label).'
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
        schedule: z
          .string()
          .min(1, 'schedule cannot be empty')
          .max(200, 'schedule must be ≤ 200 chars')
          .refine((s) => s.trim().length > 0, { message: 'schedule must contain non-whitespace' })
          .optional()
          .describe('New cron expression or alias. Same validation rules as create_job (must be non-empty; "every Nm" requires N divides 60; "every Nh" requires N in {1,2,3,4,6,8,12}).'),
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
        "Remove profile lines by 8-char hash from caller's profile. Always caller-scoped. If multiple lines share the hash (duplicates or rare birthday-paradox collision), ALL of them are removed in one call — the tool reply lists every removed text by index so the operator can re-add unintended losses via save_memory(mode='append'). Optionally promotes the (sample) removed text to a persistent L2 rule. Auto-promotion validates the text (>=6 chars + has a 4+ Letter/Number run); short or generic text is REJECTED with a SKIPPED message in the reply (the line removal still succeeds) to prevent substring-matcher pollution (#90).",
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

      const result = await memoryStore.removeProfileLine(caller, tier, hash);
      if (result.removed === 0) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Failed to remove line "${hash}".` }],
        };
      }

      // Line removal above is the primary effect; rule promotion is
      // a best-effort enhancement. If addL2Rule fails, don't undo the
      // removal — just report the partial outcome so the user knows.
      //
      // Rule-promotion text choice (#88 followup): when multiple lines
      // shared the hash, we use the sample text (first match) as the
      // rule seed. The texts are normalized-equal after bullet-strip
      // (that's why their hashes collide), so the sample is
      // representative — but the operator should see the count + the
      // full list (below) so they can decide whether to manually add
      // other variants. R1-audit followup: when removed>1+promote, also
      // emit a "review whether you want all variants treated as
      // private" warning so the operator catches the over-broad rule.
      let tail = '';
      // promote_result distinguishes requested-vs-applied for the
      // audit trail (R2-audit followup on #90). Pre-followup the audit
      // log only saw `promote_to_rule=true` (the request) — operators
      // couldn't tell whether it landed, was rejected by validation,
      // or threw. Values:
      //   'not-requested' — promote_to_rule was false/unset
      //   'added'         — rule wrote to privacy-rules.md
      //   'skipped:too-short' / 'skipped:no-substantive-word'
      //                   — validation rejected at the L2 boundary
      //   'error:...'     — addL2Rule threw (disk failure etc)
      let promoteResult: string = 'not-requested';
      if (promote_to_rule) {
        try {
          const { addL2Rule } = await import('./privacy-rules.js');
          const ruleResult = await addL2Rule(result.sample ?? '', 'Always private');
          if (ruleResult.added) {
            promoteResult = 'added';
            tail = ' Also appended to privacy-rules.md under "Always private" — future distillations will classify similar content accordingly.';
            if (result.removed > 1) {
              tail +=
                ' Note: rule seeded from the sample text only; multiple lines were removed, so review whether other variants should also be added manually.';
            }
          } else {
            // #90 fix: validate at the L2 boundary. A 3-char common
            // word like "工程师" or a length-borderline phrase would
            // poison the substring matcher (extractL2PrivatePhrases)
            // for years — every line containing those characters
            // would be marked private. Reject explicitly so the
            // operator sees the failure mode instead of silently
            // accumulating a polluted ruleset.
            promoteResult = `skipped:${ruleResult.reason}`;
            const reasonText =
              ruleResult.reason === 'too-short'
                ? 'too short (< 6 chars) — would substring-match too many unrelated lines'
                : 'too generic (no substantive word) — would over-match';
            tail =
              ` Rule promotion SKIPPED: "${result.sample}" is ${reasonText}. ` +
              `To force-add anyway, edit ~/.claude/channels/lark/privacy-rules.md directly. ` +
              `Removal of the profile line above succeeded; only the auto-rule was rejected.`;
          }
        } catch (err) {
          promoteResult = `error:${err instanceof Error ? err.message.slice(0, 40) : String(err).slice(0, 40)}`;
          tail = ` (Warning: removal succeeded but failed to append rule to privacy-rules.md: ${err instanceof Error ? err.message : String(err)}. You can add the rule manually.)`;
        }
      }

      // Audit log includes the removed count for forensic visibility
      // (R1-audit followup #12 — pre-fix only ok/denied was recorded,
      // hiding that a multi-delete had happened from the audit trail).
      // promote_result added in v1.0.26 R2-audit followup so operators
      // can distinguish a successful auto-promote from a validation-
      // skipped one when scanning audit.log.
      void audit('forget_memory', caller, { ...auditArgs, removed: result.removed, promote_result: promoteResult }, 'ok');

      // #88 fix: faithful confirmation that names the count AND lists
      // every removed text (so the operator can copy-paste back any
      // unintended losses via save_memory). Pre-fix the singular wording
      // hid multi-deletes entirely; intermediate fix named the count
      // but the recovery hint ("re-add the others") was misleading
      // because what_do_you_know wouldn't show the deleted texts to
      // copy from. R1-audit followup #8 — surface allTexts inline via
      // formatForgetMemoryReply (extracted as a pure function so the
      // branch logic is unit-testable).
      return {
        content: [{ type: 'text' as const, text: formatForgetMemoryReply(result, hash, tier, tail) }],
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
