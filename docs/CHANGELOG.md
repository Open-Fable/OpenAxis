**English** · [Français](CHANGELOG.fr.md)

# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-06-15

First public release. A macOS desktop shell unifying three open-source AI tools.

### Added

- **Electron shell** with a 3-slot sidebar (Work, Code, Design) plus Chat,
  Orchestrator and Config, each view isolated in a state-preserving
  `WebContentsView`.
- **Unified LLM proxy** on `127.0.0.1:9999` (OpenAI-compatible, Bearer required)
  routing to Anthropic, OpenAI, OpenRouter, Ollama and Google Gemini.
- **Secret storage in an encrypted file** at `~/Library/Application Support/openaxis/secrets.enc` (AES-256-GCM) — never in plaintext;
  the apps only receive a fake local token.
- **Built-in chat**: model selector, per-model reasoning effort,
  saved history, web search, attachments, project context.
- **Multi-agent orchestrator**: iterative planning, execution of a DAG of
  agents (code / design / work / pure LLM / verification), deterministic
  quality gates and retry on error.
- **Project management**: standalone projects and orchestrator projects, with
  custom instructions injected into the AI context.
- **Persistent memory**: profile, tagged facts, auto-extraction and token budget.
- **Override layer** (CSS/JS) per app — upstream source code is never
  modified, which preserves compatibility with updates.
- **Prefix caching optimization** in the proxy to reduce cost and latency.
- **Tooling**: automated setup, selector verification, Vitest + Playwright
  tests, CI lint & typecheck.

### Security

- Locked-down WebViews (`contextIsolation`, `sandbox`, no `nodeIntegration`).
- `opencode serve` bound strictly to `127.0.0.1` with a generated session
  password, never logged.
- Minimal `contextBridge` bridge, with no disk path parameter.

[0.1.0]: https://github.com/Open-Fable/OpenAxis/releases/tag/v0.1.0
