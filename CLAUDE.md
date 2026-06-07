# CLAUDE.md — OpenHub

Behavioral guidelines for the OpenHub project. Biased toward caution over speed.
For trivial tasks, use judgment.

## 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

---

## Project Context

### About OpenHub

Electron desktop shell for macOS that unifies 3 open-source AI tools behind a
single sidebar (Work, Code, Design). Each tool runs as a separate native process;
the shell displays their web UIs in isolated WebContentsViews.

**Key principle:** The 3 apps' source code is NEVER modified. All customization
happens through CSS/JS injection from `electron/overrides/` and env var injection
at process spawn time.

### Architecture Reference

Read `ARCHITECTURE.md` for the full canonical spec — ports, security model,
config cascade, and overlay system. That document is the single source of truth.

### Key Directories

```
electron/           ← Shell code (main, preload, proxy, process-manager)
electron/overrides/ ← CSS/JS injections per app (never touches source code)
electron/settings/  ← Config panel UI
apps/               ← Cloned upstream repos (openwork, opencode, open-design)
scripts/            ← Setup, update, selector-check utilities
```

### Apps & Ports

| Slot   | App                 | Port              | Start command                            |
| ------ | ------------------- | ----------------- | ---------------------------------------- |
| Work   | openwork `apps/app` | 5173              | `pnpm dev:ui` (dev) / serve build (prod) |
| Code   | opencode            | 4096              | `opencode serve` + `opencode web`        |
| Design | open-design         | captured at spawn | `od` daemon                              |
| Proxy  | internal Express    | 9999              | started by Electron main                 |

### Stack

- **Runtime:** Electron v32+, TypeScript, native processes (zero Docker)
- **Proxy:** Express on 127.0.0.1:9999, OpenAI-compatible, Bearer token required
- **Secrets:** macOS Keychain via `keytar` — never on disk
- **Config cascade:** `~/.config/opencode/opencode.json` propagates to all 3 apps
- **Overrides:** `insertCSS()` + `executeJavaScript()` via contextBridge

### Coding Standards

- TypeScript strict mode, no `any` except at serialization boundaries
- Prefer `const` and immutable patterns
- Functions under 50 lines, files under 400 lines
- Naming: `camelCase` functions/vars, `PascalCase` types, `UPPER_SNAKE` constants
- No comments unless the WHY is non-obvious

### Security Rules (CRITICAL)

- WebContentsView: `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`
- Bridge (`contextBridge`): minimal surface, NO disk path parameters
- Proxy: bind `127.0.0.1` ONLY, require `Authorization: Bearer`
- Secrets: Keychain → RAM → env vars at spawn. Never localStorage, never .env on disk
- Injected JS: UI only, zero secrets inline
- opencode serve: `OPENCODE_SERVER_PASSWORD` generated per session, never logged

### Opencode Usage

This project was originally configured for Claude Code. You now run under **Opencode**.
The only agent types available are `explore` (codebase discovery) and `general-purpose`
(implementation). See `AGENTS.md` for details.

### Commands

```bash
npm run dev              # Start Electron shell in dev mode
npm run build            # Build for production
npm run update:apps      # git pull + rebuild all 3 apps
npm run check:selectors  # Verify CSS selectors still exist post-update
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
```

### Testing

- Unit tests: Vitest
- E2E: Playwright (Electron mode)
- Run `npm test` before any commit
- Coverage target: 80%+

### Workflow

1. Investigate: read the relevant code, understand the current state
2. Plan: state what you'll change and why (for non-trivial tasks)
3. Implement: surgical changes only
4. Verify: run tests, typecheck, lint
5. If touching overrides: run `npm run check:selectors` to verify targets exist

### Override System Rules

When creating/editing files in `electron/overrides/`:

- Target semantic selectors (`data-*`, `aria-*`, `role`, `id`) over utility classes
- Each override = 1 file, 1 purpose
- Register in `electron/overrides/index.json`
- CSS overrides: use `!important` sparingly, prefer specificity
- JS overrides: use `MutationObserver` for SPA route changes
- NEVER put secrets in override JS files

### Hooks

Pre-commit hooks are configured via Husky + lint-staged:

- ESLint + Prettier on staged files
- `tsc --noEmit` verifies types
- Graphify knowledge graph updated daily via terminal hook (no AI needed)

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer
rewrites due to overcomplication, and clarifying questions come before
implementation rather than after mistakes.
