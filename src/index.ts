import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { getProcessStartTime, buildLockToken, parseLockToken } from './lock.js';
import path from 'node:path';
import os from 'node:os';
import { appConfig } from './config.js';
import { LarkChannel } from './channel.js';
import { registerTools, setCronjobOutcomeHandler } from './tools.js';
import { ConversationBuffer } from './memory/buffer.js';
import { buildFlushPrompt, triggerProfileDistillation } from './memory/distiller.js';
import { MemoryStore } from './memory/file.js';
import { IdentitySession, SYSTEM_FLUSH_CALLER } from './identity-session.js';
import { JobScheduler } from './scheduler.js';
import { runInboxGcOnce } from './inbox-gc.js';
import { mcpServerInstructions } from './prompts.js';

const LOCK_FILE = path.join(os.tmpdir(), `claude-lark-${appConfig.appId}.lock`);

function extractDocCommentMeta(envelope: string): Record<string, string> {
  // Allow-list of attributes we extract from <doc_comment ...> into notification meta.
  // Explicit allow-list (not the regex's full output) prevents a future envelope
  // attribute addition from silently overriding system-set meta fields like
  // chat_id or message_id (defense-in-depth — PR #182 round 4 M2).
  const ALLOWED_ATTRS = new Set([
    'doc_token',
    'comment_id',
    'reply_id',
    'kind',
    'operator',
    'doc_title',
    'file_type',
    'is_mentioned',
  ]);
  const m = envelope.match(/<doc_comment\s+([^>]+)>/);
  if (!m) return {};
  const out: Record<string, string> = {};
  const attrRe = /(\w+)="([^"]*)"/g;
  let attr: RegExpExecArray | null;
  while ((attr = attrRe.exec(m[1])) !== null) {
    if (ALLOWED_ATTRS.has(attr[1])) {
      out[attr[1]] = attr[2];
    }
  }
  return out;
}

