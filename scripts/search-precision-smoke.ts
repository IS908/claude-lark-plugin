/**
 * Search precision smoke test (v1.0.41, closes #102).
 *
 * Directly exercises `MemoryStore.matchKeyword` (pure static) which
 * is the core of the fix. End-to-end testing via searchSkills /
 * searchEpisodes requires fs setup; the matchKeyword unit covers the
 * threading-the-needle logic without that ceremony.
 *
 * Threading note: the issue suggested word-boundary on both sides
 * (\b...\b), but that would regress legitimate prefix matches
 * ("deploy" should still match "deployment-script"). Fix uses a
 * length threshold:
 *   - ASCII keyword ≤ 3 chars → both-sides boundary (exact word)
 *   - ASCII keyword ≥ 4 chars → start-only boundary (prefix match)
 *   - Non-ASCII (CJK) → substring (preserves expected Chinese behavior)
 */

import { MemoryStore } from '../src/memory/file.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let testNum = 0;

// ── Part A: the bug — short ASCII keywords no longer false-match ──

// 1. "pi" must NOT match "pipeline-deploy" (the issue's headline example)
{
  if (MemoryStore.matchKeyword('pipeline-deploy ci/cd deployment helper', 'pi')) {
    fail(`1: "pi" must not match "pipeline" — the original bug`);
  }
  testNum++;
}

// 2. "pi" matches "raspberry pi setup notes" (genuine word boundary)
{
  if (!MemoryStore.matchKeyword('raspberry pi setup notes', 'pi')) {
    fail(`1b: "pi" must match "raspberry pi" — genuine word boundary`);
  }
  testNum++;
}

// 3. "go" must NOT match "google", "argo", "ago"
{
  for (const haystack of ['google search', 'argo cd pipeline', 'three days ago']) {
    if (MemoryStore.matchKeyword(haystack, 'go')) {
      fail(`3: "go" must not match "${haystack}"`);
    }
  }
  // But DOES match "go programming"
  if (!MemoryStore.matchKeyword('go programming language', 'go')) {
    fail(`3: "go" must match "go programming"`);
  }
  testNum++;
}

// 4. "api" exact match — DOES match "api-gateway" (hyphen is word boundary)
{
  if (!MemoryStore.matchKeyword('api-gateway routing rules', 'api')) {
    fail(`4: "api" must match "api-gateway"`);
  }
  // Does NOT match "apiary" (no boundary inside the word)
  if (MemoryStore.matchKeyword('apiary bee-keeping guide', 'api')) {
    fail(`4: "api" must NOT match "apiary"`);
  }
  // DOES match "rapid-api" (hyphen as boundary)
  if (!MemoryStore.matchKeyword('rapid-api integration', 'api')) {
    fail(`4: "api" must match "rapid-api" (hyphen separates)`);
  }
  testNum++;
}

// ── Part B: long ASCII keywords PRESERVE prefix/stem match ──

// 5. "deploy" matches "deployment-script", "deployable", "deployment plan"
{
  for (const haystack of [
    'deployment-script for staging',
    'deployable artifact builder',
    'deployment plan for q1',
  ]) {
    if (!MemoryStore.matchKeyword(haystack, 'deploy')) {
      fail(`5: "deploy" must match prefix "${haystack}"`);
    }
  }
  // BUT not "redeploy" (no boundary before "deploy")
  if (MemoryStore.matchKeyword('redeploy fast-track', 'deploy')) {
    fail(`5: "deploy" must NOT match "redeploy" (no leading boundary)`);
  }
  testNum++;
}

// 6. "config" matches "configuration", "configurable", "configfile"
{
  for (const haystack of ['configuration helper', 'configurable cli', 'configfile parser']) {
    if (!MemoryStore.matchKeyword(haystack, 'config')) {
      fail(`6: "config" must match prefix "${haystack}"`);
    }
  }
  // Not "misconfig" (no boundary before "config")
  if (MemoryStore.matchKeyword('misconfig diagnosis', 'config')) {
    fail(`6: "config" must NOT match "misconfig"`);
  }
  testNum++;
}

// ── Part C: non-ASCII (CJK) preserves substring semantics ──

// 7. "人工" matches "人工智能" (Chinese substring, no word boundaries)
{
  if (!MemoryStore.matchKeyword('人工智能助手 介绍', '人工')) {
    fail(`7: Chinese "人工" must match substring "人工智能"`);
  }
  testNum++;
}

// 8. "学习" matches "深度学习" (Chinese substring)
{
  if (!MemoryStore.matchKeyword('深度学习论文 阅读笔记', '学习')) {
    fail(`8: Chinese "学习" must match substring "深度学习"`);
  }
  testNum++;
}

// 9. Cyrillic (non-ASCII) preserves substring
{
  if (!MemoryStore.matchKeyword('россия москва санкт', 'россия')) {
    fail(`9: Cyrillic substring match should work`);
  }
  testNum++;
}

// ── Part D: edge cases ──

// 10. Empty haystack — never matches
{
  if (MemoryStore.matchKeyword('', 'anything')) fail(`10: empty haystack`);
  if (MemoryStore.matchKeyword('', '人工')) fail(`10: empty haystack non-ASCII`);
  testNum++;
}

// 11. Case-insensitivity (kw is pre-lowered by extractKeywords; matcher
//     also accepts mixed-case haystacks just in case)
{
  // ASCII path uses regex with `i` flag
  if (!MemoryStore.matchKeyword('Deploy Pipeline', 'deploy')) {
    fail(`11: ASCII case-insensitive (haystack mixed case)`);
  }
  // Substring path on non-ASCII doesn't lowercase — caller is expected to
  // pre-lowercase the haystack (which searchSkills/Episodes do). This
  // documents that behavior.
  testNum++;
}

// 12. Special regex chars in keyword are escaped (defensive — extractKeywords
//     splits on punctuation so this shouldn't reach the matcher, but
//     belt-and-suspenders against a future caller bypass)
{
  // A keyword with a regex metachar would otherwise crash the RegExp constructor
  // or worse, alter the match semantics. matchKeyword escapes them.
  if (MemoryStore.matchKeyword('plain text', 'a.b')) {
    // Should NOT match — '.' is escaped, not wildcard
    fail(`12: dot in keyword must be literal, not wildcard`);
  }
  // But IF the haystack literally contains "a.b", that does NOT match either
  // because "a.b" isn't ASCII-word (contains "."), so it falls through to
  // substring. Actually `/^[a-z0-9_-]+$/i` rejects "a.b" → substring path.
  if (!MemoryStore.matchKeyword('found a.b in text', 'a.b')) {
    fail(`12: substring path matches literal "a.b" in haystack`);
  }
  testNum++;
}

// 13. Regression guard — the issue's "Raspberry Pi vs CI/CD" scenario
//     end-to-end at the matcher level.
{
  // Scenario from the issue:
  // skill: "pipeline-deploy" with description "CI/CD deployment helper"
  // user query: "Raspberry Pi 怎么装 Ubuntu" → keywords [raspberry, pi, 装, ubuntu]
  const skillHaystack = 'pipeline-deploy ci/cd deployment helper';
  const keywords = ['raspberry', 'pi', '装', 'ubuntu'];
  let totalScore = 0;
  for (const kw of keywords) {
    if (MemoryStore.matchKeyword(skillHaystack, kw)) totalScore++;
  }
  if (totalScore !== 0) {
    fail(`13: pipeline-deploy must score 0 against raspberry-pi query, got ${totalScore}`);
  }
  testNum++;
}

console.log(`search-precision smoke: ${testNum}/${testNum} PASS`);
