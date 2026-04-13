import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appConfig } from './config.js';
import { LarkChannel } from './channel.js';
import { registerTools } from './tools.js';
import { ConversationBuffer } from './memory/buffer.js';
import { buildFlushPrompt } from './memory/distiller.js';
import { createMemoryProvider } from './memory/factory.js';

const LOCK_FILE = path.join(os.tmpdir(), `claude-lark-${appConfig.appId}.lock`);

async function acquireLock(): Promise<void> {
  try {
    // Try to create lock file exclusively
    await fs.writeFile(LOCK_FILE, String(process.pid), { flag: 'wx' });
  } catch {
    // Lock file exists — check if the process is still alive
    try {
      const pid = parseInt(await fs.readFile(LOCK_FILE, 'utf-8'), 10);
      try {
        process.kill(pid, 0); // Check if process exists
        console.error(`[lock] Another instance is running (PID ${pid}). Exiting.`);
        process.exit(1);
      } catch {
        // Process is dead — stale lock, overwrite
        await fs.writeFile(LOCK_FILE, String(process.pid));
      }
    } catch {
      await fs.writeFile(LOCK_FILE, String(process.pid));
    }
  }
  // Clean up lock on exit
  const cleanup = () => { try { unlinkSync(LOCK_FILE); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  // 1. Create memory provider
  const memoryProvider = await createMemoryProvider();

  // 2. Create MCP server
  const server = new McpServer(
    { name: 'claude-lark-plugin', version: '0.6.0' },
    {
      capabilities: {
        logging: {},
        experimental: {
          'claude/channel': {},
        },
      },
      instructions: [
        'Users see Feishu, not this transcript. Use reply to respond; edit_message to update; react for acknowledgements.',
        'Always pass reply_to=message_id so replies thread correctly in Feishu.',
        'If metadata has image_path, Read that file to see the image.',
        'If metadata has attachment_file_id, call download_attachment with message_id and file_key, then Read the path.',
        'Use save_memory for important facts; save_skill for reusable procedures.',
      ].join('\n'),
    }
  );

  // 3. Create Lark channel
  const channel = new LarkChannel();
  channel.setMemoryProvider(memoryProvider);

  // 4. Create conversation buffer + wire flush handler
  const buffer = new ConversationBuffer();
  buffer.setFlushHandler(async (chatId, messages) => {
    const flushPrompt = buildFlushPrompt(chatId, messages);
    // In auto-flush, we inject the prompt as if it were a message
    // The channel's message handler will forward it to Claude
    console.error(`[distiller] Auto-flush for chat ${chatId}: ${messages.length} messages`);
    // Forward flush prompt through the normal message handler
    if (channel['messageHandler']) {
      await channel['messageHandler']({
        messageId: `flush-${Date.now()}`,
        chatId,
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
  registerTools(server, channel.getClient(), memoryProvider, buffer, channel.getAckReactions(), channel.getBotMessageTracker());

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
            ts: new Date().toISOString(),
            ...(message.parentContent ? { parent_content: message.parentContent } : {}),
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
    console.error('[dry-run] All modules loaded successfully. Memory provider:', appConfig.memoryProvider);
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

  console.error('[index] claude-lark-plugin started successfully');
}

main().catch((err) => {
  console.error('[index] Fatal error:', err);
  process.exit(1);
});
