# Reddit Launch Posts

Post on the same day as Show HN, staggered by a few hours each.

---

## 1. r/opensource

**Title:** OpenAxis — macOS app that unifies 3 open-source AI tools + chat + multi-agent orchestrator (MIT)

**Body:**

Hey r/opensource,

I've been working on OpenAxis, a free macOS desktop app that brings together several open-source AI tools into a single interface.

**What it does:**

- Built-in chat (any LLM provider)
- Multi-agent orchestrator (give it a goal, it builds a DAG of agents and produces real files)
- Integrates OpenCode (sst), OpenWork (different-ai), and Open Design (nexu-io) — each running unmodified
- Unified LLM proxy — enter your API keys once (encrypted file), all tools share them
- Persistent memory and per-project context

**Key design decisions:**

- Upstream source code is never modified — all customization is CSS/JS injection
- Zero Docker — everything runs as native macOS processes
- Secrets stored in an encrypted file, never in plaintext
- MIT licensed

GitHub: https://github.com/Open-Fable/OpenAxis

Download the .dmg from Releases (Apple Silicon) — no clone or setup needed.

Looking for feedback, especially on the orchestrator architecture and the override system.

---

## 2. r/LocalLLaMA

**Title:** OpenAxis — free macOS app with built-in Ollama support: chat + code agent + design tool + orchestrator in one window

**Body:**

Built this for my own workflow and thought r/LocalLLaMA might find it useful.

OpenAxis is a macOS desktop app that puts 5 AI tools behind one sidebar: chat, code agent (OpenCode), task manager (OpenWork), design tool (Open Design), and a multi-agent orchestrator.

**Why it's relevant here:** it has a local LLM proxy that routes to Ollama (among others). You configure your Ollama endpoint once and every tool in the app uses it. No API keys needed for local models.

The orchestrator can use your local models too — it creates a team of agents that plan, build, and verify a deliverable.

Open source, MIT: https://github.com/Open-Fable/OpenAxis

---

## 3. r/macapps

**Title:** OpenAxis — free, open-source AI workspace for macOS (chat + code + design + orchestrator)

**Body:**

I've been building an AI desktop app for macOS that combines several tools I was using separately.

- Native macOS app — download the .dmg, drag to Applications, done
- Five sidebar slots: Chat, Code, Work, Design, Orchestrator
- API keys stored in an encrypted file
- No setup, no Docker

It wraps three open-source projects (OpenCode, OpenWork, Open Design) and adds a built-in chat and multi-agent orchestrator on top. The upstream apps run unmodified.

Free, MIT licensed: https://github.com/Open-Fable/OpenAxis

Note: the .dmg isn't code-signed yet (open-source project), so right-click → Open on first launch.

---

## 4. r/selfhosted

**Title:** OpenAxis — self-hosted AI workspace for macOS: chat, code agent, orchestrator, unified LLM proxy (MIT)

**Body:**

OpenAxis is a desktop AI workspace that runs entirely on your machine — no cloud, no Docker, no accounts.

- Local LLM proxy on 127.0.0.1:9999 supporting Anthropic, OpenAI, OpenRouter, Ollama, and Gemini
- Built-in chat with any model
- Multi-agent orchestrator that produces real deliverables
- Three integrated open-source tools (code, work, design)
- API keys in encrypted file, never in plaintext

Everything runs as native macOS processes. The proxy is localhost-only with Bearer auth.

MIT licensed: https://github.com/Open-Fable/OpenAxis

Would love input on what it would take to make a Linux version viable.

---

**General Reddit tips:**

- Don't post in all subreddits simultaneously — stagger by 4–6 hours
- Reply to every comment
- Be transparent about limitations
- Don't astroturf with alt accounts
- Adjust the angle for each community's interests
