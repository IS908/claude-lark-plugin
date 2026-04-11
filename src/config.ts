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

  // Memory
  memoryProvider: optional('MEMORY_PROVIDER', 'file') as 'file' | 'openviking' | 'mem0',
  minSearchScore: optionalNumber('LARK_MIN_SEARCH_SCORE', 0.3),
  maxSearchResults: optionalNumber('LARK_MAX_SEARCH_RESULTS', 2),
  inactivityHours: optionalNumber('LARK_INACTIVITY_HOURS', 3),

  // OpenViking
  openVikingUrl: optional('OPENVIKING_URL', 'http://localhost:1933'),
  openVikingApiKey: process.env.OPENVIKING_API_KEY || '',

  // mem0
  mem0Url: process.env.MEM0_URL || '',
  mem0ApiKey: process.env.MEM0_API_KEY || '',

  // Paths
  memoriesDir: path.join(os.homedir(), '.claude', 'channels', 'lark', 'memories'),
  inboxDir: path.join(os.homedir(), '.claude', 'channels', 'lark', 'inbox'),
} as const;

export type AppConfig = typeof appConfig;
