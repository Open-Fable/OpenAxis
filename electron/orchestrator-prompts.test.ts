import { describe, it, expect } from "vitest";
import type { Project } from "./project-store.js";
import {
  buildDependencyContext,
  buildPlanningSystemPrompt,
  buildPlanningUserPrompt,
  buildNodeSystemPrompt,
  buildNodeUserPrompt,
  buildContinuationPrompt,
  buildCompletenessCheckPrompt,
  buildIterationPrompt,
  buildVerifyPromptsSystemPrompt,
  buildVerifyPromptsUserPrompt,
  buildVerifyOutputSystemPrompt,
  buildVerifyOutputUserPrompt,
  buildBrandComplianceSystemPrompt,
  buildBrandComplianceUserPrompt,
  buildWorkspaceIndexSystemPrompt,
  buildWorkspaceIndexUserPrompt,
  buildDecomposeSystemPrompt,
  buildDecomposeUserPrompt,
  buildSubStepUserPrompt,
  buildSynthesisSystemPrompt,
  buildSynthesisUserPrompt,
  buildIterativePlanningSystemPrompt,
  buildIterativePlanningUserPrompt,
  type SubStep,
  type SubStepResult,
} from "./orchestrator-prompts.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Agent Test",
    instructions: "",
    type: "code",
    dependencies: [],
    task: "Tâche de test",
    ...overrides,
  } as Project;
}

// ── buildDependencyContext ─────────────────────────────────────────────────

