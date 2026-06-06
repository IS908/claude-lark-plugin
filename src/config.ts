import { config } from 'dotenv';
import path from 'node:path';
import os from 'node:os';

/**
 * Config lifecycle (#154):
 *
 * `appConfig` (exported below) is built ONCE at module load time —
 * `dotenv` reads `~/.claude/channels/lark/.env`, every `optional*`
 * helper captures `process.env[KEY]` into the literal, and the
 * resulting object is frozen-ish (no setter discipline beyond
 * "don't write to it"). **There is no hot-reload.** Mutating
 * `process.env.LARK_*` at runtime has NO effect on `appConfig.*`
 * reads from anywhere in the codebase.
 *
 * If a test or future use site needs to verify env-override
 * behavior, it must either (a) set `process.env.LARK_*` BEFORE the
 * first `import './config.js'` in the entry point, or (b) spawn a
 * subprocess with the env preset. Setting env after `appConfig` is
 * imported and expecting the change to land is a known footgun.
 *
 * Hot-path use sites that read `appConfig.someKey` per-call (e.g.
 * `src/memory/file.ts` cap reads, `src/scheduler.ts` retry knobs)
 * do so for code-organization reasons — NOT to allow runtime
 * retuning. The reads are constant after module load.
 */

const envPath = path.join(os.homedir(), '.claude', 'channels', 'lark', '.env');
config({ path: envPath });

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function optionalList(key: string): string[] {
  const val = process.env[key];
  return val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
}

function optionalNumber(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = Number(val);
  // R2-audit followup on #108: reject NaN/non-finite so a misconfigured
  // env var (e.g. LARK_MAX_DOWNLOAD_BYTES="abc") falls back to the
  // safe default rather than silently disabling the consumer's
  // numeric guard. Pre-fix, NaN propagated to `length > NaN === false`,
  // identical to the partial-opts footgun R1 just closed.
  if (!Number.isFinite(n)) {
    console.error(`[config] ${key}="${val}" is not a finite number — using fallback ${fallback}.`);
    return fallback;
  }
  return n;
}

/**
 * Strictly positive numeric env (#109 R1-followup). Reject 0 / negatives
 * as well as NaN, because for the sizing knobs (`LARK_LOG_MAX_BYTES`,
 * `LARK_*_CACHE_SIZE`, `LARK_*_TTL_HOURS`, `LARK_EPISODE_RETENTION_DAYS`,
 * etc.) a `0` is a footgun:
 *   - `LARK_LOG_MAX_BYTES=0` rotates after every write — debug.log
 *     retains 1 live line + 1 in .1, history is lost in seconds.
 *   - `LARK_NAME_CACHE_TTL_HOURS=0` makes the cache write-only (100%
 *     contact-API miss → Feishu rate-limit risk).
 *   - `LARK_EPISODE_RETENTION_DAYS=0` deletes every episode on next
 *     prune.
 * The strict-positive guard prevents these failure modes by snapping
 * back to the fallback with a stderr breadcrumb.
 */
function optionalPositiveNumber(key: string, fallback: number): number {
  const n = optionalNumber(key, fallback);
  if (n <= 0) {
    console.error(`[config] ${key}=${n} must be > 0 — using fallback ${fallback}.`);
    return fallback;
  }
  return n;
}

/**
 * Read and validate `LARK_OWNER_OPEN_ID`.
 *
 * Trims whitespace, treats empty after trim as unset, and refuses values
 * that collide with a reserved sentinel — both `__terminal__` and
 * `__system_flush__` have special meaning elsewhere in the identity
 * pipeline and would create absurd downstream states (terminal-chat
 * lookups returning the sentinel back, save_memory authorization for the
 * flush sentinel auto-passing, etc). Invalid values are dropped to null
 * with a stderr warning rather than crashing the boot, so a misconfigured
 * .env still produces a runnable bot — just without OWNER privileges.
 *
 * Treating an invalid OWNER as null also keeps `migrateLegacySkills`
 * (v1.0.14+, #84) safe: it would have written `created_by: "   "` or
 * `created_by: "__terminal__"` into every legacy sidecar, locking the
 * real owner out forever (the owner check is exact string equality).
 */
