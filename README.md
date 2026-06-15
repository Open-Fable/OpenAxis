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
[![tests](https://img.shields.io/github/actions/workflow/status/1zalt/OpenHub/test.yml?label=tests&style=flat)](https://github.com/1zalt/OpenHub/actions/workflows/test.yml)

**English** · [Français](README.fr.md)

[Installation](#-installation) | [Usage](docs/USAGE.md) | [Orchestrator](docs/ORCHESTRATOR.md) | [FAQ](docs/FAQ.md) | [Architecture](#-architecture) | [Contributing](CONTRIBUTING.md)

</div>

---

## Why OpenHub?

Running OpenWork, OpenCode, and Open Design separately means three terminals, three ports, three configs, and no shared context. OpenHub wraps them in a single Electron window with a unified LLM proxy — your AI tools share memory, projects, and API keys without touching their source code.

## Features

|                              |                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **3 apps, 1 window**         | Switch between OpenWork (orchestration), OpenCode (code agent), and Open Design (visual design) via a sidebar    |
| **Unified LLM proxy**        | Routes calls to Anthropic, OpenAI, OpenRouter, Ollama, and Google Gemini — on `127.0.0.1:9999`                   |
| **Persistent memory**        | AI remembers your project and decisions across sessions                                                          |
| **Built-in chat**            | Model selector, history, auto-save                                                                               |
| **Project management**       | Multiple projects with custom instructions, injected into AI context                                             |
| **Unified theming**          | CSS/JS overrides per app for a cohesive look — upstream code is never modified                                   |
| **Multi-agent orchestrator** | A DAG of agents that plan, build, and self-verify a real deliverable — see [the deep dive](docs/ORCHESTRATOR.md) |
| **Secure by default**        | API keys in **macOS Keychain**, never on disk. WebViews sandboxed. Proxy localhost-only with Bearer auth         |

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

See the [Usage guide](docs/USAGE.md) for how to use the chat, projects, and orchestrator day-to-day.

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

For the full spec — ports, security model, config cascade, and overlay system — see [ARCHITECTURE.md](ARCHITECTURE.md). For the orchestrator engine, see [docs/ORCHESTRATOR.md](docs/ORCHESTRATOR.md).

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

See [SECURITY.md](SECURITY.md) for the full policy and how to report a vulnerability.

---

## Acknowledgements

OpenHub is a shell — it unifies, it doesn't fork. The AI tooling belongs to
[OpenCode](https://github.com/sst/opencode) (sst),
[OpenWork](https://github.com/different-ai/openwork) (different-ai), and
[Open Design](https://github.com/nexu-io/open-design) (nexu-io), each cloned at install
time and run unmodified. See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) for credits and
licenses.

## License

MIT — see [LICENSE](LICENSE). This covers OpenHub's own code only; the bundled tools
keep their own licenses.

---

**[Open an issue](https://github.com/1zalt/OpenHub/issues) · [Usage](docs/USAGE.md) · [Orchestrator](docs/ORCHESTRATOR.md) · [FAQ](docs/FAQ.md) · [Architecture](ARCHITECTURE.md) · [Acknowledgements](ACKNOWLEDGEMENTS.md) · [Contribute](CONTRIBUTING.md)**

---

_Built for developers who want to stay in control of their AI tools._
