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

echo "Starting claude-lark-plugin..."
echo "  App ID: ${LARK_APP_ID:-<not set>}"
echo "  Memory: ${MEMORY_PROVIDER:-file}"
echo "  Skills: ${LARK_ENABLED_SKILLS}"

exec claude --dangerously-load-development-channels "plugin:lark@claude-lark-plugin"