describe("buildDependencyContext", () => {
  it("returns empty string when node has no dependencies", () => {
    const node = makeProject({ dependencies: [] });
    const result = buildDependencyContext(node, [], new Map());
    expect(result).toBe("");
  });

  it("returns empty string when dependencies is undefined", () => {
    const node = makeProject({ dependencies: undefined });
    const result = buildDependencyContext(node, [], new Map());
    expect(result).toBe("");
  });

  it("includes the dependency name, type and task in the context block", () => {
    const dep = makeProject({
      id: "dep1",
      name: "Designer",
      type: "design",
      task: "Faire les maquettes",
    });
    const node = makeProject({ id: "p1", dependencies: ["dep1"] });
    const results = new Map([["dep1", "Résultat du designer"]]);

    const out = buildDependencyContext(node, [dep], results);

    expect(out).toContain("PREVIOUS AGENT RESULTS");
    expect(out).toContain("Designer");
    expect(out).toContain("design");
    expect(out).toContain("Faire les maquettes");
    expect(out).toContain("Résultat du designer");
  });

  it("shows placeholder when a dependency has not been executed yet", () => {
    const dep = makeProject({ id: "dep1", name: "Designer" });
    const node = makeProject({ id: "p1", dependencies: ["dep1"] });

    const out = buildDependencyContext(node, [dep], new Map());

    expect(out).toContain("(not yet executed)");
  });

  it("skips dependency ids that do not resolve to a project", () => {
    const node = makeProject({ id: "p1", dependencies: ["ghost"] });
    const out = buildDependencyContext(node, [], new Map([["ghost", "x"]]));
    expect(out).toBe("");
  });

  it("truncates design dependency results to 60_000 chars", () => {
    const dep = makeProject({ id: "dep1", type: "design" });
    const node = makeProject({ id: "p1", dependencies: ["dep1"] });
    const huge = "x".repeat(70_000);
    const out = buildDependencyContext(node, [dep], new Map([["dep1", huge]]));
    // 60_000 of the x's should survive, not all 70_000
    expect(out).toContain("x".repeat(60_000));
    expect(out).not.toContain("x".repeat(60_001));
  });

  it("truncates non-design dependency results to 24_000 chars", () => {
    const dep = makeProject({ id: "dep1", type: "code" });
    const node = makeProject({ id: "p1", dependencies: ["dep1"] });
    const huge = "y".repeat(30_000);
    const out = buildDependencyContext(node, [dep], new Map([["dep1", huge]]));
    expect(out).toContain("y".repeat(24_000));
    expect(out).not.toContain("y".repeat(24_001));
  });

  it("bounds the cumulative size across many large dependencies", () => {
    const deps = Array.from({ length: 6 }, (_, i) =>
      makeProject({ id: `dep${i}`, type: "code" }),
    );
    const node = makeProject({
      id: "p1",
      dependencies: deps.map((d) => d.id),
    });
    const results = new Map(deps.map((d) => [d.id, "z".repeat(24_000)]));
    const out = buildDependencyContext(node, deps, results);
    // 6 × 24k = 144k uncapped; the global budget keeps it well under that.
    expect(out.length).toBeLessThan(110_000);
    // Later deps are still named even when their content is dropped.
    expect(out).toContain("context budget reached");
  });

  it("appends a fidelity mandate when a code node depends on a design agent", () => {
    const dep = makeProject({ id: "dep1", type: "design" });
    const node = makeProject({ id: "p1", type: "code", dependencies: ["dep1"] });
    const out = buildDependencyContext(node, [dep], new Map([["dep1", "maquette"]]));
    expect(out).toContain("FIDELITY MANDATE");
    expect(out).toContain("reproduce them IDENTICALLY");
  });

  it("appends a fidelity mandate when a code node depends on a work agent", () => {
    const dep = makeProject({ id: "dep1", type: "work" });
    const node = makeProject({ id: "p1", type: "code", dependencies: ["dep1"] });
    const out = buildDependencyContext(node, [dep], new Map([["dep1", "charte"]]));
    expect(out).toContain("FIDELITY MANDATE");
  });

  it("does NOT append a fidelity mandate when only a code agent is a dependency", () => {
    const dep = makeProject({ id: "dep1", type: "code" });
    const node = makeProject({ id: "p1", type: "code", dependencies: ["dep1"] });
    const out = buildDependencyContext(node, [dep], new Map([["dep1", "code"]]));
    expect(out).not.toContain("FIDELITY MANDATE");
  });

  it("injects per-dependency disk evidence when provided (Problème 7)", () => {
    const dep = makeProject({ id: "dep1", name: "Recherche", type: "recherche" });
    const node = makeProject({ id: "p1", type: "work", dependencies: ["dep1"] });
    const evidence = new Map([["dep1", '✓ schema.json (120 octets) :\n{"k":"v"}']]);
    const out = buildDependencyContext(
      node,
      [dep],
      new Map([["dep1", "résumé chat"]]),
      evidence,
    );
    expect(out).toContain("PRODUCED FILES");
    expect(out).toContain("schema.json");
    expect(out).toContain('{"k":"v"}');
  });

  it("omits the disk-evidence block when none is provided for a dependency", () => {
    const dep = makeProject({ id: "dep1", type: "work" });
    const node = makeProject({ id: "p1", type: "work", dependencies: ["dep1"] });
    const out = buildDependencyContext(node, [dep], new Map([["dep1", "x"]]), new Map());
    expect(out).not.toContain("PRODUCED FILES");
  });

  it("does NOT append a fidelity mandate for a verifier node even with design deps", () => {
    const dep = makeProject({ id: "dep1", type: "design" });
    const node = makeProject({ id: "p1", type: "verifier", dependencies: ["dep1"] });
    const out = buildDependencyContext(node, [dep], new Map([["dep1", "maquette"]]));
    expect(out).not.toContain("FIDELITY MANDATE");
  });

  it("injects the INTERFACE CONTRACT block when depExpectedFilesMap is provided", () => {
    const dep = makeProject({ id: "dep1", name: "API Agent", type: "code" });
    const node = makeProject({ id: "p2", type: "code", dependencies: ["dep1"] });
    const out = buildDependencyContext(
      node,
      [dep],
      new Map([["dep1", "result"]]),
      undefined,
      { dep1: ["src/api/router.ts", "src/api/service.ts"] },
    );
    expect(out).toContain("INTERFACE CONTRACT");
    expect(out).toContain("src/api/router.ts");
    expect(out).toContain("src/api/service.ts");
    expect(out).toContain("do not invent alternatives");
  });

  it("omits the INTERFACE CONTRACT block when no files are declared for a dep", () => {
    const dep = makeProject({ id: "dep1", type: "code" });
    const node = makeProject({ id: "p2", type: "code", dependencies: ["dep1"] });
    const out = buildDependencyContext(
      node,
      [dep],
      new Map([["dep1", "result"]]),
      undefined,
      { dep1: [] },
    );
    expect(out).not.toContain("INTERFACE CONTRACT");
  });

  it("omits the INTERFACE CONTRACT block when depExpectedFilesMap is not provided", () => {
    const dep = makeProject({ id: "dep1", type: "code" });
    const node = makeProject({ id: "p2", type: "code", dependencies: ["dep1"] });
    const out = buildDependencyContext(node, [dep], new Map([["dep1", "result"]]));
    expect(out).not.toContain("INTERFACE CONTRACT");
  });
});

