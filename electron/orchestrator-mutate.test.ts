import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, OrchRun } from "./project-store.js";
import {
  planMutations,
  applyMutations,
  buildFixTask,
  type MutationContext,
  type MutationBudget,
} from "./orchestrator-mutate.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "agent-1",
    name: "Agent 1",
    type: "code",
    instructions: "",
    model: "test-model",
    linked: [],
    dependencies: [],
    task: "build stuff",
    color: "",
    ...overrides,
  } as Project;
}

function makeOrchestrator(overrides: Partial<Project> = {}): Project {
  return makeProject({
    id: "orch-1",
    name: "Orchestrator",
    type: "orchestrator",
    instructions: "Custom instructions",
    ...overrides,
  });
}

function makePreviousRun(nodeResults: OrchRun["nodeResults"] = []): OrchRun {
  return {
    id: "run-1",
    task: "Build a web app",
    date: new Date().toISOString(),
    result: "done",
    nodeResults,
  } as OrchRun;
}

function makeBudget(autoRemaining = 2): MutationBudget {
  return { autoRemaining };
}

// ── Mock LLM ─────────────────────────────────────────────────────────────────

const mockCallLLMWithTools = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    message: { content: "", tool_calls: [] },
  }),
);

vi.mock("./orchestrator-llm.js", () => ({
  callLLMWithTools: mockCallLLMWithTools,
}));

const mockSaveProject = vi.hoisted(() =>
  vi.fn().mockImplementation(async (p: Partial<Project>) => ({
    id: p.id ?? `new-${Date.now()}`,
    ...p,
  })),
);

