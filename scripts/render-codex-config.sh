#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_FILE="$ROOT_DIR/config.example.toml"
OUTPUT_FILE=""

usage() {
  echo "Usage: bash scripts/render-codex-config.sh [--output ./promptit.codex.toml]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT_FILE="${2:-}"
      if [[ -z "$OUTPUT_FILE" ]]; then
        echo "Error: --output requires a file path." >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "Error: config.example.toml not found at: $SOURCE_FILE" >&2
  exit 1
fi

RENDERED="$(sed "s|/YOUR/ABSOLUTE/PATH|$ROOT_DIR|g" "$SOURCE_FILE")"

if [[ -n "$OUTPUT_FILE" ]]; then
  mkdir -p "$(dirname "$OUTPUT_FILE")"
  printf "%s\n" "$RENDERED" > "$OUTPUT_FILE"
  echo "Wrote rendered PromptIT Codex config snippet to: $OUTPUT_FILE"
else
  printf "%s\n" "$RENDERED"
fi
