#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Rename preload from .js to .cjs so it's treated as CommonJS (package.json has "type": "module")
if [ -f "$ROOT/dist/electron/preload.js" ]; then
  mv "$ROOT/dist/electron/preload.js" "$ROOT/dist/electron/preload.cjs"
  rm -f "$ROOT/dist/electron/preload.js.map"
fi

cp "$ROOT/electron/sidebar.html" "$ROOT/dist/electron/sidebar.html"
cp "$ROOT/electron/splash.html" "$ROOT/dist/electron/splash.html"
cp "$ROOT/electron/chat.html" "$ROOT/dist/electron/chat.html"
cp "$ROOT/electron/projects.html" "$ROOT/dist/electron/projects.html"
cp "$ROOT/electron/nav-popup.html" "$ROOT/dist/electron/nav-popup.html"

rm -rf "$ROOT/dist/electron/projects"
cp -r "$ROOT/electron/projects" "$ROOT/dist/electron/projects"

rm -rf "$ROOT/dist/electron/overrides"
cp -r "$ROOT/electron/overrides" "$ROOT/dist/electron/overrides"

if [ -d "$ROOT/electron/settings" ]; then
  rm -rf "$ROOT/dist/electron/settings"
  cp -r "$ROOT/electron/settings" "$ROOT/dist/electron/settings"
fi

echo "Assets copied to dist/electron/"
