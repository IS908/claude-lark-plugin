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

// 2. single URL embedded → text_run, docs_link
{
  const els = buildCommentElements('see https://x.y/a');
  if (els.length < 2) fail(`2: expected ≥2 elements, got ${els.length}`);
  if (els[0].text_run?.text !== 'see ') fail(`2: prefix wrong: '${els[0].text_run?.text}'`);
  if (els[1].type !== 'docs_link') fail(`2: second should be docs_link`);
  if (els[1].docs_link?.url !== 'https://x.y/a') fail(`2: url mismatch`);
}

// 3. multiple URLs interspersed
{
  const els = buildCommentElements('a https://1.x b https://2.y c');
  const links = els.filter(e => e.type === 'docs_link');
  if (links.length !== 2) fail(`3: expected 2 docs_links, got ${links.length}`);
  if (links[0].docs_link?.url !== 'https://1.x') fail(`3: link[0] mismatch`);
  if (links[1].docs_link?.url !== 'https://2.y') fail(`3: link[1] mismatch`);
}

// 4. URL at start
{
  const els = buildCommentElements('https://x.y then text');
  if (els[0].type !== 'docs_link') fail(`4: first should be docs_link`);
  if (els[0].docs_link?.url !== 'https://x.y') fail(`4: url mismatch`);
}

// 5. URL at end
{
  const els = buildCommentElements('see https://x.y');
  const last = els[els.length - 1];
  if (last.type !== 'docs_link') fail(`5: last should be docs_link`);
  if (last.docs_link?.url !== 'https://x.y') fail(`5: url mismatch`);
}

// 8. URL with query params kept intact (no & truncation)
{
  const els = buildCommentElements('go https://x.y?q=a&b=c done');
  const link = els.find(e => e.type === 'docs_link');
  if (!link) fail(`8: docs_link not found`);
  if (link.docs_link?.url !== 'https://x.y?q=a&b=c') fail(`8: query truncated: '${link.docs_link?.url}'`);
}

// 9. non-http URL stays as text_run (no docs_link recognition)
{
  const els = buildCommentElements('see ftp://x.y');
  const link = els.find(e => e.type === 'docs_link');
  if (link) fail(`9: ftp should not be recognized as docs_link`);
  if (els[0].text_run?.text !== 'see ftp://x.y') fail(`9: full text should stay`);
}

console.error(`PASS: 9 cases (text baseline + URL parsing)`);
