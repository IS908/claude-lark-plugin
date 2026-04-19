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
  return val ? Number(val) : fallback;
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

  // Memory
  minSearchScore: optionalNumber('LARK_MIN_SEARCH_SCORE', 0.3),
  maxSearchResults: optionalNumber('LARK_MAX_SEARCH_RESULTS', 2),
  inactivityHours: optionalNumber('LARK_INACTIVITY_HOURS', 3),

  // Identity / privacy
  ownerOpenId: process.env.LARK_OWNER_OPEN_ID || null,
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
