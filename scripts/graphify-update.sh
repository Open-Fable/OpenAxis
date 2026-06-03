#!/usr/bin/env bash
set -euo pipefail

# Daily graphify knowledge graph update (terminal only, no AI)
# Called by cron or session-start hook

cd "$(dirname "$0")/.."

echo "Updating graphify knowledge graph..."

if command -v graphify &> /dev/null; then
  graphify update .
  echo "Graphify updated."
else
  echo "graphify not installed — skipping."
fi