// ── buildPlanningSystemPrompt / UserPrompt ─────────────────────────────────

describe("buildPlanningSystemPrompt", () => {
  it("includes custom instructions when present", () => {
    const orch = makeProject({ instructions: "Sois concis." });
    const out = buildPlanningSystemPrompt(orch);
    expect(out).toContain("CUSTOM INSTRUCTIONS");
    expect(out).toContain("Sois concis.");
  });

  it("omits the custom instructions block when instructions are empty", () => {
    const orch = makeProject({ instructions: "" });
    const out = buildPlanningSystemPrompt(orch);
    expect(out).not.toContain("CUSTOM INSTRUCTIONS");
  });

  it("describes all agent role types", () => {
    const out = buildPlanningSystemPrompt(makeProject());
    for (const role of ["recherche", "work", "design", "code", "verifier"]) {
      expect(out).toContain(role);
    }
  });
});

describe("buildPlanningUserPrompt", () => {
  it("lists each linked project with id, name and type", () => {
    const projects = [
      makeProject({ id: "a", name: "Alpha", type: "work" }),
      makeProject({ id: "b", name: "Beta", type: "code" }),
    ];
    const out = buildPlanningUserPrompt("Construire un site", projects, "[ÉTAT]");

    expect(out).toContain("Construire un site");
    expect(out).toContain('ID: "a"');
    expect(out).toContain("Alpha");
    expect(out).toContain('ID: "b"');
    expect(out).toContain("Beta");
    expect(out).toContain("[ÉTAT]");
  });

  it("resolves dependency ids to names in the agent list", () => {
    const projects = [
      makeProject({ id: "a", name: "Alpha" }),
      makeProject({ id: "b", name: "Beta", dependencies: ["a"] }),
    ];
    const out = buildPlanningUserPrompt("Tâche", projects, "");
    expect(out).toContain("Depends on: Alpha");
  });
});

// ── buildNodeSystemPrompt ──────────────────────────────────────────────────

describe("buildNodeSystemPrompt", () => {
  it("uses the code-fence file format by default", () => {
    const out = buildNodeSystemPrompt(makeProject({ type: "code" }));
    expect(out).toContain("FILE FORMAT (REQUIRED)");
    expect(out).toContain("filepath:");
  });

  it("uses the file-tools format when codeFenceFormat is false", () => {
    const out = buildNodeSystemPrompt(makeProject({ type: "code" }), {
      codeFenceFormat: false,
    });
    expect(out).toContain("FILE TOOLS");
    expect(out).toContain("EXECUTE IMMEDIATELY");
  });

  it("backend prompt instructs relative paths, no shell, and markdown fallback when codeFenceFormat is false", () => {
    const out = buildNodeSystemPrompt(makeProject({ type: "code" }), {
      codeFenceFormat: false,
    });
    expect(out).toContain("RELATIVE paths");
    expect(out).toContain("NEVER absolute paths");
    expect(out).toContain("shell access");
    expect(out).toContain("LAST RESORT");
  });

  it("injects the design quality rules for a design agent", () => {
    const out = buildNodeSystemPrompt(makeProject({ type: "design" }));
    expect(out).toContain("VISUAL MOCKUPS");
  });

  it("falls back to code quality rules for an unknown type", () => {
    const out = buildNodeSystemPrompt(makeProject({ type: "weird" as Project["type"] }));
    expect(out).toContain("PRODUCTION-READY");
  });

  it("uses node.instructions as identity when present", () => {
    const out = buildNodeSystemPrompt(makeProject({ instructions: "Je suis spécial" }));
    expect(out).toContain("Je suis spécial");
  });
});

// ── buildNodeSystemPrompt — tier « modèle léger » (compact) ─────────────────