async function acquireLock(): Promise<void> {
  const myToken = buildLockToken(process.pid);
  try {
    // Try to create lock file exclusively
    await fs.writeFile(LOCK_FILE, myToken, { flag: 'wx' });
  } catch {
    // Lock file exists — check if the process is still alive AND is
    // the same process that wrote the lock (#101). Pre-v1.0.23 only
    // `process.kill(pid, 0)` was used, which says "some process with
    // this PID exists" but cannot distinguish the original lock-
    // holder from a recycled-PID bash/python/launchd child. After
    // an unclean shutdown + PID reuse, the bot would refuse to start
    // forever and need manual `rm /tmp/claude-lark-*.lock`.
    let parsed: { pid: number; startTime: string } | null = null;
    let readError: NodeJS.ErrnoException | null = null;
    try {
      parsed = parseLockToken(await fs.readFile(LOCK_FILE, 'utf-8'));
    } catch (err: any) {
      readError = err;
    }
    // R2-audit followup: distinguish a permission error (EACCES —
    // file exists but owned by another uid in /tmp with restrictive
    // mode) from genuine missing/malformed content. Pre-followup
    // EACCES fell through to overwrite → writeFile then threw EACCES
    // uncaught → main() saw stack trace instead of the polished
    // "manually delete the lock" message we provide for the EPERM
    // path below. Treat EACCES the same way: refuse with operator
    // guidance.
    if (readError && readError.code === 'EACCES') {
      console.error(
        `[lock] Lock file ${LOCK_FILE} exists but is not readable by this process ` +
        `(likely owned by another user's bot). Refusing to overwrite — manually delete the ` +
        `lock after confirming the other instance is stopped.`,
      );
      process.exit(1);
    }
    if (parsed === null) {
      // Malformed / empty lock OR read failed for some other reason
      // (ENOENT shouldn't happen since wx-create just hit EEXIST) —
      // overwrite. writeFile may STILL fail with EACCES on cross-uid
      // /tmp + restrictive parent; we let that propagate to main()'s
      // fatal handler since it's an environment-level problem.
      await fs.writeFile(LOCK_FILE, myToken);
    } else {
      const { pid: recordedPid, startTime: recordedStart } = parsed;
      // Distinguish "process gone" (ESRCH) from "process exists but
      // I can't signal it" (EPERM, cross-uid). R1-audit followup on
      // PR #124: pre-fix the catch swallowed both, so a Linux bot
      // started under a different uid would see the lock holder's
      // EPERM as "gone" and overwrite → two bots running.
      let pidExists = false;
      try {
        process.kill(recordedPid, 0);
        pidExists = true;
      } catch (err: any) {
        if (err?.code === 'EPERM') {
          // Process exists but we lack permission to signal it. Treat
          // as alive — the recorded start-time check below still
          // applies for identity disambiguation.
          pidExists = true;
        }
        // ESRCH (or any other code) → process is gone.
      }
      if (pidExists) {
        const currentStart = getProcessStartTime(recordedPid);
        // Compare ps-reported start time against the recorded one.
        // If they match (and recorded is non-empty), it's truly the
        // same process that wrote the lock → refuse. Otherwise PID
        // has been recycled OR the recorded value is from a legacy
        // pre-v1.0.23 PID-only lock → overwrite.
        //
        // EPERM edge: if `process.kill` failed with EPERM, `ps -p`
        // also typically returns no rows for the cross-uid PID, so
        // currentStart is null → falls through to overwrite. That's
        // wrong (the lock holder IS alive); but the legitimate
        // recovery path is "another user owns the lock — refuse",
        // not "overwrite". Tighten by also refusing when pidExists
        // is true AND currentStart is null AND recordedStart is
        // non-empty (means: we know the process is alive but can't
        // verify start-time, so err on the side of refusing).
        if (currentStart !== null && currentStart === recordedStart && recordedStart !== '') {
          console.error(
            `[lock] Another instance is running (PID ${recordedPid}, started ${recordedStart}). Exiting.`,
          );
          process.exit(1);
        }
        if (currentStart === null && recordedStart !== '') {
          console.error(
            `[lock] Lock holder PID ${recordedPid} exists but its start-time is unreadable ` +
            `(likely owned by a different user). Refusing to overwrite — manually delete ` +
            `${LOCK_FILE} after confirming the other instance is stopped.`,
          );
          process.exit(1);
        }
        console.error(
          `[lock] Stale lock for PID ${recordedPid} ` +
          (recordedStart === ''
            ? '(legacy pre-v1.0.23 lock file)'
            : '(PID has been recycled to a different process)') +
          ' — overwriting.',
        );
      }
      await fs.writeFile(LOCK_FILE, myToken);
    }
  }

  // TOCTOU verify-after-write (R1-audit followup on PR #124): two
  // bots starting simultaneously can both hit EEXIST, both read the
  // same stale token, both decide stale, both overwrite — last
  // writer wins but BOTH proceed past acquireLock. Re-read the file
  // and confirm we're the winner; if not, exit cleanly.
  try {
    const persisted = await fs.readFile(LOCK_FILE, 'utf-8');
    if (persisted.trim() !== myToken.trim()) {
      console.error(
        `[lock] Lost the startup race (another instance wrote the lock ` +
        `between our read and our write). Exiting.`,
      );
      process.exit(1);
    }
  } catch {
    // Lock file disappeared between our write and our verify (very
    // unusual — would require an external rm). Treat as a refusal
    // so we don't proceed without a valid lock.
    console.error(
      `[lock] Lock file vanished after we wrote it — refusing to start.`,
    );
    process.exit(1);
  }

  // Cleanup runs on every path that can take down the process —
  // pre-v1.0.23 only `exit` / SIGINT / SIGTERM were covered, which
  // leaked the lock on SIGPIPE (very common when Claude Code closes
  // the child's stdio), SIGHUP (terminal disconnect), SIGQUIT, and
  // uncaught exceptions / unhandled rejections (#101 Case B).
  const cleanup = () => {
    try { unlinkSync(LOCK_FILE); } catch { /* best-effort */ }
  };
  process.on('exit', cleanup);
  // 128 + signal-number is the conventional shell exit code for
  // signal-induced termination. Looked up via os.constants.signals
  // so a custom Node build with non-standard numbers still works.
  const exitOnSignal = (sig: NodeJS.Signals) => {
    cleanup();
    const code = (os.constants.signals as Record<string, number | undefined>)[sig];
    process.exit(typeof code === 'number' ? 128 + code : 1);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGPIPE'] as const) {
    process.on(sig, () => exitOnSignal(sig));
  }
  // Fatal error handlers — last-chance cleanup before crash.
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaughtException:', err);
    cleanup();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection:', reason);
    cleanup();
    process.exit(1);
  });
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  // 1. Create memory store
  const memoryStore = new MemoryStore();
  console.error(`[memory] Using ${appConfig.memoriesDir}`);

  // 1a. One-shot legacy-skill ownership migration (#84). Pre-v1.0.14
  // save_skill had no ownership tracking, so existing skills/<slug>.md
  // files have no sidecar. The migration claims them for OWNER so the
  // operator isn't locked out of their own skills the moment they
  // upgrade. Idempotent: skills with an existing .meta.json are skipped.
  // No-op without LARK_OWNER_OPEN_ID — see migrateLegacySkills for the
  // fail-loud diagnostic.
  await memoryStore.migrateLegacySkills(appConfig.ownerOpenId);

  // 1b. Create identity session (server-side caller tracking for sensitive tools)
  const identitySession = new IdentitySession(
    () => appConfig.ownerOpenId,
    appConfig.identitySessionTtlMs,
    { maxSize: appConfig.identitySessionMaxSize },
  );
  if (appConfig.ownerOpenId) {
    console.error(`[identity] owner fallback: ${appConfig.ownerOpenId}`);
  } else {
    console.error('[identity] no LARK_OWNER_OPEN_ID set — terminal skill invocations will be denied');
  }

  // 2. Create MCP server
  const server = new McpServer(
    { name: 'claude-lark-plugin', version: '1.2.0' },
    {
      capabilities: {
        logging: {},
        experimental: {
          'claude/channel': {},
        },
      },
      instructions: mcpServerInstructions,
    }
  );

  // 3. Create Lark channel
  const channel = new LarkChannel();
  channel.setMemoryStore(memoryStore);
  channel.setIdentitySession(identitySession);

  // 4. Create conversation buffer + wire flush handler

  // #113: per-user TTL cache for profile-distillation cooldown. Map<userId, lastDistillTimestamp>.
  // No persistence across daemon restarts — restart resets the cooldown (acceptable;
  // first post-restart flush may double-distill one user at worst). Orchestration
  // logic lives in `triggerProfileDistillation` (src/memory/distiller.ts) so the
  // shape is unit-testable; this Map is per-process state owned by main().
  const profileDistillCooldownState = new Map<string, number>();

  const buffer = new ConversationBuffer();
  buffer.setFlushHandler(async (chatId, messages) => {
    // Generate flushKey FIRST so it can be interpolated into the
    // prompt (Claude is then told to pass it as `thread_id` in the
    // save_memory call — R1-audit followup on #87, closes the prompt
    // gap where Claude could omit thread_id and fall back to the
    // chat-level slot which resolves to the last real user).
    const flushKey = `flush-${Date.now()}`;
    const flushPrompt = buildFlushPrompt(chatId, messages, flushKey);
    // In auto-flush, we inject the prompt as if it were a message
    // The channel's message handler will forward it to Claude
    console.error(`[distiller] Auto-flush for chat ${chatId}: ${messages.length} messages`);

    // Bind a system-flush caller BEFORE notifying Claude (#66). Without
    // this, save_memory(type=chat) inside the flush turn fails caller
    // resolution because:
    //   - User entries are stored by IdentitySession under (chatId, threadId).
    //   - getCaller resolves by thread-key first, falls back to chat-key.
    //
    // Pre-v1.0.24 the binding lived at chat-level (threadId=undefined),
    // which leaked across subsequent non-flush messages on the SAME
    // chat (#87): any tool call resolving via the chat-level fallback
    // — e.g. a Claude cronjob calling create_job(chat_id, thread_id=T2)
    // where T2 isn't bound — would resolve to the SYSTEM_FLUSH_CALLER
    // sentinel and be denied with the confusing "not authorized for
    // system-flush caller" error long after the flush turn ended.
    //
    // Fix (v1.0.24, #87): bind under a flush-specific thread-key, and
    // pass the same key as `threadId` so the channel notification
    // carries `thread_id=flush-<ts>` → save_memory's resolveCaller
    // does an EXACT thread match → no chat-level fallback pollution.
    // The chat-level slot stays whatever the last real user message
    // wrote, preserving correct identity for unrelated tool calls in
    // other threads or no-thread paths within the same chat.
    //
    // Chat episodes are stored by (chatId, threadId?), NOT by caller,
    // so a sentinel caller doesn't change WHERE the data goes — only
    // WHAT the audit log records. Mirrors scheduler.executePromptJob's
    // pattern of binding job.meta.created_by before the cronjob
    // notification. The thread-key `flush-<ts>` matches LARK_ID_REGEX
    // (alphanumeric + dash) so save_memory's tool-boundary regex
    // accepts it. flushKey was generated above (used to interpolate
    // into the prompt's `thread_id="${flushKey}"` instruction so
    // Claude reliably passes it back — R1-audit followup on #87).
    identitySession.setCaller(chatId, flushKey, SYSTEM_FLUSH_CALLER);

    // Forward flush prompt through the normal message handler
    if (channel['messageHandler']) {
      await channel['messageHandler']({
        messageId: flushKey,
        chatId,
        // RESERVED: chatType='system' is the auto-flush distillation
        // marker. The Stop hook (hooks/enforce-lark-reply.mjs #74)
        // exempts chat_type='system' from its reply-obligation check.
        // Do NOT reuse 'system' for other synthetic notifications that
        // DO need a reply — they would be silently dropped.
        chatType: 'system',
        senderId: 'system',
        // threadId surfaces as `thread_id=flush-<ts>` in the channel
        // notification meta → Claude's save_memory call carries the
        // same value as `thread_id` → resolveCaller hits the exact
        // (chatId, flushKey) entry instead of the chat-level slot
        // (#87 fix).
        threadId: flushKey,
        text: flushPrompt,
        messageType: 'text',
        rawContent: flushPrompt,
      });
    }

    // #113: Stage 2 — Episodes → Profile distillation. Fire-and-forget,
    // per active user, rate-limited via per-user TTL cache. Off by
    // default (LARK_PROFILE_DISTILL_ENABLED). See `triggerProfileDistillation`
    // (src/memory/distiller.ts) for the per-user gating + dispatch logic.
    if (appConfig.profileDistillEnabled) {
      void triggerProfileDistillation(
        chatId,
        messages,
        {
          listEpisodes: (cid: string) => memoryStore.listEpisodes(cid),
          getProfile: (uid: string, caller: string) => memoryStore.getProfile(uid, caller),
          setCaller: (cid: string, tid: string, uid: string) => identitySession.setCaller(cid, tid, uid),
          isPrivateChat: (cid: string) => channel.isPrivateChat(cid),
          injectNotification: async (text: string, distillKey: string) => {
            if (!channel['messageHandler']) return;
            await channel['messageHandler']({
              messageId: distillKey,
              chatId,
              chatType: 'system', // Stop-hook exempt
              senderId: 'system',
              threadId: distillKey,
              text,
              messageType: 'text',
              rawContent: text,
            });
          },
        },
        {
          cooldownMs: appConfig.profileDistillCooldownHours * 60 * 60 * 1000,
          minEpisodes: appConfig.profileDistillMinEpisodes,
          cooldownState: profileDistillCooldownState,
        },
      ).catch((err) => {
        console.error(`[distill-stage2] orchestration error for chat ${chatId}: ${err?.message ?? err}`);
      });
    }
  });
  channel.setConversationBuffer(buffer);

  // 5. Register MCP tools (pass buffer so reply records assistant messages)
  registerTools(
    server,
    channel.getClient(),
    memoryStore,
    identitySession,
    channel,
    buffer,
    channel.getAckReactions(),
    channel.getBotMessageTracker(),
    channel.getLatestMessageTracker()
  );

  // 6. Set message handler — forwards Feishu messages to Claude via MCP
  channel.setMessageHandler(async (message) => {
    // Build friendly display: user_xxx or user_xxx · chat_xxx · thread_xxx
    const displayUser = message.senderName || message.senderId;
    const displayParts = [displayUser];
    if (message.chatName) displayParts.push(message.chatName);
    if (message.threadId) displayParts.push(`thread_${message.threadId.slice(-7)}`);
    const displayLabel = displayParts.join(' · ');

    console.error(`[channel] ${displayLabel}: ${message.text.slice(0, 100)}...`);

    try {
      await server.server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: message.text,
          meta: {
            chat_id: message.chatId,
            message_id: message.messageId,
            user: displayLabel,
            user_id: message.senderId,
            chat_type: message.chatType,
            ...(message.chatName ? { chat_name: message.chatName } : {}),
            ...(message.threadId ? { thread_id: message.threadId } : {}),
            ...(message.botMentioned ? { bot_mentioned: 'true' } : {}),
            ts: new Date().toISOString(),
            // R2-audit followup on #115: `parent_content` is the body of
            // the quoted message — author-controlled by a potentially-
            // different user. Pre-followup it was sent as a raw `meta`
            // attribute on the notification, bypassing the
            // <memory_context> envelope that enrichWithMemory adds
            // INSIDE the prompt text. Drop it from meta — the envelope-
            // wrapped copy in `content` is the only render path Claude
            // sees, and it's the trust-bounded one.
            ...(message.imagePath ? { image_path: message.imagePath } : {}),
            ...(message.imagePaths?.length ? { image_paths: message.imagePaths.join(',') } : {}),
            ...(message.attachments?.length === 1
              ? {
                  attachment_kind: message.attachments[0].fileType,
                  attachment_file_id: message.attachments[0].fileKey,
                  attachment_name: message.attachments[0].fileName,
                }
              : message.attachments && message.attachments.length > 1
                ? { attachments: JSON.stringify(message.attachments) }
                : {}),
            ...(message.chatType === 'doc_comment'
              ? extractDocCommentMeta(message.text)
              : {}),
          },
        },
      });
      return true;
    } catch (err) {
      console.error('[channel] Failed to deliver inbound to Claude:', err);
      // #189 round-2 review: signal non-delivery instead of throwing so
      // existing call sites keep their behavior, while the IM path can
      // invalidate its enrichment-dedup scope (the model never saw this
      // turn's injected blocks — suppressing them next turn would point
      // a stub at history that doesn't exist).
      return false;
    }
  });

  if (isDryRun) {
    console.error('[dry-run] All modules loaded successfully.');
    console.error('[dry-run] Tools registered. Exiting.');
    process.exit(0);
  }

  // 7. Acquire single-instance lock BEFORE the MCP transport is
  //    connected (R2-audit followup on #101). Pre-followup acquireLock
  //    ran after server.connect, so any of the 3 acquireLock refuse
  //    paths (legacy-lock collision, EPERM cross-uid, lost startup
  //    race) would call process.exit(1) with a live stdio transport
  //    already handshaking with Claude Code — operator saw a half-
  //    connected server. Moving the lock up to before the transport
  //    keeps the exit clean.
  await acquireLock();

  // 8. Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[index] MCP server connected via stdio');

  // 9. Start Lark WebSocket
  await channel.start();

  // 9. Re-arm flush timers from persisted episodes
  await buffer.rearmFromDisk();

  // 10. Start cronjob scheduler
  const scheduler = new JobScheduler({
    server: server.server,
    client: channel.getClient(),
    identitySession,
    // #81: pass the same tracker the reply tool uses so cronjob-sent
    // messages (message-type jobs + scheduler notices) also land in
    // the tracker — without this, reactions on them silently drop in
    // handleReactionEvent.
    botMessageTracker: channel.getBotMessageTracker(),
  });
  await scheduler.start();

  // #121: wire the prompt-cronjob outcome handler so the reply tool's
  // permanent-target-error / success paths can report back to the
  // scheduler. Without this, prompt-type cronjobs targeting an
  // unreachable chat fire a fresh Claude turn on every tick — the
  // reply tool returns LARK_DEFER each time but the job never auto-
  // pauses, burning tokens until an operator notices.
  setCronjobOutcomeHandler((jobId, kind, ctx) => {
    void scheduler.notePromptJobOutcome(jobId, kind, ctx);
  });

  // 11. Inbox garbage collection (#89). Pre-v1.0.35 the inbox grew
  //     unboundedly. Run once at startup to sweep accumulated files,
  //     then install a periodic timer at LARK_INBOX_GC_INTERVAL_MIN
  //     cadence. `.unref()` so the timer never holds an idle process
  //     open. Opt out with LARK_INBOX_GC_DISABLED=true for forensic
  //     deployments that want everything preserved.
  if (!appConfig.inboxGcDisabled) {
    // Fire-and-forget; runInboxGcOnce swallows its own errors.
    void runInboxGcOnce();
    const intervalMs = appConfig.inboxGcIntervalMin * 60 * 1000;
    const timer = setInterval(() => { void runInboxGcOnce(); }, intervalMs);
    // R2-followup: setInterval always returns a NodeJS.Timeout with
    // unref defined; no optional-chain needed.
    timer.unref();
    console.error(
      `[index] Inbox GC enabled (maxAge=${appConfig.inboxMaxAgeDays}d, ` +
      `maxSize=${appConfig.inboxMaxSizeMB}MB, interval=${appConfig.inboxGcIntervalMin}min)`,
    );
  } else {
    console.error('[index] Inbox GC disabled via LARK_INBOX_GC_DISABLED');
  }

  // 12. Episode retention prune (#109). saveEpisode writes one .md per
  //     buffer flush; listEpisodes / searchEpisodes do `readdir +
  //     per-file score` on every memory enrichment, so cost is O(N) per
  //     inbound message. Run once at startup, then on
  //     LARK_EPISODE_PRUNE_INTERVAL_MIN cadence (default 24h).
  if (!appConfig.episodePruneDisabled) {
    const pruneOnce = async (): Promise<void> => {
      try {
        const ageMs = appConfig.episodeRetentionDays * 86_400_000;
        const r = await memoryStore.pruneEpisodes(ageMs);
        if (r.removedFiles > 0 || r.skipped > 0) {
          const mb = (r.bytesFreed / (1024 * 1024)).toFixed(2);
          const skipPart = r.skipped > 0 ? ` (${r.skipped} skipped — stat/unlink failed)` : '';
          console.error(
            `[episode-prune] removed ${r.removedFiles} stale episode file(s), freed ${mb}MB${skipPart}`,
          );
        }
      } catch (err) {
        console.error('[episode-prune] run failed:', err);
      }
    };
    void pruneOnce();
    const intervalMs = appConfig.episodePruneIntervalMin * 60 * 1000;
    const timer = setInterval(() => { void pruneOnce(); }, intervalMs);
    timer.unref();
    console.error(
      `[index] Episode prune enabled (retention=${appConfig.episodeRetentionDays}d, ` +
      `interval=${appConfig.episodePruneIntervalMin}min)`,
    );
  } else {
    console.error('[index] Episode prune disabled via LARK_EPISODE_PRUNE_DISABLED');
  }

  console.error('[index] claude-lark-plugin started successfully');
}

main().catch((err) => {
  console.error('[index] Fatal error:', err);
  process.exit(1);
});
