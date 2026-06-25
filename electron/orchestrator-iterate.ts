import type { Project, OrchRun } from "./project-store.js";
import { callLLMWithTools, type ChatMessage } from "./orchestrator-llm.js";

const MAX_TRIAGE_ITERATIONS = 10;
const PREVIOUS_RESULT_MAX_CHARS = 4000;
const NODE_RESULT_SUMMARY_CHARS = 1500;

export interface TriageContext {
  readonly orchestrator: Project;
  readonly linked: readonly Project[];
  readonly feedback: string;
  readonly previousRun: OrchRun;
  readonly workspaceContext: string;
  readonly signal?: AbortSignal;
  readonly fallbackModel?: string;
  readonly fallbackReasoningEffort?: string;
}

const TRIAGE_TOOLS = [
  {
    type: "function",
    function: {
      name: "assign_fix",
      description:
        "Relaunch an agent with a targeted corrective task in response to user feedback.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "ID of the agent to relaunch" },
          fix_task: {
            type: "string",
            description:
              "Precise corrective task: what must be modified, in which existing files, and the expected result.",
          },
        },
        required: ["agent_id", "fix_task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish_triage",
      description: "Finish triage when all necessary fixes are assigned.",
      parameters: { type: "object", properties: {} },
    },
  },
];

function buildTriageSystemPrompt(orchestrator: Project): string {
  const base = orchestrator.instructions || "";
  return `You are an AI project coordinator in CORRECTIVE ITERATION phase. An orchestration already produced a complete output, and the user gives feedback on that output.

${base ? `CUSTOM INSTRUCTIONS :\n${base}\n\n` : ""}YOUR ROLE :
- Analyze user feedback and identify the agents responsible for the criticized elements
- Assign to each concerned agent a corrective task via the assign_fix tool
- Call finish_triage when all fixes are assigned

CRITICAL RULES :
- SELECTIVITY: only relaunch the agents concerned by the feedback. If the feedback is about visuals, do not relaunch the research agent. Targeted relaunch, NOT the whole project.
- MODIFICATION: files already exist in the workspace (see workspace state). Each fix_task must reference the existing files to modify — never a complete regeneration.
- PRECISION: each fix_task must be actionable: what to change, where, and the success criterion.
- You must assign AT LEAST one fix before calling finish_triage.`;
}

function summarizeNodeResults(previousRun: OrchRun): string {
  const blocks = previousRun.nodeResults.map((r) => {
    const excerpt = r.result
      ? r.result.substring(0, NODE_RESULT_SUMMARY_CHARS)
      : "(no result)";
    return `--- Agent "${r.name}" (ID: ${r.projectId}, statut: ${r.status}) ---\n${excerpt}`;
  });
  return blocks.join("\n\n");
}

function buildTriageUserPrompt(ctx: TriageContext): string {
  const agentList = ctx.linked
    .map(
      (p) =>
        `- "${p.name}" (ID: ${p.id}, type: ${p.type ?? "unknown"})${p.task ? ` — last task: ${p.task.substring(0, 200)}` : ""}`,
    )
    .join("\n");

  return `INITIAL TASK OF THE PREVIOUS RUN :
${ctx.previousRun.task}

USER FEEDBACK ON THE OUTPUT :
${ctx.feedback}

AVAILABLE AGENTS :
${agentList}

PREVIOUS RUN RESULTS :
${summarizeNodeResults(ctx.previousRun)}

${ctx.workspaceContext}

Analyze the feedback, then use assign_fix for each agent to relaunch (only the concerned ones), and finish with finish_triage.`;
}

function parseTriageJsonFallback(
  content: string,
  linked: readonly Project[],
): Record<string, string> | null {
  try {
    const cleaned = content
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const fixes: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") continue;
      const match = linked.find(
        (p) =>
          p.id === key ||
          p.name.toLowerCase() === key.toLowerCase() ||
          key.toLowerCase().includes(p.name.toLowerCase()) ||
          p.name.toLowerCase().includes(key.toLowerCase()),
      );
      if (match) fixes[match.id] = value;
    }
    return Object.keys(fixes).length > 0 ? fixes : null;
  } catch {
    return null;
  }
}

function fallbackAllNonSkipped(ctx: TriageContext): Record<string, string> {
  const fixes: Record<string, string> = {};
  for (const r of ctx.previousRun.nodeResults) {
    if (r.status === "skipped") continue;
    if (!ctx.linked.some((p) => p.id === r.projectId)) continue;
    fixes[r.projectId] = ctx.feedback;
  }
  return fixes;
}

/**
 * Structured feedback (auto-quality loop) tags each issue line with `[agent name]`
 * via buildAutoFeedback. Match those tags to linked agents so a triage failure
 * relaunches ONLY the implicated agents instead of the whole project. Returns null
 * when no tag matches a real agent (e.g. free-form human feedback) so the caller
 * falls back to all-non-skipped.
 */
function fixesFromTaggedAgents(ctx: TriageContext): Record<string, string> | null {
  const tags = new Set<string>();
  const tagPattern = /^\s*-\s*\[([^\]]+)\]/gm;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(ctx.feedback)) !== null) {
    tags.add(match[1].trim());
  }
  if (tags.size === 0) return null;

  const fixes: Record<string, string> = {};
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    const agent = ctx.linked.find(
      (p) =>
        p.name.toLowerCase() === lower ||
        lower.includes(p.name.toLowerCase()) ||
        p.name.toLowerCase().includes(lower),
    );
    if (agent) fixes[agent.id] = ctx.feedback;
  }
  return Object.keys(fixes).length > 0 ? fixes : null;
}

