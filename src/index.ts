import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { getProcessStartTime, buildLockToken, parseLockToken } from './lock.js';
import path from 'node:path';
import os from 'node:os';
import { appConfig } from './config.js';
import { LarkChannel } from './channel.js';
import { registerTools } from './tools.js';
import { ConversationBuffer } from './memory/buffer.js';
import { buildFlushPrompt } from './memory/distiller.js';
import { MemoryStore } from './memory/file.js';
import { IdentitySession, SYSTEM_FLUSH_CALLER } from './identity-session.js';
import { JobScheduler } from './scheduler.js';
import { mcpServerInstructions } from './prompts.js';

const LOCK_FILE = path.join(os.tmpdir(), `claude-lark-${appConfig.appId}.lock`);

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
    try {
      parsed = parseLockToken(await fs.readFile(LOCK_FILE, 'utf-8'));
    } catch {
      // Lock file unreadable — fall through to overwrite.
    }
    if (parsed === null) {
      // Malformed / empty lock — overwrite.
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
  );
  if (appConfig.ownerOpenId) {
    console.error(`[identity] owner fallback: ${appConfig.ownerOpenId}`);
  } else {
    console.error('[identity] no LARK_OWNER_OPEN_ID set — terminal skill invocations will be denied');
  }

  // 2. Create MCP server
  const server = new McpServer(
    { name: 'claude-lark-plugin', version: '1.0.23' },
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
  const buffer = new ConversationBuffer();
  buffer.setFlushHandler(async (chatId, messages) => {
    const flushPrompt = buildFlushPrompt(chatId, messages);
    // In auto-flush, we inject the prompt as if it were a message
    // The channel's message handler will forward it to Claude
    console.error(`[distiller] Auto-flush for chat ${chatId}: ${messages.length} messages`);

    // Bind a system-flush caller BEFORE notifying Claude (#66). Without
    // this, save_memory(type=chat) inside the flush turn fails caller
    // resolution because:
    //   - User entries are stored by IdentitySession under (chatId, threadId).
    //   - The flush notification carries chatId only (no threadId, since the
    //     buffer is chat-scoped, not thread-scoped).
    //   - getCaller(chatId, undefined) falls back to a chat-level entry,
    //     which is only present in non-threaded chats. Threaded chats miss.
    //
    // Chat episodes are stored by (chatId, threadId?), NOT by caller, so a
    // sentinel caller doesn't change WHERE the data goes — only WHAT the
    // audit log records. Mirrors scheduler.executePromptJob's pattern of
    // binding job.meta.created_by before the cronjob notification.
    identitySession.setCaller(chatId, undefined, SYSTEM_FLUSH_CALLER);

    // Forward flush prompt through the normal message handler
    if (channel['messageHandler']) {
      await channel['messageHandler']({
        messageId: `flush-${Date.now()}`,
        chatId,
        // RESERVED: chatType='system' is the auto-flush distillation
        // marker. The Stop hook (hooks/enforce-lark-reply.mjs #74)
        // exempts chat_type='system' from its reply-obligation check.
        // Do NOT reuse 'system' for other synthetic notifications that
        // DO need a reply — they would be silently dropped.
        chatType: 'system',
        senderId: 'system',
        text: flushPrompt,
        messageType: 'text',
        rawContent: flushPrompt,
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
          },
        },
      });
    } catch (err) {
      console.error('[channel] Failed to deliver inbound to Claude:', err);
    }
  });

  if (isDryRun) {
    console.error('[dry-run] All modules loaded successfully.');
    console.error('[dry-run] Tools registered. Exiting.');
    process.exit(0);
  }

  // 7. Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[index] MCP server connected via stdio');

  // 8. Acquire single-instance lock and start Lark WebSocket
  await acquireLock();
  await channel.start();

  // 9. Re-arm flush timers from persisted episodes
  await buffer.rearmFromDisk();

  // 10. Start cronjob scheduler
  const scheduler = new JobScheduler({
    server: server.server,
    client: channel.getClient(),
    identitySession,
  });
  await scheduler.start();

  console.error('[index] claude-lark-plugin started successfully');
}

main().catch((err) => {
  console.error('[index] Fatal error:', err);
  process.exit(1);
});
