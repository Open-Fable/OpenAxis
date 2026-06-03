#!/usr/bin/env bash
set -euo pipefail

APPS_DIR="$(cd "$(dirname "$0")/.." && pwd)/apps"

echo "=== Updating upstream apps ==="

for app in openwork opencode open-design; do
  dir="$APPS_DIR/$app"
  if [ -d "$dir" ]; then
    echo ""
    echo "--- Updating $app ---"
    cd "$dir"
    git stash --quiet 2>/dev/null || true
    git pull --rebase origin "$(git rev-parse --abbrev-ref HEAD)"

    if [ -f "pnpm-lock.yaml" ]; then
      pnpm install
    elif [ -f "package-lock.json" ]; then
      npm install
    fi

    echo "$app updated successfully."
  else
    echo "WARNING: $dir not found — run 'npm run setup' first."
  fi
done

echo ""
echo "=== All apps updated ==="
echo "Run 'npm run check:selectors' to verify overrides still work."
