**English** · [Français](ORCHESTRATOR.fr.md)

# OpenAxis — The Multi-Agent Orchestrator

> The orchestrator is an **interactive assistant** that turns a plain-language goal
> into a multi-agent workflow. You describe what you want — it plans the work as a
> visual DAG, assigns agents, executes them, verifies the result, and self-corrects.
> You stay in control without needing to understand the engine underneath.

> Technical reference below. Covers how a goal becomes a graph of AI agents that
> produce a deliverable (website, code library, report, ebook, slides...), and
> how the system catches structural defects instead of trusting the model.

This document is for contributors and power users. For day-to-day usage,
For day-to-day usage, see [USAGE](USAGE.md#4-the-multi-agent-orchestrator). The code
lives in `electron/orchestrator-runner.ts` (engine), `electron/orchestrator-quality.ts`
(deterministic quality gate), `electron/orchestrator-prompts.ts` (prompts & rules),
`electron/orchestrator-backends/` (native backends) and `electron/orchestrator-iterate.ts`
(corrective triage).

---

## 1. Mental model

The orchestrator is a **DAG of agents**. Each agent is a `Project` with a role
(`type`), a task, and a list of dependencies. A coordinator project of type
`orchestrator` ties them together. A run:

1. **plans** — decomposes the global objective into per-agent tasks, optionally
   creating sub-agents and declaring a file contract for each;
2. **executes** — runs each agent in dependency order, feeding upstream results
   downstream, writing files into a shared **workspace** folder;
3. **verifies** — runs a deterministic quality gate (no LLM needed to catch the
   structural defects) plus an optional LLM verifier;
4. **self-corrects** — when the gate fails, it relaunches only the agents that own
   the broken deliverables, then re-audits.

The guiding principle: **the LLM never gets the final say on whether the deliverable
is correct.** Structural defects (broken imports, missing files, dead code, broken
asset links, inconsistent prices, unstyled pages…) are detected by deterministic
code and force a fail regardless of what the verifier model claims.

---

## 2. Agent types and roles

Six `type` values exist (`project-store.ts`). Each maps to a backend and a set of
quality rules (`orchestrator-prompts.ts`):

| Type           | Backend            | Role                                                                                                                                             |
| -------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recherche`    | none (pure-LLM)    | Investigation, data gathering, state-of-the-art, synthesis docs/plans/recommendations.                                                           |
| `work`         | none (pure-LLM)    | Content & assets: writing, structured data (.md/.json/.csv), **and the design system / palette / typography / charte graphique** for a site.     |
| `design`       | Open Design daemon | Visual web mockups (HTML/CSS) **only**, and only if the deliverable has a UI. It _receives_ the design system from work — it does not invent it. |
| `code`         | OpenCode server    | The functional deliverable: app, library, API, CLI, scripts. Reproduces mockups faithfully when they exist.                                      |
| `verifier`     | none (pure-LLM)    | QA / tests. **Report-only** — never rewrites another agent's files; the orchestrator routes fixes to the owner.                                  |
| `orchestrator` | —                  | The coordinator node itself. Runs the planning prompts; not an executable agent.                                                                 |

"Pure-LLM" is an **execution path**, not a type: any node without a tool-using
backend (`work`, `recherche`, `verifier`) runs through the direct LLM path and has
no disk access of its own — so the engine injects the real on-disk content of its
dependencies as evidence (see §7). Unknown types fall back to `code` rules.

---

## 3. The project / node data model

Both orchestrator nodes and agents share one `Project` type (`project-store.ts`).
The orchestrator-relevant fields:

| Field          | Meaning                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| `type`         | Agent role (see §2). Drives backend, quality rules, dependency mandates.              |
| `instructions` | The agent's persona/system header.                                                    |
| `task`         | The concrete task text injected as `TÂCHE:` in the node prompt.                       |
| `steps`        | Manually-defined sub-steps (used when ≥ 2).                                           |
| `autoSteps`    | Auto-decompose the task into sub-steps at runtime.                                    |
| `dependencies` | Upstream node ids — the DAG edges. Drives execution order and context injection.      |
| `linked`       | For an orchestrator: the agent ids it coordinates.                                    |
| `orchSettings` | `{ autoDistribute, checkCoherence, relaunchOnError, adaptToWeakModel? }` (see below). |
| `bypassMemory` | Skip memory injection for this node.                                                  |
| `maxRetries`   | Per-node retry budget (clamped — see §10).                                            |
| `model`        | Model override for this node.                                                         |
| `generated`    | Marks an auto-created sub-agent.                                                      |

**`orchSettings`:**

- `autoDistribute` — run the iterative planner to auto-assign tasks (§5). If off,
  each agent's pre-configured `task` is used as-is.
- `checkCoherence` — enable the (advisory) pre-execution prompt verifier and the
  (advisory) final brand/spec verification.
- `relaunchOnError` — historical flag; the auto quality loop now runs whenever a
  verifier agent exists, independent of this flag.
- `adaptToWeakModel` — selects the **weak tier** profile (more iterations, forced
  decomposition, compact prompts) for less capable models.

Projects are stored at `~/.config/openaxis/projects.json` (atomic write + write-lock).
Run history lives in `~/.config/openaxis/orch-history.json`, capped at 50 runs.

---

## 4. Run lifecycle

Entry point: `OrchestratorRunner.run(orchestratorId, task, workDir?, workflowName?)`.
It refuses concurrent runs, sets up an `AbortController`, and always clears its
running state in a `finally`. The phases, in order:

**Phase 0 — Setup & validation.** Load projects, confirm the target is an
`orchestrator`, resolve the **workspace dir** (first absolute, _safe_ candidate of
`workDir` → `orchestrator.path` → active workspace; otherwise `~/_orch/<name>`).
`isSafeWorkspaceDir` blocks `/`, `$HOME`, system prefixes and sensitive home
subdirs. Seed `WORKSPACE_INDEX.md`. Resolve the fallback model (**fails fast if no
model is configured anywhere**) and the tier profile.

**Phase 1 — Planning.** If `autoDistribute`, run `generatePlanningIterative` (§5),
persist generated tasks/sub-agents to disk. Otherwise use each agent's existing task.

**Phase 2 — Prompt verifier (advisory).** If `checkCoherence` and a verifier exists,
`verifyPrompts` reviews task quality. Never blocks — only emits warnings.

**Phase 3 — DAG resolution.** `resolveDAG` computes a topological order (DFS with
cycle detection; throws on circular dependencies).

**Phase 4 — Execution.** `executeNodesSequence` (the active path) runs nodes one at a
time in DAG order, skipping any node whose dependency errored or was skipped.

**Phase 5 — Brand/spec verification (advisory).** If no errors and `checkCoherence`,
`verifyBrandCompliance` runs. Non-blocking.

**Phase 6 — Quality loop or no-verifier warning.** If no execution errors: with a
verifier agent → `runAutoQualityLoop` (§9); without one → `warnOnBrokenAssets` (§11).

**Phase 7 — Final status.** Recompute from per-node statuses, emit `done` or `error`.

A second entry point, `iterate(orchestratorId, feedback, previousRun, …)`, handles
human-feedback re-runs by resolving the existing workspace and delegating to
`runCorrectiveCycle` (§10).

---

## 5. Iterative planning

`generatePlanningIterative` is a **tool-calling agentic loop** (up to
`MAX_PLANNING_ITERATIONS = 20` turns), not a single shot. The planner model is given
three tools:

- **`assign_task`** — assign a task to an agent, with:
  - `steps[]` — optional sub-steps (accepted only if ≥ 2, capped at `MAX_SUBSTEPS = 8`);
  - `depends_on[]` — DAG edges (resolved by id, by name, or by parent-prefixed fuzzy
    match, then persisted to the project on disk);
  - **`expected_files[]`** — the **deliverable contract** (see below);
  - **`checks{}`** — machine-verifiable per-file constraints (see below).
- **`create_sub_agent`** — spawn a new agent (`work|code|recherche|design`) under a
  parent, capped at `MAX_SUB_AGENTS = 15`. Persisted as a generated project named
  `"<parent> › <sub>"`.
- **`finish_planning`** — end planning (refused while any linked agent still has no
  task).

If the model replies in prose instead of calling tools on the first turn, a JSON
fallback parses `{agentId|name: task}`; as a last resort the global task is assigned
to every agent. After the loop, any still-unassigned agent receives the global task.

There is **no separate re-planning trigger** — refinement happens through the
corrective cycle (§10), not by re-running the planner.

### The two contracts the planner declares

**`expected_files`** — the hard file contract. A declared file that is missing at the
end = a failed task = automatic relaunch. Paths are sanitized (≤ 50 entries, ≤ 200
chars, no absolute/`..`/dotfile/null-byte). One canonical path per logical
deliverable; shared files are produced once and `depends_on`-ed, never copied.

**`checks`** — per-file, machine-checkable constraints, keyed by workspace-relative
path:

| Constraint           | Meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `minWords`           | Minimum word count.                                                     |
| `minItems`           | Minimum array length (JSON top-level or `.items`).                      |
| `minSections`        | Minimum `##`/`###` headings.                                            |
| `requiredSubstrings` | Substrings that must appear (case-insensitive).                         |
| `format`             | `json` (must parse) / `csv` (column-consistent) / `md` (has a heading). |

These are **enforced deterministically — the LLM never judges them.** Inputs are
sanitized and clamped (e.g. `minWords` ≤ 100000), and keys go through the same path
sanitizer so a hallucinated key can never become a filesystem oracle.

---

## 6. Node execution

`runOneNode` wraps each node: it derives the node's expected files and a per-file
"floor" of checks (prose `.md`/`.txt` deliverables get a default `minWords` floor of
`PROSE_FLOOR_WORDS = 400` unless declared otherwise), installs a **path filter** that
scopes every write to that node (§8), then calls `executeNode`.

`executeNode` chooses the strategy:

- **Backend dispatch.** If the node has a backend (`code` → OpenCode, `design` →
  Open Design), it ensures the process is running and calls the backend. On
  `BackendUnavailableError` (port down) or any non-abort error, it **falls back to the
  LLM path** with a warning.
- **Pure-LLM path** (`work`/`recherche`/`verifier`, and any fallback). Routing, in
  priority order:
  1. predefined `steps` (≥ 2) → step-by-step execution;
  2. `autoSteps` → runtime LLM decomposition into steps;
  3. weak tier + large task → forced decomposition;
  4. multi-turn types (`work`, `code`) → `executeMultiTurn`;
  5. otherwise → a single call (with limited retries).

**Multi-turn execution** (`executeMultiTurn`). A "turn" is one streamed LLM call plus
a separate completeness-check call. After each turn, any emitted files are written.
The loop stops when the completeness check returns `complete` **and** the word count
meets the declared `minWords` target — a **volume gate** keeps the agent developing
content even if the model prematurely declares itself done. Hard cap on turns comes
from the tier: **6 (strong) / 10 (weak)**.

**Sub-steps.** When a task is decomposed, producer types (`work`/`code`) run each step
multi-turn and need no synthesis; non-producer types run each step once, then a
**synthesis pass** merges the steps into one deliverable. Decomposition asks the model
for a 2–8 step JSON array, falling back to a single step on parse failure.

**Tiers.** `adaptToWeakModel` selects `WEAK_TIER` vs `STRONG_TIER`, controlling
compact prompts, max iterations (6 vs 10), max sub-step iterations (4 vs 6) and forced
decomposition. In weak tier, backend calls get an extra directive since a backend does
a single `execute()` (the iteration axis doesn't apply to it).

---

## 7. Backends

Both backends implement `ExecutionBackend` (`orchestrator-backends/types.ts`): a
`slot`, an `apiPort`, `isAvailable()`, and `execute(ctx)`. The context carries the
node, workspace dir, prompts, model, abort signal, a progress callback, and
**`otherOwnedPaths`** — paths owned by other agents, to be write-denied. The result
reports `resultText`, `filesWritten`, and the actual `writtenPaths` — so a node that
wrote real files but returned a terse summary ("Created 6 files") is **not** judged
trivial and re-run through the LLM, which would clobber tool-authored files.

**OpenCode backend** (`code`/`work` slot → `127.0.0.1:4096`). It snapshots workspace
file mtimes, opens a session with a **permission ruleset**, sends the prompt
(15-minute timeout), then diffs the snapshot to learn what was written. Permission
design: a catch-all **deny** first, then workspace-scoped `write`/`read`/`edit`
allows, then **per-path denies for every other agent's owned files** (last-match-wins
ordering enforces ownership). **`bash` is intentionally excluded** — write/edit
suffice and shell would let the model run arbitrary commands. A **plan-only guard**
detects "here's my plan" replies that wrote zero files and pushes up to 2 "stop
planning, produce now" follow-ups.

**Open Design backend** (`design` slot → daemon on `127.0.0.1:7456`). It finds/creates
a project, then runs an **iterative refinement loop** (up to 3 iterations, with first-run
/ refine / total time budgets). After each run it exports the artifacts into
`workspace/design/<id>/`, **skipping symlinks** for safety, and refines when content is
thin or contains placeholders. The mockups are both written to disk **and** inlined into
`resultText` as `filepath:` blocks, so downstream agents can read them directly.

---

## 8. Dependency context & file ownership

### Injecting upstream results downstream

`buildDependencyContext` passes prior agents' results to a downstream node. For each
dependency it emits `Agent "<name>" (<type>) — Task — Result`. Budgets: design
dependencies get 60 000 chars, others 24 000, with a global cap of 96 000; once the
budget is exhausted, remaining deps are named only. Not-yet-run deps show
`(not yet executed)`.

For the pure-LLM path, the engine also injects **disk evidence** — the real on-disk
content of each dependency's `expected_files`, marked as _authoritative_ — because
those nodes have no tools to read the workspace themselves.

**Fidelity mandates** are appended only when the node _reproduces_ upstream work
(`code`/`work`):

- if a dependency is a `design` agent or produced `.html`/`.css` → a strict
  **web mandate**: reproduce every mockup pixel-faithfully, code all pages, zero dead
  links, identical class names and images, keep the CSS filename;
- else if a dependency is `design`/`work`/`recherche` → a **neutral mandate**: reuse
  the upstream contracts/schemas/names/data faithfully, resolve contradictions to one
  version.

A shared **asset policy** is baked into the code/design/work rules — the single
biggest fix for broken renders: **ban external image URLs** (unsplash/picsum 404 at
deploy → use inline SVG), exactly one `styles.css` in the same folder as the pages,
every local `href`/`src` must point to a real file.

### The ownership model (write-lock per agent)

Every write goes through a per-node **path filter**:

- **Shared paths** (`WORKSPACE_INDEX.md`, `reports/*`) are always writable.
- The node's own **declared `expected_files`** are always writable.
- A path **owned by another node is refused** — the first node to write a non-shared
  path claims it (`fileOwner` map). This stops corrective-cycle agents (especially
  research/design) from clobbering siblings' deliverables.
- A free, unowned path is writable **only on the first run**. On a re-run a node may
  rewrite its own files but **cannot mint new free paths** — this prevents parasitic
  `public/` sites from spawning during corrections.

Backends additionally receive every other agent's owned paths as hard `deny` rules,
and report their `writtenPaths` so the file extractor skips them rather than
overwriting.

### File extraction

Agents on the LLM path emit files as fenced blocks with a **mandatory `filepath:`
marker**:

````
```python filepath: src/api/auth.py
<file content>
```
````

`extractAndWriteFiles` runs three parsers (the primary `filepath:` form, a
`**Fichier: `path`**` form, and inline `// filepath:` comments), deduped so mixed
formats aren't dropped. The closing fence is found by scanning **backwards** from the
next opener, so a file whose content contains its own ``` (e.g. a README with code
samples) is **not truncated**. Writes are capped (`MAX_WRITTEN_FILES = 200`,
`MAX_FILE_BYTES = 5 MiB`), path-validated, and lexically + symlink-contained inside
the workspace before hitting disk.

---

## 9. The quality gate

`runQualityGate` is one audit pass that combines **deterministic detectors** (no LLM)
with an **LLM verifier**, and merges them **fail-closed**:

```
pass = llmVerdict !== null && llmVerdict.pass === true && deterministicIssues.length === 0
```

So: an unparseable LLM verdict **blocks** (it used to sail through), and any
deterministic defect forces a fail **regardless of the model's judgment**. Issues are
attributed to the **owning agent** (via the `expected_files` map) so fixes route to
whoever produced the broken file. The merged list is capped at 30.

### Deterministic detectors (force-fail)

All run as pure static analysis in the main process — no code is executed:

- **Broken asset refs** — `src`/`href`/`url()` pointing at files that don't exist;
  placeholder hotlinks (unsplash, picsum, placehold.co…) flagged as broken.
- **Uncoded mockups** — a `mockups/` page with no coded counterpart elsewhere.
- **Served-site problems** — gray `data:image/svg+xml` placeholders; `../` refs/imports
  that escape the served root (break on deploy).
- **CSS consistency** — multiple pages that share no common stylesheet.
- **Invalid JSON** — every `.json` (except `*.artifact.json`) must parse.
- **CSV columns** — every row must match the header's column count.
- **Placeholder deliverables** — `lorem ipsum`, `[à compléter]`, `coming soon`, `todo:`
  (density-guarded so a single mention in a long doc is spared).
- **Consolidation shrinkage** — a "final/complete" file shorter than 80% of its source
  content (summarized instead of consolidated).
- **Unstyled classes** — pages where ≥ 3 classes and ≥ 30% of used classes have no CSS
  rule (framework-CDN pages excepted).
- **Served HTML placeholders** — visible filler text or `class="...placeholder..."`
  containers (not the legit `<input placeholder>` attribute).
- **Structured-data mismatch** — a JSON-LD `price` not present in the visible page text
  (with number-boundary guards so `14` doesn't match inside `114`).
- **Orphan stylesheets/scripts** — assets under a served root that no HTML references,
  directly or through an `@import` chain.
- **Declared-checks validation** — enforces the planner's `checks` contract (§5).
- **Module-graph gate** — see below.

A second set of **warning-only** detectors (unreferenced modules, divergent/scattered
duplicates, unwanted web scaffolding, useless design artifacts, headless render
problems) runs **only** in the no-verifier path (§11), because they have a higher
false-positive rate and shouldn't hard-fail a run.

### The module-graph gate

`findModuleGraphProblems` targets the #1 multi-agent failure mode: **APIs that don't
line up across files written by different agents** — invisible to a text-judging LLM
and to per-file checks. It statically parses Python and TS/JS into a module graph of
exports and imports (no execution), resolves local import edges, and flags:

- **Inconsistent inter-agent API** — file A imports `sort_data` from module B, but B
  only exports `DataSorter`. The deliverable won't even import → force-fail. (Wildcard
  re-exports suppress the check, since the exported name set is unprovable.)
- **Orphan / dead code** — a module that exports symbols but is never imported by any
  other file = an agent's output that was never integrated. Conservative: only runs
  with ≥ 3 files, and skips entry points (`index`/`main`/`app`/`server`/`cli`…),
  tests, and `dist`/`build`.

This is what catches the classic "two agents, two incompatible APIs, ships broken"
outcome that an optimistic verifier would wave through.

### Fail-closed everywhere

The JSON extractor returns `null` (→ block) rather than guessing when there's no valid
object; unreadable files are skipped; containment guards refuse to even `stat` paths
that escape the workspace. Detector caps only truncate the _list of reported problems_
— a capped, non-empty list still force-fails; hitting a cap is never mistaken for
"all clear."

---

## 10. Corrective cycle & retries

`runAutoQualityLoop` runs up to `MAX_AUTO_QUALITY_LOOPS = 2` cycles. Each cycle calls
`runQualityGate`; on a pass it returns. On a failure it formats the issues as
`- [agent] issue → fix`, builds a synthetic run, and calls `runCorrectiveCycle`:

- `planIterationFixes` (LLM triage) maps the feedback to specific agent ids; if it
  targets none, it throws.
- Each targeted agent gets a rewritten fix task and is re-executed **through the DAG**
  (only the targeted subset), with previous results seeded so untargeted nodes keep
  their output.
- Results merge back, and the loop re-audits.

The same `runCorrectiveCycle` powers the human-feedback `iterate()` entry point.

**Retry semantics & clamps:**

- Per-node LLM retries: `clampRetries(n) = min(max(n ?? 3, 1), MAX_NODE_RETRIES = 5)`,
  retrying only on watchdog timeouts.
- Deliverable-enforcement retries: `min(max(maxRetries ?? 2, 1), 5)` — relaunches with
  a missing-files / content-shortfall / trivial-result prompt depending on the failure.
- Enforcement is **non-blocking unless the initial result was trivial**
  (`< MIN_RESULT_CHARS = 200`): a missing-file outcome normally becomes a warning, but a
  trivial result throws (node → error).

---

## 11. The no-verifier path

If the orchestration has no `verifier` agent, the run can't self-correct — so instead
of a fix loop, `warnOnBrokenAssets` runs the **full** detector suite (including the
warning-only detectors and an optional headless render check) and surfaces a **single
non-blocking warning** summarizing what's broken. It never fails the run and never
triggers a rerun — it just makes sure a silently-broken build doesn't look like a
success. Add a verifier agent to turn this into an actual self-correcting loop.

---

## 12. Constants reference

| Constant                        | Value           | Meaning                                                 |
| ------------------------------- | --------------- | ------------------------------------------------------- |
| `MAX_PLANNING_ITERATIONS`       | 20              | Tool-calling turns during planning.                     |
| `MAX_SUB_AGENTS`                | 15              | Planner-created sub-agents.                             |
| `MAX_SUBSTEPS`                  | 8               | Sub-steps per node.                                     |
| `MAX_PARALLEL_NODES`            | 1               | Concurrency — currently strictly sequential.            |
| `STRONG_TIER` iterations        | 6 / 4           | Multi-turn / sub-step iterations (capable models).      |
| `WEAK_TIER` iterations          | 10 / 6          | Multi-turn / sub-step iterations (weak models).         |
| `MAX_NODE_RETRIES`              | 5               | Hard ceiling on per-node LLM retries (default 3).       |
| `MAX_RETRIES_CEILING` (enforce) | 5               | Ceiling on deliverable-enforcement retries (default 2). |
| `MAX_AUTO_QUALITY_LOOPS`        | 2               | Self-correction cycles.                                 |
| `MAX_WRITTEN_FILES`             | 200             | Files per extraction call.                              |
| `MAX_FILE_BYTES`                | 5 MiB           | Per-file write cap.                                     |
| `PROSE_FLOOR_WORDS`             | 400             | Default `minWords` floor for prose deliverables.        |
| `MIN_RESULT_CHARS`              | 200             | Triviality threshold.                                   |
| dep context caps                | 24k / 60k / 96k | Per-dep (other / design) and global context budgets.    |

> Note: with `MAX_PARALLEL_NODES = 1`, the parallel "wave" executor and its
> Kahn-based topological sort exist in the code but are dormant — execution is
> sequential in practice.

---

## 13. Worked example — the seed projects

A fresh install seeds a demo orchestration ("Refonte onboarding", `project-seed.ts`):

- **p1** `code` — Auth API (OAuth2 + refresh tokens)
- **p2** `design` — Design system (buttons & inputs)
- **p3** `work` — CI/CD pipeline
- **p4** `orchestrator` — coordinator, `linked: [p1,p2,p3,p5]`,
  `orchSettings: { autoDistribute, checkCoherence, relaunchOnError }`
- **p5** `code` — E2E Playwright tests, `dependencies: [p1]`
- **p6** `verifier` — global QA, `dependencies: [p1,p2,p3,p5]`, `bypassMemory`

This is a concrete DAG: a coordinator over a code backend, a design backend, a
work/pure-LLM agent, a dependent code agent (p5 → p1), and a fan-in verifier (p6 over
all producers). It's the quickest way to see the full plan → execute → verify →
self-correct cycle in action.

---

See also: [Architecture](../ARCHITECTURE.md) · [Usage](USAGE.md) · [FAQ](FAQ.md)
