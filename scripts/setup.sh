#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# OpenHub — Setup Script
# ──────────────────────────────────────────────────────────────────────────────
# Ce script configure tout le nécessaire pour faire fonctionner OpenHub :
#   1. Vérifie/mét à jour les dépendances système (Node.js, pnpm)
#   2. Installe le binaire opencode CLI
#   3. Clone les 3 apps upstream (openwork, opencode, open-design)
#   4. Crée les fichiers de configuration externes (~/.config/opencode/, etc.)
#   5. Installe les dépendances npm du projet
#   6. Copie les assets de build
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATES="$ROOT/config/templates"
APPS_DIR="$ROOT/apps"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $*"; }
error() { echo -e "${RED}[setup]${NC} $*"; }

# ──────────────────────────────────────────────────────────────────────────────
# 1. Vérifications système
# ──────────────────────────────────────────────────────────────────────────────
info "=== Vérification des prérequis ==="

NODE_MIN=22
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt "$NODE_MIN" ]; then
    error "Node.js >= $NODE_MIN requis (actuel: $(node -v))"
    error "Utilise fnm (https://github.com/Schniz/fnm) ou Volta pour installer une version récente."
    exit 1
  fi
  info "Node.js $(node -v) ✓"
else
  error "Node.js introuvable — installe-le via https://nodejs.org ou fnm"
  exit 1
fi

if ! command -v git &>/dev/null; then
  error "Git introuvable — installe-le via 'brew install git' ou https://git-scm.com"
  exit 1
fi
info "Git $(git --version | head -1) ✓"

if ! command -v pnpm &>/dev/null; then
  warn "pnpm introuvable — installation globale..."
  npm install -g pnpm
fi
info "pnpm $(pnpm --version) ✓"

# ──────────────────────────────────────────────────────────────────────────────
# 2. Installation du binaire opencode CLI
# ──────────────────────────────────────────────────────────────────────────────
info "=== OpenCode CLI ==="
if command -v opencode &>/dev/null; then
  info "opencode déjà installé: $(opencode --version 2>/dev/null || echo 'présent') ✓"
else
  warn "Installation de opencode CLI..."
  curl -fsSL https://opencode.ai/install | bash
  info "opencode CLI installé ✓"
fi

# ──────────────────────────────────────────────────────────────────────────────
# 3. Clonage des apps upstream
# ──────────────────────────────────────────────────────────────────────────────
info "=== Apps upstream ==="
mkdir -p "$APPS_DIR"

clone_or_pull() {
  local name="$1" repo="$2" branch="${3:-main}"
  local dir="$APPS_DIR/$name"
  if [ -d "$dir/.git" ]; then
    info "$name déjà cloné — mise à jour..."
    (cd "$dir" && git fetch origin && git pull --rebase origin "$branch" 2>/dev/null || true)
  else
    info "Clonage de $name (branch: $branch)..."
    git clone --branch "$branch" "$repo" "$dir"
  fi
}

clone_or_pull "openwork" "https://github.com/different-ai/openwork.git" "dev"
clone_or_pull "opencode" "https://github.com/sst/opencode.git"
clone_or_pull "open-design" "https://github.com/nexu-io/open-design.git"

info "Installation des dépendances des apps upstream..."

# openwork
if [ -f "$APPS_DIR/openwork/package.json" ]; then
  (cd "$APPS_DIR/openwork" && pnpm install 2>/dev/null || warn "openwork: pnpm install a des warnings (non-bloquant)")
fi

# opencode
if [ -f "$APPS_DIR/opencode/package.json" ]; then
  (cd "$APPS_DIR/opencode" && npm install 2>/dev/null || warn "opencode: npm install a des warnings (non-bloquant)")
fi

# open-design (nécessite Node 24 — essaie fnm/volta)
if [ -f "$APPS_DIR/open-design/package.json" ]; then
  if command -v fnm &>/dev/null; then
    fnm exec --using=24 pnpm install --dir "$APPS_DIR/open-design" 2>/dev/null || \
      warn "open-design: fnm a échoué, essaie pnpm direct..."
  fi
  if command -v volta &>/dev/null; then
    volta run --node 24 pnpm install --dir "$APPS_DIR/open-design" 2>/dev/null || true
  else
    (cd "$APPS_DIR/open-design" && pnpm install 2>/dev/null || warn "open-design: pnpm install a échoué (Node 24 requis)" )
  fi
fi

# ──────────────────────────────────────────────────────────────────────────────
# 4. Création des fichiers de configuration externes
# ──────────────────────────────────────────────────────────────────────────────
info "=== Configuration externe ==="

