import type { BufferedMessage } from './buffer.js';
import {
  flushPrompt,
  profileDistillationPrompt,
} from '../prompts.js';

/**
 * Distillation Stage 1: Buffer → Episode.
 */
export function buildFlushPrompt(chatId: string, messages: BufferedMessage[]): string {
  const conversation = messages
    .map((m) => `[${m.timestamp}] ${m.role === 'user' ? m.senderId : 'bot'}: ${m.text}`)
    .join('\n');

  return flushPrompt(chatId, conversation, messages.length);
}

/**
 * Distillation Stage 2: Episodes → Profile.
 */
export function buildProfileDistillationPrompt(
  userId: string,
  currentProfile: string | null,
  episodeSummaries: string[]
): string {
  return profileDistillationPrompt(userId, currentProfile, episodeSummaries);
}
