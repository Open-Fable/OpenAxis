<div align="center">

# OpenHub

**One window. Three AI tools. Zero Docker.**

A macOS desktop shell that unifies [OpenWork](https://github.com/different-ai/openwork), [OpenCode](https://github.com/sst/opencode), and [Open Design](https://github.com/nexu-io/open-design) behind a single sidebar — with a local LLM proxy that routes to any provider.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/platform-macOS_14+-black?logo=apple)](https://www.apple.com/macos)
[![Electron](https://img.shields.io/badge/Electron-42+-47848F?logo=electron&logoColor=white)](https://www.electronjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![typecheck](https://img.shields.io/github/actions/workflow/status/1zalt/OpenHub/typecheck.yml?label=typecheck&style=flat)](https://github.com/1zalt/OpenHub/actions/workflows/typecheck.yml)
[![lint](https://img.shields.io/github/actions/workflow/status/1zalt/OpenHub/lint.yml?label=lint&style=flat)](https://github.com/1zalt/OpenHub/actions/workflows/lint.yml)

[Francais](#-version-francaise) | [Installation](#-installation) | [Architecture](#-architecture) | [Contributing](CONTRIBUTING.md)

</div>

---

## Why OpenHub?

Running OpenWork, OpenCode, and Open Design separately means three terminals, three ports, three configs, and no shared context. OpenHub wraps them in a single Electron window with a unified LLM proxy — your AI tools share memory, projects, and API keys without touching their source code.

## Features

|                              |                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **3 apps, 1 window**         | Switch between OpenWork (orchestration), OpenCode (code agent), and Open Design (visual design) via a sidebar |
| **Unified LLM proxy**        | Routes calls to Anthropic, OpenAI, OpenRouter, Ollama, and Google Gemini — on `127.0.0.1:9999`                |
| **Persistent memory**        | AI remembers your project and decisions across sessions                                                       |
| **Built-in chat**            | Model selector, history, auto-save                                                                            |
| **Project management**       | Multiple projects with custom instructions, injected into AI context                                          |
| **Unified theming**          | CSS/JS overrides per app for a cohesive look — upstream code is never modified                                |
| **Multi-agent orchestrator** | Complex workflows with smart classification and pro/flash routing                                             |
| **Secure by default**        | API keys in **macOS Keychain**, never on disk. WebViews sandboxed. Proxy localhost-only with Bearer auth      |

---

## Installation

**Prerequisites:** macOS 14+, Node.js 22+, Git

```bash
git clone https://github.com/1zalt/OpenHub.git
cd OpenHub
bash scripts/setup.sh
npm run dev
```

`setup.sh` handles everything:

- Verifies Node.js, Git, pnpm
- Installs the `opencode` CLI binary
- Clones the 3 upstream apps into `apps/`
- Creates config files in `~/.config/`
- Compiles TypeScript and copies assets

### First launch

1. Open the **Config** panel (gear icon in the sidebar)
2. Add your API keys (Anthropic, OpenAI, OpenRouter, Google AI, Brave Search) — stored in macOS Keychain
3. Pick your models

> [!TIP]
> To use Google Gemini models directly (without OpenRouter), run `opencode auth login` in your terminal.

---

## Architecture

```
WebView (OpenWork / OpenCode / Open Design)
    │
    ├── CSS/JS overrides  ←──  electron/overrides/
    │
    └── LLM calls  ──→  Proxy :9999  ──→  Anthropic / OpenAI / OpenRouter / Ollama / Gemini
                             │
                             ├── Context injection (project, memory)
                             └── Background memory extraction
```

For the full spec — ports, security model, config cascade, and overlay system — see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Commands

| Command                 | Description                       |
| ----------------------- | --------------------------------- |
| `npm run dev`           | Start in development mode         |
| `npm run build`         | Build and package the app         |
| `npm run typecheck`     | TypeScript check                  |
| `npm run lint`          | ESLint                            |
| `npm test`              | Unit tests (Vitest)               |
| `bash scripts/setup.sh` | Full setup / update upstream apps |

---

## Security

- **API keys** stored in macOS Keychain via `keytar` — never written to disk
- **LLM proxy** runs on `127.0.0.1:9999` with per-session Bearer auth
- **WebViews** sandboxed (`contextIsolation`, `sandbox`, no `nodeIntegration`)
- **Overrides** are CSS/JS injection only — upstream source code is never modified

---

## License

MIT — see [LICENSE](LICENSE).

---

**[Open an issue](https://github.com/1zalt/OpenHub/issues) · [Read the docs](ARCHITECTURE.md) · [Contribute](CONTRIBUTING.md)**

---

## Version francaise

**OpenHub** est un hub desktop macOS qui reunit plusieurs outils IA open-source dans une interface unique.

Une seule fenetre, une sidebar a icones, un proxy LLM central — et ton environnement de developpement IA prefere, unifie.

### Fonctionnalites

- **3 apps en 1** — Bascule entre OpenWork (orchestration), OpenCode (agent de code), et Open Design (design visuel)
- **Proxy LLM unifie** — Route les appels vers Anthropic, OpenAI, OpenRouter, Ollama, et Google Gemini
- **Memoire persistante** — L'IA se souvient de ton projet et de tes decisions entre les sessions
- **Chat integre** — Selection de modele, historique, sauvegarde automatique
- **Gestion de projets** — Projets multiples avec instructions personnalisees injectees dans le contexte IA
- **Theme unifie** — Override CSS/JS par app pour une experience visuelle coherente
- **Orchestrateur multi-agent** — Workflows complexes avec classification intelligente
- **Securise** — Cles API dans le macOS Keychain, jamais sur disque

### Installation

```bash
git clone https://github.com/1zalt/OpenHub.git
cd OpenHub
bash scripts/setup.sh
npm run dev
```

Le script `setup.sh` s'occupe de tout : verification des prerequis, installation d'opencode, clonage des apps, configuration, et compilation.

Apres le premier lancement, ouvre le panneau Config pour ajouter tes cles API (stockees dans le Keychain) et configurer tes modeles.

---

_Built for developers who want to stay in control of their AI tools._
