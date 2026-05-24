import { config } from 'dotenv';
import path from 'node:path';
import os from 'node:os';

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

  // Paths
  memoriesDir: path.join(os.homedir(), '.claude', 'channels', 'lark', 'memories'),
  inboxDir: path.join(os.homedir(), '.claude', 'channels', 'lark', 'inbox'),
  jobsDir: path.join(os.homedir(), '.claude', 'channels', 'lark', 'jobs'),
} as const;

export type AppConfig = typeof appConfig;
