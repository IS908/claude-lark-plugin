#!/usr/bin/env node
// Stop hook: ensure Lark inbound messages in the current turn have been answered
// via mcp__plugin_lark_lark__reply before allowing the turn to end.
//
// Fail-safe: any internal error → exit 0 (never block on tool malfunction).
// Loop-safe: stop_hook_active === true → exit 0 (break forced-continuation cycle).
//
// Stdin: { session_id, stop_hook_active, transcript_path, cwd }
// Exit: 0 = allow stop, 2 = block + stderr injected into model context
// Audit: appends one line per invocation to ~/.claude/channels/lark/hook-audit.log

import {
  readFileSync, appendFileSync, mkdirSync, existsSync,
  statSync, renameSync, openSync, readSync, closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const AUDIT_LOG =
  process.env.LARK_HOOK_AUDIT_LOG ||
  join(homedir(), '.claude', 'channels', 'lark', 'hook-audit.log');

// #109 fix: single-rotation cap for the hook audit log. The hook
// can't import from src/ (it's a standalone mjs invoked by Claude
// Code's hook framework), so the rotation logic is inlined here.
// Same shape and env var as src/log-rotation.ts.
const LOG_MAX_BYTES = (() => {
  const raw = process.env.LARK_LOG_MAX_BYTES;
  if (!raw) return 50 * 1024 * 1024;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 50 * 1024 * 1024;
})();

// Tools that count as fulfilling a reply obligation for an inbound message.
// - reply: standard answer; reply.reply_to → user's inbound message_id
// - react: emoji ack on the user's message; react.message_id → user's id
//
// edit_message is intentionally NOT here. Its `message_id` targets the
// BOT's previous message (the one being patched), not the user's inbound
// message_id, so it cannot satisfy "the user's question has been
// answered." A turn that consists only of edit_message — with no prior
// reply — should still block (the user got no new content addressing
// them). When reply IS present in the same turn, that reply already
// satisfies; the trailing edit_message is just a follow-up refinement.
const REPLY_TOOLS = new Set([
  'mcp__plugin_lark_lark__reply',
  'mcp__plugin_lark_lark__react',
]);
const DEFER_SENTINELS = ['[LARK_DEFER]', '[LARK_NO_REPLY]'];

// Tag opener anchor — we then parse attributes manually to handle quoted
// values that may legitimately contain `>` (e.g. parent_content from a user).
const TAG_OPENER = '<channel ';
const TAG_CLOSER = '</channel>';

function audit(line) {
  try {
    if (!existsSync(dirname(AUDIT_LOG))) {
      mkdirSync(dirname(AUDIT_LOG), { recursive: true });
    }
    // #109 fix: rotate at LOG_MAX_BYTES (default 50MB). Single
    // rotated copy at `<path>.1`. Best-effort: stat / rename / append
    // failures all swallowed — hook must never block on log I/O.
    let size = 0;
    try { size = statSync(AUDIT_LOG).size; } catch { /* not yet created */ }
    if (size > LOG_MAX_BYTES) {
      try { renameSync(AUDIT_LOG, AUDIT_LOG + '.1'); } catch { /* swallow */ }
    }
    appendFileSync(AUDIT_LOG, `${new Date().toISOString()}  ${line}\n`);
  } catch {
    // best-effort; never propagate
  }
}

function readStdinJson() {
  const raw = readFileSync(0, 'utf-8');
  return JSON.parse(raw);
}

// Quote-aware tag parser. Walks `text` from `start` (must point at
// `<channel `), scanning key="value" pairs (or bare key flags) until it
// hits the unquoted `>` or `/>`. Returns { attrs, endIndex, selfClosing }
// or null only when the tag is truly unterminated (no `>` ever).
// Tolerant of:
//   - `>` inside quoted attribute values  (Round 1 fix #1)
//   - whitespace around `=`  (Round 2 fix #3)
//   - bare flag attributes with no value  (Round 2 fix #4 — never lose other attrs)
//   - unicode / non-ASCII attribute names  (Round 2 fix #5)
function parseTagAt(text, start) {
  let i = start + TAG_OPENER.length;
  const attrs = {};
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) return null;
    if (text[i] === '/' && text[i + 1] === '>') return { attrs, endIndex: i + 2, selfClosing: true };
    if (text[i] === '>') return { attrs, endIndex: i + 1, selfClosing: false };
    // Scan an attribute name: any non-whitespace chars up to `=`, `>`, `/` or whitespace.
    // Permissive on purpose — fail-safe hook should err toward extracting too much
    // metadata, not too little. We don't trust unknown attrs anyway.
    const keyStart = i;
    while (i < text.length && !/[\s=/>]/.test(text[i])) i++;
    if (i === keyStart) {
      // Stuck on an unexpected char — skip it and continue
      i++;
      continue;
    }
    const key = text.slice(keyStart, i);
    // Optional whitespace, then `=`
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '=') {
      // Bare flag attribute — record as empty string, continue
      attrs[key] = '';
      continue;
    }
    i++; // consume `=`
    while (i < text.length && /\s/.test(text[i])) i++;
    // Quoted value required after `=`
    if (text[i] !== '"') {
      // Malformed (e.g. unquoted value) — record as empty flag and continue
      attrs[key] = '';
      continue;
    }
    i++; // consume opening "
    const valStart = i;
    while (i < text.length && text[i] !== '"') i++;
    if (i >= text.length) return null; // truly unterminated
    attrs[key] = text.slice(valStart, i);
    i++; // consume closing "
  }
  return null;
}