function ownerOpenId(): string | null {
  const raw = process.env.LARK_OWNER_OPEN_ID;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) {
    console.error('[config] LARK_OWNER_OPEN_ID is whitespace-only — treating as unset.');
    return null;
  }
  if (trimmed === '__terminal__' || trimmed === '__system_flush__') {
    console.error(
      `[config] LARK_OWNER_OPEN_ID="${trimmed}" collides with a reserved sentinel — treating as unset. ` +
      `Use the real Feishu open_id (typically starts with "ou_").`,
    );
    return null;
  }
  return trimmed;
}

export const appConfig = {
  // Required
  appId: required('LARK_APP_ID'),
  appSecret: required('LARK_APP_SECRET'),

  // Filtering
  allowedUserIds: optionalList('LARK_ALLOWED_USER_IDS'),
  allowedChatIds: optionalList('LARK_ALLOWED_CHAT_IDS'),
  textChunkLimit: optionalNumber('LARK_TEXT_CHUNK_LIMIT', 4000),
  ackEmoji: optional('LARK_ACK_EMOJI', 'MeMeMe'),
  botMessageTrackerSize: optionalNumber('LARK_BOT_MESSAGE_TRACKER_SIZE', 500),
  cronScanInterval: optionalNumber('LARK_CRON_SCAN_INTERVAL', 60),
  cronTimezone: optional('LARK_CRON_TIMEZONE', Intl.DateTimeFormat().resolvedOptions().timeZone),

  // Attachment download (#108)
  //   maxDownloadBytes: per-file upper bound enforced INSIDE writeSdkResource.
  //     Feishu allows 30MB images / 50MB files / 300MB videos; default 50MB
  //     covers images+files comfortably and refuses pathological/video.
  //   downloadTimeoutMs: timeout for the inline-in-event-handler image
  //     download. If exceeded, the notification is forwarded WITHOUT
  //     image_path (Claude won't have the local file); the download
  //     continues in the background so a later Read may still succeed
  //     if it lands within the inbox-GC window.
  maxDownloadBytes: optionalNumber('LARK_MAX_DOWNLOAD_BYTES', 50 * 1024 * 1024),
  downloadTimeoutMs: optionalNumber('LARK_DOWNLOAD_TIMEOUT_MS', 10_000),

  // Memory
  minSearchScore: optionalNumber('LARK_MIN_SEARCH_SCORE', 0.3),
  maxSearchResults: optionalNumber('LARK_MAX_SEARCH_RESULTS', 2),
  inactivityHours: optionalNumber('LARK_INACTIVITY_HOURS', 3),
  // #100 fix: episode size caps. `episodeWriteCapBytes` is the
  // write-side cap inside `saveEpisode` — keeps a pathologically
  // large flush from inflating disk + every subsequent injection.
  // `episodeInjectCapBytes` is the read-side cap inside
  // `enrichWithMemory` — defends against a pre-cap episode that's
  // already on disk OR an off-by-one window between the two caps.
  // Both default conservative; set to 0 to disable a side. 8KB write
  // ≈ a few screens of distilled text; 2KB inject keeps the per-
  // episode budget in line with the system-prompt envelope.
  episodeWriteCapBytes: optionalNumber('LARK_EPISODE_WRITE_CAP_BYTES', 8 * 1024),
  episodeInjectCapBytes: optionalNumber('LARK_EPISODE_INJECT_CAP_BYTES', 2 * 1024),
  // #113 — autonomous profile distillation (Stage 2: Episodes → Profile).
  //
  // OFF by default. Operator opts in by setting LARK_PROFILE_DISTILL_ENABLED=true.
  // Adds a follow-up Claude turn per active user per Stage 1 flush — small
  // for a quiet bot, multiplicative for busy group chats. See CHANGELOG
  // v1.0.57 for the trade-off discussion.
  //
  // - profileDistillEnabled: master switch. False → behaves identically
  //   to pre-#113 (profiles populated only by explicit save_memory).
  // - profileDistillCooldownHours: per-user TTL. The same user across
  //   any chat won't be re-distilled until cooldown expires. Defaults
  //   to 24h — once-per-day per user feels about right for "bot
  //   remembers you" without spamming token cost.
  // - profileDistillMinEpisodes: skip users whose `listEpisodes(chat)`
  //   length is below this floor. Avoids distilling sparse data into
  //   spurious "facts." Default 5 — enough signal to be worth a Stage 2
  //   turn.
  profileDistillEnabled: (process.env.LARK_PROFILE_DISTILL_ENABLED ?? '').toLowerCase() === 'true',
  profileDistillCooldownHours: optionalPositiveNumber('LARK_PROFILE_DISTILL_COOLDOWN_HOURS', 24),
  profileDistillMinEpisodes: optionalPositiveNumber('LARK_PROFILE_DISTILL_MIN_EPISODES', 5),
  // #110 fix: hard cap on per-chat buffer entries. The inactivity
  // timer was the only pre-fix bound; a chat that produced events
  // faster than the timer could fire (or a cronjob that kept
  // resetting the timer) would grow the buffer without limit. This
  // is the belt-and-suspenders backstop — once a buffer reaches the
  // cap, force-flush regardless of timer state. 200 entries × ~1KB
  // each ≈ 200KB per chat — comfortably bounded.
  bufferMaxMessages: optionalPositiveNumber('LARK_BUFFER_MAX_MESSAGES', 200),

  // Identity / privacy
  ownerOpenId: ownerOpenId(),
  /**
   * Session entry TTL. Must comfortably exceed the buffer auto-flush window
   * (LARK_INACTIVITY_HOURS) so that save_memory / save_skill calls triggered
   * by a flush still resolve to the last real user of the chat.
   * Default: max(2h, inactivityHours × 2).
   */
  identitySessionTtlMs: optionalNumber(
    'LARK_IDENTITY_SESSION_TTL_MS',
    Math.max(
      2 * 60 * 60 * 1000,
      optionalNumber('LARK_INACTIVITY_HOURS', 3) * 2 * 60 * 60 * 1000,
    ),
  ),
  /**
   * Soft cap on the IdentitySession LRU map size (PR #182 round-6 M-2).
   * Per-comment keying (post-round-4 I1) means the map can grow 1 entry
   * per comment under a hostile commenter, so this LRU cap is the second
   * line of defense behind the 2h TTL. Default 5000 matches the in-code
   * DEFAULT_MAX_SIZE constant; env override mirrors the pattern used by
   * other tracker caps (`LARK_*_CACHE_SIZE`, `LARK_BOT_MESSAGE_TRACKER_SIZE`).
   * `optionalPositiveNumber` rejects 0/negatives and falls back to the
   * default; the IdentitySession constructor additionally clamps to a
   * floor of 1 (round-6 M-3) so the cap is always effective.
   */
  identitySessionMaxSize: optionalPositiveNumber('LARK_IDENTITY_SESSION_MAX_SIZE', 5000),

  // Paths
  memoriesDir: path.join(os.homedir(), '.claude', 'channels', 'lark', 'memories'),
  inboxDir: path.join(os.homedir(), '.claude', 'channels', 'lark', 'inbox'),
  jobsDir: path.join(os.homedir(), '.claude', 'channels', 'lark', 'jobs'),

  // Inbox garbage collection (#89). The inbox directory was write-only
  // pre-v1.0.35 — every downloaded image and every download_attachment
  // file accumulated forever. In a heavy-image deployment (group with
  // screenshots / PDF reports / memes) an SSD would fill in months.
  //
  // GC runs at startup and periodically. Files are removed when:
  //   1. mtime is older than maxAgeDays (age expiry), OR
  //   2. total directory size exceeds maxSizeMB → oldest-first LRU
  //      eviction until under cap.
  //
  // The 7-day default age comfortably exceeds any reasonable Claude
  // turn duration (largest turn we've observed is single-digit minutes),
  // so a mid-turn `Read` of an `image_path` notification meta will
  // always find its file. Operators can disable entirely via
  // LARK_INBOX_GC_DISABLED=true for forensic / archival deployments.
  inboxMaxAgeDays: optionalNumber('LARK_INBOX_MAX_AGE_DAYS', 7),
  inboxMaxSizeMB: optionalNumber('LARK_INBOX_MAX_SIZE_MB', 500),
  inboxGcIntervalMin: optionalNumber('LARK_INBOX_GC_INTERVAL_MIN', 60),
  inboxGcDisabled: (process.env.LARK_INBOX_GC_DISABLED ?? '').toLowerCase() === 'true',

  // Daemon hygiene (#109). The bot's in-memory caches and append-only
  // log files grew without bound pre-v1.0.36. These tunables bound
  // each surface; defaults are sized for a typical org-wide bot
  // (thousands of users / hundreds of chats / multi-week deployment).
  //
  // nameCache: open_id / chat_id → display name. ~50 bytes/entry; 2000
  // entries ≈ 100KB. 24h TTL is generous — names rarely change within
  // a day, and a re-resolution miss costs one Feishu contact API call.
  // R1-followup on #109: use optionalPositiveNumber so a misconfigured
  // `=0` (or negative) falls back to the safe default with a stderr
  // breadcrumb instead of silently nuking history / blowing past rate
  // limits / write-only-ing the cache.
  nameCacheTtlHours: optionalPositiveNumber('LARK_NAME_CACHE_TTL_HOURS', 24),
  nameCacheSize: optionalPositiveNumber('LARK_NAME_CACHE_SIZE', 2000),
  // chatTypeCache: chat_id → 'p2p' | 'group'. Chat type is STRUCTURAL —
  // a p2p chat doesn't become a group chat. A short TTL (like the 24h
  // initial proposal) would just spuriously recompute; worse, R2 audit
  // caught that an idle p2p chat past TTL expiry would have
  // `isPrivateChat` return false (cache miss → default-to-group), and
  // any tool call from a cronjob in that chat (no fresh inbound to
  // re-set the entry) would widen the visibility filter — silent
  // privacy regression.
  //
  // Default 720 hours (30 days) effectively means "never expire while
  // the daemon is running"; LRU cap (5000) is the real defender against
  // pathological growth. Operator who wants tighter TTL (e.g. a
  // deployment that frequently re-uses chat_ids for different chats —
  // shouldn't happen but defensive) can shorten via the env.
  chatTypeCacheTtlHours: optionalPositiveNumber('LARK_CHAT_TYPE_CACHE_TTL_HOURS', 720),
  chatTypeCacheSize: optionalPositiveNumber('LARK_CHAT_TYPE_CACHE_SIZE', 5000),
  // Log rotation: single rotated copy (`<file>.1`). Effective on-disk
  // cap is ~2 × maxBytes per log. 50MB default × 2 × 3 logs = 300MB
  // worst case, which is much smaller than the pre-fix multi-GB growth.
  logMaxBytes: optionalPositiveNumber('LARK_LOG_MAX_BYTES', 50 * 1024 * 1024),
  // Episode retention. saveEpisode writes one .md per buffer flush;
  // listEpisodes / searchEpisodes do `readdir + per-file score` so cost
  // is O(N) per enrichment — prune keeps the search amortized. 180 days
  // is generous (half-year history); operator can shorten for tighter
  // privacy or extend for archival.
  episodeRetentionDays: optionalPositiveNumber('LARK_EPISODE_RETENTION_DAYS', 180),
  episodePruneIntervalMin: optionalPositiveNumber('LARK_EPISODE_PRUNE_INTERVAL_MIN', 1440),
  episodePruneDisabled: (process.env.LARK_EPISODE_PRUNE_DISABLED ?? '').toLowerCase() === 'true',
} as const;

export type AppConfig = typeof appConfig;
