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
echo "=== Card builder unit checks ==="
npx tsx scripts/card-smoke.ts

echo ""
echo "=== Job store unit checks ==="
npx tsx scripts/job-smoke.ts

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
echo "=== Transparency unit checks ==="
npx tsx scripts/transparency-smoke.ts

echo ""
echo "All tests passed."
