# Twitter/X Launch Thread

**When:** Same day as Show HN, a few hours after.

---

**Tweet 1 (hook):**

I got tired of juggling 5 AI windows with 5 API keys.

So I built OpenAxis — one macOS app that puts chat, code agents, design tools, and a multi-agent orchestrator in a single sidebar.

Open source. Free. MIT licensed.

🧵 Here's what it does →

---

**Tweet 2 (the problem):**

The problem: every AI tool wants its own API key, its own settings, its own window.

OpenCode for coding. OpenWork for tasks. Open Design for mockups. A chat for quick questions. None of them talk to each other.

---

**Tweet 3 (the solution):**

OpenAxis wraps all three + adds a built-in chat and orchestrator.

You enter your keys once (encrypted secrets file — never stored in plaintext).
A local proxy routes everything. All tools share the same context.

One window. One config. Five tools.

---

**Tweet 4 (orchestrator):**

The orchestrator is the part I'm most excited about.

Give it a goal: "build me a landing page"

It creates a DAG of agents — planner, coder, designer, verifier — and they produce real files. Not just text. Actual deliverables.

---

**Tweet 5 (technical):**

How it works under the hood:

- Electron shell, TypeScript strict
- CSS/JS injection layer (upstream code never touched)
- Express proxy on localhost:9999
- Supports Anthropic, OpenAI, OpenRouter, Ollama, Gemini
- Zero Docker, native macOS processes only

---

**Tweet 6 (CTA):**

MIT licensed. Download the .dmg (Apple Silicon) and you're running in 30 seconds.

Star it, fork it, break it:
→ github.com/Open-Fable/OpenAxis

Feedback welcome — especially on the orchestrator engine.

---

**Tips:**

- Add a GIF/video (30s screen recording of switching between slots)
- Tag @saborman (OpenCode/SST), @nicholashaley (different-ai/OpenWork)
- Post between 14:00–17:00 UTC for max reach
- Pin the thread
