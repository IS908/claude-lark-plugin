#!/usr/bin/env bash
# Surface common documentation drift patterns in the claude-lark-plugin repo.
# Run before pushing security/refactor commits to catch the recurring
# "docs lag code" class flagged 6 times in PR #182.
#
# Exit 0 with no output → clean.
# Exit 1 with itemized output → potential drift to review.

set -euo pipefail
cd "$(dirname "$0")/.."

found=0
report() {
  if [ "$found" -eq 0 ]; then
    echo "Potential doc-surface drift:" >&2
    found=1
  fi
  echo "$@" >&2
}

# 1. LARK_* env vars in source but missing from README env-var tables.
src_envs=$(grep -hoE 'LARK_[A-Z_]+' src/config.ts | sort -u)
for env in $src_envs; do
  if ! grep -q "$env" README.md 2>/dev/null; then
    report "  - env $env present in src/config.ts but missing from README.md"
  fi
  if ! grep -q "$env" README_CN.md 2>/dev/null; then
    report "  - env $env present in src/config.ts but missing from README_CN.md"
  fi
done

# 2. Stale setCaller(..., undefined, ...) prose in docs (round-4 invariant)
for f in CHANGELOG.md CLAUDE.md README.md README_CN.md; do
  if grep -q 'setCaller("doc:[^"]*", undefined' "$f" 2>/dev/null; then
    report "  - $f mentions setCaller(\"doc:...\", undefined, ...) — illegal post-N5 throw"
  fi
done

# 3. __terminal__ in tool descriptions that explicitly reject terminal context
if grep -q '__terminal__' src/tools.ts 2>/dev/null; then
  # Allowed in code logic, but NOT in z.string().describe(...) for reply_doc_comment / create_doc_comment
  if grep -B 2 'reply_doc_comment\|create_doc_comment' src/tools.ts | grep -q '__terminal__'; then
    report "  - src/tools.ts: __terminal__ appears near reply_doc_comment / create_doc_comment description (these tools reject terminal context)"
  fi
fi

# 4. Smoke case counts in CHANGELOG that don't match actual count
for smoke in scripts/comment-event-smoke.ts scripts/identity-smoke.ts scripts/reply-doc-comment-smoke.ts scripts/comment-elements-smoke.ts; do
  if [ ! -f "$smoke" ]; then continue; fi
  # Count numbered case blocks: lines matching `^// \d+[a-z]?\.`
  actual=$(grep -cE '^// [0-9]+[a-z]?\.' "$smoke" 2>/dev/null || echo 0)
  basename=$(basename "$smoke")
  # Extract claimed counts from CHANGELOG.md for this smoke file
  claimed=$(grep -oE "scripts/$basename \([0-9]+ cases" CHANGELOG.md 2>/dev/null | grep -oE '[0-9]+' | sort -un | head -1 || echo "")
  if [ -n "$claimed" ] && [ "$claimed" != "$actual" ]; then
    report "  - CHANGELOG.md claims $basename has $claimed cases but actual is $actual"
  fi
done

if [ "$found" -eq 1 ]; then
  echo >&2
  echo "Review the items above before pushing. Some may be intentional (e.g.," >&2
  echo "historical references in older CHANGELOG entries) — adjust accordingly." >&2
  exit 1
fi

echo "doc-surface check: clean"
exit 0