// Extract AT MOST ONE channel tag from a user entry's text content.
//
// Why one: `src/index.ts:146` emits exactly one `notifications/claude/channel`
// per inbound Lark event. Each notification renders into its own assistant
// transcript entry. So "one channel tag per user entry" is the structural
// invariant — taking more than that means we're parsing user-controlled body
// content as structured metadata.
//
// Why this matters (Round 3 fix #1): Round 2 stopped scanning for nested
// `<channel>` OPENERS in body, but a Feishu user can still place a literal
// `</channel>` in their message body, prematurely closing the real tag. Any
// `<channel source="plugin:lark:lark" ...>` text that follows in their body
// then becomes a forged sibling. Same wedging outcome as the original
// injection (Claude tries to reply to a non-existent message_id, gets stuck
// in stop_hook_active retry loops).
//
// Fix: ignore the body entirely. We only need attributes from the opener.
function scanChannelTags(text) {
  const opener = text.indexOf(TAG_OPENER);
  if (opener < 0) return [];
  const parsed = parseTagAt(text, opener);
  if (!parsed) return [];
  if (parsed.attrs.source !== 'plugin:lark:lark') return [];
  return [parsed.attrs];
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .join('\n');
}

// Tool-use blocks come in two flavors depending on routing path:
// - `tool_use`        — model called the tool directly (MCP via stdio)
// - `server_tool_use` — Claude Code dispatched server-side (some MCP paths)
// Both should count for the reply allowlist (Round 2 fix #6).
function extractToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b) => b && typeof b === 'object' && (b.type === 'tool_use' || b.type === 'server_tool_use')
  );
}

// Tail-only transcript read.
//
// The hook only needs entries from the start of the current turn onward
// (findCurrentTurn scans backward from the end for the last real user
// entry). A long Claude Code session JSONL can grow to tens of MB; reading
// the whole file on every Stop event is wasteful. Cap at MAX_TAIL_BYTES.
//
// Edge case: a single turn spanning more than MAX_TAIL_BYTES of activity
// (very long agent run) would lose its earlier entries. The hook then
// either finds an OLDER user entry from a previous turn (false-negative
// risk — could under-block) or none at all (exits ok / no-user-entry,
// which is fail-safe). 2 MB is generous — a typical turn is 10-100 KB.
const MAX_TAIL_BYTES = 2 * 1024 * 1024;

