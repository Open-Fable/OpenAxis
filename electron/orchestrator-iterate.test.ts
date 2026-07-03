import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, OrchRun } from "./project-store.js";

// Force the triage LLM to return unusable text so planIterationFixes drops into
// its fallback path — that's the behavior under test (which agents get relaunched).
const callLLMWithTools = vi.fn();
vi.mock("./orchestrator-llm.js", () => ({
  callLLMWithTools: (...args: unknown[]) => callLLMWithTools(...args),
}));

const { buildFixTask, planIterationFixes } = await import("./orchestrator-iterate.js");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "agent",
    name: "Agent",
    instructions: "",
    color: "#000",
    type: "work",
    task: "",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeRun(ids: readonly string[]): OrchRun {
  return {
    id: "run-1",
    workflowId: "",
    orchProjectId: "orch",
    task: "tâche initiale",
    status: "done",
    nodeResults: ids.map((id) => ({
      projectId: id,
      name: id,
      status: "done" as const,
      result: "résultat",
    })),
    logs: [],
    startedAt: 0,
    finishedAt: 0,
    duration: 0,
  };
}

describe("buildFixTask", () => {
  it("embeds the user feedback and the requested fix", () => {
    const out = buildFixTask("Corrige le header", "Le header est cassé");
    expect(out).toContain("[CORRECTIVE ITERATION]");
    expect(out).toContain("Le header est cassé");
    expect(out).toContain("Corrige le header");
  });

  it("omits the previous-result block when no previous result is given", () => {
    const out = buildFixTask("fix", "feedback");
    expect(out).not.toContain("YOUR PREVIOUS RESULT");
  });

  it("includes the previous-result block when provided", () => {
    const out = buildFixTask("fix", "feedback", "ancien résultat");
    expect(out).toContain("YOUR PREVIOUS RESULT");
    expect(out).toContain("ancien résultat");
  });

  it("truncates the previous result to 4000 characters", () => {
    const huge = "p".repeat(5000);
    const out = buildFixTask("fix", "feedback", huge);
    expect(out).toContain("p".repeat(4000));
    expect(out).not.toContain("p".repeat(4001));
  });

  it("always restates the critical rules about modifying existing files", () => {
    const out = buildFixTask("fix", "feedback");
    expect(out).toContain("CRITICAL RULES");
    expect(out).toContain("SOURCE OF TRUTH");
    expect(out).toContain("NEVER SHORTEN");
  });

  it("injects the real on-disk content when provided", () => {
    const disk = "<html>contenu réel sur disque</html>";
    const out = buildFixTask("fix", "feedback", undefined, disk);
    expect(out).toContain("CURRENT CONTENT OF YOUR FILES ON DISK");
    expect(out).toContain(disk);
  });

  it("prefers on-disk content over the truncated previous-result excerpt", () => {
    const out = buildFixTask("fix", "feedback", "ancien résultat", "fichier disque");
    expect(out).toContain("fichier disque");
    expect(out).not.toContain("YOUR PREVIOUS RESULT");
    expect(out).not.toContain("ancien résultat");
  });

  it("falls back to the previous-result excerpt when disk content is empty", () => {
    const out = buildFixTask("fix", "feedback", "ancien résultat", "");
    expect(out).toContain("YOUR PREVIOUS RESULT");
    expect(out).toContain("ancien résultat");
  });

  it("injects the workspace file tree when provided", () => {
    const tree = "├── index.html\n└── style.css";
    const out = buildFixTask("fix", "feedback", undefined, undefined, tree);
    expect(out).toContain("[ALL FILES CURRENTLY IN WORKSPACE");
    expect(out).toContain("index.html");
    expect(out).toContain("style.css");
  });

  it("omits the workspace file tree block when not provided", () => {
    const out = buildFixTask("fix", "feedback");
    expect(out).not.toContain("[ALL FILES CURRENTLY IN WORKSPACE");
  });
});

describe("planIterationFixes fallback narrowing", () => {
  beforeEach(() => {
    callLLMWithTools.mockReset();
    // Unusable text response → JSON fallback fails → narrowed fallback path.
    callLLMWithTools.mockResolvedValue({
      message: {
        role: "assistant",
        content: "je ne sais pas trier",
        tool_calls: undefined,
      },
      finishReason: "stop",
    });
  });

  const orchestrator = makeProject({
    id: "orch",
    type: "orchestrator",
    name: "Orchestrateur",
  });
  const linked = [
    makeProject({ id: "a1", name: "Recherche" }),
    makeProject({ id: "a2", name: "Design" }),
    makeProject({ id: "a3", name: "Rédaction" }),
  ];

  it("relaunches only the agents tagged in structured auto-quality feedback", async () => {
    const feedback =
      "[CYCLE QUALITÉ AUTOMATIQUE]\nLe vérificateur a identifié :\n- [Design] couleurs incohérentes → harmoniser la palette";
    const fixes = await planIterationFixes({
      orchestrator,
      linked,
      feedback,
      previousRun: makeRun(["a1", "a2", "a3"]),
      workspaceContext: "",
    });
    expect(Object.keys(fixes)).toEqual(["a2"]);
  });

  it("relaunches all non-skipped agents for free-form feedback with no tags", async () => {
    const fixes = await planIterationFixes({
      orchestrator,
      linked,
      feedback: "le rendu global est décevant",
      previousRun: makeRun(["a1", "a2", "a3"]),
      workspaceContext: "",
    });
    expect(Object.keys(fixes).sort()).toEqual(["a1", "a2", "a3"]);
  });
});
