# OpenHub

Super-Hub desktop macOS qui réunit plusieurs outils IA open-source dans une
interface unique inspirée de l'app native Claude macOS.

## Concept

Une seule fenêtre, une sidebar à icônes, 3 espaces de travail :

| Slot | App | Description |
|------|-----|-------------|
| **Work** | [OpenWork](https://github.com/different-ai/openwork) | Orchestration et coworking IA |
| **Code** | [OpenCode](https://github.com/sst/opencode) | Agent de code IA |
| **Design** | [Open Design](https://github.com/nexu-io/open-design) | Design visuel assisté par IA |

Chaque app garde son code source **intact**. Toute personnalisation passe par
injection CSS/JS depuis le wrapper Electron.

## Prérequis

- **macOS 14+** (Apple Silicon ou Intel)
- **Node.js 22+** (recommandé : via [fnm](https://github.com/Schniz/fnm))
- **pnpm 10+** (installé automatiquement si absent)
- **Git**
- **Clés API** (au moins un provider : Anthropic, OpenAI, OpenRouter, ou
  Google Gemini avec `opencode auth login`)

## Installation

```bash
git clone https://github.com/1zalt/OpenHub.git
cd OpenHub
bash scripts/setup.sh
npm run dev
```

`scripts/setup.sh` s'occupe de **tout** :
- Installe les dépendances (pnpm, opencode CLI)
- Clone les 3 apps upstream dans `apps/`
- Crée les fichiers de configuration dans `~/.config/`
- Compile le TypeScript et copie les assets

### Après le premier lancement

1. Ouvre le panneau **Config** (⚙️ dans la sidebar)
2. Ajoute tes clés API (Anchropique, OpenAI, OpenRouter, Google AI, Brave Search)
   → stockées dans le **macOS Keychain** (jamais sur disque)
3. Configure les modèles souhaités

### Si tu viens de cloner le projet

Le binaire `opencode` CLI est requis. Le setup script l'installe automatiquement,
mais tu peux aussi le faire manuellement :

```bash
curl -fsSL https://opencode.ai/install | bash
```

Tu auras aussi besoin d'authentifier Google Gemini pour les modèles direct :

```bash
opencode auth login
```

## Développement

```bash
npm run dev              # Lance Electron + les serveurs locaux
npm run build            # Compile + package l'app
npm run typecheck        # Vérification TypeScript
npm run lint             # ESLint
npm run format           # Prettier
npm test                 # Tests unitaires
```

## Structure du projet

```
OpenHub/
├── electron/            # Shell Electron (main, preload, proxy, process-manager)
│   ├── overrides/       # CSS/JS injectés par app (ne touche jamais le source)
│   └── proxy/           # Serveur proxy LLM (Express, routage multi-provider)
├── apps/                # Les 3 dépôts upstream (clonés, jamais modifiés)
│   ├── openwork/
│   ├── opencode/
│   └── open-design/
├── config/templates/    # Templates de configuration (utilisés par setup.sh)
├── scripts/             # Utilitaires (setup, update, build)
└── graphify-out/        # Graphe de connaissance du codebase (régénéré à la demande)
```

## Fichiers de configuration externes

L'application utilise des fichiers en dehors du dépôt pour les données runtime :

| Emplacement | Usage | Auto-créé ? |
|------------|-------|-------------|
| `~/.config/opencode/opencode.json` | Provider LLM, modèles, clés | Oui (par `setup.sh` puis mis à jour par l'app) |
| `~/.config/opencode/openhub-selected-models.json` | Modèles sélectionnés | Oui |
| `~/.config/openhub/settings.json` | Paramètres OpenHub | Oui |
| `~/.config/openhub/projects.json` | Projets sauvegardés | Oui (au premier usage) |
| `~/.config/openhub/memory.json` | Mémoire persistante IA | Oui (au premier usage) |
| `~/.config/openhub/cache-metrics.json` | Métriques de cache LLM | Oui (au premier usage) |
| `~/.opencode/bin/opencode` | Binaire CLI Opencode | Oui (par `setup.sh`) |
| `~/.local/share/opencode/account.json` | Authentification Google OAuth | Après `opencode auth login` |

Les secrets (clés API) ne sont **jamais** écrits sur disque — ils vivent dans le
**macOS Keychain** via `keytar`.

## Sécurité

- Les secrets vivent dans le **macOS Keychain**, jamais sur disque.
- Le proxy LLM tourne sur `127.0.0.1:9999` avec authentification Bearer.
- Les WebViews sont sandboxées (`contextIsolation`, `sandbox`, pas de `nodeIntegration`).

## Mise à jour des apps upstream

```bash
bash scripts/setup.sh    # Tout mettre à jour (apps + configs)
npm run check:selectors  # Vérifier que les overrides CSS ciblent encore les bons éléments
```

## Licence

MIT
