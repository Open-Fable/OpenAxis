import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import { getProjects, saveProject, setActiveProject, Project } from "./project-store.js";
import { getActiveWorkspaceDir } from "./proxy/index.js";

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface StatusUpdate {
  projectId: string;
  status: "idle" | "running" | "done" | "error" | "skipped" | "warning";
  task?: string;
  error?: string;
}

export class OrchestratorRunner {
  private isRunning = false;
  private currentOrchestratorId: string | null = null;
  private abortController: AbortController | null = null;

  constructor(private sendStatus: (update: StatusUpdate) => void) {}

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Run the orchestration pipeline starting from the given orchestrator ID
   */
  async run(orchestratorId: string, task: string): Promise<void> {
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

      const workspaceDir = getActiveWorkspaceDir() || homedir();
      console.warn(`[orchestrator] Starting run in: ${workspaceDir}`);

      // Initialize workspace index file
      await this.ensureWorkspaceIndexFile(workspaceDir);

      // Step 1: Initialize status of all linked nodes to idle
      const linkedIds = orchestrator.linked || [];
      const linkedProjects = allProjects.filter((p) => linkedIds.includes(p.id));

      this.sendStatus({ projectId: orchestratorId, status: "running" });
      for (const p of linkedProjects) {
        this.sendStatus({ projectId: p.id, status: "idle" });
      }

      // Step 2: Orchestrator planning phase (Auto-distribute tasks)
      let tasksMap: Record<string, string> = {};
      if (orchestrator.orchSettings?.autoDistribute) {
        tasksMap = await this.generatePlanning(orchestrator, linkedProjects, task);
        console.warn("[orchestrator] Planning generated:", tasksMap);

        // Save generated tasks and update UI
        for (const p of linkedProjects) {
          if (tasksMap[p.id]) {
            const updatedProject = { ...p, task: tasksMap[p.id] };
            await saveProject(updatedProject);
            this.sendStatus({ projectId: p.id, status: "idle", task: tasksMap[p.id] });
          }
        }
      } else {
        // Use pre-configured tasks
        for (const p of linkedProjects) {
          tasksMap[p.id] = p.task || "";
        }
      }

      // Step 3: Run Pre-Execution Prompt Verifier
      if (orchestrator.orchSettings?.checkCoherence) {
        const verifier = allProjects.find((p) => p.type === "verifier");
        if (verifier) {
          this.sendStatus({
            projectId: verifier.id,
            status: "running",
            task: "Vérification des prompts...",
          });
          const isValid = await this.verifyPrompts(verifier, task, tasksMap);
          if (!isValid) {
            this.sendStatus({
              projectId: verifier.id,
              status: "error",
              error: "Instructions de sous-tâches incohérentes.",
            });
            throw new Error(
              "Le vérificateur de prompts a rejeté la cohérence du planning.",
            );
          }
          this.sendStatus({
            projectId: verifier.id,
            status: "done",
            task: "Prompts validés avec succès.",
          });
        }
      }

      // Step 4: Resolve Topological Order (DAG)
      const executionOrder = this.resolveDAG(linkedProjects);
      console.warn(
        "[orchestrator] Execution order:",
        executionOrder.map((n) => n.name),
      );

      const executionStatuses: Record<string, "done" | "error" | "skipped"> = {};

      // Step 5: Execute each node in order
      for (const node of executionOrder) {
        if (this.abortController?.signal.aborted) {
          throw new Error("Orchestration annulée par l'utilisateur.");
        }

        // Check dependencies
        const deps = node.dependencies || [];
        const isDepFailed = deps.some(
          (depId) =>
            executionStatuses[depId] === "error" ||
            executionStatuses[depId] === "skipped",
        );

        if (isDepFailed) {
          executionStatuses[node.id] = "skipped";
          this.sendStatus({ projectId: node.id, status: "skipped" });
          continue;
        }

        // Execute node
        this.sendStatus({ projectId: node.id, status: "running" });
        try {
          const resultText = await this.executeNode(node);

          // Post-execution: check renders & quality
          await this.postExecuteProcessing(node, workspaceDir, resultText);

          // Verify node execution
          let nodeValid = true;
          if (orchestrator.orchSettings?.checkCoherence) {
            const verifier = allProjects.find((p) => p.type === "verifier");
            if (verifier) {
              nodeValid = await this.verifyOutput(verifier, node, resultText);
            }
          }

          if (nodeValid) {
            executionStatuses[node.id] = "done";
            this.sendStatus({ projectId: node.id, status: "done" });

            // Document changes in workspace manifest
            await this.updateWorkspaceIndex(node, resultText, workspaceDir);
          } else {
            executionStatuses[node.id] = "error";
            this.sendStatus({
              projectId: node.id,
              status: "error",
              error: "Le rendu a échoué aux tests de cohérence.",
            });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[orchestrator] Node ${node.name} failed:`, err);
          executionStatuses[node.id] = "error";
          this.sendStatus({ projectId: node.id, status: "error", error: msg });
        }
      }

      // Step 6: Final Brand and Spec verification
      const hasErrors = Object.values(executionStatuses).includes("error");
      if (!hasErrors && orchestrator.orchSettings?.checkCoherence) {
        const verifier = allProjects.find((p) => p.type === "verifier");
        if (verifier) {
          this.sendStatus({
            projectId: verifier.id,
            status: "running",
            task: "Vérification finale de l'image de la marque et conformité...",
          });
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
        }
      }

      // Complete orchestrator status
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
  private resolveDAG(nodes: Project[]): Project[] {
    const visited = new Set<string>();
    const tempVisited = new Set<string>();
    const order: Project[] = [];

    const visit = (node: Project) => {
      if (visited.has(node.id)) return;
      if (tempVisited.has(node.id)) {
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

  /**
   * Call LLM to break down the global task into specific sub-tasks (Planning Phase)
   */
  private async generatePlanning(
    orchestrator: Project,
    linked: Project[],
    globalTask: string,
  ): Promise<Record<string, string>> {
    const systemPrompt =
      orchestrator.instructions ||
      "Tu es un chef de projet IA coordonnant des agents techniques.";
    const userPrompt = `
Tâche globale à orchestrer : "${globalTask}"

Voici les agents disponibles sous forme de projets distincts :
${linked.map((p) => `- ID: ${p.id}, Nom: "${p.name}", Type: ${p.type}, Prompt de l'agent: "${p.instructions}"`).join("\n")}

Rôle : Attribue une consigne (prompt spécifique) claire et détaillée à chaque agent pour réaliser la tâche globale de manière cohérente.
Renvoie STRICTEMENT un objet JSON plat sans autre texte ou balise markdown. Les clés doivent être les identifiants de projet (ex: "p1") et les valeurs la tâche générée pour chaque projet.
Exemple de réponse attendue :
{
  "p1": "Écris l'API d'authentification...",
  "p2": "Crée la feuille de style CSS..."
}
`;
    const response = await this.callLLM(orchestrator, systemPrompt, userPrompt, true);
    try {
      // Strip markdown code blocks if any
      const cleaned = response
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      return JSON.parse(cleaned);
    } catch {
      console.error("[orchestrator] Planning parse failed. Raw response:", response);
      // Fallback: assign global task to everyone
      const fallback: Record<string, string> = {};
      for (const p of linked) fallback[p.id] = globalTask;
      return fallback;
    }
  }

  /**
   * Pre-execution verifier check
   */
  private async verifyPrompts(
    verifier: Project,
    globalTask: string,
    promptsMap: Record<string, string>,
  ): Promise<boolean> {
    const systemPrompt =
      verifier.instructions || "Tu es un vérificateur de qualité d'instructions.";
    const userPrompt = `
Tâche globale : "${globalTask}"
Instructions générées par l'Orchestrateur pour chaque projet lié :
${JSON.stringify(promptsMap, null, 2)}

Analyse si ces instructions couvrent tout le périmètre de la tâche globale, si elles ne se contredisent pas et s'assurer qu'elles sont cohérentes.
Réponds STRICTEMENT par un JSON valide :
{
  "valid": true ou false,
  "reason": "Explication si invalide"
}
`;
    const response = await this.callLLM(verifier, systemPrompt, userPrompt, true);
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
  private async verifyOutput(
    verifier: Project,
    node: Project,
    resultText: string,
  ): Promise<boolean> {
    const systemPrompt =
      verifier.instructions || "Tu es un réviseur de code et de livrables.";
    const userPrompt = `
Tâche de l'agent "${node.name}" : "${node.task}"
Livrable / Réponse de l'agent :
---
${resultText}
---

Vérifie si le livrable est fonctionnel, s'il répond précisément aux attentes et s'il ne présente pas d'erreurs structurelles évidentes.
Réponds par un JSON strict :
{
  "valid": true ou false,
  "reason": "Explication en cas d'erreur"
}
`;
    const response = await this.callLLM(verifier, systemPrompt, userPrompt, true);
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

    const systemPrompt =
      verifier.instructions || "Tu es le gardien de la charte de marque.";
    const userPrompt = `
Guide de style et de marque de l'application :
---
${brandGuidelines}
---

Examine les modifications globales et assure-toi que l'application respecte les règles de design de la marque, les polices, et les palettes de couleurs.
Réponds par un JSON strict :
{
  "valid": true ou false,
  "reason": "Explication des écarts de marque"
}
`;
    const response = await this.callLLM(verifier, systemPrompt, userPrompt, true);
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
  private async executeNode(node: Project): Promise<string> {
    console.warn(`[orchestrator] Executing node: ${node.name} (${node.type})`);

    // Temporarily switch active project in store so proxy intercepts with this node's instructions
    await setActiveProject(node.id);

    try {
      const maxRetries = node.maxRetries || 3;
      let attempt = 0;
      let finalResponseText = "";
      let isDone = false;

      while (attempt < maxRetries && !isDone) {
        attempt++;
        let prompt = node.task || "";

        // If we are continuing a previous generation
        if (finalResponseText.length > 0) {
          prompt = `Poursuis ton travail exactement là où tu l'as laissé. Conserve le code et les explications écrites. Voici la fin de ton dernier texte généré : \n"... ${finalResponseText.slice(-150)}"`;
        }

        console.warn(
          `[orchestrator] Calling LLM for node ${node.name} (attempt ${attempt}/${maxRetries})...`,
        );
        const chunkTimeout = 60000; // Watchdog timeout: 60s

        try {
          const response = await this.callLLMWithWatchdog(node, prompt, chunkTimeout);
          finalResponseText += response;
          isDone = true; // Completed successfully without timeout
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg === "WATCHDOG_TIMEOUT") {
            console.warn(
              `[orchestrator] Node ${node.name} hit watchdog timeout. Attempting continuation...`,
            );
            if (attempt === maxRetries) {
              throw new Error(
                "L'agent s'est bloqué de manière répétée et a dépassé la limite de relance.",
              );
            }
            // Continue the loop, it will append continuation prompt on next retry
          } else {
            throw err; // Real error
          }
        }
      }

      return finalResponseText;
    } finally {
      // Revert active project to the orchestrator
      if (this.currentOrchestratorId) {
        await setActiveProject(this.currentOrchestratorId);
      }
    }
  }

  /**
   * LLM call with a watchdog that aborts if no chunks are received for a specified duration
   */
  private async callLLMWithWatchdog(
    node: Project,
    prompt: string,
    timeoutMs: number,
  ): Promise<string> {
    const proxyUrl = "http://127.0.0.1:9999/v1/chat/completions";

    const body = {
      model: node.model || "workflow-deepseek-pro-flash", // Fallback model or default
      messages: [{ role: "user", content: prompt }],
      stream: true,
      temperature: 0.1, // Safe temperature to minimize hallucinations
      bypassInjection: true,
    };

    const controller = new AbortController();
    const orchSignal = this.abortController?.signal;
    if (orchSignal?.aborted) {
      throw new Error("Orchestration annulée par l'utilisateur.");
    }
    orchSignal?.addEventListener("abort", () => controller.abort(), { once: true });

    const timeoutSignal = controller.signal;

    let timer: NodeJS.Timeout | undefined = undefined;
    const resetTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        console.warn("[watchdog] Timeout! Aborting request...");
        controller.abort();
      }, timeoutMs);
    };

    resetTimer();

    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer openhub-local",
      },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });

    if (!response.ok) {
      clearTimeout(timer);
      const text = await response.text();
      throw new Error(`Proxy error (${response.status}): ${text}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      clearTimeout(timer);
      throw new Error("Impossible de lire le flux de réponse du proxy.");
    }

    const decoder = new TextDecoder("utf-8");
    let accumulatedText = "";
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        resetTimer(); // Reset watchdog timer on chunk received

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === "[DONE]") continue;
            try {
              const parsed = JSON.parse(jsonStr) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const text = parsed.choices?.[0]?.delta?.content;
              if (typeof text === "string") {
                accumulatedText += text;
              }
            } catch {}
          }
        }
      }
      return accumulatedText;
    } catch (err: unknown) {
      if (orchSignal?.aborted) {
        throw new Error("Orchestration annulée par l'utilisateur.");
      }
      if (timeoutSignal.aborted) {
        throw new Error("WATCHDOG_TIMEOUT");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Simple helper to call the local proxy completions endpoint
   */
  private async callLLM(
    node: Project,
    systemPrompt: string,
    userPrompt: string,
    bypassMemory = false,
  ): Promise<string> {
    const proxyUrl = "http://127.0.0.1:9999/v1/chat/completions";
    const body = {
      model: node.model || "workflow-deepseek-pro-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      bypassInjection: bypassMemory || node.bypassMemory || true,
    };

    const signal = this.abortController?.signal;
    if (signal?.aborted) {
      throw new Error("Orchestration annulée par l'utilisateur.");
    }

    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer openhub-local",
      },
      body: JSON.stringify(body),
      signal: signal ?? undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Proxy error: ${text}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? "";
  }

  /**
   * Post-execution processing (ex: Linter runs for OpenCode, copying design output from OpenDesign)
   */
  private async postExecuteProcessing(
    node: Project,
    workspaceDir: string,
    _resultText: string,
  ): Promise<void> {
    if (node.type === "code") {
      console.warn(
        `[orchestrator] Running build/linter verification for OpenCode: ${node.name}`,
      );
      try {
        // Check package.json lint script
        const pkgPath = path.join(workspaceDir, "package.json");
        const hasPkg = await fs
          .access(pkgPath)
          .then(() => true)
          .catch(() => false);
        if (hasPkg) {
          const pkgRaw = await fs.readFile(pkgPath, "utf-8");
          const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
          if (pkg.scripts?.lint) {
            console.warn("[orchestrator] Running: npm run lint...");
            await execAsync("npm run lint", { cwd: workspaceDir });
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[orchestrator] Linter verification returned warnings/errors:", msg);
        throw new Error(`Le linter (npm run lint) a échoué : ${msg}`);
      }
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
      const verifierProj = {
        id: "sys-indexer",
        name: "Indexeur de Fichiers",
        instructions: "Tu es un indexeur de code de documentation.",
        color: "#ccc",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as Project;

      const systemPrompt = "Tu es un analyste de documentation projet.";
      const userPrompt = `
Voici le résumé de l'exécution de l'agent "${node.name}" (${(node.type || "code").toUpperCase()}) :
---
${resultText.substring(0, 3000)}
---

Génère deux blocs d'information à ajouter au registre :
Bloc 1 : Nouvelles lignes pour le tableau de cartographie de fichier, au format : \`| chemin/du/fichier | Fonction courte |\` (uniquement si de nouveaux fichiers ont été créés/découverts).
Bloc 2 : Une ligne pour le tableau de Changelog, au format : \`| ${new Date().toLocaleDateString("fr-FR")} | ${node.name} | chemin/du/fichier | Rôle des modifications |\`.

Réponds sous forme de JSON strict :
{
  "newFiles": "ligne1\\nligne2",
  "changelogLine": "| date | agent | fichiers | description |"
}
`;
      const response = await this.callLLM(verifierProj, systemPrompt, userPrompt, true);
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
