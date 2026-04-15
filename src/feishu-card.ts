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

// ─── Markdown Style Optimizer ─────────────────────────────────
// Ported from happyclaw/src/feishu-markdown-style.ts (MIT).

/** Strip `![alt](value)` where value is not a valid Feishu image key. */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text;
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith('img_')) return fullMatch;
    return '';
  });
}

function _optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  // 1. Extract code blocks, protect with placeholders
  const MARK = '___CB_';
  const codeBlocks: string[] = [];
  let r = text.replace(/```[\s\S]*?```/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`;
  });

  // 2. Heading demotion (only if source has H1~H3)
  const hasH1toH3 = /^#{1,3} /m.test(text);
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1');
    r = r.replace(/^# (.+)$/gm, '#### $1');
  }

  if (cardVersion >= 2) {
    // 3. Consecutive heading spacing
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2');
    // 4. Table spacing
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2');
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1');
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, '$1\n<br>\n');
    r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n$3');
    r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n\n$3');
    r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, '$1$2$3');
    // 5. Restore code blocks with <br> wrapping
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, `\n<br>\n${block}\n<br>\n`);
    });
  } else {
    // 5. Restore code blocks without <br>
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, block);
    });
  }

  // 6. Compress excessive blank lines (3+ → 2)
  r = r.replace(/\n{3,}/g, '\n\n');

  return r;
}

/**
 * Optimize markdown for Feishu card rendering (Schema 2.0 by default).
 * Wraps the internal implementation so a bad input silently returns the raw
 * text instead of crashing the reply pipeline.
 */
function optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  try {
    const r = _optimizeMarkdownStyle(text, cardVersion);
    return stripInvalidImageKeys(r);
  } catch {
    return text;
  }
}
