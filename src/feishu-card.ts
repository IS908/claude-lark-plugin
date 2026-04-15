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

// ─── Title Extraction ─────────────────────────────────────────

/**
 * Extract a card title from the first heading (H1/H2/H3) of `text`.
 * If no heading is present, fall back to the first non-empty line,
 * stripped of markdown punctuation and truncated to 40 chars.
 */
function extractTitleAndBody(text: string): { title: string; body: string } {
  const lines = text.split('\n');
  let title = '';
  let bodyStartIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (/^#{1,3}\s+/.test(lines[i])) {
      title = lines[i].replace(/^#+\s*/, '').trim();
      bodyStartIdx = i + 1;
    }
    break;
  }

  const body = lines.slice(bodyStartIdx).join('\n').trim();

  if (!title) {
    const firstLine = (lines.find((l) => l.trim()) || '')
      .replace(/[*_`#\[\]]/g, '')
      .trim();
    title =
      firstLine.length > 40
        ? firstLine.slice(0, 37) + '...'
        : firstLine || 'Reply';
  }

  return { title, body };
}

// ─── Code-Block-Safe Splitting ───────────────────────────────

interface CodeBlockRange {
  open: number;
  close: number;
  lang: string;
}

/** Scan text for fenced code block ranges (``` ... ```). */
function findCodeBlockRanges(text: string): CodeBlockRange[] {
  const ranges: CodeBlockRange[] = [];
  const regex = /^```(\w*)\s*$/gm;
  let match: RegExpExecArray | null;
  let openMatch: RegExpExecArray | null = null;
  let openLang = '';

  while ((match = regex.exec(text)) !== null) {
    if (!openMatch) {
      openMatch = match;
      openLang = match[1] || '';
    } else {
      ranges.push({
        open: openMatch.index,
        close: match.index + match[0].length,
        lang: openLang,
      });
      openMatch = null;
      openLang = '';
    }
  }

  // Unclosed code block — treat from open to end of text
  if (openMatch) {
    ranges.push({
      open: openMatch.index,
      close: text.length,
      lang: openLang,
    });
  }

  return ranges;
}

function findContainingBlock(
  pos: number,
  ranges: CodeBlockRange[]
): CodeBlockRange | null {
  for (const r of ranges) {
    if (pos > r.open && pos < r.close) return r;
  }
  return null;
}

/**
 * Split text into chunks of at most `maxLen` characters, preferring
 * paragraph/line boundaries and never truncating a fenced code block
 * without properly closing/reopening it.
 */
function splitCodeBlockSafe(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const ranges = findCodeBlockRanges(remaining);

    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;

    const block = findContainingBlock(idx, ranges);

    if (block) {
      if (block.open > 0 && block.open > maxLen * 0.3) {
        const retreatIdx = remaining.lastIndexOf('\n', block.open);
        idx = retreatIdx > maxLen * 0.3 ? retreatIdx : block.open;
        chunks.push(remaining.slice(0, idx).trimEnd());
        remaining = remaining.slice(idx).replace(/^\n+/, '');
      } else {
        const chunk = remaining.slice(0, idx).trimEnd() + '\n```';
        chunks.push(chunk);
        const reopener = '```' + block.lang + '\n';
        remaining = reopener + remaining.slice(idx).replace(/^\n/, '');
      }
    } else {
      chunks.push(remaining.slice(0, idx).trimEnd());
      remaining = remaining.slice(idx).replace(/^\n+/, '');
    }
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
