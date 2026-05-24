/**
 * <at> tag sanitization smoke test (v1.0.16, #96).
 *
 * Verifies `sanitizeOutboundText` (src/tools.ts) strips Feishu @-mention
 * tags from outbound bot text without mangling unrelated `<...>` content.
 *
 * The vector: Feishu's `msg_type=text` renderer interprets
 * `<at user_id="...">label</at>` and the self-closing form as real
 * @-mention notifications. A prompt-injected Claude reply containing
 * `<at user_id="all">all</at>` would @-all the entire group.
 *
 * Test rigor: each assertion checks the EXACT output (`assertEqual`),
 * not just `includes('at user_id')` — covers regressions that strip too
 * little (label-preserving form leaves the tag) or too much (legitimate
 * `<atom>` etc. mistakenly matched).
 */

import { sanitizeOutboundText } from '../src/tools.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assertEq(got: string, want: string, label: string): void {
  if (got !== want) fail(`${label}\n  want: ${JSON.stringify(want)}\n  got : ${JSON.stringify(got)}`);
}

let testNum = 0;

// 1. Paired tag — label preserved
{
  testNum++;
  assertEq(
    sanitizeOutboundText('hello <at user_id="ou_xxx">Kevin</at> please review'),
    'hello Kevin please review',
    'paired tag with label',
  );
}

// 2. @-all attack — keep visible word
{
  testNum++;
  assertEq(
    sanitizeOutboundText('attention <at user_id="all">all</at> meeting now'),
    'attention all meeting now',
    '@-all paired tag',
  );
}

// 3. Self-closing tag — drop entirely
{
  testNum++;
  assertEq(
    sanitizeOutboundText('ping <at user_id="ou_xxx"/> later'),
    'ping  later',
    'self-closing tag',
  );
}

// 4. Empty paired tag — no label, drops to empty
{
  testNum++;
  assertEq(
    sanitizeOutboundText('quiet <at user_id="ou_x"></at> ping'),
    'quiet  ping',
    'empty paired tag',
  );
}

// 5. Multiple tags in one string
{
  testNum++;
  assertEq(
    sanitizeOutboundText('cc <at user_id="ou_a">Alice</at>, <at user_id="ou_b">Bob</at>, <at user_id="all"/> done'),
    'cc Alice, Bob,  done',
    'multiple tags',
  );
}

// 6. Case insensitivity — Feishu accepts <AT>, <At>, etc.
{
  testNum++;
  assertEq(
    sanitizeOutboundText('hi <AT user_id="ou_x">X</AT> and <At user_id="all"/>'),
    'hi X and ',
    'case insensitive',
  );
}

// 7. Tag with body containing newlines (LLM hard-wrapping inside tag)
{
  testNum++;
  assertEq(
    sanitizeOutboundText('start <at user_id="ou_x">multi\nline\nlabel</at> end'),
    'start multi\nline\nlabel end',
    'cross-line body',
  );
}

// 8. NON-matches that must NOT be touched
{
  testNum++;
  // <atom>, <athletics>, plain <a>, <atlas/> — these start with "at" but
  // are not @-mention tags. The regex requires `\s` after `<at`, so they
  // must not match.
  assertEq(
    sanitizeOutboundText('see <atom>this</atom> and <a>link</a>'),
    'see <atom>this</atom> and <a>link</a>',
    'non-at tags untouched',
  );
  assertEq(
    sanitizeOutboundText('<atlas/>'),
    '<atlas/>',
    'self-closing non-at untouched',
  );
  assertEq(
    sanitizeOutboundText('<athletics class="x">sports</athletics>'),
    '<athletics class="x">sports</athletics>',
    'attribute-bearing non-at untouched',
  );
}

// 9. Edge: `<at>` with no whitespace+attrs — pre-fix, this would NOT
//    match our regex (we require `\s` after `<at`). Verify the bare
//    `<at>` is NOT a Feishu @-mention vector (it requires user_id) so
//    keeping it as-is is correct.
{
  testNum++;
  assertEq(
    sanitizeOutboundText('<at>bare</at>'),
    '<at>bare</at>',
    'bare <at> (no attrs, no whitespace) — Feishu requires user_id, harmless',
  );
}

// 10. Plain text with no tags — passthrough
{
  testNum++;
  assertEq(
    sanitizeOutboundText('Hello, world!\nThis is plain text.'),
    'Hello, world!\nThis is plain text.',
    'plain text passthrough',
  );
  assertEq(sanitizeOutboundText(''), '', 'empty string');
}

// 11. Adversarial nested: an inner tag with a confusable label
{
  testNum++;
  // Nested <at> tags are unusual; non-greedy match takes the FIRST
  // closing tag, which is correct behavior (Feishu wouldn't render a
  // malformed nested tag anyway). The result: inner content preserved.
  assertEq(
    sanitizeOutboundText('<at user_id="ou_a">outer <at user_id="ou_b">inner</at> tail</at>'),
    'outer inner tail',
    'nested tags collapse safely',
  );
}

// 12. Defense in depth: @-mention attribute injection with HTML entities
{
  testNum++;
  // If Claude was tricked into HTML-entity-escaping the angle brackets
  // (`&lt;at user_id...`), the result is literal text — NOT a vector.
  // We pass it through untouched; Feishu renders &lt; as literal "<".
  assertEq(
    sanitizeOutboundText('&lt;at user_id="all"&gt;all&lt;/at&gt;'),
    '&lt;at user_id="all"&gt;all&lt;/at&gt;',
    'HTML-entity form is harmless, untouched',
  );
}

console.log(`at-tag sanitization smoke: ${testNum}/${testNum} PASS`);
