/**
 * Feishu Reply Card builder.
 *
 * Converts plain markdown text into Feishu CardKit Schema 2.0 card JSON.
 * - Optimizes markdown for Feishu's card renderer
 * - Extracts card title from the first heading
 * - Splits long text safely around fenced code blocks
 * - Splits oversized cards into multiple cards
 *
 * Ported and simplified from happyclaw/src/feishu-streaming-card.ts.
 * Streaming / interrupt / auxiliary state features are intentionally excluded
 * because the MCP reply flow delivers complete text atomically.
 */

// Per-markdown-element character limit
const CARD_MD_LIMIT = 4000;
// Per-card total size safety limit (Feishu hard limit is ~30 KB)
const CARD_SIZE_LIMIT = 25 * 1024;
// Per-card element count safety limit
const CARD_ELEMENT_LIMIT = 45;

/** Markdown-feature heuristic patterns. Any match triggers card rendering. */
const MD_PATTERNS: RegExp[] = [
  /^#{1,6}\s+/m, // headings
  /```[\s\S]*```/, // fenced code block
  /^\|.+\|$/m, // table row
  /^\s*[-*+]\s+/m, // bulleted list
  /\*\*[^*]+\*\*/, // bold
];

/**
 * Decide whether a reply text should render as a Feishu card.
 * Triggers on markdown features or length > 500 chars.
 */
export function shouldUseCard(text: string): boolean {
  if (text.length > 500) return true;
  return MD_PATTERNS.some((re) => re.test(text));
}

/**
 * Build one or more Schema 2.0 card JSON objects from raw markdown text.
 * Returns at least one card. Oversized content is split across multiple cards.
 */
export function buildCards(
  _text: string,
  _opts?: { footer?: string }
): object[] {
  throw new Error('buildCards not yet implemented');
}
