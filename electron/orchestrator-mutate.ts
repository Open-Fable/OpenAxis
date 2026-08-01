import { saveProject, type Project, type OrchRun } from "./project-store.js";
import { callLLMWithTools, type ChatMessage } from "./orchestrator-llm.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type PlanMutation =
  | { readonly kind: "assign_fix"; readonly agentId: string; readonly fixTask: string }
  | {
      readonly kind: "modify_agent";
      readonly agentId: string;
      readonly task?: string;
      readonly dependsOn?: readonly string[];
      readonly expectedFiles?: readonly string[];
    }
  | {
      readonly kind: "create_agent";
      readonly name: string;
      readonly type: string;
      readonly task: string;
      readonly dependsOn: readonly string[];
      readonly expectedFiles: readonly string[];
      readonly parentId: string;
    };

export interface MutationPlan {
  readonly mutations: readonly PlanMutation[];
}

export type MutationOutcome =
  | { readonly kind: "plan"; readonly plan: MutationPlan }
  | { readonly kind: "escalate"; readonly question: string };

export interface MutationBudget {
  readonly autoRemaining: number;
}

export interface MutationResult {
  readonly outcome: MutationOutcome;
  readonly budget: MutationBudget;
}

export interface MutationContext {
  readonly orchestrator: Project;
  readonly linked: readonly Project[];
  readonly feedback: string;
  readonly previousRun: OrchRun;
  readonly workspaceContext: string;
  readonly signal?: AbortSignal;
  readonly fallbackModel?: string;
  readonly fallbackReasoningEffort?: string;
  readonly budget: MutationBudget;
  readonly targetNodeId?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_MUTATION_ITERATIONS = 10;
const NODE_RESULT_SUMMARY_CHARS = 1500;
const PREVIOUS_RESULT_MAX_CHARS = 4000;

// ── Tools ────────────────────────────────────────────────────────────────────

const MUTATION_TOOLS = [
  {
    type: "function",
    function: {
      name: "assign_fix",
      description: "Assign a corrective task to an existing agent.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "ID of the agent to fix" },
          fix_task: { type: "string", description: "Precise corrective task" },
        },
        required: ["agent_id", "fix_task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "modify_agent",
      description: "Modify an existing agent's task, dependencies, or expected files.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "ID of the agent to modify" },
          task: { type: "string", description: "New task (replaces current)" },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description: "New dependency list (agent IDs)",
          },
          expected_files: {
            type: "array",
            items: { type: "string" },
            description: "New expected files list",
          },
        },
        required: ["agent_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_agent",
      description: "Create a new agent to handle work no existing agent covers.",
      parameters: {
        type: "object",
        properties: {
          parent_id: {
            type: "string",
            description: "ID of parent agent (inherits model/instructions)",
          },
          name: { type: "string", description: "Name for the new agent" },
          type: {
            type: "string",
            enum: ["work", "code", "recherche", "design"],
            description: "Agent type",
          },
          task: { type: "string", description: "Task for the new agent" },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description: "Dependencies (agent IDs)",
          },
          expected_files: {
            type: "array",
            items: { type: "string" },
            description: "Files this agent should produce",
          },
          delivers_tests: {
            type: "object",
            description: "Test contract for code agents: test files + command ID to run",
            properties: {
              files: {
                type: "array",
                items: { type: "string" },
                description: "Test file paths the agent must produce",
              },
              command: {
                type: "string",
                description: "Whitelisted command ID to run (e.g. 'test')",
              },
            },
            required: ["files", "command"],
          },
        },
        required: ["parent_id", "name", "type", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate",
      description:
        "Escalate to the user when you cannot determine the right fix. Provide a precise question.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Precise question for the user explaining what is unclear",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish_mutation",
      description: "Finish mutation planning when all mutations are assigned.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ── Prompts ──────────────────────────────────────────────────────────────────

function buildMutationSystemPrompt(orchestrator: Project): string {
  const base = orchestrator.instructions || "";
  return `You are an AI project coordinator in MUTATION phase. An orchestration already produced output, and corrections are needed.

${base ? `CUSTOM INSTRUCTIONS:\n${base}\n\n` : ""}YOUR ROLE:
- Analyze the feedback and determine the right mutations to the plan
- You have 3 mutation tools: assign_fix (corrective task on existing agent), modify_agent (change task/deps/files of an existing agent), create_agent (new agent for uncovered work)
- You can also escalate to the user if the feedback is unclear or you cannot determine the right action
- Call finish_mutation when all mutations are assigned

CRITICAL RULES:
- SELECTIVITY: only mutate agents concerned by the feedback. NEVER relaunch all agents.
- If the feedback asks for something no existing agent can handle, use create_agent
- If you cannot determine the right action, use escalate — never guess
- You must either assign at least one mutation OR escalate before calling finish_mutation
- MODIFICATION over creation: prefer modify_agent or assign_fix when an existing agent covers the domain`;
}

function summarizeNodeResults(previousRun: OrchRun): string {
  return previousRun.nodeResults
    .map((r) => {
      const excerpt = r.result
        ? r.result.substring(0, NODE_RESULT_SUMMARY_CHARS)
        : "(no result)";
      return `--- Agent "${r.name}" (ID: ${r.projectId}, status: ${r.status}) ---\n${excerpt}`;
    })
    .join("\n\n");
}

function buildMutationUserPrompt(ctx: MutationContext): string {
  const agentList = ctx.linked
    .map(
      (p) =>
        `- "${p.name}" (ID: ${p.id}, type: ${p.type ?? "unknown"})${p.task ? ` — task: ${p.task.substring(0, 200)}` : ""}`,
    )
    .join("\n");

  return `INITIAL TASK:
${ctx.previousRun.task}

FEEDBACK:
${ctx.feedback}

AVAILABLE AGENTS:
${agentList}

PREVIOUS RUN RESULTS:
${summarizeNodeResults(ctx.previousRun)}

${ctx.workspaceContext}

Analyze the feedback. Use assign_fix, modify_agent, or create_agent for each needed mutation. Use escalate if the feedback is unclear. Finish with finish_mutation.`;
}

// ── Mutation engine ──────────────────────────────────────────────────────────

function handleAssignFix(
  args: Record<string, unknown>,
  ctx: MutationContext,
  mutations: PlanMutation[],
): string {
  const agentId = String(args.agent_id ?? "");
  const fixTask = String(args.fix_task ?? "").trim();
  const agent = ctx.linked.find((p) => p.id === agentId);
  if (!agent) {
    return `Error: agent_id "${agentId}" unknown. Valid IDs: ${ctx.linked.map((p) => p.id).join(", ")}`;
  }
  if (!fixTask) return `Error: fix_task is empty for agent "${agent.name}".`;
  mutations.push({ kind: "assign_fix", agentId, fixTask });
  return `Fix assigned to "${agent.name}". Continue with more mutations or call finish_mutation.`;
}

function handleModifyAgent(
  args: Record<string, unknown>,
  ctx: MutationContext,
  mutations: PlanMutation[],
): string {
  const agentId = String(args.agent_id ?? "");
  const agent = ctx.linked.find((p) => p.id === agentId);
  if (!agent) {
    return `Error: agent_id "${agentId}" unknown. Valid IDs: ${ctx.linked.map((p) => p.id).join(", ")}`;
  }
  const task = args.task !== undefined ? String(args.task) : undefined;
  const dependsOn = Array.isArray(args.depends_on)
    ? (args.depends_on as string[]).filter((d) => typeof d === "string")
    : undefined;
  const expectedFiles = Array.isArray(args.expected_files)
    ? (args.expected_files as string[]).filter((f) => typeof f === "string")
    : undefined;

  if (!task && !dependsOn && !expectedFiles) {
    return `Error: no modification specified for agent "${agent.name}". Provide at least task, depends_on, or expected_files.`;
  }

  mutations.push({ kind: "modify_agent", agentId, task, dependsOn, expectedFiles });
  return `Agent "${agent.name}" modification recorded. Continue or call finish_mutation.`;
}

function handleCreateAgent(
  args: Record<string, unknown>,
  ctx: MutationContext,
  mutations: PlanMutation[],
): string {
  const parentId = String(args.parent_id ?? "");
  const parent = ctx.linked.find((p) => p.id === parentId);
  if (!parent) {
    return `Error: parent_id "${parentId}" unknown. Valid IDs: ${ctx.linked.map((p) => p.id).join(", ")}`;
  }

  const name = String(args.name ?? "").slice(0, 100);
  if (!name) return "Error: name is required for create_agent.";

  const VALID_TYPES = new Set(["work", "code", "recherche", "design"]);
  const rawType = String(args.type ?? "work");
  const type = VALID_TYPES.has(rawType) ? rawType : "work";
  const task = String(args.task ?? "").slice(0, 10000);
  if (!task) return "Error: task is required for create_agent.";

  const dependsOn = Array.isArray(args.depends_on)
    ? (args.depends_on as string[]).filter((d) => typeof d === "string")
    : [];
  const expectedFiles = Array.isArray(args.expected_files)
    ? (args.expected_files as string[]).filter((f) => typeof f === "string")
    : [];

  mutations.push({
    kind: "create_agent",
    name,
    type,
    task,
    dependsOn,
    expectedFiles,
    parentId,
  });
  return `Agent "${name}" creation recorded. Continue or call finish_mutation.`;
}

export async function planMutations(ctx: MutationContext): Promise<MutationResult> {
  let remaining = ctx.budget.autoRemaining;

  function result(outcome: MutationOutcome): MutationResult {
    return { outcome, budget: { autoRemaining: remaining } };
  }

  // Direct targeting: user clicked a specific node → bypass LLM entirely
  if (ctx.targetNodeId) {
    const agent = ctx.linked.find((p) => p.id === ctx.targetNodeId);
    if (!agent) {
      return result({
        kind: "escalate",
        question: `Target agent "${ctx.targetNodeId}" not found in linked agents.`,
      });
    }
    return result({
      kind: "plan",
      plan: {
        mutations: [
          { kind: "assign_fix", agentId: ctx.targetNodeId, fixTask: ctx.feedback },
        ],
      },
    });
  }

  // Budget check
  if (remaining <= 0) {
    return result({
      kind: "escalate",
      question:
        "Mutation budget exhausted for this run. The feedback requires manual intervention or a fresh orchestration.",
    });
  }

  const messages: ChatMessage[] = [
    { role: "system", content: buildMutationSystemPrompt(ctx.orchestrator) },
    { role: "user", content: buildMutationUserPrompt(ctx) },
  ];

  const mutations: PlanMutation[] = [];
  let escalateQuestion: string | null = null;

  for (let iter = 0; iter < MAX_MUTATION_ITERATIONS; iter++) {
    if (ctx.signal?.aborted) {
      throw new Error("Orchestration cancelled by user.");
    }

    const { message } = await callLLMWithTools(
      ctx.orchestrator,
      messages,
      MUTATION_TOOLS,
      ctx.signal,
      ctx.fallbackModel,
      ctx.fallbackReasoningEffort,
    );

    // No tool calls at all — escalate instead of fallback-all
    if (!message.tool_calls?.length) {
      if (iter === 0) {
        return result({
          kind: "escalate",
          question:
            "The mutation planner could not determine which agents to modify. Please specify which agent or file needs changes.",
        });
      }
      if (mutations.length > 0) {
        remaining--;
        return result({ kind: "plan", plan: { mutations } });
      }
      messages.push(message);
      messages.push({
        role: "user",
        content:
          "Use assign_fix, modify_agent, or create_agent to specify mutations. Use escalate if unclear. Then call finish_mutation.",
      });
      continue;
    }

    messages.push(message);

    for (const toolCall of message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        messages.push({
          role: "tool",
          content: "Error: invalid JSON arguments.",
          tool_call_id: toolCall.id,
        });
        continue;
      }

      const fnName = toolCall.function.name;

      if (fnName === "assign_fix") {
        messages.push({
          role: "tool",
          content: handleAssignFix(args, ctx, mutations),
          tool_call_id: toolCall.id,
        });
      } else if (fnName === "modify_agent") {
        messages.push({
          role: "tool",
          content: handleModifyAgent(args, ctx, mutations),
          tool_call_id: toolCall.id,
        });
      } else if (fnName === "create_agent") {
        messages.push({
          role: "tool",
          content: handleCreateAgent(args, ctx, mutations),
          tool_call_id: toolCall.id,
        });
      } else if (fnName === "escalate") {
        escalateQuestion =
          String(args.question ?? "").trim() ||
          "The mutation planner cannot determine the right action.";
        messages.push({
          role: "tool",
          content: "Escalation recorded. Call finish_mutation to end.",
          tool_call_id: toolCall.id,
        });
      } else if (fnName === "finish_mutation") {
        if (escalateQuestion) {
          return result({ kind: "escalate", question: escalateQuestion });
        }
        if (mutations.length === 0) {
          messages.push({
            role: "tool",
            content:
              "Cannot finish: no mutations assigned. Use assign_fix/modify_agent/create_agent first, or escalate.",
            tool_call_id: toolCall.id,
          });
        } else {
          remaining--;
          return result({ kind: "plan", plan: { mutations } });
        }
      } else {
        messages.push({
          role: "tool",
          content: `Unknown tool: "${fnName}".`,
          tool_call_id: toolCall.id,
        });
      }
    }
  }

  // Loop exhausted — escalate, never fallback-all
  if (mutations.length > 0) {
    remaining--;
    return result({ kind: "plan", plan: { mutations } });
  }
  return result({
    kind: "escalate",
    question:
      "Mutation planning could not converge after maximum iterations. Please specify the changes manually.",
  });
}

// ── Apply mutations ──────────────────────────────────────────────────────────

type StatusLiteral =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "skipped"
  | "warning"
  | "inactive";

export async function applyMutations(
  plan: MutationPlan,
  linked: readonly Project[],
  orchestratorId: string,
  sendStatus: (update: {
    projectId: string;
    status: StatusLiteral;
    task?: string;
  }) => void,
): Promise<{
  fixes: Record<string, string>;
  newAgents: readonly Project[];
}> {
  const fixes: Record<string, string> = {};
  const newAgents: Project[] = [];

  for (const mutation of plan.mutations) {
    if (mutation.kind === "assign_fix") {
      fixes[mutation.agentId] = mutation.fixTask;
    } else if (mutation.kind === "modify_agent") {
      const agent = linked.find((p) => p.id === mutation.agentId);
      if (!agent) continue;
      const updated = {
        ...agent,
        ...(mutation.task !== undefined ? { task: mutation.task } : {}),
        ...(mutation.dependsOn !== undefined ? { dependencies: mutation.dependsOn } : {}),
      };
      await saveProject(updated);
      if (mutation.task) {
        fixes[mutation.agentId] = mutation.task;
        sendStatus({ projectId: mutation.agentId, status: "idle", task: mutation.task });
      }
    } else if (mutation.kind === "create_agent") {
      const parent = linked.find((p) => p.id === mutation.parentId);
      if (!parent) continue;
      const newProject = await saveProject({
        name: `${parent.name} › ${mutation.name}`,
        type: mutation.type as Project["type"],
        instructions: parent.instructions || "",
        model: parent.model,
        dependencies: [...mutation.dependsOn],
        task: mutation.task,
        color: parent.color || "",
        generated: true,
      });

      // Link the new agent to the orchestrator
      const { getProjects } = await import("./project-store.js");
      const allProjects = await getProjects();
      const orch = allProjects.find((p) => p.id === orchestratorId);
      if (orch) {
        const updatedOrch = {
          ...orch,
          linked: [...(orch.linked || []), newProject.id],
        };
        await saveProject(updatedOrch);
      }

      newAgents.push(newProject);
      fixes[newProject.id] = mutation.task;
      sendStatus({ projectId: newProject.id, status: "idle", task: mutation.task });
    }
  }

  return { fixes, newAgents };
}

// ── buildFixTask (migrated from orchestrator-iterate.ts) ─────────────────────

export function buildFixTask(
  fixInstruction: string,
  feedback: string,
  previousResult?: string,
  currentFilesOnDisk?: string,
  workspaceFileTree?: string,
): string {
  const hasDiskContent =
    typeof currentFilesOnDisk === "string" && currentFilesOnDisk.trim().length > 0;
  const sourceBlock = hasDiskContent
    ? `\nCURRENT CONTENT OF YOUR FILES ON DISK (SOURCE OF TRUTH — start EXACTLY from this content, reproduce it IN FULL with only the requested corrections):\n${currentFilesOnDisk}\n`
    : previousResult
      ? `\nYOUR PREVIOUS RESULT (excerpt):\n${previousResult.substring(0, PREVIOUS_RESULT_MAX_CHARS)}\n`
      : "";

  const treeBlock =
    workspaceFileTree && workspaceFileTree.trim().length > 0
      ? `\n[ALL FILES CURRENTLY IN WORKSPACE — use these paths for edits]\n${workspaceFileTree}\n`
      : "";

  return `[CORRECTIVE ITERATION]
USER FEEDBACK :
${feedback}

REQUESTED FIX :
${fixInstruction}
${treeBlock}${sourceBlock}
CRITICAL RULES (in-place editing — do NOT regenerate) :
- FIRST READ the CURRENT on-disk content of the affected file(s): that's the SOURCE OF TRUTH (not your memory, not the excerpt above). Start from that content.
- Apply ONLY the corrections requested above. Everything else in the file must stay IDENTICAL, word for word.
- NEVER SHORTEN: do not summarize, do not remove already complete sections, do not remove existing detail. The corrected file must be AT LEAST as complete and long as before.
- Only touch YOUR OWN files (those you produced). Do not rewrite other agents' deliverables.

TWO DELIVERY FORMATS — choose according to the scope of changes:
1) SMALL CHANGE (PREFERRED): if only a few portions change, emit ONLY the modified portions via an edit block, without rewriting the entire file:
\`\`\`edit filepath: path/to/file
<<<<<<< SEARCH
(EXACT copy of the current text to replace — include enough surrounding lines for this passage to be UNIQUE in the file)
=======
(the new text)
>>>>>>> REPLACE
\`\`\`
You can chain multiple SEARCH/REPLACE pairs in the same block. The SEARCH must match character-for-character the current on-disk content; otherwise the edit is rejected.
2) FULL REWRITE: if changes touch a large part of the file, re-emit it in full using the \`\`\`<lang> filepath: format, WITH all the current content + corrections, never an abbreviated version.`;
}
