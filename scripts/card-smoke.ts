/**
 * Card builder smoke test — runs as part of `npm test`.
 * Exits non-zero if any assertion fails.
 */
import { shouldUseCard, buildCards } from '../src/feishu-card.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// 1. Short plain text should NOT trigger card
if (shouldUseCard('hello')) fail('short text triggered card');

// 2. Markdown-feature text SHOULD trigger card
if (!shouldUseCard('# heading\nbody')) fail('heading did not trigger card');
if (!shouldUseCard('a ```code``` b')) fail('code block did not trigger card');
if (!shouldUseCard('| a | b |\n|---|---|')) fail('table did not trigger card');
if (!shouldUseCard('- item 1\n- item 2')) fail('list did not trigger card');
if (!shouldUseCard('say **hi** now')) fail('bold did not trigger card');

// 3. Long text (>500) SHOULD trigger card
if (!shouldUseCard('a'.repeat(501))) fail('long text did not trigger card');

// 4. buildCards returns at least one card for any input
const c1 = buildCards('# Hi\nbody');
if (!Array.isArray(c1) || c1.length < 1) fail('buildCards returned empty');

// 5. buildCards handles oversized text by splitting into multiple cards
const big = '# Big\n' + 'x'.repeat(60 * 1024);
const c2 = buildCards(big);
if (c2.length < 2) fail(`oversized text did not split (got ${c2.length} cards)`);

// 6. Footer is appended as a notation-size markdown element
const c3 = buildCards('# Hi\nbody', { footer: 'note' });
const firstCard: any = c3[0];
const last = firstCard.body.elements[firstCard.body.elements.length - 1];
if (last.text_size !== 'notation' || last.content !== 'note') {
  fail(`footer not appended correctly: ${JSON.stringify(last)}`);
}

// 7. Title extracted from first H1
const c4: any = buildCards('# My Title\nbody');
if (c4[0].header.title.content !== 'My Title') fail('title extraction failed');

// 8. Fallback title when no heading
const c5: any = buildCards('just a line of text, no heading here');
const t5 = c5[0].header.title.content;
if (!t5 || t5.length === 0) fail('fallback title missing');

// 9. Code-block-safe splitting: long text with fenced code block must produce
// elements where fences stay balanced (close+reopen when split mid-block).
const bigCode = '# Long\n\n```py\n' + 'x = 1\n'.repeat(3000) + '```';
const c6: any = buildCards(bigCode);
for (const card of c6) {
  for (const el of card.body.elements) {
    if (el.tag !== 'markdown' || typeof el.content !== 'string') continue;
    const fenceCount = (el.content.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) {
      fail(`unbalanced fences in element: ${el.content.slice(0, 100)}...`);
    }
  }
}

// 10. Unclosed code block should not throw
try {
  buildCards('# x\n```js\nfoo');
} catch (e) {
  fail(`unclosed code block threw: ${e}`);
}

// 11. Empty text falls back to '...' placeholder
const c7: any = buildCards('');
if (!c7[0] || !c7[0].body || !Array.isArray(c7[0].body.elements)) {
  fail('empty text produced invalid card');
}

console.log('PASS');
