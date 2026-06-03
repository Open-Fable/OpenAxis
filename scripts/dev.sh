#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Compiling TypeScript (main)..."
npx tsc

echo "Compiling preload (CommonJS)..."
npx tsc -p electron/tsconfig.preload.json

echo "Copying static assets..."
bash scripts/copy-assets.sh

echo "Launching Electron..."
npx electron .
