import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
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

/**
 * Defense layer 2 for #93 (path traversal via Claude-supplied chat/thread IDs).
 *
 * Zod regex at the tool boundary (`larkIdSchema` in tools.ts) is the
 * primary defense — but anything that calls into `MemoryStore` from a
 * non-tool path (cronjob runtime, dry-run, future code) bypasses Zod.
 * This helper makes the constraint a property of the storage layer
 * itself: any key destined to become a path component is rejected here
 * if it contains a separator, parent-traversal, NUL, or control byte
 * BEFORE it reaches `path.join` (which silently *collapses* `..`
 * rather than rejecting it — the precise hazard #93 exploits).
 *
 * Note: separately from path safety, callers like `saveEpisode` that
 * accept `chatId` from authenticated identity context don't NEED this
 * check (the value already came from a Feishu webhook payload), but
 * apply it anyway to keep the storage layer's contract self-defending.
 */
function assertSafeKey(key: string, field: string): void {
  // Length cap 255 matches POSIX NAME_MAX / macOS HFS+/APFS per-component
  // limit. Beyond that, `fs.mkdir`/`writeFile` would throw ENAMETOOLONG —
  // we'd rather surface a clear "Invalid <field>" upstream than a syscall
  // error. Tool-boundary `LARK_ID_REGEX` caps at 128 (well within NAME_MAX),
  // so the larger 255 here is reachable only from non-tool callers and
  // serves as a final storage-layer guard.
  if (
    !key ||
    typeof key !== 'string' ||
    key.length > 255 ||
    key.includes('/') ||
    key.includes('\\') ||
    key.includes('..') ||
    key.includes('\0') ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f]/.test(key)
  ) {
    throw new Error(
      `Invalid ${field}: "${key.slice(0, 64)}${key.length > 64 ? '…' : ''}" — must not contain '/', '\\', '..', null/control bytes, and must be 1-255 chars.`,
    );
  }
}

/** Normalize a profile line for deduplication (not for storage). */
function normalizeProfileLine(line: string): string {
  return line.trim().replace(/^[-*]\s+/, '').toLowerCase();
}

/**
 * Merge new profile lines into an existing tier file body.
 *
 * Dedup rules:
 * - Case-insensitive line match after trim + leading-bullet strip.
 * - Punctuation is **not** normalized — "prefers tea" and "prefers tea."
 *   are kept as distinct lines to avoid silent merges.
 *
 * Original capitalization and punctuation are preserved in the output.
 *
 * Incoming lines without a `-`/`*` bullet marker are normalized on write to
 * `- <line>` so the tier file remains a well-formed markdown bullet list.
 *
 * Near-duplicates (prefix containment after normalization) are logged to
 * stderr to help operators notice redundant writes, but are still preserved.
 */
