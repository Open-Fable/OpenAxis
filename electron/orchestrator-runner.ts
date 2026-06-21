import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import { getProjects, saveProject, type Project, type OrchRun } from "./project-store.js";
import { getActiveWorkspaceDir } from "./proxy/index.js";
import {
  buildWorkspaceContext,
  buildDependencyContext,
  buildIterativePlanningSystemPrompt,
  buildIterativePlanningUserPrompt,
  buildNodeSystemPrompt,
  buildNodeUserPrompt,
  buildContinuationPrompt,
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
  buildCompletenessCheckPrompt,
  buildIterationPrompt,
  type SubStep,
  type SubStepResult,
} from "./orchestrator-prompts.js";
import type { ProcessManager } from "./process-manager.js";
import {
  selectBackend,
  executeWithBackend,
  BackendUnavailableError,
} from "./orchestrator-backends/index.js";
import {
  callLLM,
  callLLMWithTools,
  callLLMStreaming,
  callLLMStructured,
  type ChatMessage,
  type StructuredTool,
} from "./orchestrator-llm.js";

import { planIterationFixes, buildFixTask } from "./orchestrator-iterate.js";
import {
  sanitizeExpectedFiles,
  sanitizeChecks,
  deriveFloorChecks,
  type ChecksMap,
  type FileChecks,
  isTrivialResult,
  enforceDeliverables,
  checkExpectedFiles,
  buildQualityGateSystemPrompt,
  buildQualityGateUserPrompt,
  collectHtmlHeadSnippets,
  collectCssSnippets,
  findBrokenAssetRefs,
  buildBrokenAssetsReport,
  findUncodedMockups,
  buildPageCoverageReport,
  findServedSiteProblems,
  findCssConsistencyProblems,
  findInvalidJsonFiles,
  findCsvColumnProblems,
  findPlaceholderDeliverables,
  findUnreferencedModules,
  findOrphanStylesheets,
  findServedHtmlPlaceholders,
  findStructuredDataMismatch,
  sanitizeWorkspaceIndex,
  findConsolidationShrinkage,
  findUnstyledClasses,
  findDivergentDuplicates,
  findScatteredDuplicates,
  findUnwantedWebScaffolding,
  findUselessDesignArtifacts,
  findBrandConsistencyProblems,
  validateDeclaredChecks,
  buildServedSiteReport,
  extractJsonObject,
  parseQualityVerdict,
  buildAutoFeedback,
  buildSyntheticRun,
  buildExpectedFilesReport,
  MIN_RESULT_CHARS,
  MAX_AUTO_QUALITY_LOOPS,
} from "./orchestrator-quality.js";
import { findModuleGraphProblems } from "./orchestrator-module-graph.js";
import { findRenderProblems } from "./orchestrator-render.js";
import { resolveDAG, resolveDAGWaves, findFailedDependency } from "./orchestrator-dag.js";
import {
  parseFilepathBlocks,
  parseEditBlocks,
  applyEdits,
  detectTruncation,
} from "./orchestrator-files.js";
import {
  isScratchWorkspaceReal,
  isGitAvailable,
  ensureGitBaseline,
  addWorktree,
  commitWorktree,
  mergeWorktree,
  removeWorktree,
  type WorktreeHandle,
} from "./orchestrator-worktree.js";

// Parallel execution: how many nodes can run concurrently within a DAG wave.
// Configured per-orchestrator via orchSettings.maxParallelNodes; 1 = strictly
// sequential (legacy behavior). Backend nodes (code/design) only parallelize
// with git-worktree isolation on a scratch workspace (see runBackendWaveIsolated);
// otherwise they fall back to a serial lane.
const DEFAULT_MAX_PARALLEL_NODES = 3;
const MAX_PARALLEL_NODES_CAP = 4;
export const resolveMaxParallelNodes = (orchestrator: Project): number => {
  const raw = orchestrator.orchSettings?.maxParallelNodes ?? DEFAULT_MAX_PARALLEL_NODES;
  if (!Number.isFinite(raw)) return DEFAULT_MAX_PARALLEL_NODES;
  return Math.min(Math.max(Math.floor(raw), 1), MAX_PARALLEL_NODES_CAP);
};

// Forced-tool schemas for verifier verdicts. Asking the model to CALL one of
// these (tool_choice:"required") yields clean JSON arguments instead of free
// text we have to scrape. callLLMStructured falls back to text if the provider
// ignores the forcing, so the existing JSON parsers stay as the safety net.
const QUALITY_VERDICT_TOOL: StructuredTool = {
  name: "report_quality_verdict",
  description: "Rapporter le verdict qualité global de l'orchestration.",
  parameters: {
    type: "object",
    properties: {
      pass: { type: "boolean", description: "true si la qualité globale est acceptable" },
      issues: {
        type: "array",
        description: "Problèmes bloquants à corriger (vide si pass).",
        items: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Nom de l'agent concerné" },
            issue: { type: "string", description: "Problème constaté" },
            fix: { type: "string", description: "Correction attendue" },
          },
          required: ["agent", "issue", "fix"],
        },
      },
    },
    required: ["pass", "issues"],
  },
};

const PROMPT_VERDICT_TOOL: StructuredTool = {
  name: "report_prompt_verdict",
  description: "Indiquer si les tâches assignées aux agents sont valides et cohérentes.",
  parameters: {
    type: "object",
    properties: {
      valid: { type: "boolean", description: "true si les prompts/tâches sont valides" },
    },
    required: ["valid"],
  },
};

const OUTPUT_VERDICT_TOOL: StructuredTool = {
  name: "report_output_verdict",
  description: "Rapporter si la sortie d'un agent est valide.",
  parameters: {
    type: "object",
    properties: {
      valid: { type: "boolean", description: "true si la sortie est valide" },
      reason: { type: "string", description: "Raison synthétique si invalide" },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["critical", "warning", "info"] },
            description: { type: "string" },
          },
          required: ["severity", "description"],
        },
      },
    },
    required: ["valid"],
  },
};

const MAX_SUBSTEPS = 8;
const MAX_PLANNING_ITERATIONS = 20;

// Caps on LLM-emitted file writes: bound how many files and how large each can be,
// so a runaway/poisoned response cannot fill the disk from a single node.
const MAX_WRITTEN_FILES = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Hard ceiling on per-node retries. maxRetries is persisted per node and editable
// from the renderer; without a clamp a huge value makes a single node loop the LLM
// effectively forever (cost/resource exhaustion).
const MAX_NODE_RETRIES = 5;
const clampRetries = (n: number | undefined): number =>
  Math.min(Math.max(n ?? 3, 1), MAX_NODE_RETRIES);

/**
 * Modèle de repli pour les nœuds sans modèle propre.
 * Priorité : modèle global de l'orchestrateur, puis premier agent qui en a un.
 * Doit rester identique entre le premier run et chaque reprise/itération, sinon
 * un workflow change de modèle en cours de route sans que l'UI ne le reflète.
 */
export function resolveFallbackModel(
  orchestrator: Pick<Project, "model">,
  linkedProjects: readonly Pick<Project, "model">[],
): string | undefined {
  return orchestrator.model || linkedProjects.find((p) => p.model)?.model || undefined;
}

// ── Concurrency helper ──────────────────────────────────────────────────────
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Tier « modèle léger » ────────────────────────────────────────────────────
// Profil d'exécution sélectionné par le toggle `orchSettings.adaptToWeakModel`.
// OFF (défaut) → STRONG = comportement identique au code historique.
// ON → WEAK = prompts compacts + plus d'itérations + décomposition des tâches
// volumineuses, pour que les petits modèles (Flash, mini, Haiku…) produisent
// un livrable complet.
interface TierProfile {
  readonly tier: "weak" | "strong";
  readonly compactPrompts: boolean;
  readonly maxIterations: number;
  readonly maxSubStepIterations: number;
  readonly forceDecomposition: boolean;
}
const STRONG_TIER: TierProfile = {
  tier: "strong",
  compactPrompts: false,
  maxIterations: 6,
  maxSubStepIterations: 4,
  forceDecomposition: false,
};
const WEAK_TIER: TierProfile = {
  tier: "weak",
  compactPrompts: true,
  maxIterations: 10,
  maxSubStepIterations: 6,
  forceDecomposition: true,
};
// En dessous de ce volume, on n'impose pas la décomposition : générer les
// sous-étapes est une méta-tâche que les petits modèles ratent, inutile pour un
// livrable trivial.
const WEAK_DECOMPOSE_MIN_TASK_CHARS = 200;
// Directive ajoutée au prompt utilisateur du chemin backend en tier weak (le
// backend fait un seul execute() — pas de boucle d'itérations côté shell).
const WEAK_BACKEND_DIRECTIVE =
  "RYTHME (modèle léger) : produis UN livrable/page à la fois, vérifie-le intégralement, puis passe au suivant. Ne survole pas — termine chaque fichier avant d'enchaîner.";

// System directories and sensitive home subdirectories that an orchestration
// workspace must never point at — defense against a compromised renderer driving
// agents (which write files and run commands) into ~/.ssh, LaunchAgents, /etc, etc.
const SYSTEM_PREFIXES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/private",
  "/System",
  "/Library",
  "/Applications",
];
const SENSITIVE_HOME_DIRS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".gcloud",
  ".kube",
  ".config",
  ".docker",
  "Library",
]);

function isSafeWorkspaceDir(dir: string): boolean {
  // macOS volumes are case-insensitive by default, so /USERS/x/.SSH resolves to
  // the same inode as /Users/x/.ssh. Compare case-insensitively so the prefix and
  // sensitive-dir checks can't be bypassed by changing the case.
  const ci = (s: string): string => s.toLowerCase();
  const resolved = path.resolve(dir);
  const resolvedCi = ci(resolved);
  const home = path.resolve(homedir());
  if (resolvedCi === "/" || resolvedCi === ci(home)) return false;
  if (
    SYSTEM_PREFIXES.some(
      (p) => resolvedCi === ci(p) || resolvedCi.startsWith(ci(p) + path.sep),
    )
  ) {
    return false;
  }
  const rel = path.relative(home, resolved);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    const firstSeg = ci(rel.split(path.sep)[0]);
    if ([...SENSITIVE_HOME_DIRS].some((d) => ci(d) === firstSeg)) return false;
  }
  return true;
}

// Resolves `relPath` against `workspaceDir` and confirms the result stays inside it.
// Returns the absolute path, or null if it escapes (path traversal / symlink-style
// `../` escapes that the lexical filename checks might miss).
function safeResolveInWorkspace(workspaceDir: string, relPath: string): string | null {
  const root = path.resolve(workspaceDir);
  const full = path.resolve(root, relPath);
  if (full === root || full.startsWith(root + path.sep)) return full;
  return null;
}

// Symlink-aware containment check: resolves the realpath of the target's nearest
// existing ancestor (and the target itself if it exists) and confirms it stays
// within the workspace root. Defeats a symlink planted inside the workspace that
// points outside it. Returns true when the write is safe.
async function isContainedRealPath(
  workspaceDir: string,
  fullPath: string,
): Promise<boolean> {
  try {
    const realRoot = await fs.realpath(path.resolve(workspaceDir));
    const within = (p: string): boolean =>
      p === realRoot || p.startsWith(realRoot + path.sep);
    // If the target already exists, it must not be a symlink pointing elsewhere.
    try {
      const st = await fs.lstat(fullPath);
      if (st.isSymbolicLink()) return false;
      const realTarget = await fs.realpath(fullPath);
      return within(realTarget);
    } catch {
      // Target doesn't exist yet — validate its closest existing ancestor.
      const realParent = await fs.realpath(path.dirname(fullPath));
      return within(realParent);
    }
  } catch {
    return false; // realpath of the root failed — fail closed
  }
}

function normalizeForDepMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

interface PlanningResult {
  readonly tasks: Record<string, string>;
  readonly steps: Record<string, SubStep[]>;
  readonly createdSubAgents: readonly Project[];
  readonly expectedFiles: Record<string, readonly string[]>;
  readonly checks: Record<string, FileChecks>;
}

const PLANNING_TOOLS = [
  {
    type: "function",
    function: {
      name: "assign_task",
      description: "Assigner une tâche structurée à un agent.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "ID de l'agent" },
          task: {
            type: "string",
            description: "Tâche structurée avec OBJECTIF, CONTEXTE, FORMAT et CRITÈRES",
          },
          steps: {
            type: "array",
            description:
              "Sous-étapes séquentielles pour tâches complexes. Optionnel — ne fournir que si la tâche nécessite plus de 2 phases distinctes.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                focus: { type: "string" },
                deliverable: { type: "string" },
              },
              required: ["title", "focus", "deliverable"],
            },
          },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description:
              "IDs des agents qui doivent terminer AVANT cet agent. Utiliser pour établir l'ordre d'exécution du DAG.",
          },
          expected_files: {
            type: "array",
            items: { type: "string" },
            description:
              "Contrat de livrables : chemins relatifs des fichiers que l'agent DOIT produire. Un fichier absent = tâche échouée + relance auto.",
          },
          checks: {
            type: "object",
            description:
              "Contraintes MACHINE-VÉRIFIABLES par fichier, dérivées des critères CHIFFRÉS de la demande (ex: '12 produits' → minItems:12, '8 chapitres' → minSections:8, '≥500 mots' → minWords:500). Clé = chemin relatif. Le système les vérifie automatiquement et relance si non respectées. N'invente pas de seuils ; n'émets rien si aucun critère chiffré.",
            additionalProperties: {
              type: "object",
              properties: {
                minWords: {
                  type: "integer",
                  description: "Nombre minimal de mots dans le fichier",
                },
                minItems: {
                  type: "integer",
                  description: "Longueur minimale du tableau JSON racine (ou .items)",
                },
                minSections: {
                  type: "integer",
                  description: "Nombre minimal de titres markdown ## / ###",
                },
                requiredSubstrings: {
                  type: "array",
                  items: { type: "string" },
                  description: "Chaînes qui DOIVENT apparaître dans le fichier",
                },
                format: {
                  type: "string",
                  enum: ["json", "csv", "md"],
                  description: "Format structurel attendu",
                },
              },
            },
          },
        },
        required: ["agent_id", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_sub_agent",
      description:
        "Créer un sous-agent pour diviser le travail d'un agent parent. Le sous-agent sera exécuté AVANT son parent et ses résultats seront accessibles comme dépendance.",
      parameters: {
        type: "object",
        properties: {
          parent_id: {
            type: "string",
            description: "ID de l'agent parent auquel ce sous-agent est rattaché.",
          },
          name: {
            type: "string",
            description:
              "Nom court et descriptif du sous-agent (ex: 'Palette couleurs', 'Rédaction articles').",
          },
          type: {
            type: "string",
            enum: ["work", "code", "recherche", "design"],
            description: "Type du sous-agent — détermine quel outil sera utilisé.",
          },
          task: {
            type: "string",
            description:
              "Tâche structurée du sous-agent avec OBJECTIF, CONTEXTE, FORMAT et CRITÈRES.",
          },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description:
              "IDs des agents/sous-agents qui doivent terminer AVANT ce sous-agent. Optionnel.",
          },
        },
        required: ["parent_id", "name", "type", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish_planning",
      description: "Terminer la planification quand tous les agents ont reçu leur tâche.",
      parameters: { type: "object", properties: {} },
    },
  },
];

interface StatusUpdate {
  projectId: string;
  status: "idle" | "running" | "done" | "error" | "skipped" | "warning" | "inactive";
  task?: string;
  error?: string;
  result?: string;
  systemPrompt?: string;
  userPrompt?: string;
  substep?: { current: number; total: number; title: string };
  dependencies?: string[];
  workspaceDir?: string;
}