/**
 * Triage failure fallback: narrow to agents named in the feedback when possible,
 * otherwise relaunch every non-skipped agent.
 */
function narrowedFallback(ctx: TriageContext): Record<string, string> {
  return fixesFromTaggedAgents(ctx) ?? fallbackAllNonSkipped(ctx);
}

function handleAssignFix(
  args: Record<string, unknown>,
  ctx: TriageContext,
  fixes: Record<string, string>,
): string {
  const agentId = String(args.agent_id ?? "");
  const fixTask = String(args.fix_task ?? "").trim();
  const agent = ctx.linked.find((p) => p.id === agentId);
  if (!agent) {
    return `Erreur : agent_id "${agentId}" inconnu. IDs valides : ${ctx.linked.map((p) => p.id).join(", ")}`;
  }
  if (!fixTask) {
    return `Erreur : fix_task vide pour l'agent "${agent.name}".`;
  }
  fixes[agentId] = fixTask;
  return `Fix assigned to "${agent.name}". Assign other fixes if needed, otherwise call finish_triage.`;
}

/**
 * Triage LLM: analyzes user feedback and decides which agents to relaunch
 * with which corrective tasks. Tool-calling with JSON fallback, then
 * fallback all-non-skipped agents — must never fail.
 */
export async function planIterationFixes(
  ctx: TriageContext,
): Promise<Record<string, string>> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildTriageSystemPrompt(ctx.orchestrator) },
    { role: "user", content: buildTriageUserPrompt(ctx) },
  ];

  const fixes: Record<string, string> = {};

  for (let iter = 0; iter < MAX_TRIAGE_ITERATIONS; iter++) {
    if (ctx.signal?.aborted) {
      throw new Error("Orchestration cancelled by user.");
    }

    const { message } = await callLLMWithTools(
      ctx.orchestrator,
      messages,
      TRIAGE_TOOLS,
      ctx.signal,
      ctx.fallbackModel,
      ctx.fallbackReasoningEffort,
    );

    if (iter === 0 && !message.tool_calls?.length && message.content) {
      console.warn("[orchestrator] Triage: model returned text, trying JSON fallback.");
      const parsed = parseTriageJsonFallback(message.content, ctx.linked);
      if (parsed) return parsed;
      console.warn(
        "[orchestrator] Triage JSON fallback failed — targeting agents named in feedback (or all non-skipped).",
      );
      return narrowedFallback(ctx);
    }

    messages.push(message);

    if (!message.tool_calls?.length) {
      if (Object.keys(fixes).length > 0) return fixes;
      messages.push({
        role: "user",
        content:
          "Utilise l'outil assign_fix pour assigner au moins un correctif, puis finish_triage.",
      });
      continue;
    }

    for (const toolCall of message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        messages.push({
          role: "tool",
          content: "Erreur : arguments JSON invalides.",
          tool_call_id: toolCall.id,
        });
        continue;
      }

      const fnName = toolCall.function.name;
      if (fnName === "assign_fix") {
        messages.push({
          role: "tool",
          content: handleAssignFix(args, ctx, fixes),
          tool_call_id: toolCall.id,
        });
      } else if (fnName === "finish_triage") {
        if (Object.keys(fixes).length === 0) {
          messages.push({
            role: "tool",
            content: "Cannot finish: no fixes assigned. Use assign_fix first.",
            tool_call_id: toolCall.id,
          });
        } else {
          return fixes;
        }
      } else {
        messages.push({
          role: "tool",
          content: `Outil inconnu : "${fnName}".`,
          tool_call_id: toolCall.id,
        });
      }
    }
  }

  if (Object.keys(fixes).length > 0) return fixes;
  console.warn(
    "[orchestrator] Triage loop exhausted — targeting agents named in feedback (or all non-skipped).",
  );
  return narrowedFallback(ctx);
}

/**
 * Composes the corrective task written into node.task before execution.
 * The rest of the pipeline (executeNode, backends, file extraction)
 * then works without modification.
 */
export function buildFixTask(
  fixInstruction: string,
  feedback: string,
  previousResult?: string,
  currentFilesOnDisk?: string,
): string {
  // When the runner can read the agent's own files from disk, inject their REAL
  // current content as the source of truth. This replaces the truncated 4000-char
  // chat excerpt for pure-LLM agents (which have no disk access), so a corrective
  // relaunch edits the actual file instead of regenerating from a partial memory.
  const hasDiskContent =
    typeof currentFilesOnDisk === "string" && currentFilesOnDisk.trim().length > 0;
  const sourceBlock = hasDiskContent
    ? `\nCURRENT CONTENT OF YOUR FILES ON DISK (SOURCE OF TRUTH — start EXACTLY from this content, reproduce it IN FULL with only the requested corrections):\n${currentFilesOnDisk}\n`
    : previousResult
      ? `\nYOUR PREVIOUS RESULT (excerpt):\n${previousResult.substring(0, PREVIOUS_RESULT_MAX_CHARS)}\n`
      : "";

  return `[CORRECTIVE ITERATION]
USER FEEDBACK :
${feedback}

REQUESTED FIX :
${fixInstruction}
${sourceBlock}
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
