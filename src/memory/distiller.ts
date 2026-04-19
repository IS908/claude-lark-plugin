import type { BufferedMessage } from './buffer.js';
import { flushPrompt, profileDistillationPrompt } from '../prompts.js';
import { applyL1 } from '../privacy-rules.js';

/**
 * Distillation Stage 1: Buffer → Episode.
 */
export function buildFlushPrompt(chatId: string, messages: BufferedMessage[]): string {
  const conversation = messages
    .map((m) => `[${m.timestamp}] ${m.role === 'user' ? m.senderId : 'bot'}: ${m.text}`)
    .join('\n');

  return flushPrompt(chatId, conversation, messages.length);
}

/**
 * Distillation Stage 2: Episodes → Profile (tiered, v0.10.0+).
 *
 * Produces a prompt that instructs Claude to emit a JSON object classifying
 * distilled facts into public / private tiers. Pair with {@link parseTieredProfile}
 * to post-process the response.
 */
export function buildProfileDistillationPrompt(args: {
  userId: string;
  currentProfile: string | null;
  episodeSummaries: string[];
  chatType: 'p2p' | 'group';
  l2Rules: string;
}): string {
  return profileDistillationPrompt(args);
}

export interface TieredProfile {
  public: string[];
  private: string[];
}

/**
 * Parse the distiller's tiered JSON output and apply the L1 safety net.
 *
 * Contract:
 *  - Accepts a raw string (may contain surrounding whitespace or, if the LLM
 *    slipped up, surrounding text). Tolerates a leading ```json fence.
 *  - On successful JSON.parse with arrays `public` and `private`: applies L1.
 *    Anything marked public that matches an L1 blacklist (phone, ID,
 *    credentials, 薪资/跳槽/etc.) is forced to private — defense in depth
 *    against an LLM misclassification.
 *  - On JSON.parse failure: conservatively treats the entire blob as one
 *    private fact (preserves the content without exposing it).
 */
export function parseTieredProfile(raw: string): TieredProfile {
  let payload = raw.trim();

  // Strip optional markdown code fence
  if (payload.startsWith('```')) {
    payload = payload.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Fallback: cannot parse — conservatively classify entire blob as private.
    return { public: [], private: [raw.trim()].filter(Boolean) };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { public: [], private: [raw.trim()].filter(Boolean) };
  }

  const obj = parsed as { public?: unknown; private?: unknown };
  const rawPublic = Array.isArray(obj.public) ? obj.public.map(String) : [];
  const rawPrivate = Array.isArray(obj.private) ? obj.private.map(String) : [];

  // L1 safety net — anything the LLM marked public but our L1 blacklist hits
  // gets forced into private. This protects against LLM misclassification of
  // things like credentials, tokens, or sensitive keywords appearing in a
  // group-sourced fact.
  const safePublic: string[] = [];
  const enforcedPrivate: string[] = [...rawPrivate];
  for (const fact of rawPublic) {
    if (applyL1(fact) === 'private') {
      enforcedPrivate.push(fact);
    } else {
      safePublic.push(fact);
    }
  }

  return { public: safePublic, private: enforcedPrivate };
}
