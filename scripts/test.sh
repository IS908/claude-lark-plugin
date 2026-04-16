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
echo "All tests passed."
