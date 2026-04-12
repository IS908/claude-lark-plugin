# Message Handling Improvements Design

## Problem

Three gaps in the current message handling pipeline:

1. **Rich media not reaching Claude**: Images, files, audio, video sent from Feishu produce only placeholder text (`[Image]`, `[File: xxx]`). Claude cannot see image content or access file data.
2. **Attachment download unclear**: The `download_attachment` tool exists but the pipeline doesn't guide Claude on when/how to use it. Image downloads may need `im.v1.image.get` instead of `im.v1.messageResource.get`.
3. **No acknowledgement**: Users send a message and see nothing until Claude finishes thinking — no feedback that the message was received.

## Design

### 1. Image Auto-Download

**When**: `messageType === 'image'` or a `post` (rich text) contains embedded image nodes.

**How**: In `handleMessageEvent`, after parsing the message but before enqueuing:

```
if messageType is 'image':
  download via im.v1.image.get(image_key) → save to inbox/{timestamp}-{image_key}.png
  set imagePath on LarkMessage

if messageType is 'post':
  iterate content nodes, find tag === 'img'
  download each image_key → save to inbox/
  set imagePaths[] on LarkMessage
```

**Notification meta**: Add `image_path` (single image) or `image_paths` (multiple from rich text) to the channel notification. Claude reads the local file via the `Read` tool.

**Inbox location**: `~/.claude/channels/lark/inbox/` (already defined in `appConfig.inboxDir`).

**Cleanup**: No auto-cleanup in this iteration. Files accumulate in inbox. Future work can add TTL-based cleanup.

### 2. Non-Image Attachment Meta

**Current gap**: Only the first attachment is passed in notification meta.

**Fix**: Pass all attachments. The notification meta changes from flat fields to an `attachments` array when there are multiple:

Single attachment (backward compatible):
```json
{
  "attachment_kind": "file",
  "attachment_file_id": "xxx",
  "attachment_name": "report.pdf",
  "attachment_size": "1234"
}
```

Multiple attachments:
```json
{
  "attachments": [
    { "kind": "file", "file_id": "xxx", "name": "report.pdf" },
    { "kind": "audio", "file_id": "yyy" }
  ]
}
```

**Claude workflow**: See attachment meta in `<channel>` tag → call `download_attachment(message_id, file_key)` → `Read` the returned path.

**`download_attachment` fix**: The current implementation uses `im.v1.messageResource.get` for all types. For images, this should use `im.v1.image.get` instead. Add type-aware download logic.

### 3. Ack Reaction on Message Receive

**When**: After the message event is validated (whitelist, mention checks pass), before enqueueing for processing.

**How**: Fire-and-forget call to `im.v1.messageReaction.create` with emoji type `MeMeMe`.

```typescript
// Fire-and-forget — don't block message processing
client.im.v1.messageReaction.create({
  path: { message_id: messageId },
  data: { reaction_type: { emoji_type: 'MeMeMe' } },
}).catch(() => {});
```

**Why fire-and-forget**: The ack is cosmetic. If it fails (permission not granted, rate limit), message processing should continue unaffected.

**Revoke on reply**: After the reply tool sends a response successfully, remove the ack reaction. Implementation:
- Channel maintains a `Map<messageId, reactionId>` for pending acks
- When `reply` tool is called with `reply_to`, look up the reaction and call `im.v1.messageReaction.delete` (fire-and-forget)
- The Map is passed to `registerTools` alongside the conversation buffer

**Configurable**: Add `LARK_ACK_EMOJI` env var (default: `MeMeMe`). Set to empty string to disable.

### 4. Instructions Update

Current instructions don't mention image handling or ack behavior. Update to:

```
Users see Feishu, not this transcript. Use reply to respond; edit_message to update; react for acknowledgements.
Always pass reply_to=message_id so replies thread correctly in Feishu.
If metadata has image_path, Read that file to see the image.
If metadata has attachment_file_id, call download_attachment with message_id and file_key, then Read the path.
Use save_memory for important facts; save_skill for reusable procedures.
```

### 5. Reaction Event Forwarding

**Event**: `im.message.reaction.created_v1` (requires `im:message.reactions:read` permission).

**When**: A user adds an emoji reaction to any message in a chat where the bot is present.

**How**: Register a second event handler in `channel.start()`:

```typescript
eventDispatcher.register({
  'im.message.reaction.created_v1': async (data: any) => {
    // Extract reaction info and forward to Claude
  },
});
```

**Notification**: Forward to Claude via `notifications/claude/channel` with:
- `content`: `(reacted with {emoji_type} to message {message_id})`
- `meta`: `{ chat_id, message_id, user, user_id, reaction_emoji, ts }`

Claude decides whether to respond (react back, reply, or ignore). No automatic behavior.

**Filtering** (independent from message filtering — no @mention check):
1. Ignore reactions from the bot itself (`operator_id === botOpenId`) to prevent loops from ack reactions
2. Only process reactions on bot's own messages — maintain a capped `Set<messageId>` (max 300, FIFO eviction) of messages sent by the bot (populated in the `reply` tool); ignore reactions on messages not in this set
3. Apply user whitelist (`allowedUserIds`) on operator
4. Apply chat whitelist (`allowedChatIds`) on chat_id

## Files to Change

| File | Changes |
|------|---------|
| `src/channel.ts` | Image auto-download; ack reaction with revoke; reaction event handler; `LarkMessage` add `imagePath`/`imagePaths` |
| `src/index.ts` | Pass `image_path`/`image_paths` and full attachments in notification meta; update instructions |
| `src/tools.ts` | Fix `download_attachment` for image type; revoke ack reaction on reply |
| `src/config.ts` | Add `LARK_ACK_EMOJI` config option |

## Required Permissions

| Permission | Purpose | Status |
|---|---|---|
| `im:message:send_as_bot` | Send messages | Already granted |
| `im:message.reactions:write` | Add emoji reactions (ack) | Already granted |
| `im:message.reactions:read` | Receive reaction events | **Needs to be granted** |
| `im:resource` | Download attachments/images | Already granted |

## Out of Scope

- Streaming/progressive replies (not needed per user decision)
- Inbox auto-cleanup (future work)
- Audio/video transcription
- Interactive card messages (read-only placeholder is sufficient)
