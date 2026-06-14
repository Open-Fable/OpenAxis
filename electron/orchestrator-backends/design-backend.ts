import { promises as fs, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { BackendContext, BackendResult, ExecutionBackend } from "./types.js";
import { BackendUnavailableError } from "./types.js";

const DESIGN_PORT = 7456;
const DESIGN_BASE = `http://127.0.0.1:${DESIGN_PORT}`;
const HEALTH_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 2_000;
const RUN_TIMEOUT_MS = 20 * 60 * 1000;

const MAX_DESIGN_ITERATIONS = 3;

const TEXT_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".svg",
  ".json",
  ".md",
  ".txt",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
]);

const MAX_FILE_READ_SIZE = 50_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The Open Design daemon writes artifacts to `<apps>/open-design/.od/projects`.
// This file runs at different depths in dev (electron/orchestrator-backends/)
// vs prod (dist/electron/orchestrator-backends/), so a fixed number of `..`
// segments resolves to the wrong place in one of the two. Walk up from
// __dirname until we find the real apps/open-design directory; fall back to
// the project cwd (the daemon is always spawned from there).
function resolveOdRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "apps", "open-design");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), "apps", "open-design");
}

const OD_ROOT = resolveOdRoot();
const OD_PROJECTS_DIR = path.join(OD_ROOT, ".od", "projects");

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const AGENT_MODEL_MAP: ReadonlyMap<string, string> = new Map([
  ["google", "gemini"],
  ["anthropic", "claude"],
  ["deepseek", "opencode"],
]);

function resolveDesignAgentAndModel(nodeModel: string | undefined): {
  agentId: string | undefined;
  model: string | undefined;
} {
  if (!nodeModel) return { agentId: undefined, model: undefined };
  const slashIdx = nodeModel.indexOf("/");
  if (slashIdx === -1) return { agentId: undefined, model: nodeModel };
  const provider = nodeModel.substring(0, slashIdx);
  const modelId = nodeModel.substring(slashIdx + 1);
  const agentId = AGENT_MODEL_MAP.get(provider);
  return { agentId, model: modelId };
}

interface RunStatus {
  readonly id: string;
  readonly status: string;
  readonly error?: string | null;
}

function sanitizeId(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, "-").substring(0, 120);
  return `orch-${clean}`;
}

function buildDesignReviewPrompt(
  originalTask: string,
  fileContents: ReadonlyMap<string, string>,
): string {
  const fileBlocks: string[] = [];
  for (const [name, content] of fileContents) {
    fileBlocks.push(`── ${name} ──\n${content}`);
  }

  return `RÉVISION DE MAQUETTE — AMÉLIORATION DEMANDÉE

Tu as créé la maquette ci-dessous pour cette demande :
"${originalTask}"

FICHIERS ACTUELS :
${fileBlocks.join("\n\n")}

POINTS À VÉRIFIER ET AMÉLIORER :
1. COMPLÉTUDE — Toutes les pages/sections demandées sont-elles présentes ? Manque-t-il des états (hover, focus, active, disabled, loading, erreur, vide) ?
2. CONTENU RÉEL — Remplace tout placeholder ("Lorem ipsum", "Titre ici", images de démonstration) par du contenu cohérent avec le projet.
3. RESPONSIVE — Les breakpoints mobile (< 768px), tablette (768–1024px) et desktop (> 1024px) sont-ils couverts avec des media queries ?
4. DÉTAILS VISUELS — Transitions, animations CSS, ombres, border-radius, micro-interactions. Le design doit être professionnel et raffiné.
5. ACCESSIBILITÉ — Contraste WCAG AA, focus visible, aria-labels, sémantique HTML.
6. DESIGN SYSTEM — Les tokens (couleurs, typo, espacement) sont-ils cohérents et documentés ?
7. COMPOSANTS MANQUANTS — Formulaires, modales, toasts, breadcrumbs, pagination, navigation mobile (hamburger menu).

CONSIGNE : Produis la version COMPLÈTE et AMÉLIORÉE de TOUS les fichiers. Ne résume pas — écris le code intégral. Si un fichier est déjà parfait, reproduis-le tel quel. L'objectif est une maquette PRODUCTION-READY, pas un brouillon.`;
}

