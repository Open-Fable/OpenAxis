# OpenHub

Super-Hub desktop macOS qui réunit plusieurs outils IA open-source dans une
interface unique inspirée de l'app native Claude macOS.

## Concept

Une seule fenêtre, une sidebar à icônes, 3 espaces de travail :

| Slot | App | Description |
|------|-----|-------------|
| **Work** | [OpenWork](https://github.com/different-ai/openwork) | Orchestration et coworking IA |
| **Code** | [OpenCode](https://github.com/anomalyco/opencode) | Agent de code IA |
| **Design** | [Open Design](https://github.com/nexu-io/open-design) | Design visuel assisté par IA |

Chaque app garde son code source **intact**. Toute personnalisation passe par
injection CSS/JS depuis le wrapper Electron.

## Prérequis

- macOS 13+
- Node.js 24+ (via fnm ou Volta)
- pnpm 10+
- Git

## Installation

```bash
git clone <repo-url> OpenHub
cd OpenHub
npm install
bash scripts/setup.sh   # Clone les 3 apps + installe leurs deps
```

## Développement

```bash
npm run dev      # Lance Electron + les 3 serveurs locaux
```

## Mise à jour des apps upstream

```bash
npm run update:apps      # git pull + rebuild chaque app
npm run check:selectors  # Vérifie que les overrides CSS ciblent encore les bons éléments
```

## Architecture

Voir [ARCHITECTURE.md](./ARCHITECTURE.md) pour la spec complète.

```
OpenHub/
├── electron/           # Shell Electron (main, preload, proxy, process-manager)
│   ├── overrides/      # CSS/JS injectés par app (ne touche jamais le source)
│   └── settings/       # Panel de configuration central
├── apps/               # Les 3 dépôts upstream (clonés, jamais modifiés)
│   ├── openwork/
│   ├── opencode/
│   └── open-design/
└── scripts/            # Utilitaires (setup, update, vérification)
```

## Sécurité

- Les secrets vivent dans le **macOS Keychain**, jamais sur disque.
- Le proxy LLM tourne sur `127.0.0.1:9999` avec authentification Bearer.
- Les WebViews sont sandboxées (`contextIsolation`, `sandbox`, pas de `nodeIntegration`).

## Licence

MIT
