/**
 * Mention placeholder resolution smoke test — runs as part of `npm test`.
 *
 * Covers @_user_N → @<name> substitution using the mentions array.
 * Exits non-zero on any assertion failure.
 */
import { resolveMentionPlaceholders } from '../src/channel.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let passed = 0;

// ── 1. single mention resolved ──────────────────────────────
{
  const out = resolveMentionPlaceholders(
    '@_user_1 help me',
    [{ id: 'ou_bot', name: '我的助手' }],
  );
  if (out !== '@我的助手 help me') fail(`1: got ${JSON.stringify(out)}`);
  passed++;
}

// ── 2. multiple mentions — bot + other user ────────────────
{
  const out = resolveMentionPlaceholders(
    '@_user_1 @_user_2 看下这个',
    [
      { id: 'ou_alice', name: 'Alice' },
      { id: 'ou_bot', name: 'Bot' },
    ],
  );
  if (out !== '@Alice @Bot 看下这个') fail(`2: got ${JSON.stringify(out)}`);
  passed++;
}

// ── 3. empty name kept as placeholder (privacy masked) ──────
{
  const out = resolveMentionPlaceholders(
    '@_user_1 hello',
    [{ id: 'ou_masked', name: '' }],
  );
  if (out !== '@_user_1 hello') fail(`3: masked name should keep placeholder, got ${JSON.stringify(out)}`);
  passed++;
}

// ── 4. @_all untouched ──────────────────────────────────────
{
  const out = resolveMentionPlaceholders(
    '@_all please review',
    [{ id: 'ou_bot', name: 'Bot' }],
  );
  if (out !== '@_all please review') fail(`4: @_all should be untouched, got ${JSON.stringify(out)}`);
  passed++;
}

// ── 5. out-of-range index kept as placeholder ──────────────
{
  const out = resolveMentionPlaceholders(
    '@_user_3 ping',
    [{ id: 'ou_a', name: 'A' }, { id: 'ou_b', name: 'B' }],
  );
  if (out !== '@_user_3 ping') fail(`5: out-of-range should keep placeholder, got ${JSON.stringify(out)}`);
  passed++;
}

// ── 6. no mentions → no-op ─────────────────────────────────
{
  const out = resolveMentionPlaceholders('@_user_1 orphan', []);
  if (out !== '@_user_1 orphan') fail(`6: no mentions should no-op, got ${JSON.stringify(out)}`);
  passed++;
}

// ── 7. undefined mentions → no-op ─────────────────────────
{
  const out = resolveMentionPlaceholders('@_user_1 orphan', undefined);
  if (out !== '@_user_1 orphan') fail(`7: undefined mentions should no-op, got ${JSON.stringify(out)}`);
  passed++;
}

// ── 8. empty text → no-op ─────────────────────────────────
{
  const out = resolveMentionPlaceholders('', [{ id: 'ou_a', name: 'A' }]);
  if (out !== '') fail(`8: empty text should remain empty`);
  passed++;
}

// ── 9. same placeholder multiple times replaced each occurrence ──
{
  const out = resolveMentionPlaceholders(
    '@_user_1 ping @_user_1 pong',
    [{ id: 'ou_bot', name: 'Bot' }],
  );
  if (out !== '@Bot ping @Bot pong') fail(`9: got ${JSON.stringify(out)}`);
  passed++;
}

// ── 10. unicode / emoji in name preserved ─────────────────
{
  const out = resolveMentionPlaceholders(
    '@_user_1 go',
    [{ id: 'ou_x', name: '小助手 🤖' }],
  );
  if (out !== '@小助手 🤖 go') fail(`10: got ${JSON.stringify(out)}`);
  passed++;
}

console.log(`mention-resolver smoke: ${passed}/10 PASS`);
