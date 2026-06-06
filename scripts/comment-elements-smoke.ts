/**
 * buildCommentElements smoke test — markdown → Feishu reply elements.
 * Spec: docs/superpowers/specs/2026-06-06-doc-comment-channel-design.md §10.3
 */
import { buildCommentElements } from '../src/feishu-comment.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// 1. pure text → single text_run element
{
  const els = buildCommentElements('hello world');
  if (els.length !== 1) fail(`1: expected 1 element, got ${els.length}`);
  if (els[0].type !== 'text_run') fail(`1: type mismatch ${els[0].type}`);
  if (els[0].text_run?.text !== 'hello world') fail(`1: text mismatch`);
}

// 6. empty string → single empty text_run (Feishu requires non-empty array)
{
  const els = buildCommentElements('');
  if (els.length !== 1) fail(`6: empty must return 1 placeholder element, got ${els.length}`);
  if (els[0].type !== 'text_run') fail(`6: type ${els[0].type}`);
  if (els[0].text_run?.text !== '') fail(`6: text not empty`);
}

// 10. literal backslash + n (not interpreted)
{
  const els = buildCommentElements('a\\nb');
  if (els.length !== 1) fail(`10: expected 1 element`);
  if (els[0].text_run?.text !== 'a\\nb') fail(`10: escape sequence should not be interpreted`);
}

console.error(`PASS: 3 cases (text baseline)`);