describe("buildNodeSystemPrompt — compact", () => {
  it("produces a shorter prompt than the non-compact variant", () => {
    const node = makeProject({ type: "code" });
    const full = buildNodeSystemPrompt(node, { compact: false });
    const compact = buildNodeSystemPrompt(node, { compact: true });
    expect(compact.length).toBeLessThan(full.length);
  });

  it("includes a good/bad mini-example in the compact variant", () => {
    const out = buildNodeSystemPrompt(makeProject({ type: "code" }), { compact: true });
    expect(out).toContain("✅");
    expect(out).toContain("❌");
  });

  it("uses the short behavior block when compact, full block otherwise", () => {
    const node = makeProject({ type: "code" });
    expect(buildNodeSystemPrompt(node, { compact: false })).toContain("BEHAVIOR");
    const compact = buildNodeSystemPrompt(node, { compact: true });
    expect(compact).toContain("BEHAVIOR :");
  });

  // Non-régression sécurité : les invariants critiques DOIVENT survivre au compactage.
  it("preserves the secrets → env-var invariant in the compact code rules", () => {
    const out = buildNodeSystemPrompt(makeProject({ type: "code" }), { compact: true });
    expect(out).toContain("environment");
  });

  it("preserves identity coherence in the compact code/work rules", () => {
    const code = buildNodeSystemPrompt(makeProject({ type: "code" }), { compact: true });
    const work = buildNodeSystemPrompt(makeProject({ type: "work" }), { compact: true });
    expect(code).toContain("identity");
    expect(work).toContain("identity");
  });

  it("preserves the external-image ban in the compact asset policy", () => {
    const out = buildNodeSystemPrompt(makeProject({ type: "design" }), { compact: true });
    expect(out.toLowerCase()).toContain("unsplash");
    expect(out).toContain("inline SVG");
  });

  it("leaves the non-compact (strong) prompt byte-identical to the default", () => {
    const node = makeProject({ type: "code" });
    expect(buildNodeSystemPrompt(node, { compact: false })).toBe(
      buildNodeSystemPrompt(node),
    );
  });
});

// ── buildNodeUserPrompt ────────────────────────────────────────────────────

describe("buildNodeUserPrompt", () => {
  it("includes the task and the critical reminder", () => {
    const out = buildNodeUserPrompt(makeProject({ task: "Faire X" }), "", "");
    expect(out).toContain("Faire X");
    expect(out).toContain("CRITICAL REMINDER");
  });

  it("renders an expected-files contract when files are provided", () => {
    const out = buildNodeUserPrompt(makeProject(), "", "", ["a.html", "b.css"]);
    expect(out).toContain("FILE CONTRACT");
    expect(out).toContain("- a.html");
    expect(out).toContain("- b.css");
  });

  it("omits workspace and dependency sections when empty", () => {
    const out = buildNodeUserPrompt(makeProject(), "", "");
    expect(out).not.toContain("WORKSPACE");
  });

  it("appends workspace and dependency context when provided", () => {
    const out = buildNodeUserPrompt(makeProject(), "WS-CTX", "DEP-CTX");
    expect(out).toContain("WS-CTX");
    expect(out).toContain("DEP-CTX");
  });

  it("falls back to a default task label when task is missing", () => {
    const out = buildNodeUserPrompt(makeProject({ task: undefined }), "", "");
    expect(out).toContain("No task defined.");
  });

  it("uses markdown filepath format by default (codeFenceFormat: true)", () => {
    const out = buildNodeUserPrompt(makeProject(), "", "");
    expect(out).toContain("filepath:");
    expect(out).not.toContain("write/edit tools");
  });

  it("switches to tool-based reminder when codeFenceFormat is false", () => {
    const out = buildNodeUserPrompt(makeProject(), "", "", [], {
      codeFenceFormat: false,
    });
    expect(out).toContain("write/edit tools");
    expect(out).toContain("last resort");
    expect(out).toContain("RELATIVE paths");
    expect(out).toContain("shell access");
  });
});

// ── Continuation / completeness / iteration ────────────────────────────────

describe("buildContinuationPrompt", () => {
  it("includes attempt counters and the tail of the previous text", () => {
    const prev = "A".repeat(600) + "TAIL_MARKER";
    const out = buildContinuationPrompt(makeProject({ task: "T" }), prev, 2, 3);
    expect(out).toContain("attempt 2/3");
    expect(out).toContain("TAIL_MARKER");
    // Only the last 500 chars are kept, so the very start is dropped
    expect(out).not.toContain("A".repeat(600));
  });
});

