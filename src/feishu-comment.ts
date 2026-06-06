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

export function buildCommentElements(markdown: string): CommentElement[] {
  // Feishu requires non-empty elements array; emit a 0-length placeholder.
  if (markdown === '') {
    return [{ type: 'text_run', text_run: { text: '' } }];
  }
  // Baseline: single text_run. URL parsing comes in Task 2.
  return [{ type: 'text_run', text_run: { text: markdown } }];
}
