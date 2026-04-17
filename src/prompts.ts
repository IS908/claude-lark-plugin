/**
 * Centralized prompt templates.
 * All hardcoded prompts/instructions live here for easy tuning.
 */

/**
 * Distillation Stage 1: Buffer → Episode.
 * Instructs Claude to summarize a conversation and persist it as memory.
 */
export function flushPrompt(chatId: string, conversation: string, messageCount: number): string {
  return `[Auto-memory-flush]
The following is a conversation from chat ${chatId} (${messageCount} messages).
Please:
1. Write a 3-5 sentence summary focusing on: what was discussed, what was decided, what was resolved, and any open items.
2. If you identified new user preferences or important facts, call save_memory(type="profile", open_id=<userId>, ...) for each user.
3. Call save_memory(type="chat", chat_id="${chatId}", ...) with the conversation summary.

--- Conversation ---
${conversation}
--- End ---`;
}

/**
 * Distillation Stage 2: Episodes → Profile.
 * Instructs Claude to extract durable facts from episode summaries into a user profile.
 */
export function profileDistillationPrompt(
  userId: string,
  currentProfile: string | null,
  episodeSummaries: string[]
): string {
  return `[Profile-distillation]
Current user profile:
${currentProfile || '(empty — no profile yet)'}

Recent conversation summaries (${episodeSummaries.length}):
${episodeSummaries.join('\n\n')}

Please update the user profile:
- ADD: new preferences, facts, expertise discovered in conversations
- UPDATE: information that has changed (e.g., switched tech stack, new project)
- REMOVE: outdated information no longer relevant
Output the complete updated profile and call save_memory(type="profile", open_id="${userId}", ...).`;
}

/**
 * CronJob prompt injection.
 * Wraps the user's prompt with execution instructions for Claude.
 */
export function cronJobPrompt(jobName: string, targetChatId: string, prompt: string): string {
  return [
    `[CronJob: ${jobName}]`,
    `Execute this task and reply to chat_id=${targetChatId} with the result.`,
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