const mockGetProjects = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock("./project-store.js", () => ({
  saveProject: mockSaveProject,
  getProjects: mockGetProjects,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ── planMutations ────────────────────────────────────────────────────────────

describe("planMutations", () => {
  it("bypasses LLM entirely when targetNodeId is provided", async () => {
    const agent = makeProject({ id: "agent-1", name: "Agent 1" });
    const ctx: MutationContext = {
      orchestrator: makeOrchestrator(),
      linked: [agent],
      feedback: "Fix the header color",
      previousRun: makePreviousRun([
        { projectId: "agent-1", name: "Agent 1", status: "done", result: "ok" },
      ]),
      workspaceContext: "",
      budget: makeBudget(),
      targetNodeId: "agent-1",
    };

    const result = await planMutations(ctx);

    expect(result.outcome.kind).toBe("plan");
    if (result.outcome.kind === "plan") {
      expect(result.outcome.plan.mutations).toHaveLength(1);
      expect(result.outcome.plan.mutations[0]).toEqual({
        kind: "assign_fix",
        agentId: "agent-1",
        fixTask: "Fix the header color",
      });
    }
    expect(mockCallLLMWithTools).not.toHaveBeenCalled();
  });

  it("escalates when targetNodeId is unknown", async () => {
    const ctx: MutationContext = {
      orchestrator: makeOrchestrator(),
      linked: [makeProject({ id: "agent-1" })],
      feedback: "Fix stuff",
      previousRun: makePreviousRun(),
      workspaceContext: "",
      budget: makeBudget(),
      targetNodeId: "nonexistent",
    };

    const result = await planMutations(ctx);
    expect(result.outcome.kind).toBe("escalate");
  });

  it("escalates when budget is exhausted", async () => {
    const ctx: MutationContext = {
      orchestrator: makeOrchestrator(),
      linked: [makeProject()],
      feedback: "Fix it",
      previousRun: makePreviousRun(),
      workspaceContext: "",
      budget: makeBudget(0),
    };

    const result = await planMutations(ctx);
    expect(result.outcome.kind).toBe("escalate");
    if (result.outcome.kind === "escalate") {
      expect(result.outcome.question).toContain("budget");
    }
    expect(mockCallLLMWithTools).not.toHaveBeenCalled();
  });

  it("escalates on text-only response (no tool calls) at first iteration", async () => {
    mockCallLLMWithTools.mockResolvedValueOnce({
      message: { content: "I think we should fix agent-1", tool_calls: [] },
    });

    const ctx: MutationContext = {
      orchestrator: makeOrchestrator(),
      linked: [makeProject()],
      feedback: "Fix it",
      previousRun: makePreviousRun(),
      workspaceContext: "",
      budget: makeBudget(),
    };

    const result = await planMutations(ctx);
    expect(result.outcome.kind).toBe("escalate");
  });

  it("handles assign_fix tool call", async () => {
    mockCallLLMWithTools
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-1",
              function: {
                name: "assign_fix",
                arguments: JSON.stringify({
                  agent_id: "agent-1",
                  fix_task: "Fix the header",
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-2",
              function: { name: "finish_mutation", arguments: "{}" },
            },
          ],
        },
      });

    const ctx: MutationContext = {
      orchestrator: makeOrchestrator(),
      linked: [makeProject({ id: "agent-1", name: "Agent 1" })],
      feedback: "Fix header",
      previousRun: makePreviousRun([
        { projectId: "agent-1", name: "Agent 1", status: "done", result: "ok" },
      ]),
      workspaceContext: "",
      budget: makeBudget(2),
    };

    const result = await planMutations(ctx);
    expect(result.outcome.kind).toBe("plan");
    if (result.outcome.kind === "plan") {
      expect(result.outcome.plan.mutations).toHaveLength(1);
      expect(result.outcome.plan.mutations[0]).toEqual({
        kind: "assign_fix",
        agentId: "agent-1",
        fixTask: "Fix the header",
      });
      expect(result.budget.autoRemaining).toBe(1);
    }
  });

  it("handles modify_agent tool call", async () => {
    mockCallLLMWithTools
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-1",
              function: {
                name: "modify_agent",
                arguments: JSON.stringify({
                  agent_id: "agent-1",
                  task: "Updated task",
                  expected_files: ["new-file.ts"],
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-2",
              function: { name: "finish_mutation", arguments: "{}" },
            },
          ],
        },
      });

    const ctx: MutationContext = {
      orchestrator: makeOrchestrator(),
      linked: [makeProject({ id: "agent-1", name: "Agent 1" })],
      feedback: "Change the agent's task",
      previousRun: makePreviousRun(),
      workspaceContext: "",
      budget: makeBudget(),
    };

    const result = await planMutations(ctx);
    expect(result.outcome.kind).toBe("plan");
    if (result.outcome.kind === "plan") {
      expect(result.outcome.plan.mutations[0]).toEqual({
        kind: "modify_agent",
        agentId: "agent-1",
        task: "Updated task",
        dependsOn: undefined,
        expectedFiles: ["new-file.ts"],
      });
    }
  });

  it("handles create_agent tool call", async () => {
    mockCallLLMWithTools
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-1",
              function: {
                name: "create_agent",
                arguments: JSON.stringify({
                  parent_id: "agent-1",
                  name: "Contact Page",
                  type: "code",
                  task: "Create a contact page",
                  depends_on: [],
                  expected_files: ["contact.tsx"],
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-2",
              function: { name: "finish_mutation", arguments: "{}" },
            },
          ],
        },
      });

    const ctx: MutationContext = {
      orchestrator: makeOrchestrator(),
      linked: [makeProject({ id: "agent-1", name: "Agent 1" })],
      feedback: "Add a contact page",
      previousRun: makePreviousRun(),
      workspaceContext: "",
      budget: makeBudget(),
    };

    const result = await planMutations(ctx);
    expect(result.outcome.kind).toBe("plan");
    if (result.outcome.kind === "plan") {
      expect(result.outcome.plan.mutations[0]).toEqual({
        kind: "create_agent",
        name: "Contact Page",
        type: "code",
        task: "Create a contact page",
        dependsOn: [],
        expectedFiles: ["contact.tsx"],
        parentId: "agent-1",
      });
    }
  });

  it("handles escalate tool call", async () => {
    mockCallLLMWithTools
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-1",
              function: {
                name: "escalate",
                arguments: JSON.stringify({
                  question: "I don't understand which agent should handle dark mode",
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-2",
              function: { name: "finish_mutation", arguments: "{}" },
            },
          ],
        },
      });

    const ctx: MutationContext = {
      orchestrator: makeOrchestrator(),
      linked: [makeProject()],
      feedback: "Add dark mode",
      previousRun: makePreviousRun(),
      workspaceContext: "",
      budget: makeBudget(),
    };

    const result = await planMutations(ctx);
    expect(result.outcome.kind).toBe("escalate");
    if (result.outcome.kind === "escalate") {
      expect(result.outcome.question).toContain("dark mode");
    }
  });

  it("rejects unknown agent_id in assign_fix", async () => {
    mockCallLLMWithTools
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-1",
              function: {
                name: "assign_fix",
                arguments: JSON.stringify({
                  agent_id: "nonexistent",
                  fix_task: "Fix something",
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-1b",
              function: {
                name: "assign_fix",
                arguments: JSON.stringify({
                  agent_id: "agent-1",
                  fix_task: "Fix it properly",
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-2",
              function: { name: "finish_mutation", arguments: "{}" },
            },
          ],
        },
      });

    const ctx: MutationContext = {
      orchestrator: makeOrchestrator(),
      linked: [makeProject({ id: "agent-1", name: "Agent 1" })],
      feedback: "Fix stuff",
      previousRun: makePreviousRun(),
      workspaceContext: "",
      budget: makeBudget(),
    };

    const result = await planMutations(ctx);
    expect(result.outcome.kind).toBe("plan");
    if (result.outcome.kind === "plan") {
      expect(result.outcome.plan.mutations[0].kind).toBe("assign_fix");
    }
  });

  it("rejects finish_mutation with zero mutations", async () => {
    mockCallLLMWithTools
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-1",
              function: { name: "finish_mutation", arguments: "{}" },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-2",
              function: {
                name: "assign_fix",
                arguments: JSON.stringify({
                  agent_id: "agent-1",
                  fix_task: "Do something",
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-3",
              function: { name: "finish_mutation", arguments: "{}" },
            },
          ],
        },
      });

    const ctx: MutationContext = {
      orchestrator: makeOrchestrator(),
      linked: [makeProject({ id: "agent-1" })],
      feedback: "Fix it",
      previousRun: makePreviousRun(),
      workspaceContext: "",
      budget: makeBudget(),
    };

    const result = await planMutations(ctx);
    expect(result.outcome.kind).toBe("plan");
    if (result.outcome.kind === "plan") {
      expect(result.outcome.plan.mutations).toHaveLength(1);
    }
  });

  it("handles multiple mutations in a single triage", async () => {
    mockCallLLMWithTools
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-1",
              function: {
                name: "assign_fix",
                arguments: JSON.stringify({
                  agent_id: "agent-1",
                  fix_task: "Fix header",
                }),
              },
            },
            {
              id: "tc-2",
              function: {
                name: "create_agent",
                arguments: JSON.stringify({
                  parent_id: "agent-2",
                  name: "Footer",
                  type: "code",
                  task: "Create footer component",
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-3",
              function: { name: "finish_mutation", arguments: "{}" },
            },
          ],
        },
      });

    const agent1 = makeProject({ id: "agent-1", name: "Agent 1" });
    const agent2 = makeProject({ id: "agent-2", name: "Agent 2" });
    const ctx: MutationContext = {
      orchestrator: makeOrchestrator(),
      linked: [agent1, agent2],
      feedback: "Fix header and add footer",
      previousRun: makePreviousRun(),
      workspaceContext: "",
      budget: makeBudget(),
    };

    const result = await planMutations(ctx);
    expect(result.outcome.kind).toBe("plan");
    if (result.outcome.kind === "plan") {
      expect(result.outcome.plan.mutations).toHaveLength(2);
      expect(result.outcome.plan.mutations[0].kind).toBe("assign_fix");
      expect(result.outcome.plan.mutations[1].kind).toBe("create_agent");
    }
  });

  it("decrements budget on successful plan", async () => {
    mockCallLLMWithTools
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-1",
              function: {
                name: "assign_fix",
                arguments: JSON.stringify({
                  agent_id: "agent-1",
                  fix_task: "Fix it",
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        message: {
          content: "",
          tool_calls: [
            {
              id: "tc-2",
              function: { name: "finish_mutation", arguments: "{}" },
            },
          ],
        },
      });

    const budget = makeBudget(3);
    const ctx: MutationContext = {
      orchestrator: makeOrchestrator(),
      linked: [makeProject({ id: "agent-1" })],
      feedback: "Fix it",
      previousRun: makePreviousRun(),
      workspaceContext: "",
      budget,
    };

    const result = await planMutations(ctx);
    expect(result.budget.autoRemaining).toBe(2);
  });
});

