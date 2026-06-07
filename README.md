# OpenHub

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/platform-macOS-black?logo=apple)](https://www.apple.com/macos)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?logo=node.js)](https://nodejs.org)

**OpenHub** est un hub desktop macOS qui réunit plusieurs outils IA open-source
dans une interface unique, inspirée de l'app native Claude macOS.

Une seule fenêtre, une sidebar à icônes, un proxy LLM central — et ton
environnement de développement IA préféré, unifié.

---

## ✨ Fonctionnalités

| | |
|---|---|
| 🎯 **3 apps en 1** | Bascule entre [OpenWork](https://github.com/different-ai/openwork) (orchestration), [OpenCode](https://github.com/sst/opencode) (agent de code), et [Open Design](https://github.com/nexu-io/open-design) (design visuel) |
| 🔌 **Proxy LLM unifié** | Route les appels vers Anthropic, OpenAI, OpenRouter, Ollama, **et Google Gemini direct** (via OAuth) — sur `127.0.0.1:9999` |
| 🧠 **Mémoire persistante** | L'IA se souvient de ton projet et de tes décisions entre les sessions |
| 💬 **Chat intégré** | Interface de chat avec sélection de modèle, historique, et sauvegarde automatique |
| 📁 **Gestion de projets** | Multiple projets avec instructions personnalisées, colorés, injectés dans le contexte IA |
| 🎨 **Thème unifié** | Override CSS/JS par app pour une expérience visuelle cohérente |
| 🤖 **Orchestrateur multi-agent** | Exécute des workflows complexes avec classification intelligente et routage pro/flash |
| 🏎️ **Cache DeepSeek** | Optimisé pour le prefix caching — jusqu'à 90% d'économie sur les tokens système |
| 🔒 **Sécurisé** | Les clés API dans le **macOS Keychain**, jamais sur disque |

---

## 📸 Aperçu

_(Ajoute ici une capture d'écran de l'application)_

---

## 🚀 Installation

**Prérequis :** macOS 14+, Node.js 22+, Git

```bash
git clone https://github.com/1zalt/OpenHub.git
cd OpenHub
bash scripts/setup.sh
npm run dev
```

Le script `setup.sh` s'occupe de tout automatiquement :
- ✅ Vérifie Node.js, Git, pnpm
- ✅ Installe le binaire `opencode` CLI
- ✅ Clone les 3 apps upstream dans `apps/`
- ✅ Crée les fichiers de configuration dans `~/.config/`
- ✅ Compile le TypeScript et copie les assets

### Après le premier lancement

1. Ouvre le panneau **Config** (⚙️ dans la sidebar)
2. Ajoute tes clés API (Anthropic, OpenAI, OpenRouter, Google AI, Brave Search)
   → Elles sont stockées dans le **macOS Keychain** (sécurisé)
3. Configure les modèles souhaités

> 💡 Pour utiliser les modèles Google Gemini directement (sans passer par OpenRouter),
> exécute `opencode auth login` dans ton terminal.

---

## 🧱 Architecture

```
OpenHub/
├── electron/                # Shell Electron
│   ├── main.ts             # Process principal + IPC handlers
│   ├── preload.ts          # ContextBridge pour les WebViews
│   ├── proxy/
│   │   ├── index.ts        # Proxy LLM Express (Anthropic, OpenAI, OpenRouter, Ollama, Gemini)
│   │   └── vision.ts       # Proxy vision (description d'images par IA)
│   ├── overrides/          # CSS/JS injectés par app (jamais dans le source upstream)
│   ├── memory-store.ts     # Mémoire persistante avec recherche sémantique
│   ├── project-store.ts    # Gestion de projets
│   ├── cache-metrics.ts    # Métriques de cache LLM
│   ├── orchestrator-runner.ts  # Orchestrateur multi-agent
│   ├── ollama-manager.ts   # Gestion des modèles Ollama
│   ├── chat.html           # Interface de chat
│   ├── sidebar.html        # Sidebar + panneau config
│   └── projects.html       # Interface projets
├── apps/                   # Dépôts upstream clonés (gitignorés)
│   ├── openwork/
│   ├── opencode/
│   └── open-design/
├── config/templates/       # Templates de configuration (setup.sh)
└── scripts/                # Utilitaires
```

### 🔄 Flux de données

```
Navigateur WebView (OpenWork / OpenCode / Open Design)
       │
       ├── CSS/JS overrides ←── electron/overrides/
       │
       └── Appels LLM ──→ Proxy :9999 ──→ Anthropic / OpenAI / OpenRouter / Ollama / Gemini
                                │
                                ├── Injection contexte (projet, mémoire, architecture)
                                ├── Compteur de cache
                                └── Extraction mémoire (background)
```

---

## 🔧 Commandes

| Commande | Description |
|----------|-------------|
| `npm run dev` | Lance l'application en mode développement |
| `npm run build` | Compile et package l'application |
| `npm run typecheck` | Vérification TypeScript |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm test` | Tests unitaires (Vitest) |
| `bash scripts/setup.sh` | Setup complet + mise à jour des apps upstream |

---

## 🔐 Sécurité

- **Clés API :** Stockées dans le macOS Keychain via `keytar` — jamais écrites sur disque
- **Proxy LLM :** Tourne sur `127.0.0.1:9999` avec authentification Bearer par session
- **WebViews :** Sandboxées (`contextIsolation`, `sandbox`, pas de `nodeIntegration`)
- **Overrides :** CSS/JS injectés uniquement — le code source upstream n'est jamais modifié

---

## 📁 Fichiers externes

Ces fichiers sont créés automatiquement — pas besoin d'y toucher :

| Emplacement | Usage |
|------------|-------|
| `~/.config/opencode/opencode.json` | Configuration provider LLM |
| `~/.config/openhub/settings.json` | Paramètres OpenHub |
| `~/.config/openhub/memory.json` | Mémoire persistante |
| `~/.config/openhub/projects.json` | Projets sauvegardés |
| `~/.config/openhub/cache-metrics.json` | Métriques de cache |
| `~/.opencode/bin/opencode` | Binaire CLI Opencode |
| `~/.local/share/opencode/account.json` | Auth Google OAuth |

---

## 📄 Licence

MIT — voir [LICENSE](LICENSE).

---

*Construit avec ❤️ pour les développeurs qui veulent garder le contrôle de leurs outils IA.*
