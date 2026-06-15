<div align="center">

# OpenHub

**Tout ton workflow IA dans une seule fenêtre macOS.**

Un espace de travail IA unifié : un **chat** intégré, un **orchestrateur multi-agents** qui produit de vrais livrables, une **mémoire** persistante, et trois outils open-source intégrés — [OpenWork](https://github.com/different-ai/openwork), [OpenCode](https://github.com/sst/opencode) et [Open Design](https://github.com/nexu-io/open-design) — partageant tous un même proxy LLM local qui route vers n'importe quel provider. Zéro Docker.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/platform-macOS_14+-black?logo=apple)](https://www.apple.com/macos)
[![Electron](https://img.shields.io/badge/Electron-42+-47848F?logo=electron&logoColor=white)](https://www.electronjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![tests](https://img.shields.io/github/actions/workflow/status/1zalt/OpenHub/test.yml?label=tests&style=flat)](https://github.com/1zalt/OpenHub/actions/workflows/test.yml)

[English](README.md) · **Français**

[Installation](#-installation) | [Usage](docs/USAGE.fr.md) | [Orchestrateur](docs/ORCHESTRATOR.fr.md) | [FAQ](docs/FAQ.fr.md) | [Architecture](#-architecture) | [Contribuer](CONTRIBUTING.fr.md)

</div>

---

## Pourquoi OpenHub ?

La plupart des outils IA vivent en silo — fenêtres séparées, clés API séparées, aucun contexte partagé. OpenHub est une seule fenêtre macOS qui relie tout : discuter avec n'importe quel modèle, lancer un orchestrateur multi-agents qui produit de vrais livrables, et basculer entre des outils intégrés de code, de design et de travail — le tout partageant une même mémoire, un même contexte de projet et un même proxy LLM. Tes clés sont saisies **une seule fois** et ne quittent jamais le Trousseau macOS.

**Cinq slots dans la sidebar :** Chat · Code · Work · Design · Orchestrateur (plus un panneau Config).

## Fonctionnalités

|                                |                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Orchestrateur multi-agents** | Décris un objectif ; un DAG d'agents planifie, construit et **auto-vérifie** un vrai livrable — site, rapport, librairie de code… Voir [le deep-dive](docs/ORCHESTRATOR.fr.md) |
| **Chat intégré**               | Discute avec n'importe quel modèle : historique, pièces jointes, recherche web, effort de raisonnement par modèle                                                              |
| **3 outils intégrés**          | OpenCode (agent de code), OpenWork (travail structuré), Open Design (maquettes visuelles) — une seule sidebar, l'état de chaque vue préservé                                   |
| **Proxy LLM unifié**           | Un seul endpoint (`127.0.0.1:9999`) qui route vers Anthropic, OpenAI, OpenRouter, Ollama et Google Gemini                                                                      |
| **Mémoire persistante**        | Un profil et des faits taggés injectés entre les sessions, pour que l'IA se souvienne de ton projet et de tes décisions                                                        |
| **Gestion de projets**         | Projets multiples avec instructions personnalisées, injectées dans le contexte IA                                                                                              |
| **Sécurisé par défaut**        | Clés API dans le **Trousseau macOS**, jamais sur disque. WebViews sandboxées. Proxy localhost-only avec auth Bearer                                                            |

---

## Installation

**Prérequis :** macOS 14+, Node.js 22+, Git

```bash
git clone https://github.com/1zalt/OpenHub.git
cd OpenHub
bash scripts/setup.sh
npm run dev
```

`setup.sh` s'occupe de tout :

- Vérifie Node.js, Git, pnpm
- Installe le binaire CLI `opencode`
- Clone les 3 apps upstream dans `apps/`
- Crée les fichiers de config dans `~/.config/`
- Compile le TypeScript et copie les assets

### Premier lancement

1. Ouvre le panneau **Config** (icône engrenage dans la sidebar)
2. Ajoute tes clés API (Anthropic, OpenAI, OpenRouter, Google AI, Brave Search) — stockées dans le Trousseau macOS
3. Choisis tes modèles

> [!TIP]
> Pour utiliser les modèles Google Gemini directement (sans OpenRouter), lance `opencode auth login` dans ton terminal.

Voir le [guide d'usage](docs/USAGE.fr.md) pour utiliser le chat, les projets et l'orchestrateur au quotidien.

---

## Architecture

```
WebView (OpenWork / OpenCode / Open Design)
    │
    ├── overrides CSS/JS  ←──  electron/overrides/
    │
    └── appels LLM  ──→  Proxy :9999  ──→  Anthropic / OpenAI / OpenRouter / Ollama / Gemini
                             │
                             ├── injection de contexte (projet, mémoire)
                             └── extraction mémoire en arrière-plan
```

Pour la spec complète — ports, modèle de sécurité, cascade de config et système d'overlays — voir [ARCHITECTURE.fr.md](ARCHITECTURE.fr.md). Pour le moteur de l'orchestrateur, voir [docs/ORCHESTRATOR.fr.md](docs/ORCHESTRATOR.fr.md).

---

## Commandes

| Commande                | Description                          |
| ----------------------- | ------------------------------------ |
| `npm run dev`           | Démarre en mode développement        |
| `npm run build`         | Build et package l'app               |
| `npm run typecheck`     | Vérification TypeScript              |
| `npm run lint`          | ESLint                               |
| `npm test`              | Tests unitaires (Vitest)             |
| `bash scripts/setup.sh` | Setup complet / mise à jour des apps |

---

## Sécurité

- **Clés API** stockées dans le Trousseau macOS via `keytar` — jamais écrites sur disque
- **Proxy LLM** sur `127.0.0.1:9999` avec auth Bearer par session
- **WebViews** sandboxées (`contextIsolation`, `sandbox`, sans `nodeIntegration`)
- **Overrides** = injection CSS/JS uniquement — le code source upstream n'est jamais modifié

Voir [SECURITY.fr.md](SECURITY.fr.md) pour la politique complète et comment signaler une vulnérabilité.

---

## Remerciements

OpenHub est un shell — il unifie, il ne forke pas. L'outillage IA appartient à
[OpenCode](https://github.com/sst/opencode) (sst),
[OpenWork](https://github.com/different-ai/openwork) (different-ai) et
[Open Design](https://github.com/nexu-io/open-design) (nexu-io), chacun cloné à
l'installation et exécuté sans modification. Voir [ACKNOWLEDGEMENTS.fr.md](ACKNOWLEDGEMENTS.fr.md)
pour les crédits et licences.

## Licence

MIT — voir [LICENSE](LICENSE). Cela couvre uniquement le code propre d'OpenHub ; les
outils wrappés gardent leurs propres licences.

---

**[Ouvrir une issue](https://github.com/1zalt/OpenHub/issues) · [Usage](docs/USAGE.fr.md) · [Orchestrateur](docs/ORCHESTRATOR.fr.md) · [FAQ](docs/FAQ.fr.md) · [Architecture](ARCHITECTURE.fr.md) · [Remerciements](ACKNOWLEDGEMENTS.fr.md) · [Contribuer](CONTRIBUTING.fr.md)**

---

_Conçu pour les développeurs qui veulent garder le contrôle de leurs outils IA._