# 4a. ~/.config/opencode/opencode.json
OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"
if [ ! -f "$OPENCODE_CONFIG" ]; then
  warn "Création de $OPENCODE_CONFIG..."
  mkdir -p "$(dirname "$OPENCODE_CONFIG")"
  # Générer un token proxy aléatoire si le template contient le placeholder
  if [ -f "$TEMPLATES/opencode.json" ]; then
    PROXY_TOKEN=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    sed "s/__PROXY_TOKEN__/$PROXY_TOKEN/g" "$TEMPLATES/opencode.json" > "$OPENCODE_CONFIG"
    info "  → Token proxy généré: ${PROXY_TOKEN:0:16}... (conservé dans $OPENCODE_CONFIG)"
  fi
else
  info "$OPENCODE_CONFIG existe déjà ✓"
fi

# 4b. ~/.config/openhub/settings.json
OPENHUB_CONFIG_DIR="$HOME/.config/openhub"
mkdir -p "$OPENHUB_CONFIG_DIR"

install_template() {
  local src="$TEMPLATES/$1" dst="$OPENHUB_CONFIG_DIR/$2"
  if [ ! -f "$dst" ]; then
    warn "Création de $dst..."
    cp "$src" "$dst"
  else
    info "$dst existe déjà ✓"
  fi
}

install_template "openhub-settings.json" "settings.json"
install_template "openhub-projects.json" "projects.json"
install_template "openhub-memory.json" "memory.json"

# 4c. ~/.config/opencode/openhub-selected-models.json
if [ -f "$TEMPLATES/selected-models.json" ] && [ ! -f "$HOME/.config/opencode/openhub-selected-models.json" ]; then
  warn "Création de openhub-selected-models.json..."
  cp "$TEMPLATES/selected-models.json" "$HOME/.config/opencode/openhub-selected-models.json"
fi

info "Configuration externe OK ✓"

# 4d. ~/.config/openhub/cache-metrics.json (fichier vide au départ)
if [ ! -f "$OPENHUB_CONFIG_DIR/cache-metrics.json" ]; then
  echo '{"entries":[],"totalTokens":0,"totalCalls":0}' > "$OPENHUB_CONFIG_DIR/cache-metrics.json"
fi

# 4e. AGENT-MEMORY.md à la racine du projet (si absent)
if [ ! -f "$ROOT/AGENT-MEMORY.md" ]; then
  warn "Création de AGENT-MEMORY.md..."
  cp "$TEMPLATES/AGENT-MEMORY.md" "$ROOT/AGENT-MEMORY.md"
fi

# 4f. MEMORY-SYSTEM.md à la racine du projet (si absent)
if [ ! -f "$ROOT/MEMORY-SYSTEM.md" ]; then
  warn "Création de MEMORY-SYSTEM.md..."
  cp "$TEMPLATES/MEMORY-SYSTEM.md" "$ROOT/MEMORY-SYSTEM.md"
fi

info "Configuration externe OK ✓"

# ──────────────────────────────────────────────────────────────────────────────
# 5. Dépendances du projet OpenHub lui-même
# ──────────────────────────────────────────────────────────────────────────────
info "=== Dépendances OpenHub ==="
if [ -f "$ROOT/package.json" ]; then
  if [ -d "$ROOT/node_modules" ]; then
    info "node_modules déjà présent — vérification rapide..."
    # Juste vérifier que les dépendances critiques sont là
    if [ ! -d "$ROOT/node_modules/express" ] || [ ! -d "$ROOT/node_modules/keytar" ]; then
      warn "Dépendances manquantes — réinstallation..."
      cd "$ROOT" && npm install
    fi
  else
    info "Installation des dépendances npm..."
    cd "$ROOT" && npm install
  fi
  info "Dépendances OK ✓"
fi

# ──────────────────────────────────────────────────────────────────────────────
# 6. Compilation TypeScript + copie des assets
# ──────────────────────────────────────────────────────────────────────────────
info "=== Build initial ==="
cd "$ROOT"
npx tsc 2>/dev/null && bash scripts/copy-assets.sh && info "Build OK ✓" || warn "Build partiel (les erreurs TypeScript peuvent être ignorées au premier lancement)"

# ──────────────────────────────────────────────────────────────────────────────
# Résumé
# ──────────────────────────────────────────────────────────────────────────────
echo ""
info "═══════════════════════════════════════════════════════════════════════"
info "  Setup terminé !"
info ""
info "  Pour la première utilisation :"
info "    1. Lance l'app :  npm run dev"
info "    2. Ouvre le panneau Config (⚙️  dans la sidebar)"
info "    3. Ajoute tes clés API (Anthropic, OpenAI, OpenRouter...)"
info "       → Elles sont stockées dans le macOS Keychain (sécurisé)"
info ""
info "  Si un slot affiche une page blanche :"
info "    - Vérifie que l'app upstream est bien dans apps/"
info "    - Lance 'bash scripts/setup.sh' à nouveau pour les mises à jour"
info ""
info "  Besoin d'aide ? Voir README.md ou ARCHITECTURE.md"
info "═══════════════════════════════════════════════════════════════════════"
