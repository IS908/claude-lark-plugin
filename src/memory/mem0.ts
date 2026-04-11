import type { MemoryProvider, Episode, EpisodeMeta, Skill } from './interface.js';

/**
 * mem0 memory adapter — STUB.
 *
 * TODO: implement using mem0 REST API or mem0 cloud
 * Reference: https://docs.mem0.ai
 * Endpoint: MEM0_URL (self-hosted) or MEM0_API_KEY (cloud)
 *
 * Advantages over file adapter:
 * - Built-in memory management and deduplication
 * - Automatic relevance scoring
 * - Memory importance ranking
 * - Supports structured and unstructured memory
 */
export class Mem0MemoryProvider implements MemoryProvider {
  constructor(url?: string, apiKey?: string) {
    console.error(`[mem0] mem0 adapter initialized — NOT YET IMPLEMENTED`);
  }

  async healthCheck(): Promise<boolean> { return false; }

  async getProfile(userId: string): Promise<string | null> {
    throw new Error('mem0 adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async saveProfile(userId: string, content: string): Promise<void> {
    throw new Error('mem0 adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async searchEpisodes(query: string, scope?: { chatId?: string; threadId?: string }): Promise<Episode[]> {
    throw new Error('mem0 adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async saveEpisode(type: 'chat' | 'thread', content: string, meta: EpisodeMeta): Promise<void> {
    throw new Error('mem0 adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async listEpisodes(chatId: string): Promise<Episode[]> {
    throw new Error('mem0 adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async deleteEpisodes(chatId: string, ids: string[]): Promise<void> {
    throw new Error('mem0 adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async searchSkills(query: string): Promise<Skill[]> {
    throw new Error('mem0 adapter not yet implemented — use MEMORY_PROVIDER=file');
  }

  async saveSkill(name: string, description: string, content: string): Promise<void> {
    throw new Error('mem0 adapter not yet implemented — use MEMORY_PROVIDER=file');
  }
}
