/**
 * Memory provider interface — the pluggable abstraction layer.
 * Implementations: FileMemoryProvider (complete), OpenVikingMemoryProvider (stub), Mem0MemoryProvider (stub)
 */

export interface Episode {
  id: string;
  content: string;
  timestamp: string;
  chatId?: string;
  threadId?: string;
}

export interface EpisodeMeta {
  chatId: string;
  threadId?: string;
  userId?: string;
}

export interface Skill {
  name: string;
  description: string;
  content: string;
}

export interface MemoryProvider {
  // Layer 3 — Semantic Memory (user-isolated)
  getProfile(userId: string): Promise<string | null>;
  saveProfile(userId: string, content: string): Promise<void>;

  // Layer 2 — Episodic Memory (chat-isolated)
  searchEpisodes(
    query: string,
    scope?: { chatId?: string; threadId?: string }
  ): Promise<Episode[]>;
  saveEpisode(
    type: 'chat' | 'thread',
    content: string,
    meta: EpisodeMeta
  ): Promise<void>;
  listEpisodes(chatId: string): Promise<Episode[]>;
  deleteEpisodes(chatId: string, ids: string[]): Promise<void>;

  // Layer 3 — Semantic Memory (global)
  searchSkills(query: string): Promise<Skill[]>;
  saveSkill(name: string, description: string, content: string): Promise<void>;
}
