#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load env
ENV_FILE="${HOME}/.claude/channels/lark/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# Default skills to load alongside the plugin
LARK_ENABLED_SKILLS="${LARK_ENABLED_SKILLS:-lark-im,lark-contact,lark-doc,lark-calendar,lark-task}"

# ── Skill filtering: manage symlinks in ~/.claude/skills/ ──
SKILLS_DIR="${HOME}/.claude/skills"
mkdir -p "$SKILLS_DIR"

# Remove existing lark-* symlinks (stale from previous runs)
find "$SKILLS_DIR" -maxdepth 1 -name 'lark-*' -type l -delete 2>/dev/null || true

# Create symlinks for enabled skills only
IFS=',' read -ra SKILLS <<< "$LARK_ENABLED_SKILLS"
for skill in "${SKILLS[@]}"; do
  skill=$(echo "$skill" | xargs)  # trim whitespace
  [ -z "$skill" ] && continue
  # Search for the skill directory in known locations
  src=$(find "${HOME}/.claude" -path "*/larksuite/cli/skills/${skill}" -type d 2>/dev/null | head -1)
  if [ -n "$src" ]; then
    ln -sf "$src" "$SKILLS_DIR/$skill"
    echo >&2 "  Loaded skill: $skill"
  fi
done

echo >&2 "Starting claude-lark-plugin..."
echo >&2 "  App ID: ${LARK_APP_ID:-<not set>}"
echo >&2 "  Memory: ${MEMORY_PROVIDER:-file}"
echo >&2 "  Skills: ${LARK_ENABLED_SKILLS}"

exec claude --dangerously-load-development-channels "plugin:lark@claude-lark-plugin"
