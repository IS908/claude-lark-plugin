#!/usr/bin/env bash
set -euo pipefail

# Load env
ENV_FILE="${HOME}/.claude/channels/lark/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

echo >&2 "Starting claude-lark-plugin..."
echo >&2 "  App ID: ${LARK_APP_ID:-<not set>}"
echo >&2 "  Memory: ${MEMORY_PROVIDER:-file}"

exec claude --dangerously-load-development-channels "plugin:lark@claude-lark-plugin" --dangerously-skip-permissions
