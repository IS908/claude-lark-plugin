/**
 * Centralized prompt templates.
 * All hardcoded prompts/instructions live here for easy tuning.
 */

/**
 * Distillation Stage 1: Buffer → Episode.
 * Instructs Claude to summarize a conversation and persist it as a chat
 * episode. Note (v0.9.0+): `save_memory` with type="profile" writes facts
 * about the CALLER only (derived server-side from the session). During
 * auto-flush there is no single "caller", so we only produce a chat-level
 * episode summary here — individual profile updates happen in the dedicated
 * profileDistillationPrompt path where the target user is unambiguous.
 */
export function flushPrompt(chatId: string, conversation: string, messageCount: number): string {
  return `[Auto-memory-flush — system-initiated]
This is a buffer flush triggered by inactivity, not a user message. The plugin has bound a system caller for this turn, so save_memory(type="chat", ...) will succeed even though no real user invoked it.

The following is a conversation from chat ${chatId} (${messageCount} messages).
Please:
1. Write a 3-5 sentence summary focusing on: what was discussed, what was decided, what was resolved, and any open items.
2. Call save_memory(type="chat", content=<summary>, reason=<why>, chat_id="${chatId}") to persist it. Do not output a reply — this is system, not user.

Do NOT call save_memory(type="profile", ...) in this turn — profile writes are user-scoped (they persist into a specific user's profile directory), and a system caller has no user identity to attribute private-tier data to. The server-side gate will reject any profile write attempt here. Individual profile updates are handled by a separate distillation stage.

--- Conversation ---
${conversation}
--- End ---`;
}

/**
 * Distillation Stage 2: Episodes → Profile (tiered, v0.10.0+).
 *
 * Instructs Claude to extract durable facts from episode summaries and
 * output a JSON object with `public` and `private` arrays. The caller of
 * the distillation turn must be `userId` (profile writes resolve to caller
 * server-side, v0.9.0+).
 *
 * Classification rules are embedded directly in the prompt — the
 * distiller's output is later post-processed by `parseTieredProfile` in
 * src/memory/distiller.ts, which additionally applies the L1 safety net
 * (anything marked public that hits an L1 regex gets forced to private).
 */
export function profileDistillationPrompt(args: {
  userId: string;
  currentProfile: string | null;
  episodeSummaries: string[];
  chatType: 'p2p' | 'group';
  l2Rules: string;
}): string {
  const { userId, currentProfile, episodeSummaries, chatType, l2Rules } = args;
  return `[Profile-distillation]
Target user: ${userId}
Source chat type: ${chatType}

Current user profile:
${currentProfile || '(empty — no profile yet)'}

Recent conversation summaries (${episodeSummaries.length}):
${episodeSummaries.map((s, i) => `[${i + 1}] ${s}`).join('\n\n')}

User privacy rules (L2):
${l2Rules.trim() || '(none set)'}

Output a JSON object with exactly two arrays:
{
  "public":  [ "fact", "fact", ... ],   // facts safe for anyone who @mentions this user to see
  "private": [ "fact", "fact", ... ]    // facts only the user themselves should see
}

Classification rules (apply in order; higher priority wins):
1. Match any "Always private" rule in L2 → private.
2. Match any "Always public" rule in L2 → public.
3. Specific emails, phone numbers, monetary amounts, passwords, tokens, credentials — ALWAYS private, even if mentioned in a group.
4. Source-based default:
   - chatType=group → unknown facts default to public (they were already said in front of the group).
   - chatType=p2p → unknown facts default to private (never voluntarily shared beyond 1:1).
5. When truly uncertain: choose private.

Return the JSON object inline (no code fence). Then call save_memory exactly ONCE with type="profile_tiered" and pass the JSON object as the content string:

  save_memory(type="profile_tiered", content=<the JSON string>, reason=<why>, chat_id=<current>)

The server parses the JSON, applies the L1 privacy safety net (anything classified public that matches a regex/keyword rule like phone numbers, IDs, credentials, salary keywords is forced into private), and atomically writes both tier files. Do NOT make two separate save_memory(type="profile") calls — that pre-v1.0.17 dual-call pattern races with the L1 safety net and silently drops the redirected lines (#97). Empty arrays are fine; the server truncates the corresponding tier file.`;
}

/**
 * MCP server startup instructions — sent once during the initialize handshake
 * and resident in Claude's context for the whole session (cached on repeat
 * requests). Keep this short: duplication with tool descriptions is waste,
 * and long system-level prose dilutes what Claude actually notices.
 *
 * Covers only cross-tool patterns and rules that no individual tool owns:
 * channel semantics, per-notification routing, meta interpretation, cronjob
 * dispatch, and server-side caller identity. Per-tool mechanics (card
 * rendering, save_memory vs save_skill, etc.) live in tool descriptions.
 */
export const mcpServerInstructions: string = [
  'Users see Feishu, not this transcript. Respond via reply (canonical answer); use react only to acknowledge messages needing no answer. edit_message patches a prior bot card (its message_id is the bot card, not the user inbound) and does NOT count as responding.',
  'Each reply targets exactly one <channel> notification: pass its message_id as reply_to and its thread_id (if present) as thread_id. Do not cross fields between different notifications.',
  'Meta image_path → Read that file. Meta attachment_file_id → call download_attachment(message_id, file_key, file_name=meta.attachment_name) then Read the returned path. Always pass file_name so the saved file keeps its extension (.pdf, .txt, etc.) — Read infers MIME from the extension.',
  'CronJob notifications carry source=\'cronjob\'. Dispatch to a subagent so the main thread stays responsive to Feishu messages.',
  'Sensitive tools (save_memory, save_skill, what_do_you_know, forget_memory, create_job, list_jobs, update_job, delete_job) authorize the caller server-side from chat_id + thread_id. Always pass BOTH verbatim from the current notification\'s metadata — never substitute sentinels like "__terminal__" for a real chat_id.',
].join('\n');

/**
 * CronJob prompt injection.
 * Wraps the user's prompt with execution instructions for Claude.
 */
export function cronJobPrompt(jobName: string, sendChatId: string, prompt: string): string {
  return [
    `[CronJob: ${jobName}]`,
    `Execute this task and reply to chat_id=${sendChatId} with the result.`,
    `Do NOT reply to any other chat. Use a subagent when possible so the main thread stays responsive.`,
    ``,
    prompt,
  ].join('\n');
}

/**
 * Memory enrichment assembly.
 * Wraps the user's message with memory context before forwarding to Claude.
 */
export function enrichmentPrompt(
  memoryContext: string,
  parentContent: string | undefined,
  senderId: string,
  chatId: string,
  text: string
): string {
  const parentContext = parentContent
    ? `\n[Quoted Message]\n${parentContent}\n`
    : '';

  return `[Memory Context]\n${memoryContext}\n${parentContext}\n[Current Message]\nFrom: ${senderId} in ${chatId}\n${text}`;
}
