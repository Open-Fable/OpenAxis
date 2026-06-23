# Show HN: OpenAxis — One macOS window for chat, code, design, and multi-agent orchestration

**Post URL:** Submit to https://news.ycombinator.com/submit

**Title (80 chars max):**

```
Show HN: OpenAxis – One macOS app for chat, code agents, design, and orchestration
```

**Body:**

```
Hi HN,

I built OpenAxis, a free macOS desktop app that puts five AI tools in one sidebar:
a chat (any model), a multi-agent orchestrator, and three open-source tools —
OpenCode (sst), OpenWork (different-ai), and Open Design (nexu-io).

The key ideas:

- You enter your API keys once (stored in an encrypted file, never in plaintext).
  A local proxy on 127.0.0.1:9999 routes to Anthropic, OpenAI, OpenRouter,
  Ollama, or Gemini. All three tools share that proxy — no per-app configuration.

- The upstream apps run unmodified. All customization is CSS/JS injection
  from an overrides layer, so upstream updates don't break anything.

- The orchestrator takes a goal ("build me a landing page"), generates a DAG
  of agents (planner, coder, designer, verifier), and produces a real
  deliverable with file extraction. Think multi-agent CI for creative work.

- Persistent memory and per-project context that carry across sessions.

- Zero Docker, zero cloud — everything runs as native macOS processes.

Stack: Electron + TypeScript + Express proxy + AES-256-GCM encrypted secrets file.

MIT licensed. Download the .dmg from Releases (Apple Silicon).

https://github.com/Open-Fable/OpenAxis

Would love feedback on the architecture and the orchestrator engine.
```

**Best posting times:** Tuesday–Thursday, 14:00–16:00 UTC (morning EST / afternoon EU).

**Tips:**

- Don't ask for upvotes
- Reply to every comment in the first 2 hours
- Be honest about limitations (macOS only, no code signing yet)
