/**
 * IdentitySession smoke test — runs as part of `npm test`.
 * Exits non-zero if any assertion fails.
 */
import { IdentitySession, TERMINAL_CHAT_ID } from '../src/identity-session.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// 1. set/get same chat, no thread
{
  const s = new IdentitySession(() => null);
  s.setCaller('chat_A', undefined, 'ou_alice');
  if (s.getCaller('chat_A') !== 'ou_alice') fail('basic chat get');
}

// 2. thread-scoped entry takes precedence over chat-scoped
{
  const s = new IdentitySession(() => null);
  s.setCaller('chat_A', undefined, 'ou_chat');
  s.setCaller('chat_A', 't1', 'ou_thread');
  if (s.getCaller('chat_A', 't1') !== 'ou_thread') fail('thread precedence');
  if (s.getCaller('chat_A') !== 'ou_chat') fail('chat entry still present');
}

// 3. getCaller falls back from thread to chat when thread entry missing
{
  const s = new IdentitySession(() => null);
  s.setCaller('chat_A', undefined, 'ou_chat');
  if (s.getCaller('chat_A', 'no-such-thread') !== 'ou_chat') fail('fallback to chat');
}

// 4. terminal sentinel uses owner fallback
{
  const s = new IdentitySession(() => 'ou_owner');
  if (s.getCaller(TERMINAL_CHAT_ID) !== 'ou_owner') fail('terminal fallback');
}

// 5. terminal sentinel returns null when no owner configured
{
  const s = new IdentitySession(() => null);
  if (s.getCaller(TERMINAL_CHAT_ID) !== null) fail('terminal null when unset');
}

// 6. unknown chat returns null
{
  const s = new IdentitySession(() => null);
  if (s.getCaller('chat_unknown') !== null) fail('unknown chat');
}

// 7. stale entry is not returned; cleanup removes it
{
  const s = new IdentitySession(() => null, 10); // 10ms ttl
  s.setCaller('chat_A', undefined, 'ou_alice');
  await new Promise((r) => setTimeout(r, 30));
  if (s.getCaller('chat_A') !== null) fail('stale should return null');
  s.cleanup();
  if (s._size() !== 0) fail('cleanup should remove stale');
}

// 8. overwrite refreshes
{
  const s = new IdentitySession(() => null);
  s.setCaller('chat_A', undefined, 'ou_alice');
  s.setCaller('chat_A', undefined, 'ou_bob');
  if (s.getCaller('chat_A') !== 'ou_bob') fail('overwrite');
}

console.log('identity smoke: 8/8 PASS');
