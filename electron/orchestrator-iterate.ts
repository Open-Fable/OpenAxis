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
        "Relancer un agent avec une tâche corrective ciblée en réponse au feedback utilisateur.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "ID de l'agent à relancer" },
          fix_task: {
            type: "string",
            description:
              "Tâche corrective précise : ce qui doit être modifié, dans quels fichiers existants, et le résultat attendu.",
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
      description:
        "Terminer le triage quand tous les correctifs nécessaires sont assignés.",
      parameters: { type: "object", properties: {} },
    },
  },
];

function buildTriageSystemPrompt(orchestrator: Project): string {
  const base = orchestrator.instructions || "";
  return `Tu es un coordinateur de projet IA en phase d'ITÉRATION CORRECTIVE. Une orchestration a déjà produit un rendu complet, et l'utilisateur donne un feedback sur ce rendu.

${base ? `INSTRUCTIONS PERSONNALISÉES :\n${base}\n\n` : ""}TON RÔLE :
- Analyser le feedback utilisateur et identifier les agents responsables des éléments critiqués
- Assigner à chaque agent concerné une tâche corrective via l'outil assign_fix
- Appeler finish_triage quand tous les correctifs sont assignés

RÈGLES CRITIQUES :
- SÉLECTIVITÉ : ne relance QUE les agents concernés par le feedback. Si le feedback porte sur le visuel, ne relance pas l'agent de recherche. Relance ciblée, PAS tout le projet.
- MODIFICATION : les fichiers existent déjà dans le workspace (voir l'état du workspace). Chaque fix_task doit référencer les fichiers existants à modifier — jamais une régénération complète.
- PRÉCISION : chaque fix_task doit être actionnable : quoi changer, où, et le critère de réussite.
- Tu dois assigner AU MOINS un correctif avant d'appeler finish_triage.`;
}

function summarizeNodeResults(previousRun: OrchRun): string {
  const blocks = previousRun.nodeResults.map((r) => {
    const excerpt = r.result
      ? r.result.substring(0, NODE_RESULT_SUMMARY_CHARS)
      : "(aucun résultat)";
    return `--- Agent "${r.name}" (ID: ${r.projectId}, statut: ${r.status}) ---\n${excerpt}`;
  });
  return blocks.join("\n\n");
}

function buildTriageUserPrompt(ctx: TriageContext): string {
  const agentList = ctx.linked
    .map(
      (p) =>
        `- "${p.name}" (ID: ${p.id}, type: ${p.type ?? "inconnu"})${p.task ? ` — dernière tâche : ${p.task.substring(0, 200)}` : ""}`,
    )
    .join("\n");

  return `TÂCHE INITIALE DU RUN PRÉCÉDENT :
${ctx.previousRun.task}

FEEDBACK UTILISATEUR SUR LE RENDU :
${ctx.feedback}

AGENTS DISPONIBLES :
${agentList}

RÉSULTATS DU RUN PRÉCÉDENT :
${summarizeNodeResults(ctx.previousRun)}

${ctx.workspaceContext}

Analyse le feedback, puis utilise assign_fix pour chaque agent à relancer (uniquement ceux concernés), et termine avec finish_triage.`;
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
  return `Correctif assigné à "${agent.name}". Assigne d'autres correctifs si nécessaire, sinon appelle finish_triage.`;
}

/**
 * Triage LLM : analyse le feedback utilisateur et décide quels agents relancer
 * avec quelles tâches correctives. Tool-calling avec fallback JSON, puis
 * fallback « tous les agents non-skipped » — ne doit jamais échouer.
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
      throw new Error("Orchestration annulée par l'utilisateur.");
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
        "[orchestrator] Triage JSON fallback failed — targeting all non-skipped agents.",
      );
      return fallbackAllNonSkipped(ctx);
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
            content:
              "Impossible de terminer : aucun correctif assigné. Utilise assign_fix d'abord.",
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
    "[orchestrator] Triage loop exhausted — targeting all non-skipped agents.",
  );
  return fallbackAllNonSkipped(ctx);
}

/**
 * Compose la tâche corrective écrite dans node.task avant exécution.
 * Le reste du pipeline (executeNode, backends, extraction de fichiers)
 * fonctionne ensuite sans modification.
 */
export function buildFixTask(
  fixInstruction: string,
  feedback: string,
  previousResult?: string,
): string {
  const previousBlock = previousResult
    ? `\nTON RÉSULTAT PRÉCÉDENT (extrait) :\n${previousResult.substring(0, PREVIOUS_RESULT_MAX_CHARS)}\n`
    : "";

  return `[ITÉRATION CORRECTIVE]
FEEDBACK UTILISATEUR :
${feedback}

CORRECTIF DEMANDÉ :
${fixInstruction}
${previousBlock}
RÈGLES CRITIQUES :
- Les fichiers existent DÉJÀ dans le workspace (voir WORKSPACE_INDEX.md) — MODIFIE-les, ne repars PAS de zéro
- Ne touche QUE ce qui est lié au feedback ; préserve tout le reste du travail existant
- Si tu livres un fichier au format \`\`\`<lang> filepath:, reproduis-le EN ENTIER avec les corrections appliquées`;
}