describe("buildCompletenessCheckPrompt", () => {
  it("asks for a strict JSON completeness answer", () => {
    const out = buildCompletenessCheckPrompt(makeProject(), "du travail");
    expect(out).toContain('{"complete": true}');
    expect(out).toContain("du travail");
  });
});

describe("buildIterationPrompt", () => {
  it("includes the missing description and iteration counters", () => {
    const out = buildIterationPrompt(
      makeProject(),
      "déjà fait",
      "il manque la home",
      1,
      4,
    );
    expect(out).toContain("ITERATION 1/4");
    expect(out).toContain("il manque la home");
  });
});

// ── Verification prompts ───────────────────────────────────────────────────

describe("buildVerifyPromptsSystemPrompt", () => {
  it("uses verifier instructions when present", () => {
    const out = buildVerifyPromptsSystemPrompt(
      makeProject({ instructions: "Vérif perso" }),
    );
    expect(out).toContain("Vérif perso");
  });

  it("falls back to a default verifier identity", () => {
    const out = buildVerifyPromptsSystemPrompt(makeProject({ instructions: "" }));
    expect(out).toContain("instruction quality verifier");
  });
});

describe("buildVerifyPromptsUserPrompt", () => {
  it("serializes the prompts map and lists projects", () => {
    const projects = [makeProject({ id: "a", name: "Alpha", type: "code" })];
    const out = buildVerifyPromptsUserPrompt("Global", { a: "fais X" }, projects);
    expect(out).toContain("Global");
    expect(out).toContain("fais X");
    expect(out).toContain("Alpha");
    expect(out).toContain("VERIFICATION CHECKLIST");
  });
});

describe("buildVerifyOutputUserPrompt", () => {
  it("includes the full result when shorter than the excerpt limit", () => {
    const out = buildVerifyOutputUserPrompt(
      makeProject({ type: "code" }),
      "petit livrable",
    );
    expect(out).toContain("petit livrable");
    expect(out).toContain("SPECIFIC CRITERIA (code)");
  });

  it("truncates with a head+tail excerpt for long results", () => {
    const head = "H".repeat(4000);
    const tail = "T".repeat(4000);
    const out = buildVerifyOutputUserPrompt(makeProject(), head + tail);
    expect(out).toContain("characters omitted");
    // total length reported is the original
    expect(out).toContain(`${(head + tail).length} characters`);
  });

  it("selects design-specific criteria for a design node", () => {
    const out = buildVerifyOutputUserPrompt(makeProject({ type: "design" }), "x");
    expect(out).toContain("SPECIFIC CRITERIA (design)");
  });

  it("falls back to code criteria for an unknown type", () => {
    const out = buildVerifyOutputUserPrompt(
      makeProject({ type: "mystery" as Project["type"] }),
      "x",
    );
    expect(out).toContain("SPECIFIC CRITERIA (code)");
  });

  it("treats disk evidence as the source of truth when provided", () => {
    const out = buildVerifyOutputUserPrompt(
      makeProject({ type: "code" }),
      "agent prose summary",
      "✓ src/app.js (1200 octets) :\nconsole.log('hi')",
    );
    expect(out).toContain("GROUND TRUTH");
    expect(out).toContain("src/app.js");
    expect(out).toContain("never declare it");
    // the agent message is demoted to non-authoritative context
    expect(out).toContain("NOT authoritative");
  });

  it("does not add a disk section when no evidence is provided", () => {
    const out = buildVerifyOutputUserPrompt(makeProject({ type: "code" }), "x");
    expect(out).not.toContain("GROUND TRUTH");
  });
});

// ── Brand compliance ───────────────────────────────────────────────────────

describe("buildBrandComplianceUserPrompt", () => {
  it("embeds the brand guidelines and the evaluation grid", () => {
    const out = buildBrandComplianceUserPrompt("Palette: bleu primaire");
    expect(out).toContain("Palette: bleu primaire");
    expect(out).toContain("EVALUATION GRID");
    expect(out).toContain("COLORS");
  });
});

describe("buildBrandComplianceSystemPrompt", () => {
  it("falls back to the default brand-guardian identity", () => {
    const out = buildBrandComplianceSystemPrompt(makeProject({ instructions: "" }));
    expect(out).toContain("brand guidelines guardian");
  });
});

