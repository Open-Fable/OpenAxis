#!/usr/bin/env bash
set -euo pipefail

APPS_DIR="$(cd "$(dirname "$0")/.." && pwd)/apps"

echo "=== OpenHub Setup ==="

# --- Ensure pnpm is available ---
if ! command -v pnpm &>/dev/null; then
  echo "pnpm not found — installing globally via npm..."
  npm install -g pnpm
fi
echo "pnpm: $(pnpm --version)"

# --- Ensure opencode CLI is installed ---
if ! command -v opencode &>/dev/null; then
  echo "opencode CLI not found — installing via npm..."
  npm install -g opencode-ai@latest
fi
echo "opencode: $(opencode --version 2>/dev/null || echo 'installed')"

echo ""
echo "Cloning upstream repos into $APPS_DIR..."

# OpenWork (branch: dev — that's where the pnpm dev:ui command lives)
if [ ! -d "$APPS_DIR/openwork" ]; then
  echo "Cloning openwork (branch: dev)..."
  git clone --branch dev https://github.com/different-ai/openwork.git "$APPS_DIR/openwork"
  cd "$APPS_DIR/openwork" && pnpm install
else
  echo "openwork already cloned — skipping."
fi

# OpenCode (global CLI is used; repo kept for reference only)
if [ ! -d "$APPS_DIR/opencode" ]; then
  echo "Cloning opencode (for reference)..."
  git clone https://github.com/sst/opencode.git "$APPS_DIR/opencode"
else
  echo "opencode already cloned — skipping."
fi

# Open Design (requires Node 24 — use fnm or volta if available)
if [ ! -d "$APPS_DIR/open-design" ]; then
  echo "Cloning open-design..."
  git clone https://github.com/nexu-io/open-design.git "$APPS_DIR/open-design"
  cd "$APPS_DIR/open-design"
  if command -v fnm &>/dev/null; then
    echo "Using fnm for Node 24..."
    fnm install 24 2>/dev/null || true
    fnm exec --using=24 pnpm install
  elif command -v volta &>/dev/null; then
    echo "Using volta for Node 24..."
    volta run --node 24 pnpm install
  else
    echo "WARNING: open-design needs Node 24 (current: $(node -v))."
    echo "Install fnm (https://github.com/Schniz/fnm) for automatic version switching."
    pnpm install
  fi
else
  echo "open-design already cloned — skipping."
fi

echo ""
echo "=== Setup complete ==="
echo "Run 'npm run dev' to start OpenHub."