export class OrchestratorRunner {
  private isRunning = false;
  private currentOrchestratorId: string | null = null;
  private abortController: AbortController | null = null;
  // Serializes updateWorkspaceIndex calls so concurrent nodes don't clobber
  // WORKSPACE_INDEX.md (read-modify-write with an LLM call in the middle).
  private indexWriteLock: Promise<unknown> = Promise.resolve();
  // Files written on disk by a backend's tools, keyed by node id. Used so a node
  // that produced files but returned a short chat summary isn't judged "trivial".
  private readonly backendFilesWritten = new Map<string, number>();
  private readonly backendWrittenPaths = new Map<string, readonly string[]>();
  // relPath → owning node id. First node to write a path claims it; later nodes
  // (e.g. during a corrective cycle) cannot overwrite another agent's deliverable.
  // This is what stops the research/design agents from clobbering everyone else's
  // files with short rewrites. Shared paths (index, reports/) are never claimed.
  private readonly fileOwner = new Map<string, string>();
  // Serializes writes to the same relative path across concurrent nodes so two
  // agents in the same wave can never interleave a read-modify-write on one file.
  private readonly pathWriteLocks = new Map<string, Promise<unknown>>();
  // nodeId → isolated git-worktree dir, set for backend nodes running in the
  // parallel-code lane and cleared after the wave merges back.
  private readonly nodeWorkspaces = new Map<string, string>();
  // Set during a corrective cycle (iterate/auto-quality) to the ids being
  // re-run, so the anti-parasitic free-path guard fires deterministically.
  private correctiveNodeIds: ReadonlySet<string> | null = null;
  private fallbackModel: string | undefined = undefined;
  private fallbackReasoningEffort: string | undefined = undefined;
  private tierProfile: TierProfile = STRONG_TIER;
  // Resolved once per run/iterate from orchSettings.maxParallelNodes.
  private maxParallelNodes = 1;

  constructor(
    private sendStatus: (update: StatusUpdate) => void,
    private getProcessManager?: () => ProcessManager | null,
  ) {}

