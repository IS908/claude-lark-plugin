#!/usr/bin/env bash
set -euo pipefail

echo "=== TypeScript typecheck ==="
npx tsc --noEmit
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
echo "=== Path-traversal defense unit checks ==="
npx tsx scripts/path-traversal-smoke.ts

echo ""
echo "=== <at> tag sanitization unit checks ==="
npx tsx scripts/at-tag-sanitization-smoke.ts

echo ""
echo "=== Enrichment envelope unit checks ==="
npx tsx scripts/enrichment-envelope-smoke.ts

echo ""
echo "All tests passed."
