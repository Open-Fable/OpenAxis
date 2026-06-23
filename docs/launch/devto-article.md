# dev.to Article Draft

**Publish:** 3–5 days after the initial launch.

**Title:** How I built a macOS app that unifies 5 AI tools without modifying their source code

**Tags:** opensource, electron, ai, typescript

---

Most AI tools run in their own window with their own API keys and their own configuration. I had OpenCode open for coding, OpenWork for task management, Open Design for mockups, and a separate chat window. Four windows, four configs, four sets of API keys.

So I built [OpenAxis](https://github.com/Open-Fable/OpenAxis) — a macOS app that puts all of them (plus a multi-agent orchestrator) behind a single sidebar.

## The constraint that shaped everything

The #1 rule: **never modify the upstream source code.** Each tool gets cloned at install time and runs as-is. This means:

- Upstream updates don't break anything (just `git pull`)
- No fork to maintain
- Each tool keeps its own license and identity

So how do you customize apps you can't change?

## CSS/JS injection as an override layer

Electron's `WebContentsView` gives you `insertCSS()` and `executeJavaScript()` via a context bridge. OpenAxis uses this to:

- Apply a unified dark theme across all three tools
- Hide each tool's native settings (centralized in one Config panel)
- Add features like PDF export and web search

Each override is one file, one purpose, registered in an `index.json` catalog. Target semantic selectors (`data-*`, `aria-*`, `role`) instead of utility classes — they survive upstream CSS changes.

## One proxy to rule them all

The three tools all use the same underlying engine (opencode by SST). So one config file configures all three:

```json
{
  "provider": {
    "openaxis": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:9999/v1"
      }
    }
  }
}
```

The proxy on `127.0.0.1:9999` holds the real API keys (read from an encrypted file at startup), routes to Anthropic/OpenAI/OpenRouter/Ollama/Gemini, and injects project context + memory into every request.

The apps only see a fake local token. They never touch the real keys.

## The orchestrator

This is the part that surprised me the most. Give the orchestrator a goal:

> "Build me a portfolio website with an about page, projects gallery, and contact form"

It generates a DAG of agents — planner, coder, designer, verifier — each with a specific role. They work through the DAG, produce real files, and the verifier checks the output against the original goal.

It's like a tiny CI pipeline for creative work.

## What I learned

1. **The injection pattern is underrated.** Most people think "wrapping" means forking. It doesn't. CSS/JS injection + a proxy gives you 90% of what you need without touching a line of upstream code.

2. **A local encrypted file keeps secrets safe without the Keychain dependency.** AES-256-GCM encryption is solid. Keys go into `~/Library/Application Support/openaxis/secrets.enc`, read into RAM, passed as env vars at process spawn. Never stored in plaintext.

3. **The "configure once" insight was non-obvious.** I didn't realize all three tools shared the same engine until I read their source code. That one discovery eliminated 80% of the configuration complexity.

---

[OpenAxis on GitHub](https://github.com/Open-Fable/OpenAxis) — MIT licensed. Download the `.dmg` from Releases.

I'd love feedback on the architecture, especially the override system and the orchestrator engine.
