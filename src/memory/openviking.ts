import type { MemoryProvider, Episode, EpisodeMeta, Skill } from './interface.js';

/**
 * OpenViking memory adapter — STUB.
 *
 * TODO: implement using OpenViking REST API
 * Reference: https://github.com/volcengine/OpenViking
 * Endpoint: OPENVIKING_URL (default http://localhost:1933)
 * Auth: OPENVIKING_API_KEY (optional for local dev)
 *
 * Advantages over file adapter:
 * - Vector-based semantic search for episodes and skills
 * - Better relevance scoring
 * - Scalable storage
 */
export class OpenVikingMemoryProvider implements MemoryProvider {
  constructor(url: string, apiKey?: string) {
    console.error(`[openviking] OpenViking adapter initialized (url: ${url}) — NOT YET IMPLEMENTED`);
  }

  async getProfile(userId: string): Promise<string | null> {
    throw new Error('OpenViking adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async saveProfile(userId: string, content: string): Promise<void> {
    throw new Error('OpenViking adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async searchEpisodes(query: string, scope?: { chatId?: string; threadId?: string }): Promise<Episode[]> {
    throw new Error('OpenViking adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async saveEpisode(type: 'chat' | 'thread', content: string, meta: EpisodeMeta): Promise<void> {
    throw new Error('OpenViking adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async listEpisodes(chatId: string): Promise<Episode[]> {
    throw new Error('OpenViking adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async deleteEpisodes(chatId: string, ids: string[]): Promise<void> {
    throw new Error('OpenViking adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async searchSkills(query: string): Promise<Skill[]> {
    throw new Error('OpenViking adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async saveSkill(name: string, description: string, content: string): Promise<void> {
    throw new Error('OpenViking adapter not yet implemented — use MEMORY_PROVIDER=file');
  }
}