export function mergeProfileLines(
  existing: string,
  incoming: string,
  ctx?: { userId?: string; tier?: Tier },
): string {
  const existingLinesRaw = existing.split('\n').filter((l) => l.trim());
  const existingKeys = new Set(existingLinesRaw.map(normalizeProfileLine));
  const existingNormalized = existingLinesRaw.map(normalizeProfileLine);

  const newLines: string[] = [];
  for (const raw of incoming.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeProfileLine(trimmed);
    if (existingKeys.has(key)) continue; // exact match → skip
    newLines.push(trimmed);
    existingKeys.add(key); // also dedupe within the incoming batch

    // Near-duplicate warning: prefix-containment either direction.
    for (const other of existingNormalized) {
      if (key !== other && (key.startsWith(other) || other.startsWith(key))) {
        const where = ctx?.userId && ctx?.tier ? ` in ${ctx.userId}/${ctx.tier}.md` : '';
        console.error(
          `[memory] Possible near-duplicate${where}: incoming "${trimmed}" resembles existing entry "${existingLinesRaw[existingNormalized.indexOf(other)]}"`,
        );
        break;
      }
    }
  }

  if (newLines.length === 0) return existing;

  const appended = newLines
    .map((l) => (/^[-*]\s+/.test(l) ? l : `- ${l}`))
    .join('\n');
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  return existing + sep + appended + '\n';
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
 * Ownership sidecar for a skill file. Persisted as JSON at
 * `skills/<slug>.meta.json` alongside the skill markdown.
 *
 * Stored as a sidecar (not inline frontmatter) so:
 * - `searchSkills` can keep its line-index based parser unchanged.
 * - The .md file remains a clean, human-readable document.
 * - Adding/removing fields doesn't require a content-format migration.
 *
 * `migrated: true` distinguishes sidecars synthesized by the v1.0.14
 * legacy-claim migration from sidecars written by a real `save_skill`
 * call. Diagnostic only — does not affect the owner check.
 */
export interface SkillMeta {
  created_by: string;
  created_at: string;
  updated_at?: string;
  migrated?: boolean;
}

/**
 * Local markdown memory store.
 * Stores memories as .md files under ~/.claude/channels/lark/memories/
 */
export class MemoryStore {
  private baseDir: string;
  /**
   * Per-user async mutex for profile-tier read-modify-write operations
   * (#54 fix). `saveProfile` and `removeProfileLine` both do
   * `read existing → merge → write back`; two concurrent calls for the
   * same userId from different chats (e.g. a cronjob with `created_by =
   * ou_user` firing while user is messaging in a group, or two group
   * chats both seeing distillation results land at once) would race —
   * both read snapshot S, both compute different merges, second write
   * silently clobbers the first → one fact lost with no user-visible
   * error.
   *
   * Per-chat `MessageQueue` already serializes traffic within a single
   * chat, so this only fires for CROSS-chat same-user concurrency. Map
   * keyed by userId; values are the promise tail of the in-flight chain
   * for that user. Empty Map in the steady state — entries are cleaned
   * up on completion to prevent unbounded growth.
   */
  private profileMutex = new Map<string, Promise<void>>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? appConfig.memoriesDir;
  }

  async healthCheck(): Promise<boolean> { return true; }

  /**
   * Run `fn` under the per-user profile mutex (#54). Subsequent calls
   * for the same userId queue behind any in-flight one; calls for
   * different userIds proceed in parallel.
   *
   * Failures in `fn` do NOT poison subsequent calls — the chain
   * advances regardless of outcome (matches `MessageQueue` semantics in
   * `src/queue.ts`). The caller of `withProfileMutex` sees fn's own
   * rejection; the next queued call still gets its turn.
   *
   * NOTE on deadlock safety: callers of this method must NOT recurse
   * back into a mutex-wrapped function on the same userId. Today only
   * `saveProfile` and `removeProfileLine` are wrapped, neither calls
   * the other, and they don't call themselves. A future addition that
   * violates this would deadlock — gate via code review.
   */
  private withProfileMutex<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.profileMutex.get(userId) ?? Promise.resolve();
    // Chain fn after prev SYNCHRONOUSLY (no await between get and set —
    // else two callers reading the same `prev` would both register as
    // its successor and run in parallel, defeating the mutex).
    const next: Promise<T> = prev.then(
      () => fn(),
      () => fn(), // run even if a prior call rejected
    );
    const tail: Promise<void> = next.then(
      () => undefined,
      () => undefined,
    );
    this.profileMutex.set(userId, tail);
    // Cleanup: delete the entry when this call's tail resolves AND no
    // later call has chained on top. Prevents unbounded Map growth.
    //
    // R1-followup belt-and-suspenders: tail is already constructed with
    // both .then handlers returning undefined (lines just above) so it
    // can never reject — but a future contributor refactoring this
    // file might inadvertently swap `tail` for `next` here, which would
    // produce unhandled rejections every time fn() rejects. The
    // explicit .catch closes that hole.
    tail.then(
      () => {
        if (this.profileMutex.get(userId) === tail) {
          this.profileMutex.delete(userId);
        }
      },
      () => {
        // Unreachable today (tail handlers above always resolve),
        // belt-and-suspenders only.
      },
    );
    return next;
  }

  // ── User Profile (tiered, v0.10.0+) ──

  private profileDir(userId: string): string {
    // userId is server-derived (caller open_id from authenticated Feishu
    // session) so it should never carry separators, but #93 motivates
    // defense-in-depth on every path-building site.
    assertSafeKey(userId, 'userId');
    return path.join(this.baseDir, 'profiles', userId);
  }

  private profileTierPath(userId: string, tier: Tier): string {
    return path.join(this.profileDir(userId), `${tier}.md`);
  }

  private legacyProfilePath(userId: string): string {
    assertSafeKey(userId, 'userId');
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
   *
   * Output is the raw tier file bytes (bullets preserved). This is the
   * representation the channel-side memory enricher feeds to Claude as
   * conversational context. The display/edit representation in
   * {@link listProfileLines} strips bullets — the two return formats are
   * intentionally different, and their consumers are disjoint.
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
   *
   * Mode:
   * - `'append'` (default, safe): read the existing tier, merge new lines
   *   (exact-match deduped after `trim + strip-bullet + lowercase`), preserve
   *   all original content. Used by one-off save_memory calls where `content`
   *   is a single fact. Never destroys existing entries.
   * - `'replace'`: overwrite the entire tier file. Reserved for the distiller
   *   auto-flush path, which intentionally rewrites the full tier based on a
   *   fresh read of recent history.
   */
  async saveProfile(
    userId: string,
    content: string,
    tier: Tier,
    mode: 'append' | 'replace' = 'append',
  ): Promise<void> {
    // #54 fix: serialize cross-chat concurrent writes for the same userId.
    // INVARIANT: anything inside this closure must NOT recurse back into
    // saveProfile / saveProfileTiered / removeProfileLine for the same
    // userId — would deadlock the per-user mutex.
    return this.withProfileMutex(userId, async () => {
      await this._saveProfileLocked(userId, content, tier, mode);
    });
  }

  /**
   * Atomic dual-tier replace (#54 R1-followup). The `profile_tiered` path
   * (called from `tools.ts:save_memory(type='profile_tiered')` and the
   * auto-flush distillation flow) needs to REPLACE both `public.md` and
   * `private.md` from a single fresh read of recent history. Pre-followup
   * this was two separate `saveProfile(...,'replace')` calls — each grabbed
   * the per-user mutex independently, so a CROSS-CHAT save between the two
   * calls could land mid-pair (after public-replace but before private-
   * replace), then be silently clobbered by the private-replace. The dual
   * write was NOT atomic from a same-user-cross-chat concurrency
   * perspective even with the #54 fix.
   *
   * This method does both writes inside ONE `withProfileMutex` invocation,
   * so the public+private pair is observable as atomic to any other
   * concurrent same-user save / remove.
   *
   * Inputs are pre-formatted strings (caller does the JSON parse + bullet
   * formatting; we don't re-parse). L1 safety net is re-applied to the
   * public tier as defense-in-depth — even though `parseTieredProfile`
   * already classified, a future caller bypassing parseTieredProfile
   * would still get the L1 protection.
   */
  async saveProfileTiered(
    userId: string,
    content: { public: string; private: string },
  ): Promise<void> {
    return this.withProfileMutex(userId, async () => {
      await this.migrateIfNeeded(userId);

      // L1 safety net (defense-in-depth — see saveProfile's analogous
      // path at lines 408-440). Lines that pass parseTieredProfile but
      // L1 thinks are private get moved into the replacement private
      // content here, not appended on top of existing private — because
      // the caller's intent is REPLACE of both tiers.
      const publicLines = content.public.split('\n');
      const safePublic: string[] = [];
      const redirected: string[] = [];
      for (const line of publicLines) {
        if (line.trim() && applyL1(line) === 'private') {
          redirected.push(line);
        } else {
          safePublic.push(line);
        }
      }
      if (redirected.length > 0) {
        console.error(
          `[memory] L1 safety net (saveProfileTiered): redirected ${redirected.length} line(s) ` +
          `from public to private for ${userId} (LLM-classified public but L1 matched private rules).`,
        );
      }
      const sep =
        content.private && !content.private.endsWith('\n') ? '\n' : '';
      const finalPrivate =
        redirected.length > 0
          ? content.private + sep + redirected.join('\n')
          : content.private;

      // Atomic pair INSIDE the single mutex acquisition. No other
      // same-user save / remove can interleave between these two writes.
      await this._writeProfileTier(userId, 'public', safePublic.join('\n'), 'replace');
      await this._writeProfileTier(userId, 'private', finalPrivate, 'replace');
    });
  }

  /**
   * Body of saveProfile, callable only under the per-user profile mutex.
   * Split from the public method so the mutex wrapping lives at the
   * boundary and the body stays readable (and future internal callers
   * that ARE already under the mutex can skip the re-entry).
   */
  private async _saveProfileLocked(
    userId: string,
    content: string,
    tier: Tier,
    mode: 'append' | 'replace',
  ): Promise<void> {
    await this.migrateIfNeeded(userId);

    // L1 safety net (#75). CLAUDE.md promises a 3-layer defense
    // (L1 > L2 > L3) for the privacy classifier, but pre-v1.0.13 the L1
    // check only fired during legacy-profile migration — never on normal
    // save_memory writes. The `parseTieredProfile` helper that was meant
    // to be the L1 gate at write time is exported but no production path
    // calls it (Claude calls save_memory directly with the LLM-chosen
    // tier, fully trusted).
    //
    // Per-line server-side check: when the caller asks for `public`,
    // applyL1 rejects any line whose content matches a blacklist regex
    // or keyword (phone, ID, token, password, salary, ...) and forces
    // it into the `private` tier instead. private-tier writes pass
    // through unchanged — already private.
    //
    // Scope note: the check is intentionally PER-LINE. A bad actor (or
    // a creative LLM) could in theory split sensitive content across
    // lines so no single line matches an L1 regex (e.g. "the phone\n139\n
    // 12345678"). The threat model here assumes a cooperative model,
    // not an adversarial one — a per-line approach matches how
    // distillation actually emits facts (one fact per bullet line).
    // Future hardening would need cross-line context analysis.
    //
    // Replace semantics: when mode='replace' and the redirect splits
    // content across tiers, public is still REPLACED (with the safe
    // subset, possibly empty) — honoring the caller's intent to rewrite
    // public from scratch. The redirected unsafe lines are APPENDED to
    // private, because we only have the redirected subset, not the
    // existing private content to safely replace it with.
    if (tier === 'public') {
      const lines = content.split('\n');
      const safe: string[] = [];
      const unsafe: string[] = [];
      for (const line of lines) {
        if (line.trim() && applyL1(line) === 'private') {
          unsafe.push(line);
        } else {
          safe.push(line);
        }
      }
      if (unsafe.length > 0) {
        console.error(
          `[memory] L1 safety net: redirected ${unsafe.length} line(s) from public to private ` +
          `for ${userId} (LLM-classified public but L1 matched private rules — e.g. phone, ID, token, salary).`,
        );
        await this._writeProfileTier(userId, 'private', unsafe.join('\n'), 'append');
        // Write the safe subset to public honoring caller's mode.
        // If mode='replace' and safe is effectively empty, we still
        // explicitly replace (to empty) so the caller's intent of
        // "overwrite public" is honored. For append + empty safe, skip
        // the call (no-op write anyway).
        const safeContent = safe.join('\n');
        if (mode === 'replace' || safeContent.trim()) {
          await this._writeProfileTier(userId, 'public', safeContent, mode);
        }
        return;
      }
    }

    await this._writeProfileTier(userId, tier, content, mode);
  }

  /**
   * Internal: write a profile tier file. Extracted from saveProfile so
   * the L1 safety net (#75) can split a single write across both tiers
   * without duplicating the mkdir / merge / write logic.
   *
   * Callers MUST have already run {@link migrateIfNeeded}.
   */
  private async _writeProfileTier(
    userId: string,
    tier: Tier,
    content: string,
    mode: 'append' | 'replace',
  ): Promise<void> {
    const dir = this.profileDir(userId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = this.profileTierPath(userId, tier);

    if (mode === 'replace') {
      await fs.writeFile(filePath, content, 'utf-8');
      return;
    }

    // append mode
    const existing = existsSync(filePath) ? await fs.readFile(filePath, 'utf-8') : '';
    const merged = mergeProfileLines(existing, content, { userId, tier });
    if (merged === existing) return; // all incoming lines were duplicates — skip write
    await fs.writeFile(filePath, merged, 'utf-8');
  }

  /**
   * Return the lines of a profile tier as addressable items. Each line carries
   * a short sha1-based hash that is stable per content — callers (e.g. the
   * forget_memory tool) use the hash to identify a line without the file
   * needing a durable row id.
   *
   * Blank lines are skipped. Leading/trailing whitespace is trimmed. A leading
   * `-`/`*` bullet marker is also stripped so `text` (and the derived hash) is
   * storage-format-independent — a fact saved as "foo" by the distiller and
   * later merged via append as "- foo" shares one hash and renders identically
   * in `what_do_you_know`.
   */
  async listProfileLines(ownerId: string, tier: Tier): Promise<ProfileLine[]> {
    await this.migrateIfNeeded(ownerId);
    const p = this.profileTierPath(ownerId, tier);
    if (!existsSync(p)) return [];
    const content = await fs.readFile(p, 'utf-8');
    return content
      .split('\n')
      .map((raw) => raw.trim().replace(/^[-*]\s+/, ''))
      .filter(Boolean)
      .map((text, index) => ({ index, hash: lineHash(text), text }));
  }

  /**
   * Remove every line whose 8-char hash matches `hash` from the given
   * tier file (#88). Returns the count of removed lines AND a sample of
   * the removed text so the caller can surface a faithful confirmation
   * message: an 8-char sha1 prefix can collide across duplicates of the
   * same fact ("prefers tea" written twice with different bullet
   * formatting normalizes to the same key) OR via birthday paradox on
   * adversarial input. Pre-v1.0.19 the tool reply hardcoded singular
   * `Removed "<text>" from ...` regardless of how many lines vanished
   * — silent multi-delete with no operator-visible signal.
   *
   * Idempotent — removing the same hash twice returns `removed: 0` on
   * the second call.
   *
   * The rewritten file is bullet-normalized: every remaining line is
   * written back with a `- ` prefix so the tier stays visually
   * consistent with the append-mode storage convention.
   */
  async removeProfileLine(
    ownerId: string,
    tier: Tier,
    hash: string,
  ): Promise<{ removed: number; sample: string | null; allTexts: string[] }> {
    // #54 fix: same per-user mutex as saveProfile. removeProfileLine has
    // the same read-modify-write shape (`listProfileLines → filter →
    // writeFile`) and the same cross-chat race window: a forget_memory
    // in chat A concurrent with a save_memory in chat B for the same
    // user would lose the save's delta if forget's write landed last.
    //
    // INVARIANT: anything inside this closure must NOT recurse back into
    // saveProfile / saveProfileTiered / removeProfileLine for the same
    // ownerId — would deadlock the per-user mutex.
    return this.withProfileMutex(ownerId, async () => {
      const lines = await this.listProfileLines(ownerId, tier);
      const targets = lines.filter((l) => l.hash === hash);
      if (targets.length === 0) return { removed: 0, sample: null, allTexts: [] };
      const kept = lines.filter((l) => l.hash !== hash);

      const next = kept.map((l) => `- ${l.text}`).join('\n') + (kept.length > 0 ? '\n' : '');
      await fs.writeFile(this.profileTierPath(ownerId, tier), next, 'utf-8');
      return {
        removed: targets.length,
        sample: targets[0].text,
        allTexts: targets.map((t) => t.text),
      };
    });
  }

  // ── Episodes ──

  async searchEpisodes(
    query: string,
    scope?: { chatId?: string; threadId?: string }
  ): Promise<Episode[]> {
    if (!scope?.chatId) return [];

    // Defense layer 2 against #93 path traversal — assert before path.join.
    // Read paths must guard too: even though listing/reading malformed
    // paths can't *write* outside baseDir, a traversal in `chatId` could
    // exfiltrate the *existence* of files elsewhere (return their contents
    // if they happen to look like episodes), leaking server info.
    assertSafeKey(scope.chatId, 'chatId');
    if (scope.threadId) assertSafeKey(scope.threadId, 'threadId');

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
    // Defense layer 2 against #93 path traversal — assert before path.join.
    assertSafeKey(meta.chatId, 'chatId');
    if (meta.threadId) assertSafeKey(meta.threadId, 'threadId');

    const dir =
      type === 'thread' && meta.threadId
        ? path.join(this.baseDir, 'episodes', meta.chatId, 'threads', meta.threadId)
        : path.join(this.baseDir, 'episodes', meta.chatId);

    await fs.mkdir(dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${timestamp}.md`;
    await fs.writeFile(path.join(dir, fileName), content, 'utf-8');
  }

  /**
   * Retention prune for episode files (#109). `saveEpisode` writes one
   * `.md` per buffer flush; `listEpisodes` / `searchEpisodes` then do
   * `readdir + per-file score` on every memory enrichment, so cost is
   * O(N) per inbound message. Without prune N grows monotonically —
   * search becomes the slow path before disk fills.
   *
   * Walks every chat directory under `episodes/` and unlinks files
   * whose mtime is older than `maxAgeMs`. Subdirectories (chat threads
   * live under `episodes/<chat>/threads/<thread>/`) are recursed.
   *
   * Returns {removedFiles, bytesFreed} for observability + tests.
   * Best-effort throughout: unlink/stat failures are swallowed so one
   * bad file doesn't abort the rest. Empty per-chat dirs are left as
   * empty dirs (cheap, occasional readdir of an empty dir is fine).
   */
  async pruneEpisodes(maxAgeMs: number, nowMs: number = Date.now()): Promise<{ removedFiles: number; bytesFreed: number }> {
    const root = path.join(this.baseDir, 'episodes');
    const cutoff = nowMs - maxAgeMs;
    let removedFiles = 0;
    let bytesFreed = 0;

    // Recursive walker — handles both `episodes/<chat>/*.md` and
    // `episodes/<chat>/threads/<thread>/*.md` shapes.
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // dir gone — benign
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(p);
          continue;
        }
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        try {
          const s = await fs.stat(p);
          if (s.mtimeMs < cutoff) {
            await fs.unlink(p);
            removedFiles++;
            bytesFreed += s.size;
          }
        } catch {
          // stat / unlink raced with a concurrent delete or hit EACCES.
          // Best-effort; skip this file.
        }
      }
    };

    try {
      await walk(root);
    } catch {
      // root readdir failed — no episodes dir. No-op.
    }
    return { removedFiles, bytesFreed };
  }

  async listEpisodes(chatId: string): Promise<Episode[]> {
    assertSafeKey(chatId, 'chatId');
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
    assertSafeKey(chatId, 'chatId');
    const dir = path.join(this.baseDir, 'episodes', chatId);
    for (const id of ids) {
      // Episode IDs are server-generated filenames (timestamp.md) but the
      // delete API takes them as opaque strings, so apply the same guard —
      // a caller could pass `../../etc/passwd.md` and otherwise unlink it.
      assertSafeKey(id, 'episode id');
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

  /**
   * Normalize a user-supplied skill name into a filesystem-safe slug.
   *
   * Returns an empty string when the input has no alphanumeric character
   * (e.g. `""`, `"!!!"`, `"---"`). Tool handlers MUST treat empty-slug as
   * an invalid name and reject before calling {@link saveSkill}, otherwise
   * the write would land on `skills/.md` / `skills/.meta.json` — collidable
   * across all empty-slug attempts.
   */
  static sanitizeSkillSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private skillsDir(): string {
    return path.join(this.baseDir, 'skills');
  }

  private skillFilePath(slug: string): string {
    return path.join(this.skillsDir(), `${slug}.md`);
  }

  private skillMetaPath(slug: string): string {
    return path.join(this.skillsDir(), `${slug}.meta.json`);
  }

  /**
   * Read the ownership sidecar for a skill slug.
   *
   * Returns null when:
   * - the sidecar does not exist (legacy skill or fresh slug),
   * - or the file exists but cannot be parsed as JSON (treated as legacy
   *   so a corrupted sidecar doesn't permanently lock a slug — the
   *   migration / runtime path will recreate it).
   *
   * NOTE: callers that need to distinguish "no sidecar AND no .md" from
   * "no sidecar BUT .md exists" must check {@link existsSync} on
   * {@link skillFilePath} separately. The legacy-handling policy lives in
   * the consumer ({@link saveSkill}, {@link migrateLegacySkills}), not
   * here.
   */
  async readSkillMeta(slug: string): Promise<SkillMeta | null> {
    const p = this.skillMetaPath(slug);
    if (!existsSync(p)) return null;
    try {
      const raw = await fs.readFile(p, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SkillMeta>;
      if (typeof parsed.created_by !== 'string' || !parsed.created_by) return null;
      return {
        created_by: parsed.created_by,
        created_at: typeof parsed.created_at === 'string' ? parsed.created_at : new Date().toISOString(),
        migrated: parsed.migrated === true,
        updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Atomically write the sidecar JSON for a slug.
   *
   * R1-audit finding on PR #92 (v1.0.14): a plain `fs.writeFile` on the
   * final `.meta.json` path is NOT atomic — two concurrent `saveSkill`
   * calls on the same fresh slug can each pass the "no sidecar" check,
   * then race to write the final file. The empirically-observed failure
   * (3/50 of stress runs) was malformed JSON (`{...}\n}\n`-style mixed
   * output), which {@link readSkillMeta} treats as null → the slug then
   * falls into the `legacy-locked` branch on every subsequent save and
   * becomes permanently un-recoverable without operator intervention.
   *
   * Mitigation: write to a per-process temp file in the same directory
   * (so rename is intra-filesystem and atomic on POSIX), then rename onto
   * the final path. The last writer's rename wins, but the file content
   * is always a complete, valid JSON document — never a corrupt
   * interleave. The security property is unchanged: the gate is
   * `readSkillMeta`'s owner field, not the existence of the .tmp file.
   *
   * The race in "who wins ownership when two callers both see no
   * sidecar" remains (analogous to the saveProfile TOCTOU in #54) — out
   * of scope for this fix. What this DOES prevent is the much worse
   * outcome where the racing writers brick the slug for everyone.
   */
  private async writeSkillMeta(slug: string, meta: SkillMeta): Promise<void> {
    await fs.mkdir(this.skillsDir(), { recursive: true });
    const finalPath = this.skillMetaPath(slug);
    // tmpPath MUST be unique per write — using only pid+timestamp collides
    // when two parallel calls land in the same millisecond. Both would
    // call fs.writeFile against the same tmp file, racing inside the
    // syscall, and the second rename would then ENOENT because the first
    // already moved the shared tmp away. randomBytes guarantees per-call
    // uniqueness with negligible collision risk.
    const tmpPath = `${finalPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
      await fs.rename(tmpPath, finalPath);
    } catch (err) {
      // Best-effort cleanup; ignore unlink failures (the tmp file may
      // already be gone if rename partially succeeded).
      try { await fs.unlink(tmpPath); } catch {}
      throw err;
    }
  }

  /**
   * One-shot migration: scan all legacy skills (.md files without a
   * sibling .meta.json) and attribute them to the operator (OWNER).
   *
   * Rationale (#84): pre-v1.0.14 `save_skill` had no ownership tracking,
   * so any user in any chat could overwrite any other user's skill, and
   * malicious `content` would be surfaced globally by `searchSkills`.
   * v1.0.14 adds an owner gate that refuses save_skill when the slug is
   * already owned by someone else. The migration runs at startup to claim
   * legacy slugs for the OWNER (`LARK_OWNER_OPEN_ID`) so the operator
   * doesn't get locked out of their own skills the moment they upgrade.
   *
   * - Idempotent: skills with an existing sidecar are skipped.
   * - No-op without `LARK_OWNER_OPEN_ID`: legacy skills stay un-claimed
   *   and any `save_skill` on those slugs will be rejected (owner-mismatch
   *   path) until the operator either sets OWNER + restarts or deletes
   *   the offending .md manually. This is the safer failure mode — a
   *   silent migration without OWNER would risk attributing legacy
   *   content to the first caller (the precise threat we're closing).
   * - Sidecar's `created_at` reflects the .md's mtime (best-effort recovery
   *   of when the skill was actually written) and `migrated: true` so
   *   operators can tell migrated-from-legacy apart from new sidecars.
   */
  async migrateLegacySkills(ownerOpenId: string | null): Promise<void> {
    const dir = this.skillsDir();
    if (!existsSync(dir)) return; // no skills yet
    if (!ownerOpenId) {
      const orphans = await this.listLegacySlugs();
      if (orphans.length > 0) {
        console.error(
          `[migrate] skill ownership: ${orphans.length} legacy skill(s) without sidecar; LARK_OWNER_OPEN_ID is unset so they will be locked against save_skill overwrite. ` +
          `Set LARK_OWNER_OPEN_ID and restart to claim them, or manually delete the relevant .md file(s) to free the slug.`,
        );
      }
      return;
    }
    const slugs = await this.listLegacySlugs();
    if (slugs.length === 0) return; // nothing to claim, no summary needed
    let claimed = 0;
    const failures: string[] = [];
    for (const slug of slugs) {
      let createdAt = new Date().toISOString();
      try {
        const stat = await fs.stat(this.skillFilePath(slug));
        createdAt = stat.mtime.toISOString();
      } catch {
        // mtime unreadable — fall back to "now"; the sidecar timestamp is
        // informational, not part of the owner check.
      }
      try {
        await this.writeSkillMeta(slug, { created_by: ownerOpenId, created_at: createdAt, migrated: true });
        claimed++;
      } catch (err) {
        console.error(`[migrate] skill ownership: failed to write sidecar for "${slug}":`, err);
        failures.push(slug);
      }
    }
    // Always emit a summary when there were legacy slugs (R2-audit F4) — a
    // total-failure case previously left the operator with only per-slug
    // error lines buried among other startup noise. The summary is what
    // operators grep for after upgrade.
    console.error(
      `[migrate] skill ownership: claimed ${claimed}/${slugs.length} legacy skill(s) for OWNER ${ownerOpenId}` +
        (failures.length > 0 ? ` (failed: ${failures.join(', ')})` : ''),
    );
    // Operator-visibility line for the just-claimed names + descriptions
    // (R2-audit F2 minimal). Migration only gates the WRITE channel; legacy
    // .md content was created by anyone-could-write-anything pre-v1.0.14
    // and may carry prompt-injection payloads in `# name` or the description
    // line — those continue to flow into Claude's memory enrichment after
    // migration, but now under the operator's name. Surfacing the claimed
    // names+descs gives the operator a one-time chance to spot anything
    // they didn't write. Full content sanitization is a separate followup.
    if (claimed > 0) {
      for (const slug of slugs) {
        if (failures.includes(slug)) continue;
        try {
          const body = await fs.readFile(this.skillFilePath(slug), 'utf-8');
          const lines = body.split('\n');
          const name = (lines[0] ?? '').replace(/^#\s*/, '').trim();
          const desc = (lines[1] ?? '').trim();
          console.error(`[migrate] skill ownership:   - ${slug}  ←  "${name}" — ${desc}`);
        } catch {
          console.error(`[migrate] skill ownership:   - ${slug}  ←  (content unreadable)`);
        }
      }
      console.error(
        '[migrate] skill ownership: ^ review the above for any skill you did NOT author. ' +
        'Pre-v1.0.14 writes had no caller authorization (#84); migrated content is now attributed to OWNER. ' +
        'Delete unwanted entries with: rm ~/.claude/channels/lark/memories/skills/<slug>.{md,meta.json}',
      );
    }
  }

  /**
   * List slugs (sans .md extension) of every skill file lacking a sidecar.
   *
   * Distinguishes the no-skills-dir case (ENOENT → []) from
   * permission/IO failures (rethrow), so the caller doesn't silently
   * report "no legacy skills" when migration is actually blocked
   * (R2-audit F3).
   */
  private async listLegacySlugs(): Promise<string[]> {
    const dir = this.skillsDir();
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return []; // skills dir not created yet
      console.error(`[migrate] skill ownership: cannot read ${dir} (${code ?? 'unknown error'}) — migration aborted. Fix permissions and restart.`);
      throw err;
    }
    const out: string[] = [];
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const slug = f.slice(0, -'.md'.length);
      if (!existsSync(this.skillMetaPath(slug))) out.push(slug);
    }
    return out;
  }

  /**
   * Persist a skill with ownership tracking (#84).
   *
   * Authorization model:
   * - Slug is derived from `name` via {@link sanitizeSkillSlug}. Empty
   *   slugs (no alphanumeric characters) are rejected — callers must
   *   surface a recognizable error to the user.
   * - Sidecar JSON at `skills/<slug>.meta.json` records `created_by`
   *   (caller open_id at first write). Subsequent writes by anyone else
   *   are denied (`reason: 'not-owner'`).
   * - Sidecar absent: treated as a fresh slug — caller becomes owner.
   *   The startup migration ({@link migrateLegacySkills}) closes the
   *   "legacy .md without sidecar" window by pre-claiming for OWNER, so
   *   under normal operation, missing-sidecar means truly new.
   *   If migration didn't run (no OWNER configured), pre-existing .md
   *   files have no sidecar and an arbitrary caller would otherwise be
   *   able to claim them — defend by additionally rejecting when .md
   *   exists but sidecar is missing AND no OWNER is configured.
   *
   * Write order: .md first, then sidecar. Rationale: the inverse order
   * (sidecar first) creates a worse failure mode — a sidecar without an
   * .md would falsely lock the slug against the next legitimate save.
   * In the .md-first order, a sidecar-write failure leaves the slug
   * temporarily unowned, but the next save by the same caller will
   * succeed (sidecar missing path) and the startup migration would
   * eventually claim it for OWNER on the next restart.
   */
  async saveSkill(
    name: string,
    description: string,
    content: string,
    opts: { caller: string; ownerOpenId: string | null },
  ): Promise<
    | { ok: true; slug: string; action: 'created' | 'updated' }
    | { ok: false; reason: 'empty-slug' | 'not-owner' | 'legacy-locked'; message: string }
  > {
    const slug = MemoryStore.sanitizeSkillSlug(name);
    if (!slug) {
      return {
        ok: false,
        reason: 'empty-slug',
        message: `Skill name "${name}" sanitizes to an empty slug. Use a name containing at least one alphanumeric character (a-z, 0-9).`,
      };
    }

    const dir = this.skillsDir();
    await fs.mkdir(dir, { recursive: true });

    const filePath = this.skillFilePath(slug);
    const sidecar = await this.readSkillMeta(slug);
    const fileExists = existsSync(filePath);

    if (sidecar) {
      if (sidecar.created_by !== opts.caller) {
        return {
          ok: false,
          reason: 'not-owner',
          message:
            `Skill "${slug}" is owned by another user and cannot be overwritten. ` +
            `Pick a different name, or ask the original author / operator to delete ` +
            `the skill first (rm ~/.claude/channels/lark/memories/skills/${slug}.{md,meta.json}).`,
        };
      }
    } else if (fileExists) {
      // No sidecar BUT .md exists — legacy skill that migration didn't
      // (or couldn't) claim. Refuse to attribute it to the current caller
      // since we cannot prove they wrote it. Operator can run with
      // LARK_OWNER_OPEN_ID set + restart to migrate, or manually delete.
      return {
        ok: false,
        reason: 'legacy-locked',
        message:
          `Skill "${slug}" exists from a legacy install with no ownership record. ` +
          (opts.ownerOpenId
            ? `Restart the plugin to run the legacy-skill migration (it will be claimed for OWNER).`
            : `Set LARK_OWNER_OPEN_ID and restart to enable the legacy-skill migration, or manually delete the file.`),
      };
    }

    const fileContent = `# ${name}\n${description}\n\n${content}`;
    await fs.writeFile(filePath, fileContent, 'utf-8');

    const now = new Date().toISOString();
    const newMeta: SkillMeta = sidecar
      ? { ...sidecar, updated_at: now }
      : { created_by: opts.caller, created_at: now };
    try {
      await this.writeSkillMeta(slug, newMeta);
    } catch (err) {
      // .md write already succeeded — surface sidecar failure to stderr
      // but return success on the user-visible operation. The slug is
      // temporarily unowned; next save by the same caller will re-attempt
      // the sidecar, and the next startup migration will claim it for
      // OWNER if it's still bare.
      console.error(`[memory] saveSkill: wrote ${filePath} but failed to write sidecar:`, err);
    }
    return { ok: true, slug, action: sidecar ? 'updated' : 'created' };
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
