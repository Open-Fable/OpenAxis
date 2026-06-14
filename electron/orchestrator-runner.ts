import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import {
  getProjects,
  saveProject,
  setActiveProject,
  type Project,
  type OrchRun,
} from "./project-store.js";
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
  type ChatMessage,
} from "./orchestrator-llm.js";

import { planIterationFixes, buildFixTask } from "./orchestrator-iterate.js";
import {
  sanitizeExpectedFiles,
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
  buildServedSiteReport,
  parseQualityVerdict,
  buildAutoFeedback,
  buildSyntheticRun,
  buildExpectedFilesReport,
  MIN_RESULT_CHARS,
  MAX_AUTO_QUALITY_LOOPS,
} from "./orchestrator-quality.js";
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
  status: "idle" | "running" | "done" | "error" | "skipped" | "warning";
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
  // Files written on disk by a backend's tools, keyed by node id. Used so a node
  // that produced files but returned a short chat summary isn't judged "trivial".
  private readonly backendFilesWritten = new Map<string, number>();
  private fallbackModel: string | undefined = undefined;
  private fallbackReasoningEffort: string | undefined = undefined;

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
      this.fallbackModel =
        orchestrator.model || linkedProjects.find((p) => p.model)?.model || undefined;
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

      this.sendStatus({ projectId: orchestratorId, status: "running", workspaceDir });
      for (const p of linkedProjects) {
        this.sendStatus({ projectId: p.id, status: "idle" });
      }

      // Step 2: Orchestrator planning phase (Auto-distribute tasks)
      const wsContext = await buildWorkspaceContext(workspaceDir);
      let tasksMap: Record<string, string> = {};
      let plannedSteps: Record<string, SubStep[]> = {};
      let expectedFilesMap: Record<string, readonly string[]> = {};

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
      const executionOrder = this.resolveDAG(linkedProjects);
      console.warn(
        "[orchestrator] Execution order:",
        executionOrder.map((n) => n.name),
      );

      // Step 5: Execute each node in order
      const executionStatuses = await this.executeNodesSequence(
        orchestrator,
        executionOrder,
        allProjects,
        executionResults,
        wsContext,
        plannedSteps,
        workspaceDir,
        expectedFilesMap,
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
  ): Promise<Record<string, "done" | "error" | "skipped">> {
    const executionStatuses: Record<string, "done" | "error" | "skipped"> = {};

    for (const node of executionOrder) {
      if (this.abortController?.signal.aborted) {
        throw new Error("Orchestration annulée par l'utilisateur.");
      }

      const deps = node.dependencies || [];
      const failedDep = deps.find(
        (depId) =>
          executionStatuses[depId] === "error" || executionStatuses[depId] === "skipped",
      );

      if (failedDep) {
        console.warn(
          `[orchestrator] Skipping "${node.name}" — dependency "${failedDep}" is ${executionStatuses[failedDep]}`,
        );
        executionStatuses[node.id] = "skipped";
        this.sendStatus({ projectId: node.id, status: "skipped" });
        continue;
      }

      console.warn(
        `[orchestrator] ▶ Executing node "${node.name}" (type=${node.type}, model=${node.model || "fallback"})`,
      );
      console.warn(`[orchestrator]   Task: "${(node.task || "").substring(0, 120)}"`);
      this.sendStatus({ projectId: node.id, status: "running" });
      try {
        let resultText = await this.executeNode(
          node,
          allProjects,
          executionResults,
          workspaceContext,
          plannedSteps[node.id],
          workspaceDir,
          expectedFilesMap[node.id],
        );
        console.warn(
          `[orchestrator] ✓ Node "${node.name}" executed — result length: ${resultText.length} chars`,
        );
        const initialResultText = resultText;

        // Verifiers AUDIT — they must never overwrite the deliverables produced
        // by work/code/design agents. Restrict their writes to reports/ so a
        // verifier emitting "corrected" full files can't clobber the real ones.
        const verifierPathFilter =
          node.type === "verifier" ? (p: string) => p.startsWith("reports/") : undefined;
        const writtenFiles = await this.extractAndWriteFiles(
          resultText,
          workspaceDir,
          verifierPathFilter,
        );
        if (writtenFiles.length > 0) {
          console.warn(
            `[orchestrator] Wrote ${writtenFiles.length} files for "${node.name}": ${writtenFiles.join(", ")}`,
          );
        }

        await this.postExecuteProcessing(node, workspaceDir, resultText);

        const expectedFiles = expectedFilesMap[node.id] ?? [];
        const isProducerType =
          node.type === "work" || node.type === "code" || node.type === "design";
        // A backend that wrote real files on disk is never "trivial" even if its
        // chat text is short — relaunching via the LLM would clobber those files.
        const backendFilesWritten = this.backendFilesWritten.get(node.id) ?? 0;
        const looksTrivial =
          isProducerType && isTrivialResult(resultText) && backendFilesWritten === 0;
        if (expectedFiles.length > 0 || looksTrivial) {
          const nodeSystemPrompt = buildNodeSystemPrompt(node);
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
                writeFiles: (text) =>
                  this.extractAndWriteFiles(text, workspaceDir, verifierPathFilter),
                onStatus: (msg) =>
                  this.sendStatus({ projectId: node.id, status: "running", task: msg }),
              },
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
              // Verification is advisory — an infra/auth failure here (e.g. a
              // mid-run token expiry) must NOT discard a node that already
              // produced its deliverables. Surface a warning and move on.
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
        await this.updateWorkspaceIndex(node, resultText, workspaceDir);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[orchestrator] Node "${node.name}" failed:`, msg);
        executionStatuses[node.id] = "error";
        this.sendStatus({ projectId: node.id, status: "error", error: msg });
      }
    }

    return executionStatuses;
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

      const agentWithModel = linkedProjects.find((p) => p.model);
      this.fallbackModel = agentWithModel?.model ?? undefined;
      this.fallbackReasoningEffort = orchestrator.reasoningEffort || undefined;

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
  ): Promise<{
    statuses: Record<string, "done" | "error" | "skipped">;
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
      const fixTask = buildFixTask(fixes[p.id], feedback, prevResult);
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
    const executionOrder = this.resolveDAG(subset);

    const statuses = await this.executeNodesSequence(
      orchestrator,
      executionOrder,
      allProjects,
      executionResults,
      wsContext,
      {},
      workspaceDir,
      expectedFilesMap,
    );

    return { statuses, results: executionResults };
  }

  private async runQualityGate(
    verifier: Project,
    task: string,
    linkedProjects: readonly Project[],
    workspaceDir: string,
    executionStatuses: Readonly<Record<string, "done" | "error" | "skipped">>,
    executionResults: ReadonlyMap<string, string>,
    expectedFilesMap: Readonly<Record<string, readonly string[]>>,
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
    const servedProblems = [
      ...(await findServedSiteProblems(workspaceDir)),
      ...(await findCssConsistencyProblems(workspaceDir)),
      // Format-agnostic (non-web) deterministic check: every produced *.json must parse.
      ...(await findInvalidJsonFiles(workspaceDir)),
    ];
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
      buildServedSiteReport(servedProblems),
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
    });

    const response = await callLLM(
      verifier,
      systemPrompt,
      userPrompt,
      this.abortSignal,
      true,
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
    ].slice(0, 30);

    const llmIssues = llmVerdict?.issues ?? [];
    const verdict = {
      pass: (llmVerdict?.pass ?? true) && deterministicIssues.length === 0,
      issues: [...deterministicIssues, ...llmIssues],
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
    executionStatuses: Record<string, "done" | "error" | "skipped">,
    executionResults: Map<string, string>,
    expectedFilesMap: Record<string, readonly string[]>,
    verifier: Project,
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
      );

      for (const [id, status] of Object.entries(statuses)) {
        executionStatuses[id] = status;
      }
      for (const [id, result] of results) {
        executionResults.set(id, result);
      }
    }
  }

  private resolveDAG(nodes: Project[]): Project[] {
    const visited = new Set<string>();
    const tempVisited = new Set<string>();
    const order: Project[] = [];

    const visit = (node: Project) => {
      if (visited.has(node.id)) return;
      if (tempVisited.has(node.id)) {
        const cycle = [...tempVisited, node.id];
        const names = cycle.map((id) => {
          const n = nodes.find((p) => p.id === id);
          return n ? `"${n.name}" (${id})` : id;
        });
        console.error(
          `[orchestrator] Circular dependency detected: ${names.join(" → ")}`,
        );
        throw new Error("Dépendance circulaire détectée dans le graphe de projets.");
      }

      tempVisited.add(node.id);

      const deps = node.dependencies || [];
      for (const depId of deps) {
        const depNode = nodes.find((n) => n.id === depId);
        if (depNode) visit(depNode);
      }

      tempVisited.delete(node.id);
      visited.add(node.id);
      order.push(node);
    };

    for (const node of nodes) {
      visit(node);
    }

    return order;
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
      const match = subs.find((s) => {
        const short = s.name.includes("›") ? s.name.split("›").pop()!.trim() : s.name;
        const nameNorm = normalizeForDepMatch(short);
        return (
          nameNorm.length >= 6 &&
          suffixNorm.includes(nameNorm.slice(-Math.min(12, nameNorm.length)))
        );
      });
      if (match) return match.id;
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
            return { tasks: parsed, steps: {}, createdSubAgents: [], expectedFiles: {} };
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
            // Fill unmatched agents with global task
            for (const p of linked) {
              if (!remapped[p.id]) remapped[p.id] = globalTask;
            }
            return {
              tasks: remapped,
              steps: {},
              createdSubAgents: [],
              expectedFiles: {},
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
        return { tasks: fallback, steps: {}, createdSubAgents: [], expectedFiles: {} };
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

    // Fallback for unassigned agents
    for (const p of linked) {
      if (!tasks[p.id]) {
        console.warn(
          `[orchestrator] Agent "${p.name}" unassigned after planning loop, using global task.`,
        );
        tasks[p.id] = globalTask;
      }
    }

    return { tasks, steps, createdSubAgents, expectedFiles };
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
      return true; // Fallback to valid
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
    const response = await callLLM(
      verifier,
      systemPrompt,
      userPrompt,
      this.abortSignal,
      true,
      this.fallbackModel,
      this.fallbackReasoningEffort,
    );
    console.warn(
      `[orchestrator:verify] LLM response for "${node.name}": ${response.substring(0, 300)}`,
    );
    try {
      const cleaned = response
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(cleaned) as {
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
      console.warn(
        `[orchestrator:verify] Failed to parse response for "${node.name}" — defaulting to valid`,
      );
      return { valid: true };
    }
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

    const MAX_PER_FILE = 4000;
    const MAX_TOTAL = 16000;
    const lines: string[] = [];
    let total = 0;

    for (const rel of expectedFiles) {
      if (!OrchestratorRunner.isValidFilePath(rel)) continue;
      const full = path.join(workspaceDir, rel);
      try {
        const content = await fs.readFile(full, "utf-8");
        const size = Buffer.byteLength(content, "utf-8");
        if (total >= MAX_TOTAL) {
          lines.push(`✓ ${rel} (${size} octets) [contenu omis — limite atteinte]`);
          continue;
        }
        const budget = Math.min(MAX_PER_FILE, MAX_TOTAL - total);
        const shown =
          content.length > budget
            ? content.substring(0, budget) + "\n[… tronqué pour l'audit …]"
            : content;
        total += shown.length;
        lines.push(`✓ ${rel} (${size} octets) :\n${shown}`);
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
      return true;
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
    plannedSteps?: readonly SubStep[],
    workspaceDir?: string,
    expectedFiles?: readonly string[],
  ): Promise<string> {
    console.warn(
      `[orchestrator] Executing node: ${node.name} (${node.type}), task="${(node.task || "").substring(0, 100)}"`,
    );

    // Temporarily switch active project in store so proxy intercepts with this node's instructions
    await setActiveProject(node.id);

    const systemPrompt = buildNodeSystemPrompt(node);
    const depContext = buildDependencyContext(node, allProjects, executionResults);
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

    try {
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
          });

          let appUserPrompt = userPrompt;
          if (plannedSteps && plannedSteps.length >= 2) {
            const checklist = plannedSteps
              .map((s, i) => `${i + 1}. ${s.title} — ${s.focus}`)
              .join("\n");
            appUserPrompt = `${userPrompt}\n\nÉTAPES À SUIVRE :\n${checklist}`;
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
            },
            (slot) => (pm ? pm.ensureRunning(slot) : Promise.resolve(null)),
          );

          console.warn(
            `[orchestrator] ✓ Backend SUCCESS for "${node.name}" — ${result.backend}, ${result.resultText.length} chars, ${result.filesWritten} fichier(s)`,
          );
          // Record real files written by the backend's tools so the trivial-result
          // gate never relaunches (and clobbers) a node that produced files but
          // returned only a short chat summary.
          this.backendFilesWritten.set(node.id, result.filesWritten);
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
          undefined,
          workspaceDir,
        );
      }

      // work/code without steps: free-form multi-turn iteration
      if (OrchestratorRunner.MULTI_TURN_TYPES.has(node.type ?? "") && workspaceDir) {
        return await this.executeMultiTurn(
          node,
          workspaceContext,
          depContext,
          systemPrompt,
          workspaceDir,
        );
      }

      return await this.executeSingleCall(
        node,
        workspaceContext,
        depContext,
        systemPrompt,
      );
    } finally {
      // Revert active project to the orchestrator
      if (this.currentOrchestratorId) {
        await setActiveProject(this.currentOrchestratorId);
      }
    }
  }

  /**
   * Decompose a complex task into sequential sub-steps via LLM
   */
  private async decomposeTask(
    node: Project,
    workspaceContext: string,
    depContext: string,
  ): Promise<SubStep[]> {
    const systemPrompt = buildDecomposeSystemPrompt(node);
    const userPrompt = buildDecomposeUserPrompt(node, workspaceContext, depContext);

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
    workspaceDir: string,
  ): Promise<string> {
    const MAX_ITERATIONS = 6;
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

      const writtenFiles = await this.extractAndWriteFiles(response, workspaceDir);
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

        if (parsed.complete) {
          console.warn(
            `[orchestrator:multi] ${node.name} — task complete after ${iter} iteration(s)`,
          );
          break;
        }

        missing =
          parsed.missing ||
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
    workspaceDir: string,
  ): Promise<string> {
    const MAX_ITER = 4;
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

      const writtenFiles = await this.extractAndWriteFiles(response, workspaceDir);
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
      try {
        // Connect to OpenDesign daemon at port 7456 to get generated layouts
        const res = await fetch("http://localhost:7456/api/projects");
        if (res.ok) {
          await res.json();
          // Attempt to find project matching the node's name or search for assets
          // In a real run, the daemon creates folders in the workspace, so we just
          // trigger compiling assets if an endpoint exists.
          console.warn("[orchestrator] OpenDesign daemon projects list queried.");
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[orchestrator] Failed to sync OpenDesign daemon:", msg);
      }
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

  private async extractAndWriteFiles(
    resultText: string,
    workspaceDir: string,
    pathFilter?: (relPath: string) => boolean,
  ): Promise<string[]> {
    const written: string[] = [];
    // Resolved paths already written this call, so the three parsers below can ALL
    // run (an agent may mix formats mid-response) without re-writing the same file.
    // First-writer-wins → the primary ```filepath: format takes precedence.
    const seen = new Set<string>();
    const accept = (p: string): boolean =>
      OrchestratorRunner.isValidFilePath(p) && (!pathFilter || pathFilter(p));

    // Primary: match ```lang filepath: path/to/file blocks (filepath: is REQUIRED)
    const blockRe = /```[\w]*\s+filepath:\s*([^\n]+)\n([\s\S]*?)```/gi;

    let match: RegExpExecArray | null;
    while ((match = blockRe.exec(resultText)) !== null) {
      const filePath = match[1].trim();
      const content = match[2];
      if (!content || !accept(filePath)) {
        if (filePath)
          console.warn(
            `[orchestrator:files] Rejected path: ${filePath.substring(0, 80)}`,
          );
        continue;
      }
      if (written.length >= MAX_WRITTEN_FILES) break;
      await this.tryWriteWorkspaceFile(workspaceDir, filePath, content, written, seen);
    }

    // Secondary: match **Fichier: `path/to/file`** then ```...``` pattern. Runs
    // unconditionally (deduped via `seen`) so mixed-format output isn't dropped.
    const headerRe =
      /(?:\*{1,2})?(?:Fichier|File)\s*:\s*`?([^`\n*]+?)`?\*{0,2}\s*\n\s*```[\w]*\n([\s\S]*?)```/gi;
    while ((match = headerRe.exec(resultText)) !== null) {
      const filePath = match[1].trim();
      const content = match[2];
      if (!content || !accept(filePath)) continue;
      if (written.length >= MAX_WRITTEN_FILES) break;
      await this.tryWriteWorkspaceFile(workspaceDir, filePath, content, written, seen);
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
        await this.tryWriteWorkspaceFile(workspaceDir, curPath, content, written, seen);
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
  private async tryWriteWorkspaceFile(
    workspaceDir: string,
    filePath: string,
    content: string,
    written: string[],
    seen?: Set<string>,
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
    if (seen?.has(fullPath)) return; // already written this call (first-writer-wins)
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
      seen?.add(fullPath);
      written.push(filePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[orchestrator:files] Failed to write ${filePath}: ${msg}`);
    }
  }

  private async updateWorkspaceIndex(
    node: Project,
    resultText: string,
    workspaceDir: string,
  ): Promise<void> {
    const indexPath = path.join(workspaceDir, "WORKSPACE_INDEX.md");
    try {
      console.warn(`[orchestrator] Updating WORKSPACE_INDEX.md for: ${node.name}`);

      // 1. Read existing index content
      let content = await fs.readFile(indexPath, "utf-8");

      // 2. Ask LLM to generate the file map updates and changelog line based on the agent's work
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
      const parsed = JSON.parse(cleaned) as { newFiles?: string; changelogLine?: string };

      // Append files mapping to Section 1
      if (parsed.newFiles && parsed.newFiles.trim().length > 0) {
        const marker = "## 2. Journal des Modifications";
        const idx = content.indexOf(marker);
        if (idx >= 0) {
          content =
            content.slice(0, idx) + parsed.newFiles.trim() + "\n\n" + content.slice(idx);
        }
      }

      // Append changelog line to Section 2
      if (parsed.changelogLine) {
        content = content.trim() + "\n" + parsed.changelogLine.trim() + "\n";
      }

      await fs.writeFile(indexPath, content, "utf-8");
      console.warn("[orchestrator] WORKSPACE_INDEX.md updated.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] Failed to update WORKSPACE_INDEX.md:", msg);
    }
  }
}
