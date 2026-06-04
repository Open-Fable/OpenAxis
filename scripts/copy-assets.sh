#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cp "$ROOT/electron/sidebar.html" "$ROOT/dist/electron/sidebar.html"
cp "$ROOT/electron/chat.html" "$ROOT/dist/electron/chat.html"

rm -rf "$ROOT/dist/electron/overrides"
cp -r "$ROOT/electron/overrides" "$ROOT/dist/electron/overrides"

if [ -d "$ROOT/electron/settings" ]; then
  rm -rf "$ROOT/dist/electron/settings"
  cp -r "$ROOT/electron/settings" "$ROOT/dist/electron/settings"
fi

echo "Assets copied to dist/electron/"
