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
  return `[Auto-memory-flush]
The following is a conversation from chat ${chatId} (${messageCount} messages).
Please:
1. Write a 3-5 sentence summary focusing on: what was discussed, what was decided, what was resolved, and any open items.
2. Call save_memory(type="chat", content=<summary>, reason=<why>, chat_id="${chatId}") to persist it.

Do NOT call save_memory(type="profile", ...) in this turn — profile writes require a specific caller identity, which an auto-flush does not have. Individual profile updates are handled by a separate distillation stage.

--- Conversation ---
${conversation}
--- End ---`;
}

/**
 * Distillation Stage 2: Episodes → Profile.
 * Instructs Claude to extract durable facts from episode summaries into a
 * user profile. Note (v0.9.0+): `save_memory` writes profile facts about
 * the CALLER (derived server-side); the caller must be `${userId}` when
 * this prompt fires, i.e. this prompt is triggered from a turn originally
 * initiated by the target user.
 */
export function profileDistillationPrompt(
  userId: string,
  currentProfile: string | null,
  episodeSummaries: string[]
): string {
  return `[Profile-distillation]
Target user: ${userId}
Current user profile:
${currentProfile || '(empty — no profile yet)'}

Recent conversation summaries (${episodeSummaries.length}):
${episodeSummaries.join('\n\n')}

Please update the user profile:
- ADD: new preferences, facts, expertise discovered in conversations
- UPDATE: information that has changed (e.g., switched tech stack, new project)
- REMOVE: outdated information no longer relevant
Output the complete updated profile and call save_memory(type="profile", content=<full profile>, reason=<why>, chat_id=<current chat>). The profile is saved for the caller of this turn, who should be ${userId}.`;
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
  'Users see Feishu, not this transcript. Interact via reply / edit_message / react.',
  'Each reply targets exactly one <channel> notification: pass its message_id as reply_to and its thread_id (if present) as thread_id. Do not cross fields between different notifications.',
  'Meta image_path → Read that file. Meta attachment_file_id → call download_attachment(message_id, file_key) then Read the returned path.',
  'CronJob notifications carry source=\'cronjob\'. Dispatch to a subagent so the main thread stays responsive to Feishu messages.',
  'Sensitive tools (save_memory, create_job, list_jobs, update_job, delete_job) authorize the caller server-side from chat_id + thread_id. Always pass BOTH verbatim from the current notification\'s metadata — never substitute sentinels like "__terminal__" for a real chat_id.',
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