function loadTranscript(path) {
  // Initialize so that if a future edit adds a fourth branch and forgets
  // to assign, the `.split` below throws with a clear error caught by the
  // caller's fail-safe try/catch — rather than `undefined.split` confusion.
  let text = '';
  let stat;
  try {
    stat = statSync(path);
  } catch {
    // statSync failed — fall back to readFileSync which will throw
    // upstream and be caught by the caller's fail-safe try/catch.
    text = readFileSync(path, 'utf-8');
    stat = null;
  }
  if (stat && stat.size > MAX_TAIL_BYTES) {
    // Read the last MAX_TAIL_BYTES bytes.
    const fd = openSync(path, 'r');
    let bytesRead = 0;
    try {
      const buf = Buffer.alloc(MAX_TAIL_BYTES);
      bytesRead = readSync(fd, buf, 0, MAX_TAIL_BYTES, stat.size - MAX_TAIL_BYTES);
      // Slice to bytesRead in case of a short read (file shrunk
      // concurrently) — otherwise the trailing NUL fill would surface as
      // U+0000 chars and pollute parsing.
      text = buf.slice(0, bytesRead).toString('utf-8');
    } finally {
      closeSync(fd);
    }
    // The first line is almost certainly partial — drop it. (If the read
    // started exactly on a line boundary, we lose at most one entry,
    // which is acceptable for an old/historical record.)
    const firstNewline = text.indexOf('\n');
    if (firstNewline >= 0) text = text.slice(firstNewline + 1);
  } else if (stat) {
    text = readFileSync(path, 'utf-8');
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Find boundary of the current turn. Scans from the end, collecting ALL
// CONTIGUOUS non-tool_result user entries up to the previous assistant
// entry — Lark's per-chat queue (src/queue.ts) can deliver multiple inbound
// notifications back-to-back before Claude reacts, so the latest user entry
// alone is not enough (fix for finding #2).
// Returns { realUserIndices: number[], scanFromIndex: number } where:
//   realUserIndices: indices of all genuine user-prompt entries in the turn
//   scanFromIndex: where to start scanning for reply tool_uses
// Returns null when no user entries exist at all (assistant-only transcript).
function findCurrentTurn(entries) {
  const realUserIndices = [];
  let scanFromIndex = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.type === 'assistant') {
      // First assistant we hit (scanning backward) marks where this turn's
      // assistant work BEGINS. We've already passed all assistant entries
      // belonging to this turn going backward, but for the FIRST assistant
      // we encounter on our way back, that's actually the start of assistant
      // activity for the current turn (or end of previous turn). If we
      // haven't found any real user entries yet, keep scanning back.
      if (realUserIndices.length > 0) {
        // We've collected user entries; assistant boundary = end of previous turn
        break;
      }
      continue;
    }
    if (entry.type === 'user') {
      const content = entry.message?.content;
      // tool_result-only synthesized messages are part of assistant flow,
      // not new user prompts
      if (Array.isArray(content) && content.every((b) => b?.type === 'tool_result')) {
        continue;
      }
      realUserIndices.unshift(i);
      scanFromIndex = i;
    }
  }
  if (realUserIndices.length === 0) return null;
  return { realUserIndices, scanFromIndex };
}

function shouldSkipChannelTag(attrs) {
  // Reaction events: chat_type === "reaction" → no reply expected
  // (verified: src/channel.ts:287 sets chat_type from inbound event)
  if (attrs.chat_type === 'reaction') return true;
  // Buffer auto-flush (#74). ConversationBuffer's flush handler injects a
  // synthetic notification (src/index.ts:111) with chat_type='system' to
  // ask Claude to distill recent activity into a chat episode — there is
  // no user awaiting a reply. Real Feishu inbound carries chat_type='p2p'
  // or 'group' per SDK contract, never 'system', so this exemption is
  // tight. If a future feature introduces a system-typed notification
  // that DOES need a reply, narrow this to message_id.startsWith('flush-')
  // (the flush handler's id format) — see src/index.ts:109 for the
  // matching producer.
  if (attrs.chat_type === 'system') return true;
  // Cronjob notifications: scheduler.ts:437 sets meta.source='cronjob'.
  // That meta value renders into the channel tag (where it may collide
  // with the outer source='plugin:lark:lark'). The unambiguous marker is
  // meta.job_id (also set by scheduler.ts:438) — use that instead.
  if (attrs.job_id) return true;
  // No message_id means we cannot match a reply anyway — skip
  if (!attrs.message_id) return true;
  return false;
}

