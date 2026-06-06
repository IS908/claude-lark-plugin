#!/usr/bin/env bash
set -euo pipefail

echo "=== TypeScript typecheck ==="
npx tsc --noEmit
echo "PASS"

echo ""
echo "=== npm audit (high+ severity, production deps) ==="
# #94 CI gate: fail red if any HIGH or CRITICAL CVE lands in the
# production dependency tree. Most CVEs come in transitively via
# @larksuiteoapi/node-sdk; the `overrides` block in package.json pins
# each affected transitive to a patched version. A new CVE discovered
# in any production dep after this point fails CI immediately so the
# operator must add a new override (or wait for an SDK upstream bump)
# rather than silently shipping vulnerable code.
#
# `--omit=dev` excludes devDependencies (tsx / typescript / @types/node).
# `--audit-level=high` keeps moderate-level signal in stderr but only
# exits non-zero on high+. Adjust to `moderate` if your deployment
# context requires it.
npm audit --omit=dev --audit-level=high
echo "PASS"

echo ""
echo "=== Dry-run (module loading) ==="
npm run --silent start -- --dry-run 1>/tmp/lark-test-stdout.txt 2>/tmp/lark-test-stderr.txt
echo "PASS"

echo ""
echo "=== MCP stdout clean ==="
if [ -s /tmp/lark-test-stdout.txt ]; then
  echo "FAIL: stdout is not empty"
  cat /tmp/lark-test-stdout.txt
  exit 1
fi
echo "PASS"

echo ""
echo "=== SDK constructors have stderr logger ==="
# Dry-run cannot catch stdout pollution from SDK constructors that only run
# inside channel.start() (e.g. EventDispatcher). Their default logger writes
# to stdout and would corrupt MCP JSON-RPC framing. Enforce statically that
# each `new Lark.<Client|EventDispatcher|WSClient>(` in src/channel.ts has a
# `logger:` option within the parens of its arg block (depth-tracked scope).
npx tsx scripts/check-sdk-loggers.ts
echo "PASS"

echo ""
echo "=== Card builder unit checks ==="
npx tsx scripts/card-smoke.ts

echo ""
echo "=== Job store unit checks ==="
npx tsx scripts/job-smoke.ts

echo ""
echo "=== Scheduler unit checks ==="
npx tsx scripts/scheduler-smoke.ts

echo ""
echo "=== Reply raw-card unit checks ==="
npx tsx scripts/reply-card-smoke.ts

echo ""
echo "=== Identity session unit checks ==="
npx tsx scripts/identity-smoke.ts

echo ""
echo "=== Privacy rules unit checks ==="
npx tsx scripts/privacy-rules-smoke.ts

echo ""
echo "=== Profile tiering unit checks ==="
npx tsx scripts/profile-tier-smoke.ts

echo ""
echo "=== Profile-tiered (single-call distillation) unit checks ==="
npx tsx scripts/profile-tiered-smoke.ts

echo ""
echo "=== Transparency unit checks ==="
npx tsx scripts/transparency-smoke.ts

echo ""
echo "=== Mention resolver unit checks ==="
npx tsx scripts/mention-resolver-smoke.ts

echo ""
echo "=== Reply thread-routing unit checks ==="
npx tsx scripts/reply-thread-smoke.ts

echo ""
echo "=== Download attachment unit checks ==="
npx tsx scripts/download-attachment-smoke.ts

echo ""
echo "=== Auto-flush caller binding unit checks ==="
npx tsx scripts/auto-flush-smoke.ts

echo ""
echo "=== Skill ownership unit checks ==="
npx tsx scripts/skill-ownership-smoke.ts

echo ""
echo "=== Single-instance lock unit checks ==="
npx tsx scripts/lock-smoke.ts

echo ""
echo "=== Bot @-mention fail-safe unit checks ==="
npx tsx scripts/bot-mention-failsafe-smoke.ts

echo ""
echo "=== Path-traversal defense unit checks ==="
npx tsx scripts/path-traversal-smoke.ts

echo ""
echo "=== <at> tag sanitization unit checks ==="
npx tsx scripts/at-tag-sanitization-smoke.ts

echo ""
echo "=== Enrichment envelope unit checks ==="
npx tsx scripts/enrichment-envelope-smoke.ts

echo ""
echo "=== Reaction event whitelist + identity unit checks ==="
npx tsx scripts/reaction-event-smoke.ts

echo ""
echo "=== Profile TOCTOU mutex unit checks ==="
npx tsx scripts/profile-toctou-smoke.ts

echo ""
echo "=== Inbox GC unit checks ==="
npx tsx scripts/inbox-gc-smoke.ts

echo ""
echo "=== TTL cache unit checks ==="
npx tsx scripts/ttl-cache-smoke.ts

echo ""
echo "=== Log rotation unit checks ==="
npx tsx scripts/log-rotation-smoke.ts

echo ""
echo "=== Episode prune unit checks ==="
npx tsx scripts/episode-prune-smoke.ts

echo ""
echo "=== Feishu retry helper unit checks ==="
npx tsx scripts/feishu-retry-smoke.ts

echo ""
echo "=== Buffer hard-cap unit checks ==="
npx tsx scripts/buffer-cap-smoke.ts

echo ""
echo "=== Search precision (word-boundary) unit checks ==="
npx tsx scripts/search-precision-smoke.ts

echo ""
echo "=== Episode cap + empty-keyword unit checks ==="
npx tsx scripts/episode-cap-smoke.ts

echo ""
echo "=== Scheduler race (recycle / divergence / retarget) unit checks ==="
npx tsx scripts/scheduler-race-smoke.ts

echo ""
echo "=== Ack-reaction batch (pending-revoke / react / download) unit checks ==="
npx tsx scripts/ack-reaction-batch-smoke.ts

echo ""
echo "=== Envelope cluster (flush + cronjob prompt wrapping) unit checks ==="
npx tsx scripts/envelope-cluster-smoke.ts

echo ""
echo "=== Prompt-job auto-pause unit checks ==="
npx tsx scripts/prompt-job-auto-pause-smoke.ts

echo ""
echo "=== Stop hook (enforce-lark-reply) end-to-end checks ==="
node hooks/test-enforce-lark-reply.mjs

echo ""
echo "=== Profile distillation Stage 2 orchestrator unit checks ==="
npx tsx scripts/profile-distill-stage2-smoke.ts

echo ""
echo "=== Feishu comment elements unit checks ==="
npx tsx scripts/comment-elements-smoke.ts

echo ""
echo "=== Comment event (drive.notice.comment_add_v1) unit checks ==="
npx tsx scripts/comment-event-smoke.ts

echo ""
echo "=== reply_doc_comment / create_doc_comment tool checks ==="
npx tsx scripts/reply-doc-comment-smoke.ts

echo ""
echo "All tests passed."