export class DesignBackend implements ExecutionBackend {
  readonly slot = "design" as const;
  readonly apiPort = DESIGN_PORT;

  async isAvailable(): Promise<boolean> {
    try {
      console.warn(`[backend:design] Health check → ${DESIGN_BASE}/api/health`);
      const res = await fetch(`${DESIGN_BASE}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      console.warn(
        `[backend:design] Health check → ${res.status} (${res.ok ? "available" : "down"})`,
      );
      return res.ok;
    } catch (err: unknown) {
      console.warn(
        `[backend:design] Health check → UNREACHABLE:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  async execute(ctx: BackendContext): Promise<BackendResult> {
    const { node, workspaceDir, systemPrompt, userPrompt, signal } = ctx;
    const tag = `[backend:design] [${node.name}]`;
    const startTime = Date.now();

    console.warn(`${tag} ▶ Starting execute — workspace=${workspaceDir}`);

    const projectId = sanitizeId(node.id);
    if (!SAFE_ID_RE.test(projectId)) {
      throw new Error(`Invalid project ID after sanitization: "${projectId}"`);
    }
    console.warn(`${tag} Project ID: ${projectId}`);

    ctx.onProgress("Préparation du projet Open Design…");

    const existingProject = await this.findProject(projectId);
    if (existingProject) {
      console.warn(`${tag} Project already exists — reusing`);
    } else {
      console.warn(`${tag} Creating project → POST /api/projects { id: "${projectId}" }`);
      await this.createProject(projectId, node.name, systemPrompt);
      console.warn(`${tag} ✓ Project created`);
    }

    const { agentId, model } = resolveDesignAgentAndModel(node.model);
    console.warn(
      `${tag} Resolved agent: ${agentId ?? "default"}, model: ${model ?? "default"}`,
    );

    let exportedFiles: readonly string[] = [];

    for (let iter = 1; iter <= MAX_DESIGN_ITERATIONS; iter++) {
      if (signal?.aborted) throw new Error("Aborted by user");

      const isFirst = iter === 1;
      const iterLabel = isFirst
        ? "Génération de la maquette…"
        : `Amélioration de la maquette (itération ${iter}/${MAX_DESIGN_ITERATIONS})…`;
      ctx.onProgress(iterLabel);

      const message = isFirst
        ? userPrompt
        : buildDesignReviewPrompt(
            node.task ?? userPrompt,
            await this.readTextArtifacts(projectId),
          );

      console.warn(
        `${tag} Creating run ${iter}/${MAX_DESIGN_ITERATIONS} → ${message.length} chars`,
      );
      const runId = await this.createRun(projectId, message, agentId, model);
      console.warn(`${tag} ✓ Run ${iter} created: ${runId}`);

      ctx.onProgress(
        isFirst
          ? "Génération en cours…"
          : `Amélioration en cours (${iter}/${MAX_DESIGN_ITERATIONS})…`,
      );

      const finalStatus = await this.pollRun(runId, signal, (status) => {
        ctx.onProgress(`${iterLabel} (${status})…`);
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.warn(
        `${tag} Run ${iter} finished: status=${finalStatus.status} in ${elapsed}s`,
      );

      if (finalStatus.status === "canceled") {
        throw new BackendUnavailableError(
          "open-design",
          new Error("Run annulé par l'utilisateur"),
        );
      }
      if (finalStatus.status === "failed") {
        if (isFirst) {
          throw new BackendUnavailableError(
            "open-design",
            new Error(`Run échoué : ${finalStatus.error ?? "erreur inconnue"}`),
          );
        }
        console.warn(`${tag} Refinement run ${iter} failed — using previous result`);
        break;
      }

      ctx.onProgress("Export des artefacts…");
      exportedFiles = await this.exportArtifacts(projectId, workspaceDir);
      console.warn(`${tag} Run ${iter}: ${exportedFiles.length} artifacts exported`);

      if (iter >= MAX_DESIGN_ITERATIONS) break;

      const fileContents = await this.readTextArtifacts(projectId);
      const totalSize = [...fileContents.values()].reduce((s, c) => s + c.length, 0);
      console.warn(
        `${tag} Artifact review: ${fileContents.size} text files, ${totalSize} total chars`,
      );

      if (fileContents.size === 0) {
        console.warn(`${tag} No text artifacts found — skipping refinement`);
        break;
      }

      const hasSubstantialContent = totalSize > 500 && fileContents.size >= 1;
      if (!hasSubstantialContent) {
        console.warn(
          `${tag} Artifacts too thin (${totalSize} chars, ${fileContents.size} files) — running refinement`,
        );
        continue;
      }

      const hasPlaceholders = [...fileContents.values()].some(
        (c) => /lorem ipsum/i.test(c) || /placeholder/i.test(c) || /\bTODO\b/.test(c),
      );
      if (hasPlaceholders && iter < MAX_DESIGN_ITERATIONS) {
        console.warn(`${tag} Placeholders detected — running refinement`);
        continue;
      }

      console.warn(`${tag} Artifacts look complete after ${iter} iteration(s) — done`);
      break;
    }

    const fileContents = await this.readTextArtifacts(projectId);
    const resultText = this.buildResultText(exportedFiles, fileContents);

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.warn(
      `${tag} ✓ DONE in ${totalElapsed}s — ${exportedFiles.length} artifacts, ${MAX_DESIGN_ITERATIONS} max iterations`,
    );

    return { resultText, backend: "open-design", filesWritten: exportedFiles.length };
  }

  private buildResultText(
    exportedFiles: readonly string[],
    fileContents: ReadonlyMap<string, string>,
  ): string {
    const sections: string[] = [
      `Statut : succeeded`,
      `Fichiers exportés (${exportedFiles.length}) :`,
      ...exportedFiles.map((f) => `  - ${f}`),
    ];

    if (fileContents.size > 0) {
      sections.push("", "── CONTENU DES MAQUETTES ──");
      for (const [name, content] of fileContents) {
        const ext = path.extname(name).replace(".", "");
        sections.push(`\n\`\`\`${ext} filepath: ${name}\n${content}\n\`\`\``);
      }
    }

    return sections.join("\n");
  }

  private async readTextArtifacts(
    projectId: string,
  ): Promise<ReadonlyMap<string, string>> {
    const srcDir = path.join(OD_PROJECTS_DIR, projectId);
    const exists = await fs
      .access(srcDir)
      .then(() => true)
      .catch(() => false);
    if (!exists) return new Map();

    const files = await this.listFilesRecursive(srcDir, srcDir);
    const contents = new Map<string, string>();

    for (const relPath of files) {
      const ext = path.extname(relPath).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;

      try {
        const fullPath = path.join(srcDir, relPath);
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_FILE_READ_SIZE) continue;
        const content = await fs.readFile(fullPath, "utf-8");
        contents.set(relPath, content);
      } catch {
        // skip unreadable files
      }
    }

    return contents;
  }

  private async findProject(projectId: string): Promise<{ id: string } | null> {
    try {
      const res = await fetch(`${DESIGN_BASE}/api/projects/${projectId}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return (await res.json()) as { id: string };
      return null;
    } catch {
      return null;
    }
  }

  private async createProject(
    projectId: string,
    name: string,
    customInstructions: string,
  ): Promise<void> {
    const trimmedInstructions = customInstructions.substring(0, 5000);
    const res = await fetch(`${DESIGN_BASE}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: projectId,
        name: `Orch: ${name}`,
        customInstructions: trimmedInstructions,
        skipDiscoveryBrief: true,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new BackendUnavailableError(
        "open-design",
        new Error(`Project creation failed ${res.status}: ${body.substring(0, 300)}`),
      );
    }
  }

  private async createRun(
    projectId: string,
    message: string,
    agentId?: string,
    model?: string,
  ): Promise<string> {
    const body: Record<string, unknown> = { projectId, message };
    if (agentId) body.agentId = agentId;
    if (model) body.model = model;
    const res = await fetch(`${DESIGN_BASE}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new BackendUnavailableError(
        "open-design",
        new Error(`Run creation failed ${res.status}: ${body.substring(0, 300)}`),
      );
    }

    const data = (await res.json()) as { id?: string; runId?: string };
    const runId = data.id ?? data.runId;
    if (!runId) {
      throw new Error("Run creation returned no ID");
    }
    return runId;
  }

  private async pollRun(
    runId: string,
    signal: AbortSignal | undefined,
    onStatus: (status: string) => void,
  ): Promise<RunStatus> {
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    let consecutiveErrors = 0;
    const MAX_POLL_ERRORS = 5;

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await this.cancelRun(runId);
        throw new Error("Aborted by user");
      }

      let status: RunStatus;
      try {
        status = await this.getRunStatus(runId);
        consecutiveErrors = 0;
      } catch (err: unknown) {
        consecutiveErrors++;
        console.warn(
          `[design-backend] Poll error (${consecutiveErrors}/${MAX_POLL_ERRORS}):`,
          err instanceof Error ? err.message : err,
        );
        if (consecutiveErrors >= MAX_POLL_ERRORS) {
          await this.cancelRun(runId);
          throw new Error(
            `Run polling failed after ${MAX_POLL_ERRORS} consecutive errors`,
          );
        }
        await this.sleep(POLL_INTERVAL_MS, signal);
        continue;
      }

      onStatus(status.status);

      if (
        status.status === "succeeded" ||
        status.status === "failed" ||
        status.status === "canceled"
      ) {
        return status;
      }

      await this.sleep(POLL_INTERVAL_MS, signal);
    }

    await this.cancelRun(runId);
    throw new Error("Run timed out after 20 minutes");
  }

  private async getRunStatus(runId: string): Promise<RunStatus> {
    const res = await fetch(`${DESIGN_BASE}/api/runs/${runId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`Failed to get run status: ${res.status}`);
    }
    return (await res.json()) as RunStatus;
  }

  private async cancelRun(runId: string): Promise<void> {
    try {
      await fetch(`${DESIGN_BASE}/api/runs/${runId}/cancel`, {
        method: "POST",
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // best-effort
    }
  }

  private async exportArtifacts(
    projectId: string,
    workspaceDir: string,
  ): Promise<readonly string[]> {
    const srcDir = path.join(OD_PROJECTS_DIR, projectId);
    const destDir = path.join(workspaceDir, "design", projectId);

    const srcExists = await fs
      .access(srcDir)
      .then(() => true)
      .catch(() => false);

    if (!srcExists) {
      console.warn(
        `[design-backend] Artifacts dir not found: ${srcDir} — skipping export`,
      );
      return [];
    }

    await fs.mkdir(destDir, { recursive: true });
    // The source tree is agent-controlled. Skip symlinks so a planted link (e.g.
    // → ~/.ssh) cannot have its target dereferenced and copied into the workspace.
    await fs.cp(srcDir, destDir, {
      recursive: true,
      dereference: false,
      filter: async (source) => {
        try {
          const st = await fs.lstat(source);
          return !st.isSymbolicLink();
        } catch {
          return false;
        }
      },
    });

    const files = await this.listFilesRecursive(destDir, destDir);
    return files;
  }

  private async listFilesRecursive(
    dir: string,
    base: string,
  ): Promise<readonly string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue; // never follow or list symlinks
      }
      if (entry.isDirectory()) {
        const sub = await this.listFilesRecursive(fullPath, base);
        results.push(...sub);
      } else {
        results.push(path.relative(base, fullPath));
      }
    }

    return results;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