function collectPendingLarkMessages(entries, realUserIndices) {
  const pending = [];
  const seenIds = new Set();
  for (const idx of realUserIndices) {
    const entry = entries[idx];
    const text = extractTextFromContent(entry.message?.content);
    for (const attrs of scanChannelTags(text)) {
      if (shouldSkipChannelTag(attrs)) continue;
      // Dedup by message_id in case the same notification appears twice
      if (seenIds.has(attrs.message_id)) continue;
      seenIds.add(attrs.message_id);
      pending.push({
        message_id: attrs.message_id,
        chat_id: attrs.chat_id || '',
        thread_id: attrs.thread_id || '',
        user: attrs.user || '',
      });
    }
  }
  return pending;
}

function collectReplies(entries, fromIndex) {
  const replies = [];
  for (let i = fromIndex; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.type !== 'assistant') continue;
    const tools = extractToolUses(entry.message?.content);
    for (const t of tools) {
      if (!REPLY_TOOLS.has(t.name)) continue;
      const input = t.input || {};
      // For react the target message_id is in `message_id` (the user's
      // message being reacted to), not `reply_to` — both fields are accepted
      // as the target. (edit_message is excluded from REPLY_TOOLS above —
      // its message_id targets the BOT's previous message, not the user's
      // inbound id, so it cannot satisfy a pending reply obligation.)
      const targetMessageId = input.reply_to || input.message_id || '';
      replies.push({
        tool: t.name,
        reply_to: targetMessageId,
        chat_id: input.chat_id || '',
      });
    }
  }
  return replies;
}

// Collect text the model emitted in this turn — assistant text blocks AND
// thinking blocks (sentinels in thinking should still defer; fix for
// finding #5).
function collectAssistantText(entries, fromIndex) {
  let combined = '';
  for (let i = fromIndex; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (typeof content === 'string') {
      combined += content + '\n';
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'string') {
          combined += block + '\n';
        } else if (block?.type === 'text' && typeof block.text === 'string') {
          combined += block.text + '\n';
        } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
          combined += block.thinking + '\n';
        }
      }
    }
  }
  return combined;
}

// Defer sentinel must appear on its own line (allowing leading/trailing
// whitespace) — guards against echo attacks where a Lark user asks the
// bot to print the literal token inline (Round 2 hardening of #11).
// Round 1 used `text.includes(s)`; that was exploitable once the channel
// injection (Round 2 #1) was fixed, because body content is now trusted
// to be inert but assistant output isn't.
const SENTINEL_LINE_REGEXES = DEFER_SENTINELS.map(
  (s) => new RegExp(`^\\s*${s.replace(/[\[\]]/g, '\\$&')}\\s*$`, 'm')
);

