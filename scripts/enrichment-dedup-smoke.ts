/**
 * Enrichment-dedup smoke test (v1.3.0, #189).
 *
 * Verifies the content-hash dedup of memory_context blocks on hot
 * threads: a block whose content is unchanged since its last injection
 * into the same (chatId, threadId) scope within the window is
 * suppressed; profile-kind blocks render an "unchanged" stub instead
 * of disappearing; hash changes, window expiry, scope isolation, and
 * the group multi-user case all re-inject.
 *
 * Tests the pure pieces (`EnrichmentDedup`, `renderEnrichmentParts`).
 * Integration with channel.ts is exercised by typecheck + dry-run,
 * same as enrichment-envelope-smoke.ts.
 */

import {
  EnrichmentDedup,
  renderEnrichmentParts,
  UNCHANGED_STUB_BODY,
  type DedupBlock,
} from '../src/enrichment-dedup.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let testNum = 0;

const WINDOW = 1000;

function makeClock(start = 0): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

function profileBlock(owner: string, body = `${owner} likes Python`): DedupBlock {
  return {
    kind: 'profile',
    label: `self:${owner}`,
    body,
    dedupKey: `profile:${owner}`,
    stubOnSuppress: true,
  };
}

function episodeBlock(id: string, body = `episode body ${id}`): DedupBlock {
  return {
    kind: 'chat_episode',
    label: 'score:1.50 · 2026-06-01',
    body,
    dedupKey: `chat_episode:${id}`,
  };
}

// 1. Disabled (windowMs = 0) → everything injects, no state kept
{
  testNum++;
  const dedup = new EnrichmentDedup(0);
  const blocks = [profileBlock('ou_a'), episodeBlock('e1.md')];
  for (let i = 0; i < 3; i++) {
    const decisions = dedup.filter('chat1', undefined, blocks);
    if (decisions.some(d => !d.inject)) fail('disabled dedup must inject everything');
  }
  if (dedup.enabled) fail('windowMs=0 must report enabled=false');
}

// 2. First sight injects; identical repeat within window suppresses
{
  testNum++;
  const clock = makeClock();
  const dedup = new EnrichmentDedup(WINDOW, 100, clock.now);
  const first = dedup.filter('chat1', 'th1', [profileBlock('ou_a')]);
  if (!first[0].inject) fail('first sight must inject');
  clock.set(500);
  const second = dedup.filter('chat1', 'th1', [profileBlock('ou_a')]);
  if (second[0].inject) fail('unchanged repeat within window must suppress');
}

// 3. Content hash change re-injects immediately
{
  testNum++;
  const clock = makeClock();
  const dedup = new EnrichmentDedup(WINDOW, 100, clock.now);
  dedup.filter('chat1', 'th1', [profileBlock('ou_a', 'v1')]);
  clock.set(100);
  const changed = dedup.filter('chat1', 'th1', [profileBlock('ou_a', 'v2')]);
  if (!changed[0].inject) fail('hash change must re-inject');
  clock.set(200);
  const repeat = dedup.filter('chat1', 'th1', [profileBlock('ou_a', 'v2')]);
  if (repeat[0].inject) fail('unchanged v2 must suppress after re-injection');
}

// 4. Window expiry re-injects
{
  testNum++;
  const clock = makeClock();
  const dedup = new EnrichmentDedup(WINDOW, 100, clock.now);
  dedup.filter('chat1', 'th1', [profileBlock('ou_a')]);
  clock.set(WINDOW + 1);
  const after = dedup.filter('chat1', 'th1', [profileBlock('ou_a')]);
  if (!after[0].inject) fail('expired entry must re-inject');
}

// 5. TTL is ABSOLUTE, not sliding: suppression does not refresh the
//    injection timestamp, so a continuously-hot thread still re-grounds
//    once per window.
{
  testNum++;
  const clock = makeClock();
  const dedup = new EnrichmentDedup(WINDOW, 100, clock.now);
  dedup.filter('chat1', 'th1', [profileBlock('ou_a')]); // inject at t=0
  clock.set(600);
  const mid = dedup.filter('chat1', 'th1', [profileBlock('ou_a')]); // suppressed
  if (mid[0].inject) fail('t=600 must still suppress');
  clock.set(WINDOW + 100); // 500ms after the suppressed CHECK, >window after INJECTION
  const late = dedup.filter('chat1', 'th1', [profileBlock('ou_a')]);
  if (!late[0].inject) fail('absolute TTL: must re-inject one window after the last INJECTION, not the last check');
}

// 6. Scope isolation: same block in a different thread injects
{
  testNum++;
  const clock = makeClock();
  const dedup = new EnrichmentDedup(WINDOW, 100, clock.now);
  dedup.filter('chat1', 'th1', [profileBlock('ou_a')]);
  const otherThread = dedup.filter('chat1', 'th2', [profileBlock('ou_a')]);
  if (!otherThread[0].inject) fail('different thread = different scope, must inject');
  const noThread = dedup.filter('chat1', undefined, [profileBlock('ou_a')]);
  if (!noThread[0].inject) fail('thread-less scope is distinct from threaded scope');
}

