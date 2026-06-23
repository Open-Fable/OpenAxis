# Bluesky Launch Thread

---

**Post 1:**

I built OpenAxis — a free macOS app that puts chat, code agents, design tools, and a multi-agent orchestrator in one sidebar.

Enter your API keys once. All tools share the same proxy. Open source, MIT licensed.

github.com/Open-Fable/OpenAxis

Thread →

---

**Post 2:**

It wraps three open-source projects — OpenCode, OpenWork, Open Design — without modifying their source code.

All customization is CSS/JS injection. Upstream updates don't break anything.

---

**Post 3:**

The orchestrator is the fun part.

Give it a goal ("build me a portfolio site"). It creates a DAG of agents — planner, coder, designer, verifier — and they produce actual files you can use.

---

**Post 4:**

Under the hood:

- Electron + TypeScript
- Local Express proxy on localhost:9999
- Supports Anthropic, OpenAI, OpenRouter, Ollama, Gemini
- Secrets in encrypted file (~/Library/Application Support/openaxis/secrets.enc)
- Zero Docker

---

**Post 5:**

MIT licensed. Download the .dmg (Apple Silicon) — no setup needed.

Would love feedback — especially on the multi-agent orchestrator.

github.com/Open-Fable/OpenAxis
