import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from '../config.js';
import type { MemoryProvider, Episode, EpisodeMeta, Skill } from './interface.js';

// ── Low-level OpenViking HTTP client ──

class OpenVikingClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.headers = {
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    };
  }

  async health(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers,
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** Index a text resource into OpenViking via temp_upload + add-resource */
  async indexResource(targetPath: string, content: string): Promise<void> {
    try {
      // Step 1: Create a temp file from the content
      const blob = new Blob([content], { type: 'text/markdown' });
      const formData = new FormData();
      formData.append('file', blob, 'content.md');

      const uploadResp = await fetch(`${this.baseUrl}/api/v1/resources/temp_upload`, {
        method: 'POST',
        headers: this.headers,
        body: formData,
        signal: AbortSignal.timeout(10000),
      });
      if (!uploadResp.ok) {
        console.error(`[openviking] temp_upload failed: ${uploadResp.status}`);
        return;
      }
      const uploadData = (await uploadResp.json()) as any;
      const tempFileId = uploadData?.result?.temp_file_id;
      if (!tempFileId) {
        console.error('[openviking] temp_upload returned no temp_file_id');
        return;
      }

      // Step 2: Add the resource at the target path
      const addResp = await fetch(`${this.baseUrl}/api/v1/resources`, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          temp_file_id: tempFileId,
          to: targetPath,
          wait: true,
          timeout: 10,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!addResp.ok) {
        const errData = await addResp.json().catch(() => ({}));
        console.error(`[openviking] add-resource failed for ${targetPath}:`, (errData as any)?.error?.message ?? addResp.status);
      }
    } catch (err) {
      console.error(`[openviking] indexResource failed for ${targetPath}:`, (err as Error).message);
    }
  }

  /** Semantic search using the find API */
  async find(
    query: string,
    targetUri?: string,
    limit?: number,
    scoreThreshold?: number
  ): Promise<Array<{ uri: string; score: number; abstract: string }>> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/v1/search/find`, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          target_uri: targetUri ?? '',
          limit: limit ?? appConfig.maxSearchResults * 3, // fetch more, filter later
          score_threshold: scoreThreshold ?? appConfig.minSearchScore,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as any;
      const result = data?.result ?? {};
      // Combine memories, resources, skills into a flat list
      const all: Array<{ uri: string; score: number; abstract: string }> = [];
      for (const key of ['memories', 'resources', 'skills']) {
        for (const item of result[key] ?? []) {
          all.push({
            uri: item.uri ?? '',
            score: item.score ?? 0,
            abstract: item.abstract ?? '',
          });
        }
      }
      return all.sort((a, b) => b.score - a.score);
    } catch (err) {
      console.error(`[openviking] find failed:`, (err as Error).message);
      return [];
    }
  }

  /** Create a directory in the viking filesystem */
  async mkdir(uri: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/v1/fs/mkdir`, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error(`[openviking] mkdir failed for ${uri}:`, (err as Error).message);
    }
  }

  /** Delete a resource from the viking filesystem */
  async rm(uri: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/v1/fs?uri=${encodeURIComponent(uri)}`, {
        method: 'DELETE',
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error(`[openviking] rm failed for ${uri}:`, (err as Error).message);
    }
  }
}

// ── MemoryProvider implementation with dual-write ──

export class OpenVikingMemoryProvider implements MemoryProvider {
  private client: OpenVikingClient;
  private memoriesDir: string;

  constructor(url: string, apiKey?: string) {
    this.client = new OpenVikingClient(url, apiKey);
    this.memoriesDir = appConfig.memoriesDir;
  }

  async healthCheck(): Promise<boolean> {
    return this.client.health();
  }

  // ── Profiles (hot path — read from local file, not OpenViking) ──

  async getProfile(userId: string): Promise<string | null> {
    // Hot path: read from local file (faster than API, always available)
    const filePath = path.join(this.memoriesDir, 'profiles', `${userId}.md`);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  async saveProfile(userId: string, content: string): Promise<void> {
    // Write local file (primary storage)
    const dir = path.join(this.memoriesDir, 'profiles');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${userId}.md`), content, 'utf-8');
    // Index in OpenViking (for potential future search)
    await this.client.indexResource(`viking://resources/profiles/${userId}.md`, content);
  }

  // ── Episodes (cold path — vector search) ──

  async searchEpisodes(
    query: string,
    scope?: { chatId?: string; threadId?: string }
  ): Promise<Episode[]> {
    if (!scope?.chatId) return [];

    const targetUri = scope.threadId
      ? `viking://resources/episodes/${scope.chatId}/threads/${scope.threadId}`
      : `viking://resources/episodes/${scope.chatId}`;

    // Fetch extra results to account for .overview.md entries that will be filtered out
    const results = await this.client.find(query, targetUri, appConfig.maxSearchResults * 2);

    // Filter out .overview.md entries (they are directory metadata, not user content)
    const filtered = results
      .filter(r => !r.uri.endsWith('.overview.md'))
      .slice(0, appConfig.maxSearchResults);

    // For results with empty abstract, try to read content from local file
    const episodes: Episode[] = [];
    for (const r of filtered) {
      let content = r.abstract;
      if (!content) {
        // Try local file fallback
        const ts = this.extractTimestamp(r.uri);
        if (ts) {
          const localPath = scope.threadId
            ? path.join(this.memoriesDir, 'episodes', scope.chatId!, 'threads', scope.threadId, `${ts}.md`)
            : path.join(this.memoriesDir, 'episodes', scope.chatId!, `${ts}.md`);
          try {
            content = await fs.readFile(localPath, 'utf-8');
          } catch { /* not found locally */ }
        }
      }
      episodes.push({
        id: r.uri,
        content: content || '[content unavailable]',
        timestamp: this.extractTimestamp(r.uri),
        score: r.score,
        chatId: scope.chatId,
        threadId: scope.threadId,
      });
    }
    return episodes;
  }

  async saveEpisode(
    type: 'chat' | 'thread',
    content: string,
    meta: EpisodeMeta
  ): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');

    const fileDir =
      type === 'thread' && meta.threadId
        ? path.join(this.memoriesDir, 'episodes', meta.chatId, 'threads', meta.threadId)
        : path.join(this.memoriesDir, 'episodes', meta.chatId);

    // Write local file (primary storage)
    await fs.mkdir(fileDir, { recursive: true });
    const filePath = path.join(fileDir, `${ts}.md`);
    await fs.writeFile(filePath, content, 'utf-8');

    // Index in OpenViking
    const ovPath =
      type === 'thread' && meta.threadId
        ? `viking://resources/episodes/${meta.chatId}/threads/${meta.threadId}/${ts}.md`
        : `viking://resources/episodes/${meta.chatId}/${ts}.md`;
    await this.client.indexResource(ovPath, content);
  }

  async listEpisodes(chatId: string): Promise<Episode[]> {
    const dir = path.join(this.memoriesDir, 'episodes', chatId);
    try {
      const files = await fs.readdir(dir);
      const episodes: Episode[] = [];
      for (const file of files.filter(f => f.endsWith('.md'))) {
        const content = await fs.readFile(path.join(dir, file), 'utf-8');
        const stat = await fs.stat(path.join(dir, file));
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
    for (const id of ids) {
      // id may be a full URI (from searchEpisodes) or a filename (from listEpisodes)
      if (id.startsWith('viking://')) {
        // Full URI — extract the resource path for deletion
        // URI: viking://resources/episodes/{chatId}/{ts}.md/upload_xxx.md → delete the {ts}.md dir
        const tsMatch = id.match(/\/(\d{4}-\d{2}-\d{2}T[^/]+\.md)\//);
        if (tsMatch) {
          const dirUri = id.substring(0, id.indexOf(tsMatch[1]) + tsMatch[1].length);
          await this.client.rm(dirUri);
        }
      } else {
        // Filename — construct the Viking URI (keep .md, it's a directory in Viking)
        await this.client.rm(`viking://resources/episodes/${chatId}/${id}`);
      }
      // Delete local file — derive filename from id
      const filename = id.startsWith('viking://')
        ? (() => { const ts = this.extractTimestamp(id); return ts ? `${ts}.md` : ''; })()
        : id;
      if (filename) {
        try {
          await fs.unlink(path.join(this.memoriesDir, 'episodes', chatId, filename));
        } catch { /* ignore — may already be deleted */ }
      }
    }
  }

  // ── Skills (cold path — vector search) ──

  async searchSkills(query: string): Promise<Skill[]> {
    // Search without target_uri restriction (Viking's target_uri doesn't reliably match
    // shallow paths like skills/). Fetch generously and filter client-side by URI prefix.
    const results = await this.client.find(query, undefined, appConfig.maxSearchResults * 5);

    const skillPrefix = 'viking://resources/skills/';
    const filtered = results
      .filter(r => r.uri.startsWith(skillPrefix) && !r.uri.endsWith('.overview.md'))
      .slice(0, appConfig.maxSearchResults);

    const skills: Skill[] = [];
    for (const r of filtered) {
      // URI: viking://resources/skills/{name}.md/upload_xxx.md → extract {name}
      const afterPrefix = r.uri.slice(skillPrefix.length);
      const name = afterPrefix.split('/')[0]?.replace('.md', '') ?? '';

      // Try to read full content from local file
      let content = r.abstract;
      if (!content) {
        try {
          content = await fs.readFile(path.join(this.memoriesDir, 'skills', `${name}.md`), 'utf-8');
        } catch { /* fallback */ }
      }

      const lines = (content || '').split('\n');
      const description = (lines[1] ?? '').trim();
      skills.push({ name, description, content: content || '[content unavailable]', score: r.score });
    }
    return skills;
  }

  async saveSkill(name: string, description: string, content: string): Promise<void> {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const fileContent = `# ${name}\n${description}\n\n${content}`;

    // Write local file
    const dir = path.join(this.memoriesDir, 'skills');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${normalizedName}.md`), fileContent, 'utf-8');

    // Index in OpenViking
    await this.client.indexResource(`viking://resources/skills/${normalizedName}.md`, fileContent);
  }

  // ── Helpers ──

  private extractTimestamp(uri: string): string {
    // URI format: viking://resources/episodes/{chatId}/{ts}.md/upload_xxx.md
    // We need the {ts}.md segment (parent of the upload file)
    const parts = uri.split('/');
    // Find the segment that looks like a timestamp (ISO-ish format)
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = parts[i].replace('.md', '');
      if (/^\d{4}-\d{2}-\d{2}T/.test(seg)) return seg;
    }
    return '';
  }
}
