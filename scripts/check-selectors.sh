#!/usr/bin/env bash
set -euo pipefail

OVERRIDES_DIR="$(cd "$(dirname "$0")/.." && pwd)/electron/overrides"
ERRORS=0

echo "=== Checking override selectors ==="

for css_file in $(find "$OVERRIDES_DIR" -name "*.css" -not -path "*/global/*"); do
  app_name=$(basename "$(dirname "$css_file")")
  selectors=$(grep -oE '\[data-[a-z-]+[^\]]*\]|#[a-zA-Z][a-zA-Z0-9_-]*|\[role="[^"]*"\]|\[aria-[a-z-]+[^\]]*\]' "$css_file" 2>/dev/null || true)

  if [ -n "$selectors" ]; then
    echo ""
    echo "File: $css_file"
    echo "App: $app_name"
    echo "Selectors found:"
    echo "$selectors" | while read -r sel; do
      echo "  - $sel"
    done
    echo "  (Manual verification needed: start the app and check these exist in DOM)"
  fi
done

if [ "$ERRORS" -eq 0 ]; then
  echo ""
  echo "=== Selector check complete ==="
  echo "No automated errors detected. Verify selectors manually in the running apps."
fi
