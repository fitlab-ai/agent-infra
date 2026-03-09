#!/usr/bin/env bash
# Sync project Codex commands to the global ~/.codex/prompts/ directory.
# Codex CLI reads custom prompts from ~/.codex/prompts/ only; this script
# copies the project-local .codex/commands/*.md files there.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/../commands"
DEST_DIR="$HOME/.codex/prompts"

echo "Codex Prompts install script"
echo "Source:    $SRC_DIR"
echo "Target:    $DEST_DIR"
echo ""

mkdir -p "$DEST_DIR"

if [ ! -d "$SRC_DIR" ]; then
  echo "Error: source directory not found: $SRC_DIR" >&2
  exit 1
fi

if ! ls "$SRC_DIR"/*.md >/dev/null 2>&1; then
  echo "Error: no .md files found in source directory" >&2
  exit 1
fi

FILE_COUNT=$(ls -1 "$SRC_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
echo "Found $FILE_COUNT prompt file(s)"

# check overwrite
OVERWRITE_COUNT=0
for file in "$SRC_DIR"/*.md; do
  filename=$(basename "$file")
  if [ -f "$DEST_DIR/$filename" ]; then
    OVERWRITE_COUNT=$((OVERWRITE_COUNT + 1))
  fi
done

if [ $OVERWRITE_COUNT -gt 0 ]; then
  echo "Will overwrite $OVERWRITE_COUNT existing file(s)"
fi

echo ""
echo "Installing..."
cp -fv "$SRC_DIR"/*.md "$DEST_DIR"/ 2>&1 | sed 's/^/  /'

echo ""
echo "Installed $FILE_COUNT command(s) to $DEST_DIR"
echo ""
echo "Installed commands:"
echo ""

for file in "$DEST_DIR"/*.md; do
  filename=$(basename "$file" .md)
  description=$(grep -m 1 '^description:' "$file" 2>/dev/null | sed 's/^description: *//; s/^"//; s/"$//' || true)

  if [ -n "$description" ]; then
    printf "  /prompts:%-30s - %s\n" "$filename" "$description"
  else
    printf "  /prompts:%s\n" "$filename"
  fi
done | sort

exit 0