// ── buildFixTask ─────────────────────────────────────────────────────────────

describe("buildFixTask", () => {
  it("includes feedback and fix instruction", () => {
    const result = buildFixTask("Fix the color", "The header is blue, should be red");
    expect(result).toContain("[CORRECTIVE ITERATION]");
    expect(result).toContain("Fix the color");
    expect(result).toContain("The header is blue, should be red");
  });

  it("includes disk content when provided", () => {
    const result = buildFixTask(
      "Fix it",
      "feedback",
      undefined,
      'export const color = "blue";',
    );
    expect(result).toContain("CURRENT CONTENT OF YOUR FILES ON DISK");
    expect(result).toContain('export const color = "blue"');
  });

  it("falls back to previous result when no disk content", () => {
    const result = buildFixTask("Fix it", "feedback", "previous output here");
    expect(result).toContain("YOUR PREVIOUS RESULT");
    expect(result).toContain("previous output here");
  });

  it("includes workspace file tree when provided", () => {
    const result = buildFixTask(
      "Fix it",
      "feedback",
      undefined,
      undefined,
      "src/\n  app.ts",
    );
    expect(result).toContain("ALL FILES CURRENTLY IN WORKSPACE");
    expect(result).toContain("src/");
  });
});

// ── applyMutations ──────────────────────────────────────────────────────────

