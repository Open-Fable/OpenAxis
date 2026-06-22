<div align="center">

# OpenHub

**Your entire AI workflow in one macOS window.**

A local AI workspace: chat with any model, orchestrate a team of agents that builds real deliverables, and switch between three integrated tools — [OpenWork](https://github.com/different-ai/openwork), [OpenCode](https://github.com/sst/opencode), and [Open Design](https://github.com/nexu-io/open-design). One LLM proxy, persistent memory, no Docker.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/platform-macOS_14+-black?logo=apple)](https://www.apple.com/macos)
[![Electron](https://img.shields.io/badge/Electron-42+-47848F?logo=electron&logoColor=white)](https://www.electronjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![typecheck](https://img.shields.io/github/actions/workflow/status/Open-Fable/OpenHub/typecheck.yml?label=typecheck&style=flat)](https://github.com/Open-Fable/OpenHub/actions/workflows/typecheck.yml)
[![lint](https://img.shields.io/github/actions/workflow/status/Open-Fable/OpenHub/lint.yml?label=lint&style=flat)](https://github.com/Open-Fable/OpenHub/actions/workflows/lint.yml)
[![tests](https://img.shields.io/github/actions/workflow/status/Open-Fable/OpenHub/test.yml?label=tests&style=flat)](https://github.com/Open-Fable/OpenHub/actions/workflows/test.yml)

[![Download OpenHub](https://img.shields.io/badge/Download-DMG-blue?logo=apple&style=for-the-badge)](https://github.com/Open-Fable/OpenHub/releases/latest)

**English** · [Français](README.fr.md)

[Installation](#installation) | [Usage](docs/USAGE.md) | [Orchestrator](docs/ORCHESTRATOR.md) | [FAQ](docs/FAQ.md) | [Architecture](#architecture) | [Contributing](docs/CONTRIBUTING.md)

</div>

<p align="center">
  <img src="screen_github/onglet_chat.png" alt="OpenHub Dashboard Overview" width="800">
</p>

---

## Why OpenHub?

AI tools are silos. They run in separate apps with their own API keys and memory. Nothing carries over when you switch windows. OpenHub puts five tools in one macOS window — shared memory, shared project context, a single LLM proxy. Keys are encrypted to `~/Library/Application Support/openhub/secrets.enc` once. That's it.

**Five sidebar slots:** Chat · Code · Work · Design · Orchestrator (plus a Config panel).

## Features

The **multi-agent orchestrator** is the headliner. It's an interactive assistant: describe what you want in plain language — "build a landing page for my startup" or "audit my API and generate an OpenAPI spec" — and it plans the work as a visual DAG (a flowchart of agents you can inspect). Each agent executes its part autonomously: research, write content, design mockups, code, verify quality. You can follow the progress in real time, and when something fails, the system self-corrects without you lifting a finger. This is what makes complex multi-agent work accessible to anyone, not just engineers. [Deep dive here.](docs/ORCHESTRATOR.md)

The **chat** works with Anthropic, OpenAI, OpenRouter, Ollama, Google Gemini, or any OpenAI-compatible provider. Session history, file attachments, automatic Brave search, reasoning controls. Pick a model and go.

Three **upstream tools** sit beside the native Chat and Orchestrator slots: OpenCode (code-agent server), OpenWork (structured project workspace), and Open Design (visual mockups). Switch between all five freely — execution state and session memory stay intact.

Behind the scenes, a **single LLM proxy** at `127.0.0.1:9999` routes everything through one OpenAI-compatible endpoint. It handles DeepSeek and Anthropic prompt caching via a Stable Prefix Strategy — ~99% cache hit rate on DeepSeek models across Chat, Code, Work, and Design, and ~80% on the Orchestrator (being improved) — and normalizes tool schemas so the apps don't step on each other.

Your **profile and key facts** carry over between sessions _(under maintenance — coming soon)_. The system extracts them automatically after each chat using local Ollama models (Qwen) with Jaccard semantic deduplication.

**Security**: API credentials are encrypted to `~/Library/Application Support/openhub/secrets.enc` (AES-256-GCM). WebViews are sandboxed with localhost-only Bearer auth.

### Screenshots

<details>
<summary>What the chat slot looks like</summary>
<br>
<p align="center">
  <img src="screen_github/onglet_chat.png" alt="Chat Slot" width="750">
</p>
<p align="center">
  <img src="screen_github/projet_dans_chat.png" alt="Project context in chat" width="750">
</p>
</details>

<details>
<summary>Orchestrator in action — planning, building, verifying</summary>
<br>
<p align="center">
  <img src="screen_github/onglet_orchestrateur.png" alt="Orchestrator Slot" width="750">
</p>
<p align="center">
  <img src="screen_github/agent_de_workflow_dans_orchestrateur.png" alt="Active project in orchestrator" width="750">
</p>
<p align="center">
  <img src="screen_github/workflow.png" alt="Orchestration workflow diagram" width="750">
</p>
</details>

<details>
<summary>Code agent (OpenCode)</summary>
<br>
<p align="center">
  <img src="screen_github/onglet_code.png" alt="Code Slot" width="750">
</p>
</details>

<details>
<summary>OpenWork workspace and project hub</summary>
<br>
<p align="center">
  <img src="screen_github/onglet_work.png" alt="Work Slot" width="750">
</p>
</details>

<details>
<summary>Visual mockups in Open Design</summary>
<br>
<p align="center">
  <img src="screen_github/onglet_Design.png" alt="Design Slot" width="750">
</p>
</details>

<details>
<summary>Config panel and API key management</summary>
<br>
<p align="center">
  <img src="screen_github/parametre.png" alt="Config Panel" width="750">
</p>
</details>

---

## Installation

**Requirements:** macOS 14+ (Apple Silicon)

Grab the latest `.dmg` from the [Latest Release](https://github.com/Open-Fable/OpenHub/releases/latest) page, open it, and drag OpenHub to your Applications folder.

> [!IMPORTANT]
> The `.dmg` isn't signed with an Apple Developer certificate (open-source build). macOS Gatekeeper will block it on first launch. To open it:
>
> - **Right-click** `OpenHub.app` → **Open** → confirm, **or**
> - clear the quarantine flag:
>   ```bash
>   xattr -cr /Applications/OpenHub.app
>   ```

### First launch

1. Open the **Config** panel (gear icon in the sidebar)
2. Add your API keys (Anthropic, OpenAI, OpenRouter, Google AI, Brave Search) — encrypted to `~/Library/Application Support/openhub/secrets.enc`
3. Pick your models

See the [Usage guide](docs/USAGE.md) for the day-to-day.

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
                             └── Background memory extraction *(under maintenance)*
```

Full spec — ports, security model, config cascade, overlay system — in [ARCHITECTURE.md](ARCHITECTURE.md). Orchestrator engine in [docs/ORCHESTRATOR.md](docs/ORCHESTRATOR.md).

---

## Contributing

Build from source, fix a bug, add a feature — see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

---

## Security

- Keys are encrypted to `~/Library/Application Support/openhub/secrets.enc` (AES-256-GCM).
- The proxy runs on `127.0.0.1:9999` with per-session Bearer auth.
- WebViews are sandboxed: `contextIsolation`, `sandbox`, no `nodeIntegration`.
- Overrides are CSS/JS only — upstream source stays unmodified.

Full policy and how to report a vulnerability: [docs/SECURITY.md](docs/SECURITY.md).

---

## Acknowledgements

OpenHub is a shell, not a fork. The AI tooling belongs to
[OpenCode](https://github.com/sst/opencode) (sst),
[OpenWork](https://github.com/different-ai/openwork) (different-ai), and
[Open Design](https://github.com/nexu-io/open-design) (nexu-io) — each cloned at install
time, run unmodified. See [docs/ACKNOWLEDGEMENTS.md](docs/ACKNOWLEDGEMENTS.md).

## License

MIT — see [LICENSE](LICENSE). Covers OpenHub's own code only; the bundled tools
keep their own licenses.

---

**[Open an issue](https://github.com/Open-Fable/OpenHub/issues) · [Usage](docs/USAGE.md) · [Orchestrator](docs/ORCHESTRATOR.md) · [FAQ](docs/FAQ.md) · [Architecture](ARCHITECTURE.md) · [Acknowledgements](docs/ACKNOWLEDGEMENTS.md) · [Contribute](docs/CONTRIBUTING.md)**

---
