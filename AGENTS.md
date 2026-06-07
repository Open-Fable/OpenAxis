# AGENTS.md — OpenHub (Opencode)

Agent definitions for multi-agent workflows using Opencode.

## Available Agent Types

| Agent Type        | Use Case                                                |
| ----------------- | ------------------------------------------------------- |
| `explore`         | Codebase exploration, finding files, searching patterns |
| `general-purpose` | Complex multi-step tasks, research, implementation      |

## When to Use Agents

### `explore` — Codebase Discovery

- Finding files by pattern or naming convention
- Searching for specific code patterns across the project
- Understanding how a feature is implemented
- Quick answers about project structure

### `general-purpose` — Complex Tasks

- Implementing new features
- Refactoring existing code
- Researching solutions across multiple files
- Any multi-step task requiring file modifications

## Parallel Execution

Use parallel agent invocation for independent tasks:

- Security review + UI changes (independent)
- Build validation + Selector checks (independent)

Never parallelize agents that write to the same files.

## Agent Rules

1. Every agent reads `ARCHITECTURE.md` before acting.
2. No agent modifies files in `apps/` (upstream source code).
3. Security is CRITICAL — review before committing.
4. Validate selectors after every change to `electron/overrides/`.
5. Every agent reads and maintains `AGENT-MEMORY.md` before acting and after completing a task.
6. Every agent has the knowledge graph (Graphify) auto-loaded via `opencode.json` instructions — context is always fresh from `graphify-out/GRAPH_REPORT.md`.

## Knowledge Graph (Graphify)

The knowledge graph at `graphify-out/` maps the entire codebase as a semantic graph (1329 nodes, 1517 edges across 125 communities).

- **Navigation**: `graphify-out/GRAPH_REPORT.md` lists community hubs, god nodes (core abstractions), and surprising cross-module connections. Read it early to find relevant files.
- **Freshness**: Built from commit `5b849c1b`. Run `graphify update .` after significant code changes (no API cost) to regenerate.
- **Usage**: When asked about codebase structure, module relationships, or finding relevant files, consult the graph communities — they cluster related concepts better than directory trees.

For tasks involving community hubs 0-1 (design docs, branding, personas), communities 2-6 (core infra, types, runtime), or communities 12-13 (memory, semantic), use the graph to pinpoint relevant files before searching blindly.
