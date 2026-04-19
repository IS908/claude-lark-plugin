import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { appConfig } from '../config.js';
import { applyL1, loadL2Rules, extractL2PrivatePhrases } from '../privacy-rules.js';

export type Tier = 'public' | 'private';

/** Short, stable-per-text identifier for a profile line (used by forget_memory). */
export interface ProfileLine {
  index: number;
  hash: string;
  text: string;
}

function lineHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

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

  // ── User Profile (tiered, v0.10.0+) ──

  private profileDir(userId: string): string {
    return path.join(this.baseDir, 'profiles', userId);
  }

  private profileTierPath(userId: string, tier: Tier): string {
    return path.join(this.profileDir(userId), `${tier}.md`);
  }

  private legacyProfilePath(userId: string): string {
    return path.join(this.baseDir, 'profiles', `${userId}.md`);
  }

  /**
   * Migrate a pre-v0.10 single-file profile to the tiered layout, applying
   * the L1 classifier line-by-line to split into public/private.
   *
   * Idempotent: runs at most once per user. Partial-failure safe: legacy file
   * is deleted only after both target files are successfully written.
   *
   *  legacy: profiles/{userId}.md
   *  target: profiles/{userId}/{public,private}.md
   *
   * See spec's "Migration" section for the trade-off discussion (approach B:
   * deterministic L1 filter, no LLM dependency).
   */
  private async migrateIfNeeded(userId: string): Promise<void> {
    const legacy = this.legacyProfilePath(userId);
    const dir = this.profileDir(userId);

    if (!existsSync(legacy)) return; // fresh user or already migrated

    if (existsSync(dir)) {
      // Mid-failure from a previous migration — new layout already exists.
      // Safe to drop the legacy file; new layout is authoritative.
      try { await fs.unlink(legacy); } catch {}
      return;
    }

    const content = await fs.readFile(legacy, 'utf-8');
    const publicLines: string[] = [];
    const privateLines: string[] = [];

    // Pre-load L2 user rules so operators who configure privacy-rules.md
    // BEFORE upgrading can influence their own legacy-profile migration
    // (org codenames, people mentions, etc. that L1 doesn't cover).
    // Substring match is case-insensitive, deterministic, no LLM needed.
    const l2Phrases = extractL2PrivatePhrases(await loadL2Rules()).map((p) => p.toLowerCase());

    for (const line of content.split('\n')) {
      if (!line.trim()) {
        // Preserve blank lines in public for readability; skip in private.
        publicLines.push(line);
        continue;
      }

      if (applyL1(line) === 'private') {
        privateLines.push(line);
        continue;
      }

      if (l2Phrases.length > 0) {
        const lower = line.toLowerCase();
        if (l2Phrases.some((p) => lower.includes(p))) {
          privateLines.push(line);
          continue;
        }
      }

      publicLines.push(line);
    }

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.profileTierPath(userId, 'public'), publicLines.join('\n'), 'utf-8');
    if (privateLines.length > 0) {
      await fs.writeFile(this.profileTierPath(userId, 'private'), privateLines.join('\n'), 'utf-8');
    }
    // Wrap unlink in try/catch to tolerate concurrent migrations of the
    // same user (e.g. User A is mentioned in two chats handled in parallel
    // by different queues — both enter migrateIfNeeded before either
    // finishes). ENOENT on the second unlink is benign.
    try { await fs.unlink(legacy); } catch {}

    console.error(
      `[migrate] profile ${userId}: ${publicLines.filter(l => l.trim()).length} public, ${privateLines.length} private`,
    );
  }

  /**
   * Load a user's profile, filtered by rendering visibility.
   * - caller === ownerId → return public + private tiers joined
   * - caller !== ownerId → return public tier only
   *
   * Returns null if neither tier file has content.
   */
  async getProfile(ownerId: string, caller: string): Promise<string | null> {
    await this.migrateIfNeeded(ownerId);

    const readOpt = async (p: string): Promise<string> => {
      if (!existsSync(p)) return '';
      try { return await fs.readFile(p, 'utf-8'); } catch { return ''; }
    };

    const pub = (await readOpt(this.profileTierPath(ownerId, 'public'))).trim();
    if (caller === ownerId) {
      const priv = (await readOpt(this.profileTierPath(ownerId, 'private'))).trim();
      const joined = [pub, priv].filter(Boolean).join('\n\n');
      return joined || null;
    }
    return pub || null;
  }

  /**
   * Persist a profile tier. Creates the user directory if missing.
   *
   * Runs {@link migrateIfNeeded} first so that a save on an unmigrated user
   * does not silently drop their legacy profile content. Without this call,
   * the order save → read would see dir-exists-early-return in migration and
   * throw away the legacy file without classifying it.
   */
  async saveProfile(userId: string, content: string, tier: Tier): Promise<void> {
    await this.migrateIfNeeded(userId);
    const dir = this.profileDir(userId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.profileTierPath(userId, tier), content, 'utf-8');
  }

  /**
   * Return the lines of a profile tier as addressable items. Each line carries
   * a short sha1-based hash that is stable per content — callers (e.g. the
   * forget_memory tool) use the hash to identify a line without the file
   * needing a durable row id.
   *
   * Blank lines are skipped. Leading/trailing whitespace is trimmed.
   */
  async listProfileLines(ownerId: string, tier: Tier): Promise<ProfileLine[]> {
    await this.migrateIfNeeded(ownerId);
    const p = this.profileTierPath(ownerId, tier);
    if (!existsSync(p)) return [];
    const content = await fs.readFile(p, 'utf-8');
    return content
      .split('\n')
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map((text, index) => ({ index, hash: lineHash(text), text }));
  }

  /**
   * Remove a single line (identified by its hash from {@link listProfileLines})
   * from the given tier file. Returns true if a line was removed, false if
   * nothing matched. Idempotent — removing the same hash twice returns false
   * on the second call.
   */
  async removeProfileLine(ownerId: string, tier: Tier, hash: string): Promise<boolean> {
    const lines = await this.listProfileLines(ownerId, tier);
    const kept = lines.filter((l) => l.hash !== hash);
    if (kept.length === lines.length) return false;

    const next = kept.map((l) => l.text).join('\n') + (kept.length > 0 ? '\n' : '');
    await fs.writeFile(this.profileTierPath(ownerId, tier), next, 'utf-8');
    return true;
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
