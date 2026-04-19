#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_FILE="$ROOT_DIR/config.example.toml"
CODEX_DIR="${HOME}/.codex"
TARGET_FILE="${CODEX_DIR}/config.toml"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "Error: config.example.toml not found at: $SOURCE_FILE" >&2
  exit 1
fi

mkdir -p "$CODEX_DIR"

if [[ -f "$TARGET_FILE" ]]; then
  BACKUP_FILE="${TARGET_FILE}.backup-${TIMESTAMP}"
  cp "$TARGET_FILE" "$BACKUP_FILE"
  echo "Backed up existing config to: $BACKUP_FILE"
fi

sed "s|/YOUR/ABSOLUTE/PATH|$ROOT_DIR|g" "$SOURCE_FILE" > "$TARGET_FILE"

echo "Wrote Codex config to: $TARGET_FILE"
echo "Next step: restart Codex/Cursor so MCP config reloads."