// 7. Group multi-user: B's first message in a hot thread injects B's
//    profile even though A's was just suppressed (dedupKey carries the
//    profile owner id — #189 discussion point 3).
{
  testNum++;
  const clock = makeClock();
  const dedup = new EnrichmentDedup(WINDOW, 100, clock.now);
  dedup.filter('g1', 'th1', [profileBlock('ou_a')]);
  clock.set(100);
  const decisions = dedup.filter('g1', 'th1', [profileBlock('ou_a'), profileBlock('ou_b')]);
  if (decisions[0].inject) fail("A's unchanged profile must suppress");
  if (!decisions[1].inject) fail("B's never-seen profile must inject");
}

// 8. Outer LRU: evicting a scope makes its blocks re-inject
{
  testNum++;
  const clock = makeClock();
  const dedup = new EnrichmentDedup(WINDOW, 2, clock.now); // maxScopes=2
  dedup.filter('c1', undefined, [profileBlock('ou_a')]);
  dedup.filter('c2', undefined, [profileBlock('ou_a')]);
  dedup.filter('c3', undefined, [profileBlock('ou_a')]); // evicts c1
  const back = dedup.filter('c1', undefined, [profileBlock('ou_a')]);
  if (!back[0].inject) fail('evicted scope must re-inject');
  // c3 was touched most recently among survivors and must still dedup.
  const c3 = dedup.filter('c3', undefined, [profileBlock('ou_a')]);
  if (c3[0].inject) fail('surviving scope must keep its dedup state');
}

// 9. Decision order preserves block order
{
  testNum++;
  const dedup = new EnrichmentDedup(WINDOW);
  const blocks = [profileBlock('ou_a'), episodeBlock('e1.md'), episodeBlock('e2.md')];
  const decisions = dedup.filter('chat1', undefined, blocks);
  for (let i = 0; i < blocks.length; i++) {
    if (decisions[i].block.dedupKey !== blocks[i].dedupKey) fail('decision order must match block order');
  }
}

// 10. renderEnrichmentParts — injected block wraps full body in envelope
{
  testNum++;
  const { parts, stats } = renderEnrichmentParts([
    { block: profileBlock('ou_a'), inject: true },
  ]);
  if (parts.length !== 1) fail(`expected 1 part, got ${parts.length}`);
  if (!parts[0].startsWith('<memory_context type="profile"')) fail(`bad envelope: ${parts[0]}`);
  if (!parts[0].includes('ou_a likes Python')) fail('injected body lost');
  if (stats.injectedCount !== 1 || stats.suppressedCount !== 0) fail('stats wrong for inject');
}

// 11. renderEnrichmentParts — suppressed profile renders an "unchanged"
//     stub THROUGH the envelope wrapper (#189 open question 5: no
//     exceptions to #114 on the suppressed path)
{
  testNum++;
  const { parts, stats } = renderEnrichmentParts([
    { block: profileBlock('ou_a'), inject: false },
  ]);
  if (parts.length !== 1) fail('suppressed profile must emit a stub part');
  if (!parts[0].startsWith('<memory_context type="profile"')) fail(`stub must be envelope-wrapped: ${parts[0]}`);
  if (!parts[0].includes('unchanged')) fail('stub label must carry the unchanged tag');
  if (parts[0].includes('likes Python')) fail('stub must NOT contain the full profile body');
  if (!parts[0].includes(UNCHANGED_STUB_BODY)) fail('stub body missing');
  if (stats.stubCount !== 1 || stats.suppressedCount !== 1) fail('stats wrong for stub');
}

// 12. renderEnrichmentParts — suppressed episode/skill (no stub flag)
//     is omitted entirely
{
  testNum++;
  const { parts, stats } = renderEnrichmentParts([
    { block: episodeBlock('e1.md'), inject: false },
  ]);
  if (parts.length !== 0) fail('suppressed episode must be omitted, not stubbed');
  if (stats.suppressedCount !== 1 || stats.stubCount !== 0) fail('stats wrong for omit');
  if (stats.suppressedBytes <= 0) fail('suppressedBytes must count the omitted body');
}

// 13. renderEnrichmentParts — stub body survives a hostile label
//     (label goes through wrapEnrichmentSection's attribute escaping)
{
  testNum++;
  const hostile: DedupBlock = {
    kind: 'profile',
    label: 'evil"> <inject>',
    body: 'x',
    dedupKey: 'profile:evil',
    stubOnSuppress: true,
  };
  const { parts } = renderEnrichmentParts([{ block: hostile, inject: false }]);
  if (parts[0].includes('label="evil">')) fail('hostile label must be attribute-escaped in stub');
}

// 14. Mixed turn: order of parts = order of decisions (stub holds the
//     profile's slot so the preamble→profile→episodes reading order is
//     stable for Claude)
{
  testNum++;
  const { parts } = renderEnrichmentParts([
    { block: profileBlock('ou_a'), inject: false },
    { block: episodeBlock('e1.md'), inject: true },
  ]);
  if (parts.length !== 2) fail(`expected stub + episode, got ${parts.length}`);
  if (!parts[0].includes('type="profile"')) fail('stub must keep first position');
  if (!parts[1].includes('type="chat_episode"')) fail('episode must follow');
}

console.error(`enrichment-dedup smoke: all ${testNum} cases passed`);