// ── Workspace index ────────────────────────────────────────────────────────

describe("buildWorkspaceIndexSystemPrompt", () => {
  it("returns a non-empty analyst prompt", () => {
    expect(buildWorkspaceIndexSystemPrompt()).toContain("documentation analyst");
  });
});

describe("buildWorkspaceIndexUserPrompt", () => {
  it("upper-cases the node type and truncates the result", () => {
    const longResult = "z".repeat(5000);
    const out = buildWorkspaceIndexUserPrompt(
      makeProject({ name: "Coder", type: "code" }),
      longResult,
    );
    expect(out).toContain("(type: CODE)");
    expect(out).toContain("z".repeat(3000));
    expect(out).not.toContain("z".repeat(3001));
  });
});

// ── Decompose / sub-steps / synthesis ──────────────────────────────────────

describe("buildDecomposeSystemPrompt", () => {
  it("includes quality rules and the decomposition role", () => {
    const out = buildDecomposeSystemPrompt(makeProject({ type: "code" }));
    expect(out).toContain("ROLE");
    expect(out).toContain("steps");
  });
});

describe("buildDecomposeUserPrompt", () => {
  it("includes the task and the 2-to-8 step instruction", () => {
    const out = buildDecomposeUserPrompt(
      makeProject({ task: "Construire" }),
      "WS",
      "DEP",
    );
    expect(out).toContain("Construire");
    expect(out).toContain("Minimum 2 steps, maximum 8");
    expect(out).toContain("WS");
    expect(out).toContain("DEP");
  });
});

describe("buildSubStepUserPrompt", () => {
  const step: SubStep = {
    index: 1,
    title: "Étape Deux",
    focus: "Le focus",
    deliverable: "Le livrable",
  };

  it("renders the step header with 1-based numbering", () => {
    const out = buildSubStepUserPrompt(makeProject(), step, 3, [], "", "");
    expect(out).toContain("STEP 2/3 : Étape Deux");
    expect(out).toContain("Le focus");
    expect(out).toContain("Le livrable");
  });

  it("includes previous results when provided", () => {
    const prev: SubStepResult[] = [{ index: 0, title: "Première", output: "sortie une" }];
    const out = buildSubStepUserPrompt(makeProject(), step, 3, prev, "", "");
    expect(out).toContain("PREVIOUS STEPS RESULTS");
    expect(out).toContain("Step 1 : Première");
    expect(out).toContain("sortie une");
  });
});

describe("buildSynthesisUserPrompt", () => {
  it("lists all sub-step results and the original task", () => {
    const results: SubStepResult[] = [
      { index: 0, title: "Un", output: "out-un" },
      { index: 1, title: "Deux", output: "out-deux" },
    ];
    const out = buildSynthesisUserPrompt(makeProject({ task: "Big" }), results);
    expect(out).toContain("Big");
    expect(out).toContain("RESULTS OF 2 SUB-STEPS");
    expect(out).toContain("out-un");
    expect(out).toContain("out-deux");
  });
});

describe("buildSynthesisSystemPrompt", () => {
  it("describes the merge role", () => {
    const out = buildSynthesisSystemPrompt(makeProject());
    expect(out).toContain("merge");
  });
});

// ── Iterative planning ─────────────────────────────────────────────────────

describe("buildIterativePlanningSystemPrompt", () => {
  it("includes custom instructions and the role-distribution guidance", () => {
    const out = buildIterativePlanningSystemPrompt(
      makeProject({ instructions: "Mes règles" }),
    );
    expect(out).toContain("Mes règles");
    expect(out).toContain("assign_task");
    expect(out).toContain("expected_files");
  });
});

describe("buildIterativePlanningUserPrompt", () => {
  it("includes the global task, agent count and workspace context", () => {
    const projects = [
      makeProject({ id: "a", name: "Alpha" }),
      makeProject({ id: "b", name: "Beta" }),
    ];
    const out = buildIterativePlanningUserPrompt("Global Task", projects, "WS-STATE");
    expect(out).toContain("Global Task");
    expect(out).toContain("AVAILABLE AGENTS (2)");
    expect(out).toContain("WS-STATE");
    expect(out).toContain("finish_planning");
  });
});
