import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from '../config.js';

export interface Episode {
  id: string;
  content: string;
  timestamp: string;
  score?: number;
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
  score?: number;
}

/**
 * Local markdown memory store.
 * Stores memories as .md files under ~/.claude/channels/lark/memories/
 */
export class MemoryStore {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? appConfig.memoriesDir;
  }

  async healthCheck(): Promise<boolean> { return true; }

  // ── User Profile ──

  async getProfile(userId: string): Promise<string | null> {
    const filePath = path.join(this.baseDir, 'profiles', `${userId}.md`);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  async saveProfile(userId: string, content: string): Promise<void> {
    const dir = path.join(this.baseDir, 'profiles');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${userId}.md`), content, 'utf-8');
  }

  // ── Episodes ──

  async searchEpisodes(
    query: string,
    scope?: { chatId?: string; threadId?: string }
  ): Promise<Episode[]> {
    if (!scope?.chatId) return [];

    const dir = scope.threadId
      ? path.join(this.baseDir, 'episodes', scope.chatId, 'threads', scope.threadId)
      : path.join(this.baseDir, 'episodes', scope.chatId);

    try {
      const files = await fs.readdir(dir);
      const mdFiles = files.filter(f => f.endsWith('.md') && !f.startsWith('archive-'));

      // Read all episodes and score by keyword overlap + recency
      const keywords = this.extractKeywords(query);
      const scored: Array<{ episode: Episode; score: number }> = [];

      for (const file of mdFiles) {
        const filePath = path.join(dir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const stat = await fs.stat(filePath);

        // Score: keyword match on first two lines + filename
        const firstLines = content.split('\n').slice(0, 3).join(' ').toLowerCase();
        const filenameLower = file.toLowerCase();
        let keywordScore = 0;
        for (const kw of keywords) {
          if (firstLines.includes(kw) || filenameLower.includes(kw)) {
            keywordScore++;
          }
        }

        // Recency boost: newer files score higher (0-1 scale, decays over 30 days)
        const ageMs = Date.now() - stat.mtimeMs;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyScore = Math.max(0, 1 - ageDays / 30);

        const totalScore = keywordScore + recencyScore;

        scored.push({
          episode: {
            id: file,
            content,
            timestamp: stat.mtime.toISOString(),
            chatId: scope.chatId,
            threadId: scope.threadId,
          },
          score: totalScore,
        });
      }

      // Sort by score descending, return top N
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, appConfig.maxSearchResults).map(s => ({
        ...s.episode,
        score: s.score,
      }));
    } catch {
      return [];
    }
  }

  async saveEpisode(
    type: 'chat' | 'thread',
    content: string,
    meta: EpisodeMeta
  ): Promise<void> {
    const dir =
      type === 'thread' && meta.threadId
        ? path.join(this.baseDir, 'episodes', meta.chatId, 'threads', meta.threadId)
        : path.join(this.baseDir, 'episodes', meta.chatId);

    await fs.mkdir(dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${timestamp}.md`;
    await fs.writeFile(path.join(dir, fileName), content, 'utf-8');
  }

  async listEpisodes(chatId: string): Promise<Episode[]> {
    const dir = path.join(this.baseDir, 'episodes', chatId);
    try {
      const files = await fs.readdir(dir);
      const episodes: Episode[] = [];

      for (const file of files.filter(f => f.endsWith('.md'))) {
        const filePath = path.join(dir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const stat = await fs.stat(filePath);
        episodes.push({
          id: file,
          content,
          timestamp: stat.mtime.toISOString(),
          chatId,
        });
      }

      episodes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return episodes;
    } catch {
      return [];
    }
  }

  async deleteEpisodes(chatId: string, ids: string[]): Promise<void> {
    const dir = path.join(this.baseDir, 'episodes', chatId);
    for (const id of ids) {
      try {
        await fs.unlink(path.join(dir, id));
      } catch {
        // ignore missing files
      }
    }
  }

  // ── Skills ──

  async searchSkills(query: string): Promise<Skill[]> {
    const dir = path.join(this.baseDir, 'skills');
    try {
      const files = await fs.readdir(dir);
      const keywords = this.extractKeywords(query);
      const results: Array<{ skill: Skill; score: number }> = [];

      for (const file of files.filter(f => f.endsWith('.md'))) {
        const filePath = path.join(dir, file);
        const content = await fs.readFile(filePath, 'utf-8');

        // Parse skill file: first line = name, second line = description
        const lines = content.split('\n');
        const name = (lines[0] ?? '').replace(/^#\s*/, '').trim();
        const description = (lines[1] ?? '').trim();

        let score = 0;
        const searchText = `${name} ${description} ${file}`.toLowerCase();
        for (const kw of keywords) {
          if (searchText.includes(kw)) score++;
        }

        if (score > 0) {
          results.push({ skill: { name, description, content }, score });
        }
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, appConfig.maxSearchResults).map(r => ({
        ...r.skill,
        score: r.score,
      }));
    } catch {
      return [];
    }
  }

  async saveSkill(name: string, description: string, content: string): Promise<void> {
    const dir = path.join(this.baseDir, 'skills');
    await fs.mkdir(dir, { recursive: true });

    const fileName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.md';
    const fileContent = `# ${name}\n${description}\n\n${content}`;
    await fs.writeFile(path.join(dir, fileName), fileContent, 'utf-8');
  }

  // ── Helpers ──

  private extractKeywords(query: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'it', 'its',
      'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you',
      'your', 'he', 'she', 'they', 'them', 'and', 'or', 'but', 'not', 'no',
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
      '上', '也', '他', '她', '们', '这', '那', '你', '吗', '什么', '怎么',
    ]);

    return query
      .toLowerCase()
      .split(/[\s,;.!?，。！？、；：]+/)
      .filter(w => w.length > 1 && !stopWords.has(w));
  }
}
