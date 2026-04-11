import type { BufferedMessage } from './buffer.js';
import type { MemoryProvider } from './interface.js';

/**
 * Distillation Stage 1: Buffer → Episode.
 * Builds a system prompt for Claude to summarize a conversation and save it to memory.
 */
export function buildFlushPrompt(chatId: string, messages: BufferedMessage[]): string {
  const messageLines = messages.map(
    (m) => `[${m.timestamp}] ${m.role === 'user' ? m.senderId : 'bot'}: ${m.text}`
  );

  return `[Auto-memory-flush]
The following is a conversation from chat ${chatId} (${messages.length} messages).
Please:
1. Write a 3-5 sentence summary focusing on: what was discussed, what was decided, what was resolved, and any open items.
2. If you identified new user preferences or important facts, call save_memory(type="profile", open_id=<userId>, ...) for each user.
3. Call save_memory(type="chat", chat_id="${chatId}", ...) with the conversation summary.

--- Conversation ---
${messageLines.join('\n')}
--- End ---`;
}

/**
 * Distillation Stage 2: Episodes → Profile (for future use).
 * Builds a prompt for Claude to extract durable facts from episodes into a profile.
 */
export function buildProfileDistillationPrompt(
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
