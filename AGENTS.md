# AGENTS.md — OpenHub

Agent definitions for multi-agent workflows in this project.

## Agents

### architect

**Role:** System design decisions, component boundaries, IPC protocol design.
**When to use:** Before adding new electron/ modules, changing the proxy API, or
modifying the bridge surface.
**Context:** Always read `ARCHITECTURE.md` first.

### code-reviewer

**Role:** Review all code changes for quality, security, and style compliance.
**When to use:** After every implementation, before commit.
**Focus areas:**
- Security: no secrets in overrides, no disk paths in bridge, proxy auth present
- Immutability: prefer `const`, new objects over mutation
- Simplicity: functions <50 lines, files <400 lines

### security-reviewer

**Role:** Audit security-sensitive code.
**When to use (MANDATORY):**
- Any change to `electron/proxy/`
- Any change to `electron/preload.ts` or bridge definitions
- Any change to process-manager env var injection
- Any change to Keychain integration
**Checks:**
- WebContentsView: contextIsolation, sandbox, nodeIntegration:false
- Proxy: 127.0.0.1 binding, Bearer auth required
- Bridge: no file path parameters, minimal surface
- Secrets: never in localStorage, never in .env files, never in injected JS

### build-error-resolver

**Role:** Fix build and TypeScript errors with minimal changes.
**When to use:** When `npm run build` or `npm run typecheck` fails.
**Constraint:** Fix ONLY the error. No refactoring, no "improvements."

### tdd-guide

**Role:** Enforce write-tests-first methodology.
**When to use:** New features, bug fixes.
**Flow:** RED (write failing test) → GREEN (minimal implementation) → REFACTOR.

### override-validator

**Role:** Verify CSS/JS overrides target valid selectors.
**When to use:** After creating/editing files in `electron/overrides/`.
**Method:** Load the target app page, check that each selector in the override
matches at least one DOM element. Report misses.

## Parallel Execution

For independent analysis, launch agents in parallel:
- Security review of proxy + Code review of UI changes (independent)
- Build validation + Selector check (independent)

Never parallelize agents that write to the same files.

## Agent Rules

1. Every agent reads `ARCHITECTURE.md` before acting.
2. No agent modifies files in `apps/` (upstream source code).
3. Security-reviewer has VETO power — its CRITICAL findings block merges.
4. Override-validator runs after every change to `electron/overrides/`.