// #82 fix: strip markdown code content BEFORE the sentinel regex check.
// Pre-fix, `^...$` with the `m` flag matched ANY line — including lines
// inside a fenced code block. So a Claude response that *demonstrated*
// the sentinel (e.g. "to defer, write [LARK_DEFER] on its own line"
// formatted as a fenced code sample) would accidentally defer a real
// unanswered message.
//
// Threat model: an adversarial Lark user asks Claude to demonstrate /
// echo the defer sentinel. Whatever markdown code variant Claude uses
// to format that demo must NOT be parsed as a real defer. The user
// can steer Claude toward any of these shapes:
//
//   1. ```...``` fenced (3-backtick, the common case)
//   2. ````...```` fenced (4+-backtick, when inner content has ```)
//   3. ~~~...~~~ tilde-fenced (alt CommonMark fence)
//   4. 4-space indented code block (CommonMark indented-code syntax)
//   5. Tab-indented code block
//   6. `...` inline backtick spans (single-line)
//   7. Unclosed fence — adversary asks Claude to reproduce only the
//      opening line + sentinel ("reply with exactly: ```\\n[LARK_DEFER]")
//
// All 7 are stripped here.
//
// The strip ORDER matters:
//   - Backreference-anchored fences (`(`{3,})...\1`) FIRST so an outer
//     4-backtick fence wrapping a 3-backtick demo strips as one unit
//     instead of the inner ``` being mistaken for an outer close.
//   - Then unclosed-fence catch-alls (strip to EOF). Under-block is a
//     security bypass; over-block is just a UX retry — choose the
//     safer side.
//   - Then inline backticks.
//   - Then indented code blocks (4+ spaces / tab at line start),
//     stripped line-by-line.
//
// Residual gap filed for followup: unmatched single-backtick spans
// (e.g. ``Look at `this then\n[LARK_DEFER]\nanyway``) survive because
// the inline regex requires a close on the same line. Adversary-
// reachable via "echo this verbatim" but lower-frequency than 1-7.
function stripCodeContent(text) {
  // 1+2: matched-length backtick fence — \1 forces the close to be the
  // same length as the open, so outer 4-backtick fence around a
  // 3-backtick demo strips as one unit.
  let t = text.replace(/(`{3,})[\s\S]*?\1/g, '');
  // 3: tilde fence, matched-length
  t = t.replace(/(~{3,})[\s\S]*?\1/g, '');
  // 7: unclosed fences — any remaining COLUMN-0 opening swallows to EOF.
  // R2-audit followup: pre-fix this stripped from ANY remaining ``` to
  // EOF, which over-blocked the realistic case of Claude prose
  // discussing markdown ("to fence text, use ``` as a delimiter")
  // followed by a real [LARK_DEFER] — the prose ``` poisoned the
  // tail and the genuine defer was destroyed. Scoping to column-0
  // matches CommonMark: an opening fence MUST be at line start (after
  // up to 3 spaces of indent — but indented lines are caught by case
  // 4 below, so the strict ^ here is fine). Mid-line ``` is not a
  // fence per spec, just literal text.
  //
  // Residual: an adversary who tricks Claude into emitting a column-0
  // unclosed open followed by sentinel still gets stripped (correct —
  // that IS a valid code-block open per CommonMark). The narrower
  // exposure of "mid-line ``` + sentinel on next line" still produces
  // a false defer, but is much harder to trigger naturally and is
  // closer to "Claude was tricked into deferring."
  t = t.replace(/^`{3,}[\s\S]*/m, '');
  t = t.replace(/^~{3,}[\s\S]*/m, '');
  // 6: inline backtick spans (single-line)
  t = t.replace(/`[^`\n]*`/g, '');
  // 4: indented code blocks — any line starting with 4+ spaces.
  //    Per CommonMark these are code blocks; the sentinel regex would
  //    otherwise match because `^\s*` consumes the indent.
  t = t.replace(/^[ ]{4,}.*$/gm, '');
  // 5: tab-indented code blocks
  t = t.replace(/^\t.*$/gm, '');
  return t;
}

function hasDeferSentinel(text) {
  const clean = stripCodeContent(text);
  return SENTINEL_LINE_REGEXES.some((re) => re.test(clean));
}

// Determine whether each pending message has been answered.
// Strict: an explicit reply_to match always satisfies.
// Heuristic (tightened in Round 1 and again in Round 3): a chat_id-only
// match counts ONLY when (a) the reply doesn't quote a *different* turn's
// message_id (Round 3 fix #2 — queue-race false-negative: a reply quoting
// the previous turn's message_id was incorrectly counted toward the
// current turn's chat coverage), and (b) the per-chat reply count covers
// the per-chat pending count (Round 1 fix #3 — prevents one reply from
// silently satisfying multiple distinct @-mentions in a group chat).
function computeUnanswered(pending, replies) {
  const inTurnIds = new Set(pending.map((p) => p.message_id));
  const repliedIds = new Set(replies.map((r) => r.reply_to).filter(Boolean));

  // Count pending per chat
  const pendingByChat = new Map();
  for (const p of pending) {
    if (p.chat_id) pendingByChat.set(p.chat_id, (pendingByChat.get(p.chat_id) || 0) + 1);
  }
  // Count replies per chat — but only those that could plausibly belong to
  // this turn: either no reply_to (batch/general reply) or reply_to targets
  // an in-turn pending message_id. A reply_to that points outside this
  // turn's pending set is satisfying some *other* turn and must not be
  // double-counted as chat coverage here.
  const repliesByChat = new Map();
  for (const r of replies) {
    if (!r.chat_id) continue;
    if (r.reply_to && !inTurnIds.has(r.reply_to)) continue;
    repliesByChat.set(r.chat_id, (repliesByChat.get(r.chat_id) || 0) + 1);
  }

  return pending.filter((p) => {
    // 1) Direct match by message_id always satisfies
    if (repliedIds.has(p.message_id)) return false;
    // 2) Heuristic: chat covered if replies-in-chat >= pending-in-chat
    if (p.chat_id) {
      const pendingCount = pendingByChat.get(p.chat_id) || 0;
      const replyCount = repliesByChat.get(p.chat_id) || 0;
      if (replyCount >= pendingCount && replyCount > 0) return false;
    }
    return true;
  });
}

function buildBlockMessage(unanswered) {
  const lines = [
    '[LARK Stop Hook] Unreplied Lark message(s) detected:',
    '',
  ];
  for (const u of unanswered) {
    lines.push(
      `  - message_id=${u.message_id} chat_id=${u.chat_id || '?'} thread_id=${u.thread_id || '(none)'} user=${u.user || '?'}`
    );
  }
  lines.push(
    '',
    'Call mcp__plugin_lark_lark__reply (or react targeting the same message_id) for each pending message before ending the turn. Note: edit_message does NOT satisfy this — its message_id targets the bot\'s own card, not the user\'s inbound id, so calling edit_message will leave the user unaddressed and re-trigger this block.',
    'If you intentionally do NOT want to reply (async handling / non-actionable event),',
    'put the literal sentinel [LARK_DEFER] or [LARK_NO_REPLY] on its OWN LINE in your text output for this turn.'
  );
  return lines.join('\n');
}

function main() {
  let input;
  try {
    input = readStdinJson();
  } catch (e) {
    audit(`Stop  status=fail-safe  reason=stdin-parse  err=${String(e).slice(0, 100)}`);
    process.exit(0);
  }

  // Loop-safety: if Claude Code is already in a forced-continuation cycle,
  // exit 0 to break it. Per Claude Code hooks spec.
  if (input.stop_hook_active === true) {
    audit('Stop  status=loop-break  reason=stop_hook_active');
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) {
    audit('Stop  status=fail-safe  reason=missing-transcript-path');
    process.exit(0);
  }

  let entries;
  try {
    entries = loadTranscript(transcriptPath);
  } catch (e) {
    audit(`Stop  status=fail-safe  reason=transcript-read  err=${String(e).slice(0, 100)}`);
    process.exit(0);
  }

  let turn;
  try {
    turn = findCurrentTurn(entries);
  } catch (e) {
    audit(`Stop  status=fail-safe  reason=turn-detection  err=${String(e).slice(0, 100)}`);
    process.exit(0);
  }

  if (!turn) {
    audit('Stop  status=ok  pending=0  reason=no-user-entry');
    process.exit(0);
  }

  let pending, replies, assistantText;
  try {
    pending = collectPendingLarkMessages(entries, turn.realUserIndices);
    replies = collectReplies(entries, turn.scanFromIndex);
    assistantText = collectAssistantText(entries, turn.scanFromIndex);
  } catch (e) {
    audit(`Stop  status=fail-safe  reason=parse-error  err=${String(e).slice(0, 100)}`);
    process.exit(0);
  }

  if (pending.length === 0) {
    audit(`Stop  status=ok  pending=0  replied=${replies.length}  reason=no-lark-channel`);
    process.exit(0);
  }

  const unanswered = computeUnanswered(pending, replies);

  if (unanswered.length === 0) {
    audit(`Stop  status=ok  pending=${pending.length}  replied=${replies.length}`);
    process.exit(0);
  }

  if (hasDeferSentinel(assistantText)) {
    audit(
      `Stop  status=deferred  pending=${pending.length}  unanswered=${unanswered.length}  reason=defer-sentinel`
    );
    process.exit(0);
  }

  // Normal block path
  const msg = buildBlockMessage(unanswered);
  const idList = unanswered.map((u) => u.message_id).join(',');
  audit(`Stop  status=blocked  pending=${pending.length}  unanswered=${unanswered.length}  ids=${idList}`);
  process.stderr.write(msg + '\n');
  process.exit(2);
}

try {
  main();
} catch (e) {
  // Last-resort fail-safe — never block on an unexpected crash
  audit(`Stop  status=fail-safe  reason=uncaught  err=${String(e).slice(0, 100)}`);
  process.exit(0);
}