  get activeOrchestratorId(): string | null {
    return this.currentOrchestratorId;
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  // Per-run state must not survive across run()/iterate() calls — the runner is a
  // singleton (see ensureRunner in main.ts). A stale fileOwner would, on a second
  // orchestration, mark every node as a "rerun" and silently refuse new free-path
  // writes; stale backend counters would defeat trivial-result detection.
  private resetPerRunState(): void {
    this.fileOwner.clear();
    this.pathWriteLocks.clear();
    this.backendFilesWritten.clear();
    this.backendWrittenPaths.clear();
    this.nodeWorkspaces.clear();
    this.correctiveNodeIds = null;
    this.indexWriteLock = Promise.resolve();
  }

  /**
   * Run the orchestration pipeline starting from the given orchestrator ID
   */
  async run(
    orchestratorId: string,
    task: string,
    workDir?: string,
    workflowName?: string,
  ): Promise<void> {
    if (this.isRunning) {
      throw new Error("Une orchestration est déjà en cours d'exécution.");
    }

    this.isRunning = true;
    this.currentOrchestratorId = orchestratorId;
    this.abortController = new AbortController();
    this.resetPerRunState();

    try {
      let allProjects = await getProjects();
      const orchestrator = allProjects.find((p) => p.id === orchestratorId);
      if (!orchestrator || orchestrator.type !== "orchestrator") {
        throw new Error(
          "L'identifiant fourni ne correspond pas à un orchestrateur valide.",
        );
      }

      const workspaceDir = this.resolveWorkspaceDir(orchestrator, workDir, workflowName);
      await fs.mkdir(workspaceDir, { recursive: true });

      // Initialize workspace index file
      await this.ensureWorkspaceIndexFile(workspaceDir);

      // Accumulate results from each node for inter-agent context
      const executionResults = new Map<string, string>();

      // Step 1: Initialize status of all linked nodes to idle
      const linkedIds = orchestrator.linked || [];
      const linkedProjects = allProjects.filter((p) => linkedIds.includes(p.id));
      console.warn(
        `[orchestrator] Linked agents (${linkedProjects.length}):`,
        linkedProjects.map((p) => `${p.name} (${p.type}, model=${p.model || "none"})`),
      );
      console.warn(
        `[orchestrator] Orchestrator settings:`,
        JSON.stringify(orchestrator.orchSettings ?? {}),
      );

      // Resolve a fallback model: orchestrator's model first, then first agent with a model
      this.fallbackModel = resolveFallbackModel(orchestrator, linkedProjects);
      // Fail fast: with no model anywhere, getModel would fall back to a paid/likely
      // unreachable default and every node (planning, exec, verif) would fail with an
      // opaque proxy error. Surface a clear, actionable message before any LLM call.
      if (!this.fallbackModel && !linkedProjects.some((p) => p.model)) {
        throw new Error(
          "Aucun modèle utilisable configuré — sélectionne un modèle sur l'orchestrateur ou sur au moins un agent (ou configure une clé OpenRouter).",
        );
      }
      console.warn(`[orchestrator] Fallback model: ${this.fallbackModel ?? "DEFAULT"}`);

      // Resolve fallback reasoning effort from the orchestrator
      this.fallbackReasoningEffort = orchestrator.reasoningEffort || undefined;
      console.warn(
        `[orchestrator] Fallback reasoning effort: ${this.fallbackReasoningEffort ?? "none"}`,
      );

      // Resolve execution tier from the explicit toggle (no auto-detection).
      this.tierProfile = orchestrator.orchSettings?.adaptToWeakModel
        ? WEAK_TIER
        : STRONG_TIER;
      console.warn(`[orchestrator] Tier: ${this.tierProfile.tier}`);

      this.maxParallelNodes = resolveMaxParallelNodes(orchestrator);
      console.warn(`[orchestrator] Max parallel nodes: ${this.maxParallelNodes}`);

      this.sendStatus({ projectId: orchestratorId, status: "running", workspaceDir });
      for (const p of linkedProjects) {
        this.sendStatus({ projectId: p.id, status: "idle" });
      }

      // Step 2: Orchestrator planning phase (Auto-distribute tasks)
      const wsContext = await buildWorkspaceContext(workspaceDir);
      let tasksMap: Record<string, string> = {};
      let plannedSteps: Record<string, SubStep[]> = {};
      let expectedFilesMap: Record<string, readonly string[]> = {};
      let checksMap: ChecksMap = {};

      if (orchestrator.orchSettings?.autoDistribute) {
        this.sendStatus({
          projectId: orchestratorId,
          status: "running",
          task: "Planification itérative des tâches...",
        });

        const planResult = await this.generatePlanningIterative(
          orchestrator,
          linkedProjects,
          task,
          wsContext,
        );
        tasksMap = planResult.tasks;
        plannedSteps = planResult.steps;
        expectedFilesMap = planResult.expectedFiles;
        checksMap = planResult.checks;

        console.warn(
          `[orchestrator] Planning complete: ${Object.keys(tasksMap).length} tasks, ${Object.keys(plannedSteps).length} with steps, ${planResult.createdSubAgents.length} sub-agents created`,
        );

        // Integrate sub-agents created during planning
        if (planResult.createdSubAgents.length > 0) {
          for (const sub of planResult.createdSubAgents) {
            linkedProjects.push(sub);
          }
          console.warn(
            `[orchestrator] Sub-agents added to execution:`,
            planResult.createdSubAgents.map((s) => `${s.name} (${s.id}, type=${s.type})`),
          );
        }

        // Refresh in-memory projects FIRST so we don't overwrite deps saved by the planner
        const refreshed = await getProjects();
        allProjects = refreshed;
        for (let i = 0; i < linkedProjects.length; i++) {
          const fresh = refreshed.find((r) => r.id === linkedProjects[i].id);
          if (fresh) linkedProjects[i] = fresh;
        }

        // Save generated tasks and update in-memory projects so executeNode sees them
        for (let i = 0; i < linkedProjects.length; i++) {
          const p = linkedProjects[i];
          if (tasksMap[p.id]) {
            const updatedProject = { ...p, task: tasksMap[p.id] };
            await saveProject(updatedProject);
            linkedProjects[i] = updatedProject;
            this.sendStatus({ projectId: p.id, status: "idle", task: tasksMap[p.id] });
          }
        }
        // Refresh allProjects so depContext builders see updated tasks
        allProjects = await getProjects();
      } else {
        // Use pre-configured tasks
        for (const p of linkedProjects) {
          tasksMap[p.id] = p.task || "";
        }
      }

      // Step 3: Run Pre-Execution Prompt Verifier (advisory, never blocks)
      if (orchestrator.orchSettings?.checkCoherence) {
        const verifier = this.metaVerifier(allProjects);
        if (verifier) {
          this.sendStatus({
            projectId: verifier.id,
            status: "running",
            task: "Vérification des prompts...",
          });
          try {
            const isValid = await this.verifyPrompts(
              verifier,
              task,
              tasksMap,
              linkedProjects,
            );
            if (!isValid) {
              console.warn(
                "[orchestrator] Coherence check flagged issues — continuing anyway.",
              );
              this.sendStatus({
                projectId: verifier.id,
                status: "warning",
                error:
                  "Cohérence partielle — exécution en cours malgré les avertissements.",
              });
            } else {
              this.sendStatus({
                projectId: verifier.id,
                status: "done",
                task: "Prompts validés avec succès.",
              });
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[orchestrator] Coherence check failed (non-blocking): ${msg}`);
            this.sendStatus({
              projectId: verifier.id,
              status: "warning",
              error: `Vérification de cohérence ignorée — ${msg.substring(0, 160)}`,
            });
          }
        }
      }

      // Step 4: Resolve Topological Order (DAG)
      const executionOrder = resolveDAG(linkedProjects);
      console.warn(
        "[orchestrator] Execution order:",
        executionOrder.map((n) => n.name),
      );

      // Step 5: Execute each node
      const executeNodes =
        this.maxParallelNodes > 1
          ? this.executeNodesWaves.bind(this)
          : this.executeNodesSequence.bind(this);
      const executionStatuses = await executeNodes(
        orchestrator,
        executionOrder,
        allProjects,
        executionResults,
        wsContext,
        plannedSteps,
        workspaceDir,
        expectedFilesMap,
        checksMap,
        tasksMap,
      );

      // Step 6: Final Brand and Spec verification
      const hasErrors = Object.values(executionStatuses).includes("error");
      if (!hasErrors && orchestrator.orchSettings?.checkCoherence) {
        const verifier = this.metaVerifier(allProjects);
        if (verifier) {
          this.sendStatus({
            projectId: verifier.id,
            status: "running",
            task: "Vérification finale de l'image de la marque et conformité...",
          });
          try {
            const brandValid = await this.verifyBrandCompliance(verifier, workspaceDir);
            if (brandValid) {
              this.sendStatus({
                projectId: verifier.id,
                status: "done",
                task: "Conformité de marque validée.",
              });
            } else {
              this.sendStatus({
                projectId: verifier.id,
                status: "warning",
                error: "Écarts détectés avec la charte graphique de la marque.",
              });
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              `[orchestrator] Brand verification failed (non-blocking): ${msg}`,
            );
            this.sendStatus({
              projectId: verifier.id,
              status: "warning",
              error: `Vérification de marque ignorée — ${msg.substring(0, 160)}`,
            });
          }
        }
      }

      // Step 7: Auto quality loop — runs whenever a verifier agent exists.
      // A verifier's purpose is to gate quality, so its findings are applied as
      // fixes automatically (no longer gated behind relaunchOnError).
      if (!hasErrors) {
        const verifier = this.metaVerifier(allProjects);
        if (verifier) {
          // Best-effort: the auto-quality loop refines already-produced
          // deliverables. An infra/auth failure here must not flip a fully
          // executed orchestration to "error".
          try {
            await this.runAutoQualityLoop(
              orchestrator,
              linkedProjects,
              task,
              workspaceDir,
              executionStatuses,
              executionResults,
              expectedFilesMap,
              verifier,
              checksMap,
            );
          } catch (qErr: unknown) {
            if (this.abortSignal?.aborted) throw qErr;
            const qMsg = qErr instanceof Error ? qErr.message : String(qErr);
            console.warn(
              `[orchestrator] Auto quality loop crashed (non-blocking): ${qMsg}`,
            );
          }
        } else {
          // No verifier to drive a fix loop — still surface broken asset
          // references deterministically so the build isn't silently broken.
          await this.warnOnBrokenAssets(orchestrator, workspaceDir);
        }
      }

      // Complete orchestrator status
      const hasErrorsFinal = Object.values(executionStatuses).includes("error");
      const finalStatus = hasErrorsFinal ? "error" : "done";
      this.sendStatus({ projectId: orchestratorId, status: finalStatus });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sendStatus({ projectId: orchestratorId, status: "error", error: msg });
      throw err;
    } finally {
      this.isRunning = false;
      this.currentOrchestratorId = null;
      this.abortController = null;
    }
  }

  /**
   * Resolve workspace directory from candidates (workflow workDir, orchestrator path, proxy, auto-created).
   */
  private resolveWorkspaceDir(
    orchestrator: Project,
    workDir?: string,
    workflowName?: string,
  ): string {
    const candidates = [
      workDir?.trim(),
      orchestrator.path?.trim(),
      getActiveWorkspaceDir(),
    ];
    const resolvedDir =
      candidates.find((d) => d && path.isAbsolute(d) && isSafeWorkspaceDir(d)) ?? null;
    const fallbackName = (workflowName?.trim() || orchestrator.name)
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .substring(0, 60);
    const dir = resolvedDir ?? path.join(homedir(), "_orch", fallbackName);
    const source =
      resolvedDir === workDir?.trim()
        ? "workflow workDir"
        : resolvedDir === orchestrator.path?.trim()
          ? "orchestrator path"
          : resolvedDir
            ? "proxy workspace"
            : "auto-created, no workspace set";
    console.warn(`[orchestrator] Workspace: ${dir} (${source})`);
    return dir;
  }

  /**
   * Execute nodes in topological order, broadcast statuses, extract files, and run post-processing.
   */
  private async executeNodesSequence(
    orchestrator: Project,
    executionOrder: readonly Project[],
    allProjects: readonly Project[],
    executionResults: Map<string, string>,
    workspaceContext: string,
    plannedSteps: Record<string, SubStep[]>,
    workspaceDir: string,
    expectedFilesMap: Record<string, readonly string[]> = {},
    checksMap: ChecksMap = {},
    tasksMap?: Record<string, string>,
  ): Promise<Record<string, "done" | "error" | "skipped" | "inactive">> {
    const executionStatuses: Record<string, "done" | "error" | "skipped" | "inactive"> =
      {};

    for (const node of executionOrder) {
      if (this.abortController?.signal.aborted) {
        throw new Error("Orchestration annulée par l'utilisateur.");
      }

      const failedDep = findFailedDependency(node, executionStatuses);
      const hasNoTask =
        tasksMap && (!tasksMap[node.id] || tasksMap[node.id].trim().length === 0);
      if (failedDep) {
        console.warn(
          `[orchestrator] Skipping "${node.name}" — dependency "${failedDep}" is ${executionStatuses[failedDep]}`,
        );
        executionStatuses[node.id] = "skipped";
        this.sendStatus({ projectId: node.id, status: "skipped" });
        continue;
      } else if (hasNoTask) {
        console.warn(
          `[orchestrator] Skipping "${node.name}" — no task assigned (marked inactive)`,
        );
        executionStatuses[node.id] = "inactive";
        this.sendStatus({ projectId: node.id, status: "inactive" });
        continue;
      }

      await this.runOneNode(
        node,
        orchestrator,
        allProjects,
        executionResults,
        executionStatuses,
        workspaceContext,
        plannedSteps,
        workspaceDir,
        expectedFilesMap,
        checksMap,
      );
    }

    return executionStatuses;
  }

  /**
   * Execute nodes by wave (Kahn levels). Within each wave, pure-LLM nodes run
   * with bounded concurrency (this.maxParallelNodes) while backend nodes run in a
   * serial lane. Each node writes only its own key in executionStatuses /
   * executionResults — safe under concurrency.
   */
  private async executeNodesWaves(
    orchestrator: Project,
    executionOrder: readonly Project[],
    allProjects: readonly Project[],
    executionResults: Map<string, string>,
    workspaceContext: string,
    plannedSteps: Record<string, SubStep[]>,
    workspaceDir: string,
    expectedFilesMap: Record<string, readonly string[]> = {},
    checksMap: ChecksMap = {},
    tasksMap?: Record<string, string>,
  ): Promise<Record<string, "done" | "error" | "skipped" | "inactive">> {
    const executionStatuses: Record<string, "done" | "error" | "skipped" | "inactive"> =
      {};
    const waves = resolveDAGWaves(executionOrder);
    console.warn(
      `[orchestrator] DAG resolved into ${waves.length} wave(s): ${waves.map((w, i) => `W${i}[${w.map((n) => n.name).join(", ")}]`).join(" → ")}`,
    );

    for (const wave of waves) {
      if (this.abortController?.signal.aborted) {
        throw new Error("Orchestration annulée par l'utilisateur.");
      }

      // Split wave: skip nodes whose deps failed, then partition by lane.
      const runnable: Project[] = [];
      for (const node of wave) {
        const failedDep = findFailedDependency(node, executionStatuses);
        const hasNoTask =
          tasksMap && (!tasksMap[node.id] || tasksMap[node.id].trim().length === 0);
        if (failedDep) {
          console.warn(
            `[orchestrator] Skipping "${node.name}" — dependency "${failedDep}" is ${executionStatuses[failedDep]}`,
          );
          executionStatuses[node.id] = "skipped";
          this.sendStatus({ projectId: node.id, status: "skipped" });
        } else if (hasNoTask) {
          console.warn(
            `[orchestrator] Skipping "${node.name}" — no task assigned (marked inactive)`,
          );
          executionStatuses[node.id] = "inactive";
          this.sendStatus({ projectId: node.id, status: "inactive" });
        } else {
          runnable.push(node);
        }
      }

      // Lane split: pure-LLM nodes vs backend (code/design) nodes.
      const backendNodes = runnable.filter((n) => selectBackend(n.type) !== null);
      const llmNodes = runnable.filter((n) => selectBackend(n.type) === null);

      const runNode = (node: Project) =>
        this.runOneNode(
          node,
          orchestrator,
          allProjects,
          executionResults,
          executionStatuses,
          workspaceContext,
          plannedSteps,
          workspaceDir,
          expectedFilesMap,
          checksMap,
        );

      // ≥2 backend agents can run concurrently ONLY with git-worktree isolation
      // on a scratch workspace — their tools write the same dir otherwise and
      // would clobber each other. Without it, the backend lane stays serial.
      const useWorktrees =
        this.maxParallelNodes > 1 &&
        backendNodes.length > 1 &&
        (await isScratchWorkspaceReal(workspaceDir)) &&
        (await isGitAvailable());

      if (useWorktrees) {
        // LLM lane first (to completion) so the main workspace is stable while we
        // snapshot it into git and merge worktrees back — no concurrent writes.
        await mapWithConcurrency(llmNodes, this.maxParallelNodes, runNode);
        try {
          await this.runBackendWaveIsolated(
            backendNodes,
            workspaceDir,
            runNode,
            executionStatuses,
          );
        } catch (err: unknown) {
          // A user cancel must still abort. But an infra failure setting up git
          // isolation should DEGRADE to the serial lane, not kill the whole run.
          if (this.abortController?.signal.aborted) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[orchestrator] Worktree isolation failed (${msg}) — backend lane falling back to serial.`,
          );
          await mapWithConcurrency(backendNodes, 1, runNode);
        }
      } else {
        if (this.maxParallelNodes > 1 && backendNodes.length > 1) {
          console.warn(
            `[orchestrator] ${backendNodes.length} backend nodes can't be isolated (non-scratch workspace or git unavailable) — running them serially.`,
          );
        }
        await Promise.all([
          mapWithConcurrency(backendNodes, 1, runNode),
          mapWithConcurrency(llmNodes, this.maxParallelNodes, runNode),
        ]);
      }
    }

    return executionStatuses;
  }

  /**
   * Run a wave's backend nodes concurrently, each in its own git worktree, then
   * merge results back into the main workspace sequentially. A merge conflict
   * downgrades the node to "error" and is surfaced — never silently dropped.
   */
  private async runBackendWaveIsolated(
    backendNodes: readonly Project[],
    workspaceDir: string,
    runNode: (node: Project) => Promise<void>,
    executionStatuses: Record<string, "done" | "error" | "skipped" | "inactive">,
  ): Promise<void> {
    await ensureGitBaseline(workspaceDir);
    const handles = new Map<string, WorktreeHandle>();
    // If creating any worktree fails partway, tear down the ones already created
    // so we never leak git state or leave stale nodeWorkspaces entries (which
    // would poison later waves — runOneNode would resolve a deleted dir).
    try {
      for (const node of backendNodes) {
        const h = await addWorktree(workspaceDir, node.id);
        handles.set(node.id, h);
        this.nodeWorkspaces.set(node.id, h.dir);
      }
    } catch (err: unknown) {
      for (const [id, h] of handles) {
        this.nodeWorkspaces.delete(id);
        await removeWorktree(workspaceDir, h);
      }
      throw err;
    }
    console.warn(
      `[orchestrator] Parallel-code lane: ${backendNodes.length} agents in isolated worktrees.`,
    );

    try {
      await mapWithConcurrency(backendNodes, this.maxParallelNodes, runNode);
    } finally {
      for (const node of backendNodes) this.nodeWorkspaces.delete(node.id);
    }

    // If the user cancelled mid-wave, don't apply any merges (that would mutate
    // the workspace after a stop request) — just clean up the worktrees.
    if (this.abortController?.signal.aborted) {
      for (const h of handles.values()) await removeWorktree(workspaceDir, h);
      return;
    }

    // Merge sequentially — each merge mutates the shared repo.
    for (const node of backendNodes) {
      const h = handles.get(node.id);
      if (!h) continue;
      try {
        if (executionStatuses[node.id] === "done" && (await commitWorktree(h))) {
          const res = await mergeWorktree(workspaceDir, h);
          if (res.ok) {
            // Register the merged deliverables in the shared ownership map so a
            // later (non-isolated) node can't clobber them and a corrective
            // rerun is correctly treated as a rerun, not a free-path first run.
            this.claimOwnership(node.id, this.backendWrittenPaths.get(node.id) ?? []);
          } else {
            executionStatuses[node.id] = "error";
            const detail = `Conflit de fusion (${res.conflicts.join(", ") || "fichiers inconnus"})`;
            console.error(`[orchestrator] Merge conflict for "${node.name}": ${detail}`);
            this.sendStatus({ projectId: node.id, status: "error", error: detail });
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[orchestrator] Worktree merge failed for "${node.name}": ${msg}`);
        executionStatuses[node.id] = "error";
        this.sendStatus({
          projectId: node.id,
          status: "error",
          error: `Fusion worktree échouée — ${msg.substring(0, 160)}`,
        });
      } finally {
        await removeWorktree(workspaceDir, h);
      }
    }
  }

  private async runOneNode(
    node: Project,
    orchestrator: Project,
    allProjects: readonly Project[],
    executionResults: Map<string, string>,
    executionStatuses: Record<string, "done" | "error" | "skipped" | "inactive">,
    workspaceContext: string,
    plannedSteps: Record<string, SubStep[]>,
    mainWorkspaceDir: string,
    expectedFilesMap: Record<string, readonly string[]>,
    checksMap: ChecksMap,
  ): Promise<void> {
    console.warn(
      `[orchestrator] ▶ Executing node "${node.name}" (type=${node.type}, model=${node.model || "fallback"})`,
    );
    console.warn(`[orchestrator]   Task: "${(node.task || "").substring(0, 120)}"`);
    this.sendStatus({ projectId: node.id, status: "running" });

    // A backend node running in an isolated git worktree (parallel-code lane)
    // does ALL its disk work in that worktree; everything else uses the main
    // workspace. The shared WORKSPACE_INDEX.md always stays in the main dir.
    const workspaceDir = this.nodeWorkspaces.get(node.id) ?? mainWorkspaceDir;

    const nodeExpectedFiles = expectedFilesMap[node.id] ?? [];
    const declaredNodeChecks: Record<string, FileChecks> = {};
    for (const f of nodeExpectedFiles) {
      if (checksMap[f]) declaredNodeChecks[f] = checksMap[f];
    }
    const nodeChecks = deriveFloorChecks(nodeExpectedFiles, declaredNodeChecks);
    const targetWords = Math.max(
      0,
      ...Object.values(nodeChecks).map((c) => c.minWords ?? 0),
    );
    // Scope every write this node makes (final + multi-turn intermediate) to its
    // own files, so a corrective relaunch can't clobber siblings' deliverables.
    // An isolated worktree node skips this scoping — it owns its whole checkout,
    // and isValidFilePath (in extractAndWriteFiles) still blocks path escapes.
    const nodePathFilter = this.nodeWorkspaces.has(node.id)
      ? () => true
      : this.buildNodePathFilter(node.id, nodeExpectedFiles);
    try {
      let resultText = await this.executeNode(
        node,
        allProjects,
        executionResults,
        workspaceContext,
        nodePathFilter,
        plannedSteps[node.id],
        workspaceDir,
        expectedFilesMap[node.id],
        targetWords,
        expectedFilesMap,
      );
      console.warn(
        `[orchestrator] ✓ Node "${node.name}" executed — result length: ${resultText.length} chars`,
      );
      const initialResultText = resultText;

      // Backend tools may have already written files — claim ownership and
      // pass them as a skip-set so extraction doesn't overwrite them (S5).
      const bwp = this.backendWrittenPaths.get(node.id) ?? [];
      if (bwp.length > 0) {
        this.claimOwnership(node.id, bwp);
        console.warn(
          `[orchestrator] Backend wrote ${bwp.length} files for "${node.name}": ${bwp.join(", ")}`,
        );
      }

      const writtenFiles = await this.extractAndWriteFiles(
        resultText,
        workspaceDir,
        nodePathFilter,
        node.id,
        bwp.length > 0 ? new Set(bwp) : undefined,
      );
      this.claimOwnership(node.id, writtenFiles);
      if (writtenFiles.length > 0) {
        console.warn(
          `[orchestrator] Extracted ${writtenFiles.length} files for "${node.name}": ${writtenFiles.join(", ")}`,
        );
      }

      await this.postExecuteProcessing(node, workspaceDir, resultText);

      const expectedFiles = expectedFilesMap[node.id] ?? [];
      const isProducerType =
        node.type === "work" || node.type === "code" || node.type === "design";
      const backendFilesWritten = this.backendFilesWritten.get(node.id) ?? 0;
      const looksTrivial =
        isProducerType && isTrivialResult(resultText) && backendFilesWritten === 0;
      if (expectedFiles.length > 0 || looksTrivial) {
        const nodeSystemPrompt = buildNodeSystemPrompt(node, {
          compact: this.tierProfile.compactPrompts,
        });
        try {
          const enforceResult = await enforceDeliverables(
            node,
            expectedFiles,
            workspaceDir,
            resultText,
            {
              relaunch: (prompt) =>
                callLLMStreaming(
                  node,
                  prompt,
                  120000,
                  this.abortSignal,
                  nodeSystemPrompt,
                  this.fallbackModel,
                  this.fallbackReasoningEffort,
                ),
              writeFiles: async (text) => {
                const w = await this.extractAndWriteFiles(
                  text,
                  workspaceDir,
                  nodePathFilter,
                  node.id,
                  bwp.length > 0 ? new Set(bwp) : undefined,
                );
                this.claimOwnership(node.id, w);
                return w;
              },
              onStatus: (msg) =>
                this.sendStatus({ projectId: node.id, status: "running", task: msg }),
            },
            nodeChecks,
          );
          resultText = enforceResult.resultText;
          if (enforceResult.missing.length > 0 || enforceResult.trivial) {
            const details =
              enforceResult.missing.length > 0
                ? `Fichiers manquants après relances : ${enforceResult.missing.join(", ")}`
                : `Résultat insuffisant (< ${MIN_RESULT_CHARS} caractères)`;
            if (isTrivialResult(initialResultText)) {
              throw new Error(details);
            }
            console.warn(
              `[orchestrator] Deliverable enforcement failed for "${node.name}" (non-blocking — result is ${initialResultText.length} chars): ${details}`,
            );
            this.sendStatus({
              projectId: node.id,
              status: "warning",
              error: details.substring(0, 200),
            });
          } else if (enforceResult.unmetChecks.length > 0) {
            const detail = `Contenu sous la cible après relances : ${enforceResult.unmetChecks.slice(0, 3).join(" ; ")}`;
            console.warn(
              `[orchestrator] Content depth below target for "${node.name}" (non-blocking): ${detail}`,
            );
            this.sendStatus({
              projectId: node.id,
              status: "warning",
              error: detail.substring(0, 200),
            });
          }
        } catch (enforceErr: unknown) {
          if (this.abortSignal?.aborted) throw enforceErr;
          if (isTrivialResult(initialResultText)) throw enforceErr;
          const enforceMsg =
            enforceErr instanceof Error ? enforceErr.message : String(enforceErr);
          console.warn(
            `[orchestrator] Deliverable enforcement crashed for "${node.name}" (non-blocking — result is ${initialResultText.length} chars): ${enforceMsg}`,
          );
          this.sendStatus({
            projectId: node.id,
            status: "warning",
            error: `Vérification livrables échouée — ${enforceMsg.substring(0, 160)}`,
          });
        }
      }

      if (orchestrator.orchSettings?.checkCoherence) {
        const verifier = this.metaVerifier(allProjects);
        if (verifier) {
          console.warn(
            `[orchestrator] Running output verification for "${node.name}"...`,
          );
          try {
            const verdict = await this.verifyOutput(
              verifier,
              node,
              resultText,
              expectedFilesMap[node.id] ?? [],
              workspaceDir,
            );
            if (!verdict.valid) {
              const detail = verdict.reason
                ? verdict.reason.substring(0, 200)
                : "le vérificateur a signalé des problèmes";
              console.warn(
                `[orchestrator] Output verification flagged issues for "${node.name}" — continuing anyway: ${detail}`,
              );
              this.sendStatus({
                projectId: node.id,
                status: "warning",
                error: detail,
              });
            }
          } catch (verifyErr: unknown) {
            if (this.abortSignal?.aborted) throw verifyErr;
            const vMsg =
              verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
            console.warn(
              `[orchestrator] Output verification crashed for "${node.name}" (non-blocking): ${vMsg}`,
            );
            this.sendStatus({
              projectId: node.id,
              status: "warning",
              error: `Vérification ignorée — ${vMsg.substring(0, 160)}`,
            });
          }
        }
      }

      executionStatuses[node.id] = "done";
      executionResults.set(node.id, resultText);
      this.sendStatus({ projectId: node.id, status: "done", result: resultText });
      await this.updateWorkspaceIndex(node, resultText, mainWorkspaceDir);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[orchestrator] Node "${node.name}" failed:`, msg);
      executionStatuses[node.id] = "error";
      this.sendStatus({ projectId: node.id, status: "error", error: msg });
    }
  }

  /**
   * Iterate on a previous run: triage feedback, relance targeted agents, modify existing files.
   */
  async iterate(
    orchestratorId: string,
    feedback: string,
    previousRun: OrchRun,
    workDir?: string,
    workflowName?: string,
  ): Promise<void> {
    if (this.isRunning) {
      throw new Error("Une orchestration est déjà en cours d'exécution.");
    }

    this.isRunning = true;
    this.currentOrchestratorId = orchestratorId;
    this.abortController = new AbortController();
    this.resetPerRunState();

    try {
      const allProjects = await getProjects();
      const orchestrator = allProjects.find((p) => p.id === orchestratorId);
      if (!orchestrator || orchestrator.type !== "orchestrator") {
        throw new Error(
          "L'identifiant fourni ne correspond pas à un orchestrateur valide.",
        );
      }

      const linkedIds = orchestrator.linked || [];
      const linkedProjects = allProjects.filter((p) => linkedIds.includes(p.id));

      // Same precedence as run() — keeps the resolved model stable across resume.
      this.fallbackModel = resolveFallbackModel(orchestrator, linkedProjects);
      this.fallbackReasoningEffort = orchestrator.reasoningEffort || undefined;
      this.maxParallelNodes = resolveMaxParallelNodes(orchestrator);
      // Resolve the tier here too — without this the singleton runner would reuse
      // whatever tier the previous run() set (e.g. WEAK from another orchestrator).
      this.tierProfile = orchestrator.orchSettings?.adaptToWeakModel
        ? WEAK_TIER
        : STRONG_TIER;

      const workspaceDir = this.resolveWorkspaceDir(orchestrator, workDir, workflowName);
      const wsExists = await fs
        .access(workspaceDir)
        .then(() => true)
        .catch(() => false);
      if (!wsExists) {
        throw new Error(
          "Le workspace du run précédent n'existe plus — relance une orchestration complète.",
        );
      }
      await this.ensureWorkspaceIndexFile(workspaceDir);

      this.sendStatus({
        projectId: orchestratorId,
        status: "running",
        task: "Triage du feedback…",
        workspaceDir,
      });

      const wsContext = await buildWorkspaceContext(workspaceDir);
      const { statuses } = await this.runCorrectiveCycle(
        orchestrator,
        linkedProjects,
        feedback,
        previousRun,
        workspaceDir,
        wsContext,
        {},
      );

      const hasErrors = Object.values(statuses).includes("error");
      const finalStatus = hasErrors ? "error" : "done";
      this.sendStatus({ projectId: orchestratorId, status: finalStatus });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sendStatus({ projectId: orchestratorId, status: "error", error: msg });
      throw err;
    } finally {
      this.isRunning = false;
      this.currentOrchestratorId = null;
      this.abortController = null;
    }
  }

  /**
   * Topological sort to handle dependencies (DAG)
   */
  /**
   * Shared corrective cycle: triage feedback → apply fixes → DAG subset → execute.
   * Used by both iterate() (human feedback) and runAutoQualityLoop (auto feedback).
   */
  private async runCorrectiveCycle(
    orchestrator: Project,
    linkedProjects: readonly Project[],
    feedback: string,
    previousRun: OrchRun,
    workspaceDir: string,
    wsContext: string,
    expectedFilesMap: Record<string, readonly string[]>,
    checksMap: ChecksMap = {},
  ): Promise<{
    statuses: Record<string, "done" | "error" | "skipped" | "inactive">;
    results: Map<string, string>;
  }> {
    const fixes = await planIterationFixes({
      orchestrator,
      linked: linkedProjects,
      feedback,
      previousRun,
      workspaceContext: wsContext,
      signal: this.abortSignal,
      fallbackModel: this.fallbackModel,
      fallbackReasoningEffort: this.fallbackReasoningEffort,
    });

    const fixedIds = Object.keys(fixes);
    if (fixedIds.length === 0) {
      throw new Error("Le feedback ne cible aucun agent — reformule ta demande.");
    }

    console.warn(`[orchestrator] Triage: ${fixedIds.length} agents to relaunch`);

    for (const p of linkedProjects) {
      if (!fixes[p.id]) continue;
      const prevResult = previousRun.nodeResults.find(
        (r) => r.projectId === p.id,
      )?.result;
      // Pure-LLM agents have no disk access, so inject the REAL current content of
      // their own files as the source of truth. Backend agents (OpenCode/Open
      // Design) read the workspace via their own tools — skip to avoid bloat.
      let diskContent = "";
      if (selectBackend(p.type) === null) {
        const ownedFiles = this.ownedFilesForNode(p.id, expectedFilesMap);
        if (ownedFiles.length > 0) {
          diskContent = await this.readDiskEvidence(workspaceDir, ownedFiles);
        }
      }
      const fixTask = buildFixTask(fixes[p.id], feedback, prevResult, diskContent);
      await saveProject({ ...p, task: fixTask });
      this.sendStatus({ projectId: p.id, status: "idle", task: fixTask });
    }

    const allProjects = await getProjects();
    const refreshedLinked = allProjects.filter((p) =>
      (orchestrator.linked || []).includes(p.id),
    );

    const executionResults = new Map<string, string>();
    for (const r of previousRun.nodeResults) {
      if (r.result) executionResults.set(r.projectId, r.result);
    }

    const subset = refreshedLinked.filter((p) => fixes[p.id]);
    const executionOrder = resolveDAG(subset);

    const executeNodes =
      this.maxParallelNodes > 1
        ? this.executeNodesWaves.bind(this)
        : this.executeNodesSequence.bind(this);
    // These nodes ARE reruns by definition (corrective relaunch). Mark them so
    // buildNodePathFilter applies the anti-parasitic guard deterministically,
    // without depending on stale fileOwner state carried across run()/iterate().
    this.correctiveNodeIds = new Set(fixedIds);
    let statuses: Record<string, "done" | "error" | "skipped" | "inactive">;
    try {
      statuses = await executeNodes(
        orchestrator,
        executionOrder,
        allProjects,
        executionResults,
        wsContext,
        {},
        workspaceDir,
        expectedFilesMap,
        checksMap,
        fixes,
      );
    } finally {
      this.correctiveNodeIds = null;
    }

    return { statuses, results: executionResults };
  }

  private async runQualityGate(
    verifier: Project,
    task: string,
    linkedProjects: readonly Project[],
    workspaceDir: string,
    executionStatuses: Readonly<
      Record<string, "done" | "error" | "skipped" | "inactive">
    >,
    executionResults: ReadonlyMap<string, string>,
    expectedFilesMap: Readonly<Record<string, readonly string[]>>,
    checksMap: ChecksMap = {},
  ): Promise<ReturnType<typeof parseQualityVerdict>> {
    this.sendStatus({
      projectId: verifier.id,
      status: "running",
      task: "Audit qualité global…",
    });

    const summaryBlocks = linkedProjects
      .filter((p) => p.type !== "verifier" && p.type !== "orchestrator")
      .map((p) => {
        const status = executionStatuses[p.id] ?? "unknown";
        const result = executionResults.get(p.id);
        const excerpt = result ? result.substring(0, 3000) : "(aucun résultat)";
        return `--- Agent "${p.name}" (statut: ${status}) ---\n${excerpt}`;
      })
      .join("\n\n");

    const filesReport = await buildExpectedFilesReport(
      expectedFilesMap,
      workspaceDir,
      linkedProjects,
    );
    const htmlHeads = await collectHtmlHeadSnippets(workspaceDir);
    const cssSnippets = await collectCssSnippets(workspaceDir);
    const brokenAssets = await findBrokenAssetRefs(workspaceDir);
    const uncodedMockups = await findUncodedMockups(workspaceDir);

    // Charger les rapports d'audit écrits sur le disque par les agents vérificateurs
    let auditReports = "";
    try {
      const reportsDir = path.join(workspaceDir, "reports");
      const files = await fs.readdir(reportsDir);
      const blocks: string[] = [];
      for (const f of files) {
        if (/\.(md|txt)$/i.test(f)) {
          const content = await fs.readFile(path.join(reportsDir, f), "utf-8");
          blocks.push(`=== ${f} ===\n${content.substring(0, 10000)}`);
        }
      }
      if (blocks.length > 0) {
        auditReports = blocks.join("\n\n");
      }
    } catch {
      // Ignorer si le dossier reports n'existe pas
    }

    const servedProblems = [
      ...(await findServedSiteProblems(workspaceDir)),
      ...(await findCssConsistencyProblems(workspaceDir)),
      ...(await findRenderProblems(workspaceDir)),
      ...(await findBrandConsistencyProblems(workspaceDir)),
      // Format-agnostic (non-web) deterministic checks — the floor for weak models.
      ...(await findInvalidJsonFiles(workspaceDir)),
      ...(await findCsvColumnProblems(workspaceDir)),
      ...(await findPlaceholderDeliverables(workspaceDir)),
      // Consolidation that summarized instead of including full content (A4).
      ...(await findConsolidationShrinkage(workspaceDir)),
      // HTML pages whose classes have no CSS rule → unstyled/broken site (B2).
      ...(await findUnstyledClasses(workspaceDir)),
      // Served pages still carrying placeholder containers / filler text (N4).
      ...(await findServedHtmlPlaceholders(workspaceDir)),
      // JSON-LD price never shown in the visible page → structured-data drift (N8).
      ...(await findStructuredDataMismatch(workspaceDir)),
    ];
    // Cross-agent API mismatches (import of a symbol a sibling module doesn't
    // export) + unintegrated orphan modules — the #1 multi-file code failure.
    // Attributed to the file's OWNING agent (not front-end integration), so the
    // corrective cycle routes the fix to whoever produced the broken file.
    const moduleGraphProblems = await findModuleGraphProblems(workspaceDir);
    // Stylesheets/scripts no served page references — leftover duplicates from a
    // superseded design pass (e.g. styles.css beside the linked style.css).
    // Attributed to the file's owner so the right agent integrates or removes it.
    const orphanStylesheets = await findOrphanStylesheets(workspaceDir);
    // Machine-checkable contract declared by the planner (Couche 1) — attributed
    // to the owning agent so the corrective cycle routes the fix correctly.
    const declaredCheckProblems = await validateDeclaredChecks(workspaceDir, checksMap);
    const agentOwning = (file: string): string => {
      for (const [nodeId, files] of Object.entries(expectedFilesMap)) {
        if (files?.includes(file)) {
          return linkedProjects.find((p) => p.id === nodeId)?.name ?? "intégration";
        }
      }
      return "intégration";
    };
    // Missing contracted files (expected_files) are the one generic, domain-agnostic
    // deliverable contract — force-fail on them and attribute to the owning agent.
    const missingByAgent: Array<{ agent: string; file: string }> = [];
    for (const [nodeId, files] of Object.entries(expectedFilesMap)) {
      if (!files || files.length === 0) continue;
      const { missing } = await checkExpectedFiles(workspaceDir, files);
      const agentName =
        linkedProjects.find((p) => p.id === nodeId)?.name ?? "agent inconnu";
      for (const f of missing) missingByAgent.push({ agent: agentName, file: f });
    }
    const brokenAssetsReport = [
      buildBrokenAssetsReport(brokenAssets),
      buildPageCoverageReport(uncodedMockups),
      buildServedSiteReport([
        ...servedProblems,
        ...declaredCheckProblems,
        ...moduleGraphProblems,
        ...orphanStylesheets,
      ]),
    ]
      .filter((s) => s.trim())
      .join("\n\n");

    const systemPrompt = buildQualityGateSystemPrompt(verifier);
    const userPrompt = buildQualityGateUserPrompt({
      globalTask: task,
      nodeResultSummaries: summaryBlocks,
      expectedFilesReport: filesReport,
      htmlHeads,
      cssSnippets,
      brokenAssetsReport,
      auditReports,
    });

    const response = await callLLMStructured(
      verifier,
      systemPrompt,
      userPrompt,
      QUALITY_VERDICT_TOOL,
      this.abortSignal,
      this.fallbackModel,
      this.fallbackReasoningEffort,
    );

    const llmVerdict = parseQualityVerdict(response);

    // Deterministic defects ALWAYS gate, regardless of the LLM's judgment — a
    // model that wrongly says "pass" must not let broken links, uncoded pages or
    // placeholder/escape defects through. Merge them into the verdict and force
    // a fail so the corrective cycle is guaranteed to run.
    const deterministicIssues = [
      ...brokenAssets.map((b) => ({
        agent: "intégration front-end",
        issue: `Référence cassée : ${b.sourceFile} → "${b.ref}"`,
        fix: `Créer/copier la cible ou corriger le chemin dans ${b.sourceFile}`,
      })),
      ...uncodedMockups.map((p) => ({
        agent: "intégration front-end",
        issue: `Page maquettée non codée : ${p}`,
        fix: `Coder la page servie ${p} à partir de mockups/${p} et l'ajouter à la navigation`,
      })),
      ...servedProblems.map((s) => ({
        agent: "intégration front-end",
        issue: `${s.sourceFile} → ${s.problem}`,
        fix: s.problem,
      })),
      ...missingByAgent.map((m) => ({
        agent: m.agent,
        issue: `Fichier attendu manquant ou vide : ${m.file}`,
        fix: `Produire le fichier ${m.file} (complet, > ${MIN_RESULT_CHARS} caractères de contenu réel)`,
      })),
      ...declaredCheckProblems.map((p) => ({
        agent: agentOwning(p.sourceFile),
        issue: `Contrainte non respectée : ${p.sourceFile} → ${p.problem}`,
        fix: `Corriger ${p.sourceFile} pour satisfaire : ${p.problem}`,
      })),
      ...moduleGraphProblems.map((p) => ({
        agent: agentOwning(p.sourceFile),
        issue: `${p.sourceFile} → ${p.problem}`,
        fix: `Corriger ${p.sourceFile} : aligner les noms importés/exportés sur les modules réellement produits (vérifie le contexte de dépendances), ou intégrer/supprimer le module.`,
      })),
      ...orphanStylesheets.map((p) => ({
        agent: agentOwning(p.sourceFile),
        issue: `${p.sourceFile} → ${p.problem}`,
        fix: `Intégrer ${p.sourceFile} dans une page (via <link>/@import) si utile, sinon le supprimer pour éviter le doublon.`,
      })),
    ].slice(0, 30);

    const llmIssues = llmVerdict?.issues ?? [];
    // Fail CLOSED: an unparseable LLM verdict must NOT pass the gate. Previously
    // `?? true` let a parse failure sail through (the degraded state shipped
    // because the verdict couldn't be read). A null verdict now blocks and adds
    // an explicit issue so the corrective cycle has something to act on.
    const parseFailureIssues =
      llmVerdict === null
        ? [
            {
              agent: "vérificateur",
              issue: "Verdict qualité illisible (parse JSON échoué)",
              fix: "Relancer la vérification et renvoyer un JSON {pass, issues} valide.",
            },
          ]
        : [];
    const verdict = {
      pass:
        llmVerdict !== null &&
        llmVerdict.pass === true &&
        deterministicIssues.length === 0,
      issues: [...deterministicIssues, ...parseFailureIssues, ...llmIssues],
    };
    console.warn(
      `[orchestrator:quality] Verdict: pass=${verdict.pass}, issues=${verdict.issues.length} (déterministes: ${deterministicIssues.length}, LLM: ${llmIssues.length}${llmVerdict ? "" : ", parse LLM échoué"})`,
    );

    if (!verdict.pass) {
      this.sendStatus({
        projectId: verifier.id,
        status: "warning",
        error: `Quality gate: ${verdict.issues.length} problème(s) détecté(s).`,
      });
    } else {
      this.sendStatus({
        projectId: verifier.id,
        status: "done",
        task: "Quality gate validé.",
      });
    }

    return verdict;
  }

  /**
   * Deterministic, no-LLM broken-asset check used when no verifier agent is
   * present to drive a fix loop. Surfaces missing src/href/url() targets as a
   * non-blocking warning so the user isn't left with a silently broken build.
   */
  private async warnOnBrokenAssets(
    orchestrator: Project,
    workspaceDir: string,
  ): Promise<void> {
    const broken = await findBrokenAssetRefs(workspaceDir);
    const uncoded = await findUncodedMockups(workspaceDir);
    const served = [
      ...(await findServedSiteProblems(workspaceDir)),
      ...(await findCssConsistencyProblems(workspaceDir)),
      ...(await findInvalidJsonFiles(workspaceDir)),
      ...(await findCsvColumnProblems(workspaceDir)),
      ...(await findPlaceholderDeliverables(workspaceDir)),
      ...(await findConsolidationShrinkage(workspaceDir)),
      ...(await findUnstyledClasses(workspaceDir)),
      // High false-positive risk → warning only, never force-fail.
      ...(await findUnreferencedModules(workspaceDir)),
      ...(await findDivergentDuplicates(workspaceDir)),
      ...(await findScatteredDuplicates(workspaceDir)),
      ...(await findUnwantedWebScaffolding(workspaceDir)),
      ...(await findUselessDesignArtifacts(workspaceDir)),
      // Optional headless render (Problème 8) — best-effort, dev-only, never
      // blocking; silently skipped if Playwright/browser is unavailable.
      ...(await findRenderProblems(workspaceDir)),
    ];
    if (broken.length === 0 && uncoded.length === 0 && served.length === 0) return;

    const parts: string[] = [];
    if (broken.length > 0) {
      const preview = broken
        .slice(0, 5)
        .map((b) => `${b.sourceFile} → "${b.ref}"`)
        .join(", ");
      const suffix = broken.length > 5 ? ` (+${broken.length - 5})` : "";
      parts.push(`${broken.length} référence(s) cassée(s) : ${preview}${suffix}`);
    }
    if (uncoded.length > 0) {
      parts.push(
        `${uncoded.length} maquette(s) non codée(s) : ${uncoded.slice(0, 5).join(", ")}${uncoded.length > 5 ? ` (+${uncoded.length - 5})` : ""}`,
      );
    }
    if (served.length > 0) {
      parts.push(
        `${served.length} défaut(s) site servi : ${served
          .slice(0, 3)
          .map((s) => s.sourceFile)
          .join(", ")}${served.length > 3 ? ` (+${served.length - 3})` : ""}`,
      );
    }
    console.warn(
      `[orchestrator] Quality warnings — broken: ${broken.length}, uncoded mockups: ${uncoded.length}, served defects: ${served.length}`,
    );
    this.sendStatus({
      projectId: orchestrator.id,
      status: "warning",
      error: parts.join(" | "),
    });
  }

  private async runAutoQualityLoop(
    orchestrator: Project,
    linkedProjects: readonly Project[],
    task: string,
    workspaceDir: string,
    executionStatuses: Record<string, "done" | "error" | "skipped" | "inactive">,
    executionResults: Map<string, string>,
    expectedFilesMap: Record<string, readonly string[]>,
    verifier: Project,
    checksMap: ChecksMap,
  ): Promise<void> {
    for (let cycle = 1; cycle <= MAX_AUTO_QUALITY_LOOPS; cycle++) {
      if (this.abortController?.signal.aborted) {
        throw new Error("Orchestration annulée par l'utilisateur.");
      }

      const verdict = await this.runQualityGate(
        verifier,
        task,
        linkedProjects,
        workspaceDir,
        executionStatuses,
        executionResults,
        expectedFilesMap,
        checksMap,
      );

      if (!verdict || verdict.pass) {
        console.warn(`[orchestrator:quality] Quality gate passed at cycle ${cycle}`);
        return;
      }

      console.warn(
        `[orchestrator:quality] Quality gate failed — starting corrective cycle ${cycle}/${MAX_AUTO_QUALITY_LOOPS}`,
      );
      this.sendStatus({
        projectId: orchestrator.id,
        status: "running",
        task: `Cycle qualité automatique ${cycle}/${MAX_AUTO_QUALITY_LOOPS}…`,
      });

      const autoFeedback = buildAutoFeedback(verdict);
      const syntheticRun = buildSyntheticRun(
        task,
        orchestrator.id,
        executionStatuses,
        executionResults,
        linkedProjects,
      );
      const wsContext = await buildWorkspaceContext(workspaceDir);

      const { statuses, results } = await this.runCorrectiveCycle(
        orchestrator,
        linkedProjects,
        autoFeedback,
        syntheticRun,
        workspaceDir,
        wsContext,
        expectedFilesMap,
        checksMap,
      );

      for (const [id, status] of Object.entries(statuses)) {
        executionStatuses[id] = status;
      }
      for (const [id, result] of results) {
        executionResults.set(id, result);
      }
    }
  }

  private resolveDepRef(
    ref: string,
    agentIds: ReadonlySet<string>,
    linked: readonly Project[],
    createdSubAgents: readonly Project[],
    parentToSubAgents: ReadonlyMap<string, readonly Project[]>,
  ): string | null {
    if (agentIds.has(ref)) return ref;

    const byName = [...linked, ...createdSubAgents].find(
      (p) => p.name === ref || p.name.endsWith(`› ${ref}`),
    );
    if (byName) return byName.id;

    for (const [pid, subs] of parentToSubAgents) {
      if (!ref.startsWith(pid) || ref.length <= pid.length) continue;
      if (subs.length === 1) return subs[0].id;
      const suffixNorm = normalizeForDepMatch(ref.slice(pid.length));

      // Match exact d'abord (sensible à la normalisation)
      const exactMatch = subs.find((s) => {
        const short = s.name.includes("›") ? s.name.split("›").pop()!.trim() : s.name;
        return normalizeForDepMatch(short) === suffixNorm;
      });
      if (exactMatch) return exactMatch.id;

      // Sinon match partiel (fuzzy), ordonné du plus long au plus court pour éviter les faux positifs
      const sortedSubs = [...subs].sort((a, b) => {
        const nameA = a.name.includes("›") ? a.name.split("›").pop()!.trim() : a.name;
        const nameB = b.name.includes("›") ? b.name.split("›").pop()!.trim() : b.name;
        return nameB.length - nameA.length;
      });

      const fuzzyMatch = sortedSubs.find((s) => {
        const short = s.name.includes("›") ? s.name.split("›").pop()!.trim() : s.name;
        const nameNorm = normalizeForDepMatch(short);
        return nameNorm.length >= 3 && suffixNorm.includes(nameNorm);
      });
      if (fuzzyMatch) return fuzzyMatch.id;
    }

    return null;
  }

  /**
   * Iterative agentic planning loop — assigns tasks (and optional sub-steps) to each agent
   * via tool-calling, similar to how opencode works in multi-turn conversations.
   */
  private async generatePlanningIterative(
    orchestrator: Project,
    linked: readonly Project[],
    globalTask: string,
    workspaceContext: string,
  ): Promise<PlanningResult> {
    const systemPrompt = buildIterativePlanningSystemPrompt(orchestrator);
    const userPrompt = buildIterativePlanningUserPrompt(
      globalTask,
      linked,
      workspaceContext,
    );

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const MAX_SUB_AGENTS = 15;
    const tasks: Record<string, string> = {};
    const steps: Record<string, SubStep[]> = {};
    const expectedFiles: Record<string, readonly string[]> = {};
    const checks: Record<string, FileChecks> = {};
    const createdSubAgents: Project[] = [];
    const agentIds = new Set(linked.map((p) => p.id));
    const parentDepsAccumulator: Record<string, string[]> = {};
    const parentToSubAgents = new Map<string, Project[]>();
    let finished = false;

    for (let iter = 0; iter < MAX_PLANNING_ITERATIONS && !finished; iter++) {
      if (this.abortController?.signal.aborted) {
        throw new Error("Orchestration annulée par l'utilisateur.");
      }

      const { message } = await callLLMWithTools(
        orchestrator,
        messages,
        PLANNING_TOOLS,
        this.abortSignal,
        this.fallbackModel,
        this.fallbackReasoningEffort,
      );

      // Fallback: model doesn't support tools → try to parse as JSON (single-shot)
      if (iter === 0 && !message.tool_calls?.length && message.content) {
        console.warn(
          "[orchestrator] Model returned text instead of tool calls, trying JSON fallback.",
        );
        console.warn(
          "[orchestrator] Raw planning response (first 500 chars):",
          message.content.substring(0, 500),
        );
        try {
          const cleaned = message.content
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();
          const parsed = JSON.parse(cleaned) as Record<string, string>;

          // Check if keys are agent IDs
          if (linked.some((p) => parsed[p.id])) {
            console.warn("[orchestrator] JSON fallback matched by agent IDs.");
            return {
              tasks: parsed,
              steps: {},
              createdSubAgents: [],
              expectedFiles: {},
              checks: {},
            };
          }

          // Try matching by agent name (model may use names instead of IDs)
          const remapped: Record<string, string> = {};
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value !== "string") continue;
            const match = linked.find(
              (p) =>
                p.id === key ||
                p.name.toLowerCase() === key.toLowerCase() ||
                key.toLowerCase().includes(p.name.toLowerCase()) ||
                p.name.toLowerCase().includes(key.toLowerCase()),
            );
            if (match) remapped[match.id] = value;
          }
          if (Object.keys(remapped).length > 0) {
            console.warn(
              `[orchestrator] JSON fallback matched ${Object.keys(remapped).length}/${linked.length} agents by name.`,
            );
            return {
              tasks: remapped,
              steps: {},
              createdSubAgents: [],
              expectedFiles: {},
              checks: {},
            };
          }

          console.warn(
            "[orchestrator] JSON fallback: no keys matched any agent.",
            Object.keys(parsed),
          );
        } catch (e) {
          console.warn(
            "[orchestrator] JSON fallback parse failed:",
            e instanceof Error ? e.message : String(e),
          );
        }
        // Last resort: give every agent the global task
        const fallback: Record<string, string> = {};
        for (const p of linked) fallback[p.id] = globalTask;
        return {
          tasks: fallback,
          steps: {},
          createdSubAgents: [],
          expectedFiles: {},
          checks: {},
        };
      }

      messages.push(message);

      if (!message.tool_calls?.length) {
        if (linked.every((p) => tasks[p.id])) {
          finished = true;
        } else {
          messages.push({
            role: "user",
            content: `Utilise l'outil assign_task pour assigner les tâches. Agents restants : ${linked
              .filter((p) => !tasks[p.id])
              .map((p) => `"${p.name}" (${p.id})`)
              .join(", ")}`,
          });
        }
        continue;
      }

      for (const toolCall of message.tool_calls) {
        const fnName = toolCall.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}") as Record<
            string,
            unknown
          >;
        } catch {
          messages.push({
            role: "tool",
            content: "Erreur : arguments JSON invalides.",
            tool_call_id: toolCall.id,
          });
          continue;
        }

        if (fnName === "assign_task") {
          const agentId = String(args.agent_id ?? "");
          const taskText = String(args.task ?? "");

          if (!agentIds.has(agentId)) {
            messages.push({
              role: "tool",
              content: `Erreur : agent_id "${agentId}" inconnu. IDs valides : ${[...agentIds].join(", ")}`,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          tasks[agentId] = taskText;

          const rawExpectedFiles = sanitizeExpectedFiles(args.expected_files);
          if (rawExpectedFiles.length > 0) {
            expectedFiles[agentId] = rawExpectedFiles;
          }

          // Machine-checkable contract, indexed by file path (the system enforces it).
          Object.assign(checks, sanitizeChecks(args.checks));

          const rawSteps = args.steps;
          if (Array.isArray(rawSteps) && rawSteps.length >= 2) {
            steps[agentId] = (rawSteps as Array<Record<string, string>>)
              .slice(0, MAX_SUBSTEPS)
              .map((s, i) => ({
                index: i,
                title: s.title || `Étape ${i + 1}`,
                focus: s.focus || "",
                deliverable: s.deliverable || "",
              }));
          }

          const rawDeps = args.depends_on;
          if (Array.isArray(rawDeps) && rawDeps.length > 0) {
            const resolvedDeps: string[] = [];
            for (const ref of rawDeps as string[]) {
              const resolved = this.resolveDepRef(
                ref,
                agentIds,
                linked,
                createdSubAgents,
                parentToSubAgents,
              );
              if (resolved) {
                resolvedDeps.push(resolved);
              } else {
                console.warn(
                  `[orchestrator] assign_task dep "${ref}" not found by ID or name — skipping`,
                );
              }
            }
            if (resolvedDeps.length > 0) {
              const existing = parentDepsAccumulator[agentId] || [];
              const merged = [...new Set([...existing, ...resolvedDeps])];
              parentDepsAccumulator[agentId] = merged;

              const agentProject = linked.find((p) => p.id === agentId);
              if (agentProject) {
                await saveProject({ ...agentProject, dependencies: merged });
                this.sendStatus({
                  projectId: agentId,
                  status: "idle",
                  dependencies: merged,
                });
              }
            }
          }

          const agent = linked.find((p) => p.id === agentId);
          const stepsInfo = steps[agentId]
            ? ` ${steps[agentId].length} sous-étapes planifiées.`
            : "";
          const remaining = linked.filter((p) => !tasks[p.id]);

          this.sendStatus({ projectId: agentId, status: "idle", task: taskText });

          console.warn(
            `[orchestrator] Assigned task to ${agent?.name}${steps[agentId] ? ` (${steps[agentId].length} steps)` : ""}`,
          );

          messages.push({
            role: "tool",
            content: `Tâche assignée à "${agent?.name}".${stepsInfo} Agents restants : ${
              remaining.length === 0
                ? "aucun — appelle finish_planning."
                : remaining.map((p) => p.name).join(", ")
            }`,
            tool_call_id: toolCall.id,
          });
        } else if (fnName === "create_sub_agent") {
          if (createdSubAgents.length >= MAX_SUB_AGENTS) {
            messages.push({
              role: "tool",
              content: `Erreur : limite de ${MAX_SUB_AGENTS} sous-agents atteinte. Utilise les agents existants.`,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          const VALID_SUB_TYPES = new Set(["work", "code", "recherche", "design"]);
          const parentId = String(args.parent_id ?? "");
          const subName = String(args.name ?? "").slice(0, 100);
          const rawType = String(args.type ?? "work");
          const subType = (
            VALID_SUB_TYPES.has(rawType) ? rawType : "work"
          ) as Project["type"];
          const subTask = String(args.task ?? "").slice(0, 10000);

          if (!agentIds.has(parentId)) {
            messages.push({
              role: "tool",
              content: `Erreur : parent_id "${parentId}" inconnu. IDs valides : ${[...agentIds].join(", ")}`,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          // Look up parent in both original linked AND already-created sub-agents
          const parentAgent =
            linked.find((p) => p.id === parentId) ||
            createdSubAgents.find((p) => p.id === parentId);

          if (!parentAgent) {
            messages.push({
              role: "tool",
              content: `Erreur : agent parent "${parentId}" introuvable.`,
              tool_call_id: toolCall.id,
            });
            continue;
          }

          // Resolve explicit depends_on — accept IDs, names, or parent-prefixed refs
          const rawSubDeps = (args.depends_on as string[]) || [];
          const resolvedDeps: string[] = [];
          for (const ref of rawSubDeps) {
            const resolved = this.resolveDepRef(
              ref,
              agentIds,
              linked,
              createdSubAgents,
              parentToSubAgents,
            );
            if (resolved) {
              resolvedDeps.push(resolved);
            } else {
              console.warn(
                `[orchestrator] Sub-agent dep "${ref}" not found by ID or name — skipping`,
              );
            }
          }
          const subDeps = [...new Set(resolvedDeps)];

          const subProject = await saveProject({
            name: `${parentAgent.name} › ${subName}`,
            type: subType,
            instructions: parentAgent.instructions || "",
            model: parentAgent.model,
            dependencies: subDeps,
            task: subTask,
            color: parentAgent.color || "",
            generated: true,
          });

          createdSubAgents.push(subProject);
          agentIds.add(subProject.id);
          tasks[subProject.id] = subTask;
          if (!parentToSubAgents.has(parentId)) parentToSubAgents.set(parentId, []);
          parentToSubAgents.get(parentId)!.push(subProject);

          // Track accumulated deps for parent (persisted once at the end of the loop)
          if (!parentDepsAccumulator[parentId]) {
            parentDepsAccumulator[parentId] = [...(parentAgent.dependencies || [])];
          }
          parentDepsAccumulator[parentId].push(subProject.id);

          this.sendStatus({ projectId: subProject.id, status: "idle", task: subTask });

          console.warn(
            `[orchestrator] Created sub-agent "${subProject.name}" (${subProject.id}) under "${parentAgent.name}" (type=${subType})`,
          );

          messages.push({
            role: "tool",
            content: `Sous-agent créé : "${subProject.name}" (ID: ${subProject.id}, type: ${subType}). Rattaché à "${parentAgent.name}". Tu peux maintenant assigner des tâches aux agents restants ou créer d'autres sous-agents.`,
            tool_call_id: toolCall.id,
          });
        } else if (fnName === "finish_planning") {
          const unassigned = linked.filter((p) => !tasks[p.id]);
          if (unassigned.length > 0) {
            messages.push({
              role: "tool",
              content: `Impossible de terminer : ${unassigned.length} agent(s) sans tâche : ${unassigned.map((p) => `"${p.name}" (${p.id})`).join(", ")}`,
              tool_call_id: toolCall.id,
            });
          } else {
            messages.push({
              role: "tool",
              content: "Planification terminée.",
              tool_call_id: toolCall.id,
            });
            finished = true;
            break;
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

    // Persist accumulated parent dependencies (sub-agents → parent depends_on)
    for (const [pid, deps] of Object.entries(parentDepsAccumulator)) {
      const parent =
        linked.find((p) => p.id === pid) || createdSubAgents.find((p) => p.id === pid);
      if (parent) {
        await saveProject({ ...parent, dependencies: deps });
      }
    }

    return { tasks, steps, createdSubAgents, expectedFiles, checks };
  }

  /**
   * Pre-execution verifier check
   */
  private async verifyPrompts(
    verifier: Project,
    globalTask: string,
    promptsMap: Record<string, string>,
    linkedProjects: readonly Project[],
  ): Promise<boolean> {
    const systemPrompt = buildVerifyPromptsSystemPrompt(verifier);
    const userPrompt = buildVerifyPromptsUserPrompt(
      globalTask,
      promptsMap,
      linkedProjects,
    );
    const response = await callLLMStructured(
      verifier,
      systemPrompt,
      userPrompt,
      PROMPT_VERDICT_TOOL,
      this.abortSignal,
      this.fallbackModel,
      this.fallbackReasoningEffort,
    );
    try {
      const cleaned = response
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(cleaned) as { valid: boolean };
      return parsed.valid === true;
    } catch {
      // Fail-closed: an unreadable verdict is not an implicit pass (advisory only).
      console.warn(
        "[orchestrator] verifyPrompts: LLM returned non-JSON — treating as invalid (advisory).",
      );
      return false;
    }
  }

  /**
   * Post-execution output verification for a single node
   */
  /**
   * Resolve the verifier project used to DRIVE internal verification/quality
   * meta-calls. The verifier's own model is ignored — these calls always run on
   * the orchestration's chosen model (fallbackModel) so they never silently bill
   * a paid provider (e.g. DeepSeek) just because a stray verifier project points
   * there. Returns undefined if no verifier exists.
   */
  private metaVerifier(allProjects: readonly Project[]): Project | undefined {
    const found = allProjects.find((p) => p.type === "verifier");
    if (!found) return undefined;
    return this.fallbackModel ? { ...found, model: this.fallbackModel } : found;
  }

  private async verifyOutput(
    verifier: Project,
    node: Project,
    resultText: string,
    expectedFiles: readonly string[] = [],
    workspaceDir?: string,
  ): Promise<{ valid: boolean; reason?: string }> {
    // Judge what is ACTUALLY on disk, not the agent's chat text. The chat
    // stream may be a truncated preview, prose-only (when the backend wrote
    // files via tools), or list a file the extractor already wrote elsewhere —
    // all of which cause false "missing/truncated" verdicts and wasted reruns.
    const diskEvidence = workspaceDir
      ? await this.readDiskEvidence(workspaceDir, expectedFiles)
      : "";

    const systemPrompt = buildVerifyOutputSystemPrompt(verifier);
    const userPrompt = buildVerifyOutputUserPrompt(node, resultText, diskEvidence);
    console.warn(
      `[orchestrator:verify] Verifying output for "${node.name}" (disk evidence: ${diskEvidence.length} chars, result preview: ${resultText.substring(0, 80)}...)`,
    );
    const response = await callLLMStructured(
      verifier,
      systemPrompt,
      userPrompt,
      OUTPUT_VERDICT_TOOL,
      this.abortSignal,
      this.fallbackModel,
      this.fallbackReasoningEffort,
    );
    console.warn(
      `[orchestrator:verify] LLM response for "${node.name}": ${response.substring(0, 300)}`,
    );
    try {
      const json = extractJsonObject(response);
      if (json === null) throw new Error("aucun objet JSON dans le verdict");
      const parsed = JSON.parse(json) as {
        valid: boolean;
        reason?: string;
        issues?: ReadonlyArray<{ severity?: string; description?: string }>;
      };
      console.warn(
        `[orchestrator:verify] Parsed verdict for "${node.name}": valid=${parsed.valid}, reason=${parsed.reason ?? "none"}`,
      );
      // Prefer the explicit reason; otherwise summarize the critical/warning issues.
      let reason = parsed.reason?.trim();
      if (!reason && Array.isArray(parsed.issues)) {
        reason = parsed.issues
          .filter((i) => i.severity === "critical" || i.severity === "warning")
          .map((i) => i.description)
          .filter(Boolean)
          .slice(0, 2)
          .join(" ; ");
      }
      return { valid: parsed.valid === true, reason: reason || undefined };
    } catch {
      // Fail CLOSED: an unreadable verdict is NOT an implicit pass. Flag it as a
      // warning (the output-verify path is non-blocking and continues anyway) so
      // a parse failure surfaces instead of silently green-lighting the node.
      console.warn(
        `[orchestrator:verify] Failed to parse response for "${node.name}" — treating as invalid (fail-closed)`,
      );
      return {
        valid: false,
        reason: "verdict du vérificateur illisible (parse JSON échoué)",
      };
    }
  }

  /**
   * Files a node currently owns: its contracted expected files plus any path it
   * claimed during execution (fileOwner map). Used to feed a corrective relaunch
   * the REAL on-disk content of its own deliverables instead of a chat excerpt.
   */
  private ownedFilesForNode(
    nodeId: string,
    expectedFilesMap: Record<string, readonly string[]>,
  ): string[] {
    const files = new Set<string>(expectedFilesMap[nodeId] ?? []);
    for (const [rel, owner] of this.fileOwner) {
      if (owner === nodeId) files.add(rel);
    }
    return [...files];
  }

  /**
   * Reads the actual files a node was expected to produce, from disk, so the
   * output verifier judges ground truth instead of the chat stream. Reports
   * presence/size per expected file and includes capped contents.
   */
  private async readDiskEvidence(
    workspaceDir: string,
    expectedFiles: readonly string[],
  ): Promise<string> {
    if (expectedFiles.length === 0) return "";

    const MAX_PER_FILE = 6000;
    const MAX_TOTAL = 24000;
    const lines: string[] = [];
    let total = 0;

    for (const rel of expectedFiles) {
      if (!OrchestratorRunner.isValidFilePath(rel)) continue;
      const full = path.join(workspaceDir, rel);
      try {
        const content = await fs.readFile(full, "utf-8");
        const size = Buffer.byteLength(content, "utf-8");
        // Deterministic completeness signal so the verifier judges on a FACT, not
        // a guess. Critically, the display cap below NEVER stands in for disk
        // truncation: we show the real END of the file (head + tail) and say the
        // file is complete — otherwise the LLM reads the cap marker as "truncated
        // on disk" and triggers a destructive (and wrong) corrective cycle.
        const trunc = detectTruncation(content);
        const ending = trunc !== null ? `⚠ FIN SUSPECTE (${trunc})` : "fin propre";
        if (total >= MAX_TOTAL) {
          lines.push(
            `✓ ${rel} (${size} octets, ${ending}) [affichage omis — limite globale d'audit atteinte ; le fichier sur disque est COMPLET]`,
          );
          continue;
        }
        const budget = Math.min(MAX_PER_FILE, MAX_TOTAL - total);
        let shown: string;
        if (content.length > budget) {
          const headLen = Math.floor(budget * 0.7);
          const tailLen = budget - headLen;
          const head = content.substring(0, headLen);
          const tail = content.substring(content.length - tailLen);
          shown =
            `${head}\n\n[… NOTE D'AUDIT : portion centrale omise de l'AFFICHAGE seulement ` +
            `(cap ${budget} car.). Le fichier sur disque fait ${size} octets et est ` +
            `COMPLET. Sa FIN réelle est juste en dessous — juge la complétude sur ` +
            `cette fin, PAS sur cette coupure d'affichage. …]\n\n${tail}`;
          total += budget;
        } else {
          shown = content;
          total += shown.length;
        }
        lines.push(`Fichier ${rel} (${size} octets — ${ending}) :\n${shown}`);
      } catch {
        lines.push(`✗ ${rel} — ABSENT du disque`);
      }
    }

    return lines.join("\n\n");
  }

  /**
   * Brand compliance checking (checking `/fichier-de-la-marque` file contents)
   */
  private async verifyBrandCompliance(
    verifier: Project,
    workspaceDir: string,
  ): Promise<boolean> {
    // Attempt to locate and read branding guidelines
    let brandGuidelines = "Aucun guide de marque trouvé.";
    const brandDir = path.join(workspaceDir, "fichier-de-la-marque");
    try {
      const files = await fs.readdir(brandDir);
      const docs = [];
      for (const file of files) {
        if (file.endsWith(".md") || file.endsWith(".txt")) {
          const content = await fs.readFile(path.join(brandDir, file), "utf-8");
          docs.push(`Fichier ${file} :\n${content}`);
        }
      }
      if (docs.length > 0) brandGuidelines = docs.join("\n\n");
    } catch {}

    const systemPrompt = buildBrandComplianceSystemPrompt(verifier);
    const userPrompt = buildBrandComplianceUserPrompt(brandGuidelines);
    const response = await callLLM(
      verifier,
      systemPrompt,
      userPrompt,
      this.abortSignal,
      true,
      this.fallbackModel,
      this.fallbackReasoningEffort,
    );
    try {
      const cleaned = response
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(cleaned) as { valid: boolean };
      return parsed.valid === true;
    } catch {
      // Fail-closed: an unreadable brand verdict is not an implicit pass (advisory only).
      console.warn(
        "[orchestrator] verifyBrandCompliance: LLM returned non-JSON — treating as invalid (advisory).",
      );
      return false;
    }
  }

  /**
   * Execute a single project node with watchdog-supported streaming for auto-continuation
   */
  private async executeNode(
    node: Project,
    allProjects: readonly Project[],
    executionResults: ReadonlyMap<string, string>,
    workspaceContext: string,
    pathFilter: (relPath: string) => boolean,
    plannedSteps?: readonly SubStep[],
    workspaceDir?: string,
    expectedFiles?: readonly string[],
    targetWords = 0,
    expectedFilesMap: Record<string, readonly string[]> = {},
  ): Promise<string> {
    console.warn(
      `[orchestrator] Executing node: ${node.name} (${node.type}), task="${(node.task || "").substring(0, 100)}"`,
    );

    const systemPrompt = buildNodeSystemPrompt(node, {
      compact: this.tierProfile.compactPrompts,
    });
    // Pure-LLM fidelity (Problème 7): the pure-LLM path has no disk access, so
    // inject the REAL content of each dependency's produced files. Backend nodes
    // (OpenCode/Open Design) read the workspace via their own tools — skip them
    // to avoid context bloat. Bounded by a combined budget across dependencies.
    let depDiskEvidence: Map<string, string> | undefined;
    if (workspaceDir !== undefined && selectBackend(node.type) === null) {
      depDiskEvidence = new Map<string, string>();
      let evidenceBudget = 24_000;
      for (const depId of node.dependencies ?? []) {
        if (evidenceBudget <= 0) break;
        const depFiles = expectedFilesMap[depId] ?? [];
        if (depFiles.length === 0) continue;
        const ev = await this.readDiskEvidence(workspaceDir, depFiles);
        if (ev.trim().length === 0) continue;
        const clipped = ev.length > evidenceBudget ? ev.substring(0, evidenceBudget) : ev;
        depDiskEvidence.set(depId, clipped);
        evidenceBudget -= clipped.length;
      }
    }
    const depContext = buildDependencyContext(
      node,
      allProjects,
      executionResults,
      depDiskEvidence,
    );
    const userPrompt = buildNodeUserPrompt(
      node,
      workspaceContext,
      depContext,
      expectedFiles,
    );
    console.warn(
      `[orchestrator]   System prompt length: ${systemPrompt.length}, depContext length: ${depContext.length}`,
    );

    this.sendStatus({
      projectId: node.id,
      status: "running",
      systemPrompt,
      userPrompt,
    });

    // ── Real-app backend dispatch ───────────────────────────────────────────
    if (workspaceDir && selectBackend(node.type)) {
      const backendLabel = node.type === "design" ? "Open Design" : "OpenCode";
      console.warn(
        `[orchestrator] 🔌 Backend dispatch: "${node.name}" (${node.type}) → ${backendLabel}`,
      );
      try {
        this.sendStatus({
          projectId: node.id,
          status: "running",
          task: `Exécution via ${backendLabel}…`,
        });

        const appSystemPrompt = buildNodeSystemPrompt(node, {
          codeFenceFormat: false,
          compact: this.tierProfile.compactPrompts,
        });

        let appUserPrompt = buildNodeUserPrompt(
          node,
          workspaceContext,
          depContext,
          expectedFiles,
          { codeFenceFormat: false },
        );
        if (plannedSteps && plannedSteps.length >= 2) {
          const checklist = plannedSteps
            .map((s, i) => `${i + 1}. ${s.title} — ${s.focus}`)
            .join("\n");
          appUserPrompt = `${appUserPrompt}\n\nÉTAPES À SUIVRE :\n${checklist}`;
        }
        // Backend = un seul execute() : l'Axe C (itérations) ne s'y applique
        // pas. En tier weak, on guide le rythme via le prompt utilisateur.
        if (this.tierProfile.tier === "weak") {
          appUserPrompt = `${appUserPrompt}\n\n${WEAK_BACKEND_DIRECTIVE}`;
        }

        // In an isolated worktree the agent has its own full checkout, so it must
        // NOT be denied edits to sibling files — that deny-list is a shared-workspace
        // guard only. Conflicts are caught at merge time instead.
        const otherOwnedPaths: string[] = [];
        if (!this.nodeWorkspaces.has(node.id)) {
          for (const [relPath, ownerId] of this.fileOwner) {
            if (ownerId !== node.id) otherOwnedPaths.push(relPath);
          }
        }

        const pm = this.getProcessManager?.();
        const result = await executeWithBackend(
          {
            node,
            workspaceDir,
            systemPrompt: appSystemPrompt,
            userPrompt: appUserPrompt,
            fallbackModel: this.fallbackModel,
            signal: this.abortSignal,
            onProgress: (label) =>
              this.sendStatus({
                projectId: node.id,
                status: "running",
                task: label,
              }),
            otherOwnedPaths: otherOwnedPaths.length > 0 ? otherOwnedPaths : undefined,
          },
          (slot) => (pm ? pm.ensureRunning(slot) : Promise.resolve(null)),
        );

        console.warn(
          `[orchestrator] ✓ Backend SUCCESS for "${node.name}" — ${result.backend}, ${result.resultText.length} chars, ${result.filesWritten} fichier(s)`,
        );
        this.backendFilesWritten.set(node.id, result.filesWritten);
        this.backendWrittenPaths.set(node.id, result.writtenPaths);
        return result.resultText;
      } catch (err: unknown) {
        if (this.abortSignal?.aborted) {
          console.warn(
            `[orchestrator] ✗ Backend ABORTED for "${node.name}" — user cancelled`,
          );
          throw err;
        }
        if (err instanceof BackendUnavailableError) {
          console.warn(
            `[orchestrator] ⚠ Backend UNAVAILABLE for "${node.name}" → falling back to LLM:`,
            err.message,
            err.cause instanceof Error ? `(cause: ${err.cause.message})` : "",
          );
          this.sendStatus({
            projectId: node.id,
            status: "running",
            task: "App indisponible — repli sur LLM direct.",
          });
        } else {
          console.warn(
            `[orchestrator] ⚠ Backend ERROR for "${node.name}" → falling back to LLM:`,
            err instanceof Error ? err.message : err,
          );
          this.sendStatus({
            projectId: node.id,
            status: "warning",
            task: "Erreur backend — repli sur LLM direct.",
          });
        }
      }
    } else if (workspaceDir) {
      console.warn(
        `[orchestrator] No backend for type="${node.type}" — using LLM direct`,
      );
    }

    // ── LLM fallback (original path) ────────────────────────────────────────
    // Pre-planned steps from the agentic planning loop (≥2 steps)
    if (plannedSteps && plannedSteps.length >= 2) {
      return await this.executeNodeWithSteps(
        node,
        workspaceContext,
        depContext,
        systemPrompt,
        pathFilter,
        plannedSteps,
        workspaceDir,
      );
    }

    // Agent-level autoSteps: decompose via LLM at runtime
    if (node.autoSteps) {
      return await this.executeNodeWithSteps(
        node,
        workspaceContext,
        depContext,
        systemPrompt,
        pathFilter,
        undefined,
        workspaceDir,
      );
    }

    // Weak tier (LLM path): make the iteration cap actually reach this node.
    // - Large task → force step decomposition (skip trivial one-liners).
    // - recherche/design (not multi-turn types) → route through the multi-turn
    //   loop so the raised maxIterations + completeness checks apply.
    if (this.tierProfile.forceDecomposition && workspaceDir) {
      const isMultiTurnType = OrchestratorRunner.MULTI_TURN_TYPES.has(node.type ?? "");
      if ((node.task?.length ?? 0) > WEAK_DECOMPOSE_MIN_TASK_CHARS) {
        return await this.executeNodeWithSteps(
          node,
          workspaceContext,
          depContext,
          systemPrompt,
          pathFilter,
          undefined,
          workspaceDir,
        );
      }
      if (!isMultiTurnType) {
        return await this.executeMultiTurn(
          node,
          workspaceContext,
          depContext,
          systemPrompt,
          pathFilter,
          workspaceDir,
          targetWords,
        );
      }
    }

    // work/code without steps: free-form multi-turn iteration
    if (OrchestratorRunner.MULTI_TURN_TYPES.has(node.type ?? "") && workspaceDir) {
      return await this.executeMultiTurn(
        node,
        workspaceContext,
        depContext,
        systemPrompt,
        pathFilter,
        workspaceDir,
        targetWords,
      );
    }

    return await this.executeSingleCall(node, workspaceContext, depContext, systemPrompt);
  }

  /**
   * Decompose a complex task into sequential sub-steps via LLM
   */
  private async decomposeTask(
    node: Project,
    workspaceContext: string,
    depContext: string,
  ): Promise<SubStep[]> {
    const compact = this.tierProfile.compactPrompts;
    const systemPrompt = buildDecomposeSystemPrompt(node, compact);
    const userPrompt = buildDecomposeUserPrompt(
      node,
      workspaceContext,
      depContext,
      compact,
    );

    try {
      const response = await callLLM(
        node,
        systemPrompt,
        userPrompt,
        this.abortSignal,
        true,
        this.fallbackModel,
        this.fallbackReasoningEffort,
      );
      const cleaned = response
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(cleaned) as Array<{
        title?: string;
        focus?: string;
        deliverable?: string;
      }>;

      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("Réponse non-array ou vide");
      }

      return parsed.slice(0, MAX_SUBSTEPS).map((s, i) => ({
        index: i,
        title: s.title ?? `Étape ${i + 1}`,
        focus: s.focus ?? "",
        deliverable: s.deliverable ?? "",
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[orchestrator] Decomposition failed for ${node.name}, falling back to single step:`,
        msg,
      );
      return [
        {
          index: 0,
          title: node.name,
          focus: node.task ?? "",
          deliverable: node.task ?? "",
        },
      ];
    }
  }

  /**
   * Execute a single LLM call with retry/continuation (shared by normal and single-step-fallback paths)
   */
  private async executeSingleCall(
    node: Project,
    workspaceContext: string,
    depContext: string,
    systemPrompt: string,
  ): Promise<string> {
    const maxRetries = clampRetries(node.maxRetries);
    let attempt = 0;
    let finalResponseText = "";
    let isDone = false;

    while (attempt < maxRetries && !isDone) {
      attempt++;
      const prompt =
        finalResponseText.length > 0
          ? buildContinuationPrompt(node, finalResponseText, attempt, maxRetries)
          : buildNodeUserPrompt(node, workspaceContext, depContext);

      try {
        const response = await callLLMStreaming(
          node,
          prompt,
          120000,
          this.abortSignal,
          systemPrompt,
          this.fallbackModel,
          this.fallbackReasoningEffort,
        );
        finalResponseText += response;
        isDone = true;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg === "WATCHDOG_TIMEOUT" && attempt < maxRetries) {
          console.warn(`[orchestrator] ${node.name} timeout, retrying...`);
        } else {
          throw err;
        }
      }
    }

    return finalResponseText;
  }

  /**
   * Multi-turn execution for work/code agents — iterates until the task is complete
   */
  private async executeMultiTurn(
    node: Project,
    workspaceContext: string,
    depContext: string,
    systemPrompt: string,
    pathFilter: (relPath: string) => boolean,
    workspaceDir: string,
    targetWords = 0,
  ): Promise<string> {
    const MAX_ITERATIONS = this.tierProfile.maxIterations;
    const wordCount = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length;
    let accumulated = "";
    let missing = "";

    for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
      if (this.abortController?.signal.aborted) {
        throw new Error("Orchestration annulée par l'utilisateur.");
      }

      this.sendStatus({
        projectId: node.id,
        status: "running",
        substep: {
          current: iter,
          total: MAX_ITERATIONS,
          title: iter === 1 ? "Production initiale" : `Itération ${iter}`,
        },
      });

      const prompt =
        iter === 1
          ? buildNodeUserPrompt(node, workspaceContext, depContext)
          : buildIterationPrompt(node, accumulated, missing, iter, MAX_ITERATIONS);

      console.warn(
        `[orchestrator:multi] ${node.name} — iteration ${iter}/${MAX_ITERATIONS}`,
      );

      const response = await callLLMStreaming(
        node,
        prompt,
        120000,
        this.abortSignal,
        systemPrompt,
        this.fallbackModel,
        this.fallbackReasoningEffort,
      );
      accumulated += (iter > 1 ? "\n\n" : "") + response;

      const writtenFiles = await this.extractAndWriteFiles(
        response,
        workspaceDir,
        pathFilter,
        node.id,
      );
      if (writtenFiles.length > 0) {
        console.warn(
          `[orchestrator:multi] ${node.name} — iter ${iter}: wrote ${writtenFiles.length} files: ${writtenFiles.join(", ")}`,
        );
      }

      if (iter >= MAX_ITERATIONS) break;

      const checkPrompt = buildCompletenessCheckPrompt(node, accumulated);
      const checkResponse = await callLLM(
        node,
        "Tu évalues la complétude d'un livrable. Réponds uniquement en JSON.",
        checkPrompt,
        this.abortSignal,
        true,
        this.fallbackModel,
        this.fallbackReasoningEffort,
      );

      try {
        const cleaned = checkResponse
          .replace(/```json/gi, "")
          .replace(/```/g, "")
          .trim();
        const parsed = JSON.parse(cleaned) as { complete: boolean; missing?: string };
        console.warn(
          `[orchestrator:multi] ${node.name} — completeness check: complete=${parsed.complete}, missing=${(parsed.missing || "").substring(0, 120)}`,
        );

        // Volume gate: don't accept "complete" while below the declared word
        // target — force the agent to keep developing instead of stopping short.
        const words = wordCount(accumulated);
        if (parsed.complete && (targetWords === 0 || words >= targetWords)) {
          console.warn(
            `[orchestrator:multi] ${node.name} — task complete after ${iter} iteration(s)`,
          );
          break;
        }

        missing =
          parsed.complete && targetWords > 0 && words < targetWords
            ? `Le contenu est trop court (${words}/${targetWords} mots). DÉVELOPPE en profondeur : ajoute détails, exemples, sous-sections. Reproduis les fichiers EN ENTIER, ne résume pas.`
            : parsed.missing ||
              "Éléments manquants non précisés — continue à compléter la tâche.";
      } catch {
        console.warn(
          `[orchestrator:multi] ${node.name} — completeness parse failed, continuing`,
        );
        missing = "Vérifie ce qui manque et complète la tâche.";
      }
    }

    return accumulated;
  }

  private static readonly MULTI_TURN_TYPES = new Set(["work", "code"]);

  /**
   * Execute a node by decomposing into sub-steps.
   * For work/code types each sub-step iterates (multi-turn) and files are written
   * directly — no synthesis pass needed.
   * For other types the original single-call + synthesis approach is kept.
   */
  private async executeNodeWithSteps(
    node: Project,
    workspaceContext: string,
    depContext: string,
    systemPrompt: string,
    pathFilter: (relPath: string) => boolean,
    preDefinedSteps?: readonly SubStep[],
    workspaceDir?: string,
  ): Promise<string> {
    let steps: readonly SubStep[];

    if (preDefinedSteps) {
      console.warn(
        `[orchestrator] Using ${preDefinedSteps.length} pre-planned steps for node: ${node.name}`,
      );
      steps = preDefinedSteps;
    } else {
      console.warn(`[orchestrator] Decomposing task for node: ${node.name}`);
      this.sendStatus({
        projectId: node.id,
        status: "running",
        task: "Décomposition de la tâche en sous-étapes...",
      });
      steps = await this.decomposeTask(node, workspaceContext, depContext);
    }

    const totalSteps = steps.length;
    console.warn(
      `[orchestrator] ${node.name}: ${totalSteps} sub-steps planned:`,
      steps.map((s) => s.title),
    );

    if (totalSteps === 1) {
      const isMultiTurn =
        OrchestratorRunner.MULTI_TURN_TYPES.has(node.type ?? "") && workspaceDir;
      return isMultiTurn
        ? await this.executeMultiTurn(
            node,
            workspaceContext,
            depContext,
            systemPrompt,
            pathFilter,
            workspaceDir,
          )
        : await this.executeSingleCall(node, workspaceContext, depContext, systemPrompt);
    }

    const isProducer = OrchestratorRunner.MULTI_TURN_TYPES.has(node.type ?? "");
    const subStepResults: SubStepResult[] = [];

    for (const step of steps) {
      if (this.abortController?.signal.aborted) {
        throw new Error("Orchestration annulée par l'utilisateur.");
      }

      this.sendStatus({
        projectId: node.id,
        status: "running",
        task: `[${step.index + 1}/${totalSteps}] ${step.title}`,
        substep: { current: step.index + 1, total: totalSteps, title: step.title },
      });

      console.warn(
        `[orchestrator] ${node.name}: executing sub-step ${step.index + 1}/${totalSteps}: ${step.title}`,
      );

      const stepOutput =
        isProducer && workspaceDir
          ? await this.executeSubStepMultiTurn(
              node,
              step,
              totalSteps,
              subStepResults,
              workspaceContext,
              depContext,
              systemPrompt,
              pathFilter,
              workspaceDir,
            )
          : await this.executeSubStepSingle(
              node,
              step,
              totalSteps,
              subStepResults,
              workspaceContext,
              depContext,
              systemPrompt,
            );

      subStepResults.push({
        index: step.index,
        title: step.title,
        output: stepOutput,
      });
    }

    // work/code: files already written per sub-step — return accumulated output, no synthesis
    if (isProducer) {
      return subStepResults.map((r) => r.output).join("\n\n");
    }

    // Other types: synthesis pass to merge sub-step outputs
    this.sendStatus({
      projectId: node.id,
      status: "running",
      task: "Synthèse des résultats...",
    });
    console.warn(`[orchestrator] ${node.name}: running synthesis pass`);

    const synthesisSystem = buildSynthesisSystemPrompt(node);
    const synthesisUser = buildSynthesisUserPrompt(node, subStepResults);
    return await callLLMStreaming(
      node,
      synthesisUser,
      120000,
      this.abortSignal,
      synthesisSystem,
      this.fallbackModel,
      this.fallbackReasoningEffort,
    );
  }

  /**
   * Single-call execution for one sub-step (non-producer types)
   */
  private async executeSubStepSingle(
    node: Project,
    step: SubStep,
    totalSteps: number,
    previousResults: readonly SubStepResult[],
    workspaceContext: string,
    depContext: string,
    systemPrompt: string,
  ): Promise<string> {
    const userPrompt = buildSubStepUserPrompt(
      node,
      step,
      totalSteps,
      previousResults,
      workspaceContext,
      depContext,
    );
    const maxRetries = clampRetries(node.maxRetries);
    let attempt = 0;
    let stepOutput = "";
    let isDone = false;

    while (attempt < maxRetries && !isDone) {
      attempt++;
      const prompt =
        stepOutput.length > 0
          ? buildContinuationPrompt(node, stepOutput, attempt, maxRetries)
          : userPrompt;

      try {
        const response = await callLLMStreaming(
          node,
          prompt,
          120000,
          this.abortSignal,
          systemPrompt,
          this.fallbackModel,
          this.fallbackReasoningEffort,
        );
        stepOutput += response;
        isDone = true;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg === "WATCHDOG_TIMEOUT" && attempt < maxRetries) {
          console.warn(`[orchestrator] Sub-step ${step.index + 1} timeout, retrying...`);
        } else {
          throw err;
        }
      }
    }

    return stepOutput;
  }

  /**
   * Multi-turn execution for one sub-step (work/code producer types).
   * Iterates until the sub-step deliverable is complete, writing files each iteration.
   */
  private async executeSubStepMultiTurn(
    node: Project,
    step: SubStep,
    totalSteps: number,
    previousResults: readonly SubStepResult[],
    workspaceContext: string,
    depContext: string,
    systemPrompt: string,
    pathFilter: (relPath: string) => boolean,
    workspaceDir: string,
  ): Promise<string> {
    const MAX_ITER = this.tierProfile.maxSubStepIterations;
    let accumulated = "";
    let missing = "";

    for (let iter = 1; iter <= MAX_ITER; iter++) {
      if (this.abortController?.signal.aborted) {
        throw new Error("Orchestration annulée par l'utilisateur.");
      }

      this.sendStatus({
        projectId: node.id,
        status: "running",
        substep: {
          current: step.index + 1,
          total: totalSteps,
          title: `${step.title} ${iter > 1 ? `(iter ${iter})` : ""}`,
        },
      });

      const prompt =
        iter === 1
          ? buildSubStepUserPrompt(
              node,
              step,
              totalSteps,
              previousResults,
              workspaceContext,
              depContext,
            )
          : buildIterationPrompt(node, accumulated, missing, iter, MAX_ITER);

      const response = await callLLMStreaming(
        node,
        prompt,
        120000,
        this.abortSignal,
        systemPrompt,
        this.fallbackModel,
        this.fallbackReasoningEffort,
      );
      accumulated += (iter > 1 ? "\n\n" : "") + response;

      const writtenFiles = await this.extractAndWriteFiles(
        response,
        workspaceDir,
        pathFilter,
        node.id,
      );
      if (writtenFiles.length > 0) {
        console.warn(
          `[orchestrator:multi] ${node.name} step ${step.index + 1} iter ${iter}: wrote ${writtenFiles.join(", ")}`,
        );
      }

      if (iter >= MAX_ITER) break;

      const checkPrompt = buildCompletenessCheckPrompt(
        {
          ...node,
          task: `[Sous-étape] ${step.title}\nFOCUS: ${step.focus}\nLIVRABLE: ${step.deliverable}`,
        } as Project,
        accumulated,
      );
      const checkResponse = await callLLM(
        node,
        "Tu évalues la complétude d'un livrable. Réponds uniquement en JSON.",
        checkPrompt,
        this.abortSignal,
        true,
        this.fallbackModel,
        this.fallbackReasoningEffort,
      );

      try {
        const cleaned = checkResponse
          .replace(/```json/gi, "")
          .replace(/```/g, "")
          .trim();
        const parsed = JSON.parse(cleaned) as { complete: boolean; missing?: string };
        console.warn(
          `[orchestrator:multi] ${node.name} step ${step.index + 1} completeness: complete=${parsed.complete}`,
        );

        if (parsed.complete) break;
        missing =
          parsed.missing || "Éléments manquants non précisés — continue à compléter.";
      } catch {
        console.warn(
          `[orchestrator:multi] ${node.name} step ${step.index + 1} completeness parse failed, continuing`,
        );
        missing = "Vérifie ce qui manque et complète le livrable.";
      }
    }

    return accumulated;
  }

  private get abortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  /**
   * Post-execution processing (ex: Linter runs for OpenCode, copying design output from OpenDesign)
   */
  private async postExecuteProcessing(
    node: Project,
    _workspaceDir: string,
    _resultText: string,
  ): Promise<void> {
    if (node.type === "code") {
      // SECURITY: we deliberately do NOT execute the workspace's own `npm run lint`
      // (or any workspace-defined npm script). The package.json here is written by the
      // LLM/agent during this same run, so running its scripts would be arbitrary code
      // execution driven by model output. Lint verification, if desired, must run a
      // fixed, pinned linter binary — never the workspace's scripts.
      console.warn(
        `[orchestrator] Skipping workspace-defined lint scripts for OpenCode (untrusted): ${node.name}`,
      );
    } else if (node.type === "design") {
      console.warn(`[orchestrator] Exporting renders for OpenDesign: ${node.name}`);
    }
  }

  /**
   * Ensure the WORKSPACE_INDEX.md file exists in the workspace root
   */
  private async ensureWorkspaceIndexFile(workspaceDir: string): Promise<void> {
    const indexPath = path.join(workspaceDir, "WORKSPACE_INDEX.md");
    const exists = await fs
      .access(indexPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      const initialContent = `# Registre de Workspace — Index & Changelog

Ce fichier répertorie la fonction de chaque fichier du projet et tient à jour le journal des modifications des agents d'orchestration.

## 1. Cartographie du Projet (Index des fichiers)
| Fichier | Fonction |
|---|---|
| WORKSPACE_INDEX.md | Registre de workspace et changelog central. |

## 2. Journal des Modifications (Changelog)
| Date | Agent | Fichier(s) modifié(s) | Description |
|---|---|---|---|
`;
      await fs.writeFile(indexPath, initialContent, "utf-8");
    }
  }

  /**
   * Document agent execution changes into WORKSPACE_INDEX.md
   */
  /**
   * Parse code blocks from agent output and write them as files in the workspace.
   * Recognizes patterns like:
   *   ```html filepath: src/index.html
   *   **Fichier : `src/index.html`**
   *   <!-- fichier: src/index.html -->
   *   // src/index.html
   */
  private static isValidFilePath(p: string): boolean {
    if (!p || p.length > 200) return false;
    if (p.includes("\0")) return false;
    if (p.startsWith("/") || p.startsWith("\\") || p.includes("..") || p.startsWith("."))
      return false;
    // Must look like a path: contain a dot (extension) or a slash (directory)
    if (!p.includes(".") && !p.includes("/")) return false;
    // Reject HTML/JS content accidentally captured as filenames
    if (
      p.includes("<") ||
      p.includes(">") ||
      p.includes("(") ||
      p.includes(")") ||
      p.includes("{") ||
      p.includes("}")
    )
      return false;
    if (p.includes("  ") || p.includes("\t")) return false;
    // Must have a valid-looking extension
    const ext = path.extname(p).toLowerCase();
    if (!ext || ext.length > 10) return false;
    return true;
  }

  // Index + audit reports are shared: any node may write them, and they are never
  // claimed as a single owner.
  private static isSharedPath(p: string): boolean {
    return p === "WORKSPACE_INDEX.md" || p.startsWith("reports/");
  }

  /**
   * Per-node write scope. A node may write: its declared deliverables, the shared
   * index/reports, or any path no other node already owns. Writing a path owned
   * by ANOTHER node is refused — this is what prevents corrective-cycle agents
   * from overwriting siblings' work, and (because an undeclared report is a free
   * path) it also lets a verifier emit its own audit file instead of losing it.
   */
  private buildNodePathFilter(
    nodeId: string,
    nodeExpectedFiles: readonly string[],
  ): (relPath: string) => boolean {
    // A node on a corrective relaunch may rewrite ITS files but must NOT mint new
    // free paths (that's how a parasitic public/ site got spawned). On a first run
    // free paths are open. The corrective set is authoritative when present;
    // otherwise fall back to ownership (covers within-run reruns).
    const isRerun =
      this.correctiveNodeIds?.has(nodeId) ??
      [...this.fileOwner.values()].includes(nodeId);
    return (p: string): boolean => {
      if (OrchestratorRunner.isSharedPath(p)) return true;
      if (nodeExpectedFiles.includes(p)) return true;
      const owner = this.fileOwner.get(p);
      if (owner === nodeId) return true;
      if (owner !== undefined) return false; // owned by another agent → refuse
      return !isRerun; // free path: only on the first run
    };
  }

  // First writer of a non-shared path claims ownership for its node.
  private claimOwnership(nodeId: string, written: readonly string[]): void {
    // Isolated worktree nodes opt out of the shared-workspace ownership map: the
    // worktree IS their isolation and merge resolves conflicts, so claiming paths
    // here would only mislead later (non-isolated) nodes.
    if (this.nodeWorkspaces.has(nodeId)) return;
    for (const p of written) {
      if (OrchestratorRunner.isSharedPath(p)) continue;
      if (!this.fileOwner.has(p)) this.fileOwner.set(p, nodeId);
    }
  }

  private async extractAndWriteFiles(
    resultText: string,
    workspaceDir: string,
    pathFilter: (relPath: string) => boolean,
    nodeId: string,
    skipPaths?: ReadonlySet<string>,
  ): Promise<string[]> {
    const written: string[] = [];
    // Resolved paths already written this call, so the three parsers below can ALL
    // run (an agent may mix formats mid-response) without re-writing the same file.
    // First-writer-wins → the primary ```filepath: format takes precedence.
    // skipPaths: relative paths already written by a backend's tools — never
    // overwrite them. Convert to absolute because tryWriteWorkspaceFile checks
    // seen against resolved full paths (safeResolveInWorkspace output).
    const seen = new Set<string>();
    if (skipPaths !== undefined) {
      for (const rel of skipPaths) {
        const full = safeResolveInWorkspace(workspaceDir, rel);
        if (full !== null) seen.add(full);
      }
    }
    // The node's path filter scopes every write (final + multi-turn intermediate)
    // to files it owns, so a concurrent sibling can't be clobbered.
    const accept = (p: string): boolean =>
      OrchestratorRunner.isValidFilePath(p) && pathFilter(p);

    // Pre-pass: surgical ```edit filepath: SEARCH/REPLACE blocks. Patch the file
    // ON DISK instead of rewriting it whole. ALL-OR-NOTHING per file — a failed
    // match leaves the file untouched and unclaimed, so the full-file parsers
    // below still act as the fallback. Reserved fence (parseFilepathBlocks skips
    // ```edit filepath:), so a failed edit never dumps raw markers into the file.
    for (const block of parseEditBlocks(resultText)) {
      if (!accept(block.path) || written.length >= MAX_WRITTEN_FILES) continue;
      const full = safeResolveInWorkspace(workspaceDir, block.path);
      if (!full || seen.has(full)) continue;
      let current: string;
      try {
        current = await fs.readFile(full, "utf-8");
      } catch {
        console.warn(
          `[orchestrator:files] Edit ignoré — fichier introuvable : ${block.path.substring(0, 80)}`,
        );
        continue;
      }
      const res = applyEdits(current, block.edits);
      if (!res.ok) {
        console.warn(
          `[orchestrator:files] Edit échoué (SEARCH absent ou non unique) sur ${block.path.substring(0, 80)} — repli sur fichier complet`,
        );
        continue;
      }
      await this.tryWriteWorkspaceFile(
        workspaceDir,
        block.path,
        res.content,
        written,
        seen,
        nodeId,
      );
    }

    // Primary: ```lang filepath: path blocks (filepath: REQUIRED). Nested-fence
    // safe — see parseFilepathBlocks (a naive non-greedy regex truncates a file
    // at the first ``` inside its own content).
    for (const block of parseFilepathBlocks(resultText)) {
      const filePath = block.path;
      const content = block.content;
      if (!content || !accept(filePath)) {
        if (filePath)
          console.warn(
            `[orchestrator:files] Rejected path: ${filePath.substring(0, 80)}`,
          );
        continue;
      }
      if (written.length >= MAX_WRITTEN_FILES) break;
      await this.tryWriteWorkspaceFile(
        workspaceDir,
        filePath,
        content,
        written,
        seen,
        nodeId,
      );
    }

    // Secondary: match **Fichier: `path/to/file`** then ```...``` pattern. Runs
    // unconditionally (deduped via `seen`) so mixed-format output isn't dropped.
    const headerRe =
      /(?:\*{1,2})?(?:Fichier|File)\s*:\s*`?([^`\n*]+?)`?\*{0,2}\s*\n\s*```[\w]*\n([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;
    while ((match = headerRe.exec(resultText)) !== null) {
      const filePath = match[1].trim();
      const content = match[2];
      if (!content || !accept(filePath)) continue;
      if (written.length >= MAX_WRITTEN_FILES) break;
      await this.tryWriteWorkspaceFile(
        workspaceDir,
        filePath,
        content,
        written,
        seen,
        nodeId,
      );
    }

    // Tertiary: inline path comments (// filepath: ..., <!-- filepath: ... -->).
    // Parsed line-by-line (not one mega-regex) to avoid catastrophic backtracking
    // / ReDoS on adversarial LLM output in the main process. Also runs always.
    const markerRe = /^(?:\/\/|<!--|#)\s*filepath\s*:\s*(.+?)(?:\s*-->)?\s*$/i;
    const lines = resultText.split("\n");
    let curPath: string | null = null;
    let buf: string[] = [];
    const flush = async (): Promise<void> => {
      if (curPath === null) return;
      const content = buf.join("\n");
      if (content.trim() && accept(curPath) && written.length < MAX_WRITTEN_FILES) {
        await this.tryWriteWorkspaceFile(
          workspaceDir,
          curPath,
          content,
          written,
          seen,
          nodeId,
        );
      }
    };
    for (const line of lines) {
      const m = markerRe.exec(line);
      if (m) {
        await flush();
        curPath = m[1].trim();
        buf = [];
      } else if (curPath !== null) {
        buf.push(line);
      }
    }
    await flush();

    return written;
  }

  // Centralizes the mkdir+write for an LLM-emitted file, enforcing the per-file
  // size cap and the workspace containment check. Pushes to `written` on success.
  // Serialize physical writes to one path (mirror of indexWriteLock, keyed by
  // path) so a shared path or an edit's read-modify-write can't interleave
  // between two concurrent writers. Errors don't poison the chain.
  private withPathLock<T>(fullPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.pathWriteLocks.get(fullPath) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.pathWriteLocks.set(
      fullPath,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async tryWriteWorkspaceFile(
    workspaceDir: string,
    filePath: string,
    content: string,
    written: string[],
    seen: Set<string>,
    nodeId: string,
  ): Promise<void> {
    if (Buffer.byteLength(content, "utf-8") > MAX_FILE_BYTES) {
      console.warn(
        `[orchestrator:files] Skipped oversized file ${filePath.substring(0, 80)} (> ${MAX_FILE_BYTES} bytes)`,
      );
      return;
    }
    const fullPath = safeResolveInWorkspace(workspaceDir, filePath);
    if (!fullPath) {
      console.warn(
        `[orchestrator:files] Rejected escaping path: ${filePath.substring(0, 80)}`,
      );
      return;
    }
    if (seen.has(fullPath)) return; // already written this call (first-writer-wins)

    // Atomic cross-node ownership claim. The check-and-set runs synchronously
    // (no await before it), so two nodes in the same wave can't both claim the
    // same free path — the first to reach here wins, the loser is refused rather
    // than silently clobbering the file on disk. Shared paths (reports/, index)
    // are exempt and rely on their own serialization (e.g. indexWriteLock).
    // Isolated worktree nodes are exempt too: the same relative path in two
    // separate worktrees is NOT a conflict (merge resolves it later).
    if (!OrchestratorRunner.isSharedPath(filePath) && !this.nodeWorkspaces.has(nodeId)) {
      const owner = this.fileOwner.get(filePath);
      if (owner !== undefined && owner !== nodeId) {
        console.warn(
          `[orchestrator:files] Refus d'écriture concurrente sur ${filePath.substring(0, 80)} — appartient à "${owner}"`,
        );
        return;
      }
      if (owner === undefined) this.fileOwner.set(filePath, nodeId);
    }

    await this.withPathLock(fullPath, async () => {
      try {
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        // The lexical check above can be defeated by a symlink planted inside the
        // workspace. Re-confirm the realpath of the parent dir is still inside the
        // workspace, and refuse to follow a symlinked target file.
        if (!(await isContainedRealPath(workspaceDir, fullPath))) {
          console.warn(
            `[orchestrator:files] Rejected symlink-escaping path: ${filePath.substring(0, 80)}`,
          );
          return;
        }
        await fs.writeFile(fullPath, content, { encoding: "utf-8", flag: "w" });
        seen.add(fullPath);
        written.push(filePath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[orchestrator:files] Failed to write ${filePath}: ${msg}`);
      }
    });
  }

  private async updateWorkspaceIndex(
    node: Project,
    resultText: string,
    workspaceDir: string,
  ): Promise<void> {
    const run = this.indexWriteLock.then(() =>
      this.updateWorkspaceIndexUnsafe(node, resultText, workspaceDir),
    );
    this.indexWriteLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async updateWorkspaceIndexUnsafe(
    node: Project,
    resultText: string,
    workspaceDir: string,
  ): Promise<void> {
    const indexPath = path.join(workspaceDir, "WORKSPACE_INDEX.md");
    try {
      console.warn(`[orchestrator] Updating WORKSPACE_INDEX.md for: ${node.name}`);

      let content = await fs.readFile(indexPath, "utf-8");

      const indexerProj = {
        id: "sys-indexer",
        name: "Indexeur de Fichiers",
        instructions: "",
        color: "#ccc",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as Project;

      const systemPrompt = buildWorkspaceIndexSystemPrompt();
      const userPrompt = buildWorkspaceIndexUserPrompt(node, resultText);
      const response = await callLLM(
        indexerProj,
        systemPrompt,
        userPrompt,
        this.abortSignal,
        true,
        this.fallbackModel,
        this.fallbackReasoningEffort,
      );
      const cleaned = response
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      let parsed: { newFiles?: string; changelogLine?: string };
      try {
        parsed = JSON.parse(cleaned) as { newFiles?: string; changelogLine?: string };
      } catch {
        console.warn(
          "[orchestrator] Workspace index update: LLM returned non-JSON, skipping.",
        );
        return;
      }

      if (parsed.newFiles && parsed.newFiles.trim().length > 0) {
        const marker = "## 2. Journal des Modifications";
        const idx = content.indexOf(marker);
        if (idx >= 0) {
          content =
            content.slice(0, idx) + parsed.newFiles.trim() + "\n\n" + content.slice(idx);
        }
      }

      if (parsed.changelogLine) {
        content = content.trim() + "\n" + parsed.changelogLine.trim() + "\n";
      }

      // Each turn inserts fresh file-map rows without checking for prior entries,
      // so the map accumulates duplicates. Dedupe deterministically before write.
      content = sanitizeWorkspaceIndex(content);

      await fs.writeFile(indexPath, content, "utf-8");
      console.warn("[orchestrator] WORKSPACE_INDEX.md updated.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] Failed to update WORKSPACE_INDEX.md:", msg);
    }
  }
}
