import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs/promises';
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
  const cleanup = () => { try { require('fs').unlinkSync(LOCK_FILE); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  // 1. Create memory provider
  const memoryProvider = createMemoryProvider();

  // 2. Create MCP server
  const server = new McpServer(
    { name: 'claude-lark-plugin', version: '0.2.0' },
    {
      capabilities: { logging: {} },
      instructions:
        'You are connected to Feishu (Lark) via this plugin. Users send messages through Feishu and you respond using the reply tool. You can also edit messages, add emoji reactions, download attachments, and save memories for cross-session recall.',
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
  registerTools(server, channel.getClient(), memoryProvider, buffer);

  // 6. Set message handler — forwards Feishu messages to Claude via MCP
  channel.setMessageHandler(async (message) => {
    // Log the incoming message for debugging
    console.error(
      `[channel] Message from ${message.senderId} in ${message.chatId}: ${message.text.slice(0, 100)}...`
    );

    // Record assistant responses in buffer when Claude replies
    // (The actual forwarding to Claude happens via the MCP server's tool calls)
    // In the channel plugin model, Claude Code reads messages from the MCP server
    // and calls tools to respond. The message is made available via server notification.
    try {
      await server.server.sendLoggingMessage({
        level: 'info',
        logger: 'lark-channel',
        data: {
          type: 'incoming_message',
          chatId: message.chatId,
          senderId: message.senderId,
          text: message.text,
          messageId: message.messageId,
          chatType: message.chatType,
          parentContent: message.parentContent,
          attachments: message.attachments,
        },
      });
    } catch (err) {
      console.error('[channel] Failed to send logging message:', err);
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
