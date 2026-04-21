#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_FILE="$ROOT_DIR/claude-code.config.json"
TARGET_FILE="${HOME}/.claude/mcp.json"
PRINT_ONLY="0"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET_FILE="${2:-}"
      if [[ -z "$TARGET_FILE" ]]; then
        echo "Error: --target requires a file path." >&2
        exit 1
      fi
      shift 2
      ;;
    --print)
      PRINT_ONLY="1"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: bash scripts/setup-claude-code-config.sh [--target /path/to/mcp.json] [--print]" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "Error: claude-code.config.json not found at: $SOURCE_FILE" >&2
  exit 1
fi

RENDERED="$(sed "s|/YOUR/ABSOLUTE/PATH|$ROOT_DIR|g" "$SOURCE_FILE")"

if [[ "$PRINT_ONLY" == "1" ]]; then
  echo "$RENDERED"
  exit 0
fi

mkdir -p "$(dirname "$TARGET_FILE")"

if [[ -f "$TARGET_FILE" ]]; then
  BACKUP_FILE="${TARGET_FILE}.backup-${TIMESTAMP}"
  cp "$TARGET_FILE" "$BACKUP_FILE"
  echo "Backed up existing config to: $BACKUP_FILE"
fi

printf "%s\n" "$RENDERED" > "$TARGET_FILE"

echo "Wrote Claude Code MCP config to: $TARGET_FILE"
echo "Next step: restart Claude Code so MCP config reloads."
