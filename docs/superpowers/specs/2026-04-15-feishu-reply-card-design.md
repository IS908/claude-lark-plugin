# Feishu Reply Card Design

## Context

The current `reply` tool in claude-lark-plugin sends all responses as plain text (`msg_type: 'text'`). Markdown features (headings, code blocks, tables) render as raw characters in Feishu, making long technical responses hard to read. The `happyclaw` project has mature card rendering (`feishu-streaming-card.ts`, 2234 lines), but most of its features (streaming typewriter, interrupt button, auxiliary state) require Happyclaw's own agent loop and don't apply to MCP plugins where the reply text arrives atomically.

This spec covers porting the **card rendering** pieces from happyclaw — markdown optimization, title extraction, code-block-safe splitting, and Schema 2.0 card assembly — without the streaming machinery. The goal is making long / markdown-rich replies render beautifully as Feishu cards while preserving the current fast plain-text path for short replies.

## Design

### Trigger Strategy — Hybrid

The `reply` tool accepts an optional `format` parameter:

- `format` omitted → **heuristic auto-detection**
- `format: 'card'` → always render as card
- `format: 'text'` → always render as plain text (current behavior)

**Heuristic rule** (`shouldUseCard`):

```typescript
const MD_PATTERNS = [
  /^#{1,6}\s+/m,        // headings
  /```[\s\S]*```/,      // code blocks
  /^\|.+\|$/m,          // tables
  /^\s*[-*+]\s+/m,      // bulleted lists
  /\*\*[^*]+\*\*/,      // bold
];

function shouldUseCard(text: string): boolean {
  if (text.length > 500) return true;
  return MD_PATTERNS.some((re) => re.test(text));
}
```

### Card Format — Schema 2.0 (CardKit)

```json
{
  "schema": "2.0",
  "config": {
    "wide_screen_mode": true,
    "summary": { "content": "<title>" }
  },
  "header": {
    "title": { "tag": "plain_text", "content": "<title>" },
    "template": "wathet"
  },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "<chunk 1>" },
      { "tag": "markdown", "content": "<chunk 2>" },
      ...
      { "tag": "markdown", "content": "<footer>", "text_size": "notation" }
    ]
  }
}
```

- **Header template**: fixed `wathet` (light blue)
- **Title**: extracted from first `#`/`##` heading; fallback to first non-empty line truncated at 40 chars
- **Footer**: only appended when Claude passes the optional `footer` parameter

### Markdown Optimization

Port `optimizeMarkdownStyle` from `happyclaw/src/feishu-markdown-style.ts` unchanged:

- Heading demotion: H1→H4, H2~H6→H5 (card headings render too large otherwise)
- Code block protection during processing
- `<br>` padding around tables and between consecutive headings
- Blank line compression (3+ → 2)
- Strip invalid image references (only `img_xxx` keys are valid in Feishu card markdown)

### Text Splitting — Code-Block-Safe

Port `splitCodeBlockSafe` from `happyclaw`. Splits long text at paragraph/line boundaries but never truncates inside a fenced code block without closing and reopening the fence with its language tag.

Used with `CARD_MD_LIMIT = 4000` (per-markdown-element character limit).

### Multi-Card Splitting

If the full card exceeds Feishu's limits, split into multiple cards:

- **Per-element char limit**: 4000
- **Per-card element count limit**: 45
- **Per-card total size limit**: 25 KB (safety margin under Feishu's ~30 KB)

Each card is sent as a separate Feishu message. First card can still be a quoted reply via `message.reply`; subsequent cards use `message.create`.

### Files to Modify

| File | Change |
|------|--------|
| `src/feishu-card.ts` | **NEW** — card builder module |
| `src/tools.ts` | Add `format` and `footer` params to reply tool; dispatch to card or text path |
| `src/index.ts` | Add one line to instructions explaining card auto-detection |

### Module: `src/feishu-card.ts`

**Exports**:
```typescript
export function shouldUseCard(text: string): boolean;
export function buildCards(
  text: string,
  opts?: { footer?: string }
): object[];
```

**Internal helpers**:
- `optimizeMarkdownStyle(text, cardVersion = 2)` — markdown preprocessor (ported from happyclaw)
- `extractTitleAndBody(text)` — returns `{ title, body }`
- `splitCodeBlockSafe(text, maxLen)` — returns string chunks
- `buildCardContent(text, opts)` — returns content elements for a single card
- `buildSchema2Card(elements, title)` — assembles final card JSON

### Module: `src/tools.ts` Changes

Schema additions to `reply` tool:
```typescript
format: z.enum(['text', 'card']).optional()
  .describe('Output format. Omit for heuristic auto-detection based on content.'),
footer: z.string().optional()
  .describe('Optional small footnote displayed at the bottom of the card. Ignored when sending as plain text.'),
```

Handler dispatch:
```typescript
const useCard = format === 'card' || (format !== 'text' && shouldUseCard(text));

if (useCard) {
  const cards = buildCards(text, { footer });
  for (let i = 0; i < cards.length; i++) {
    const content = JSON.stringify(cards[i]);
    let resp: any;
    if (i === 0 && effectiveReplyTo) {
      resp = await client.im.v1.message.reply({
        path: { message_id: effectiveReplyTo },
        data: { content, msg_type: 'interactive' },
      });
    } else {
      resp = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chat_id, content, msg_type: 'interactive' },
      });
    }
    const sentId = resp?.data?.message_id;
    if (sentId && botMessageTracker) botMessageTracker.add(sentId);
  }
  // Skip the existing text chunking loop
} else {
  // Existing plain-text path — unchanged
}
```

Buffer recording and ack revoke logic run after the branch completes (unchanged).

### Module: `src/index.ts` Instructions

Add one line to the existing instructions array:

```
Long replies with headings, code blocks, or tables render as a Feishu card automatically. Pass format='card' to force, format='text' to force plain. Optionally pass footer for a small footnote at the card bottom.
```

## Error Handling

- `buildCards` wraps `optimizeMarkdownStyle` in try/catch — fallback returns the original text unmodified
- If `im.v1.message.create` fails with an error for a card chunk, surface the same Feishu API error detail as the text path (via existing `apiError?.code && apiError?.msg` handling)
- If a card exceeds size limits even after splitting (single huge code block), the final chunk is hard-truncated with a `...` suffix rather than throwing

## Out of Scope

- Streaming typewriter (requires Claude Agent SDK streaming; MCP model delivers complete text atomically)
- Interrupt button (only meaningful with streaming)
- Auxiliary state rendering (thinking, tool calls, todo list)
- Embedding downloaded/inline images inside card bodies (images continue to flow as separate messages via `files` parameter)
- Card action buttons / interactivity

## Verification

1. `npx tsc --noEmit` — typecheck passes
2. `npm test` — smoke tests pass (typecheck + dry-run + stdout clean)
3. **Unit-style check in scripts/test.sh**: call `shouldUseCard` and `buildCards` with fixture inputs (short text, long text, code block, table, oversize text) and assert no exceptions and reasonable output shapes
4. **Manual end-to-end in Feishu**:
   - Short reply "hello" → plain text
   - Reply with `#` heading and code block → single card rendering correctly
   - Reply > 25 KB → multiple cards in sequence
   - Reply with `format: 'text'` on a markdown message → plain text (override works)
   - Reply with `footer: '...'` → footer appears at card bottom as small text
