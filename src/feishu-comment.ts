/**
 * Convert markdown-ish reply content into Feishu file-comment elements.
 *
 * Element type contract (verified via `lark-cli schema drive.file.comment.replys.create`):
 *   { type: 'text_run', text_run: { text: string, style?: {} } }
 *   { type: 'docs_link', docs_link: { url: string, title?: string } }
 *   { type: 'person',    person:    { user_id: string } }
 *
 * v1 supports only text_run + inline URL → docs_link auto-detection.
 * @-mentions (person) are TODO.
 */

export type CommentElement =
  | { type: 'text_run'; text_run: { text: string; style?: Record<string, unknown> } }
  | { type: 'docs_link'; docs_link: { url: string; title?: string } }
  | { type: 'person'; person: { user_id: string } };

export const MAX_TEXT_RUN_LEN = 1000;

// Only http(s) URLs. Stops at whitespace/quotes/punctuation that aren't valid in URLs.
const URL_RE = /https?:\/\/[^\s"'<>]+/g;

export function buildCommentElements(markdown: string): CommentElement[] {
  if (markdown.length > MAX_TEXT_RUN_LEN) {
    throw new Error(
      `reply text exceeds ${MAX_TEXT_RUN_LEN} char per-element limit (got ${markdown.length}).`,
    );
  }
  if (markdown === '') {
    return [{ type: 'text_run', text_run: { text: '' } }];
  }
  const out: CommentElement[] = [];
  let cursor = 0;
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(markdown)) !== null) {
    if (m.index > cursor) {
      out.push({ type: 'text_run', text_run: { text: markdown.slice(cursor, m.index) } });
    }
    out.push({ type: 'docs_link', docs_link: { url: m[0] } });
    cursor = m.index + m[0].length;
  }
  if (cursor < markdown.length) {
    out.push({ type: 'text_run', text_run: { text: markdown.slice(cursor) } });
  }
  if (out.length === 0) {
    // Shouldn't happen since markdown !== '' above, but defensive.
    out.push({ type: 'text_run', text_run: { text: markdown } });
  }
  return out;
}
