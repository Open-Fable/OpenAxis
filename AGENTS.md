# AGENTS.md — OpenAxis (Opencode)

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
7. Respect the protected proxy zone below — never refactor it without explicit user confirmation.

## ZONE PROTÉGÉE : cache de préfixe du proxy

Le fichier `electron/proxy/index.ts` contient une logique critique optimisée pour le
**prefix caching** des providers (DeepSeek, Anthropic…). Toute modification de la
structure du préfixe, de l'ordre des messages, de la composition des blocs système ou
de l'historique conversationnel peut provoquer une chute majeure du cache hit rate,
augmenter fortement les tokens recalculés, dégrader les performances et augmenter les
coûts API.

### Interdiction par défaut

Ne pas modifier, refactoriser, réordonner, simplifier, nettoyer, dédupliquer,
factoriser ou « améliorer » ces zones sans validation explicite de l'utilisateur :

- la structure et l'ordre exact des 5 blocs système dans `electron/proxy/index.ts`
  (présents même vides) ;
- la valeur et la gestion de `userQuery` (actuellement figée à `""`) ;
- toute logique liée à `structuredMessages.push(...)` ou qui change la position, le
  contenu ou l'ordre des messages avant l'appel provider ;
- toute déduplication d'historique qui change la séquence transmise au provider ;
- toute mutation automatique d'un contenu injecté dans le préfixe (notamment
  `AGENT-MEMORY.md`) ;
- toute logique de mémoire ou de skills pouvant faire varier le préfixe d'un tour à
  l'autre, ou de réinjection sur les sous-agents ;
- `bypassInjection`, `buildMemoryBlock`, `buildDynamicSkillsSnippet`.

### Invariants contractuels

1. Exactement 5 blocs système, même ordre, même forme JSON, même si certains sont vides.
2. Le préfixe reste le plus stable possible entre deux requêtes successives.
3. Aucun contenu volatil injecté tôt dans le prompt s'il modifie le préfixe.
4. Pas de déduplication d'historique qui change la séquence envoyée au provider.
5. Aucune réécriture/enrichissement automatique d'un contenu injecté sans accord explicite.
6. Les sous-agents ne subissent jamais de double injection architecture/mémoire/skills.

### Comportement attendu de l'agent

Si une tâche touche l'une de ces zones, l'agent doit : (1) s'arrêter ; (2) expliquer le
risque pour le prefix caching et son impact probable sur le cache hit rate, les coûts et
les performances ; (3) attendre une confirmation explicite ; (4) ne produire aucun diff
tant que cette confirmation n'a pas été donnée. En cas de doute : **ne pas toucher**.

## Knowledge Graph (Graphify)

The knowledge graph at `graphify-out/` maps the entire codebase as a semantic graph (1329 nodes, 1517 edges across 125 communities).

- **Navigation**: `graphify-out/GRAPH_REPORT.md` lists community hubs, god nodes (core abstractions), and surprising cross-module connections. Read it early to find relevant files.
- **Freshness**: Built from commit `5b849c1b`. Run `graphify update .` after significant code changes (no API cost) to regenerate.
- **Usage**: When asked about codebase structure, module relationships, or finding relevant files, consult the graph communities — they cluster related concepts better than directory trees.

For tasks involving community hubs 0-1 (design docs, branding, personas), communities 2-6 (core infra, types, runtime), or communities 12-13 (memory, semantic), use the graph to pinpoint relevant files before searching blindly.