describe("applyMutations", () => {
  it("returns fixes for assign_fix mutations", async () => {
    const plan = {
      mutations: [
        { kind: "assign_fix" as const, agentId: "agent-1", fixTask: "Fix the header" },
      ],
    };
    const sendStatus = vi.fn();
    const { fixes, newAgents } = await applyMutations(
      plan,
      [makeProject({ id: "agent-1" })],
      "orch-1",
      sendStatus,
    );

    expect(fixes["agent-1"]).toBe("Fix the header");
    expect(newAgents).toHaveLength(0);
  });

  it("saves updated project for modify_agent", async () => {
    const agent = makeProject({ id: "agent-1", name: "Agent 1", task: "old task" });
    const plan = {
      mutations: [
        {
          kind: "modify_agent" as const,
          agentId: "agent-1",
          task: "new task",
          dependsOn: undefined,
          expectedFiles: undefined,
        },
      ],
    };
    const sendStatus = vi.fn();
    await applyMutations(plan, [agent], "orch-1", sendStatus);

    expect(mockSaveProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", task: "new task" }),
    );
    expect(sendStatus).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "agent-1", status: "idle", task: "new task" }),
    );
  });

  it("creates new agents for create_agent mutations", async () => {
    const parent = makeProject({ id: "parent-1", name: "Parent" });
    mockGetProjects.mockResolvedValueOnce([
      makeOrchestrator({ id: "orch-1", linked: ["parent-1"] }),
      parent,
    ]);
    mockSaveProject.mockImplementation(async (p: Partial<Project>) => ({
      id: p.id ?? "new-agent-id",
      ...p,
    }));

    const plan = {
      mutations: [
        {
          kind: "create_agent" as const,
          name: "Footer",
          type: "code",
          task: "Create footer",
          dependsOn: [] as string[],
          expectedFiles: ["footer.tsx"] as string[],
          parentId: "parent-1",
        },
      ],
    };
    const sendStatus = vi.fn();
    const { fixes, newAgents } = await applyMutations(
      plan,
      [parent],
      "orch-1",
      sendStatus,
    );

    expect(newAgents).toHaveLength(1);
    expect(mockSaveProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Parent › Footer",
        type: "code",
        task: "Create footer",
        generated: true,
      }),
    );
  });
});
