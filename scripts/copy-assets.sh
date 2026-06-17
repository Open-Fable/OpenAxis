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
cp "$ROOT/electron/update-toast.html" "$ROOT/dist/electron/update-toast.html"

# View scripts externalized from inline <script> (CSP: script-src 'self')
cp "$ROOT/electron/sidebar-ui.js" "$ROOT/dist/electron/sidebar-ui.js"
cp "$ROOT/electron/chat.js" "$ROOT/dist/electron/chat.js"
cp "$ROOT/electron/nav-popup.js" "$ROOT/dist/electron/nav-popup.js"
cp "$ROOT/electron/onboarding.js" "$ROOT/dist/electron/onboarding.js"
cp "$ROOT/electron/onboarding.css" "$ROOT/dist/electron/onboarding.css"

rm -rf "$ROOT/dist/electron/i18n"
cp -r "$ROOT/electron/i18n" "$ROOT/dist/electron/i18n"

rm -rf "$ROOT/dist/electron/shared"
cp -r "$ROOT/electron/shared" "$ROOT/dist/electron/shared"

rm -rf "$ROOT/dist/electron/projects"
cp -r "$ROOT/electron/projects" "$ROOT/dist/electron/projects"

rm -rf "$ROOT/dist/electron/overrides"
cp -r "$ROOT/electron/overrides" "$ROOT/dist/electron/overrides"

if [ -d "$ROOT/electron/settings" ]; then
  rm -rf "$ROOT/dist/electron/settings"
  cp -r "$ROOT/electron/settings" "$ROOT/dist/electron/settings"
fi

echo "Assets copied to dist/electron/"
