import { promises as fs } from "fs";
import { homedir } from "os";
import path from "path";
import type { BackendContext, BackendResult, ExecutionBackend } from "./types.js";
import { BackendUnavailableError } from "./types.js";

const OPENCODE_PORT = 4096;
const OPENCODE_BASE = `http://127.0.0.1:${OPENCODE_PORT}`;
const SESSION_TIMEOUT_MS = 5_000;
const PROMPT_TIMEOUT_MS = 15 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 2_000;
const MAX_CONTINUATIONS = 2;

const CONTINUATION_PROMPT = `Tu n'as PAS encore produit les fichiers demandés. Ton message précédent contenait un plan ou une analyse, mais AUCUN fichier n'a été écrit dans le workspace.

ARRÊTE DE PLANIFIER. PRODUIS MAINTENANT.

Utilise immédiatement les outils fichiers (write) pour créer chaque fichier demandé avec son contenu COMPLET et INTÉGRAL. Commence par le premier fichier et enchaîne sans t'arrêter.`;

function buildPermissions(workspaceDir: string) {
  // OpenCode's Permission.evaluate uses `findLast` — the LAST matching rule
  // wins. So the catch-all deny must come FIRST (base layer) and the specific
  // allows AFTER, otherwise the trailing `deny *` overrides every allow and
  // ALL tool writes inside the workspace are silently denied (forcing the
  // agent to fall back to emitting code blocks instead of using write/edit).
  return [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "write", pattern: `${workspaceDir}/**`, action: "allow" },
    { permission: "read", pattern: `${workspaceDir}/**`, action: "allow" },
    { permission: "edit", pattern: `${workspaceDir}/**`, action: "allow" },
    { permission: "bash", pattern: `${workspaceDir}/**`, action: "allow" },
  ];
}

interface OpencodeConfig {
  readonly provider?: {
    readonly openhub?: {
      readonly models?: Record<string, unknown>;
    };
  };
}

let cachedValidModels: ReadonlySet<string> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;

async function loadValidModels(): Promise<ReadonlySet<string>> {
  if (cachedValidModels && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedValidModels;
  }

  try {
    const configPath = path.join(homedir(), ".config", "opencode", "opencode.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as OpencodeConfig;
    const models = config.provider?.openhub?.models;
    cachedValidModels = models ? new Set(Object.keys(models)) : new Set<string>();
  } catch {
    cachedValidModels = new Set<string>();
  }
  cacheTimestamp = Date.now();
  return cachedValidModels;
}

function resolveModel(
  nodeModel: string | undefined,
  fallback: string | undefined,
  validModels: ReadonlySet<string>,
): { providerID: string; modelID: string } | undefined {
  const candidate = nodeModel ?? fallback;
  if (!candidate) return undefined;
  if (!validModels.has(candidate)) {
    console.warn(
      `[opencode-backend] Model "${candidate}" not in openhub provider config — omitting`,
    );
    return undefined;
  }
  return { providerID: "openhub", modelID: candidate };
}

interface SessionResponse {
  readonly id: string;
}

interface MessagePart {
  readonly type: string;
  readonly content?: string;
  readonly text?: string;
}

interface PromptResponse {
  readonly parts?: readonly MessagePart[];
}

function extractText(parts: readonly MessagePart[] | undefined): string {
  if (!parts) return "";
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.content ?? p.text ?? "")
    .join("\n");
}

async function snapshotWorkspaceFiles(
  workspaceDir: string,
): Promise<ReadonlyMap<string, number>> {
  try {
    const entries = await fs.readdir(workspaceDir, { recursive: true });
    const files = new Map<string, number>();
    for (const entry of entries) {
      const rel = String(entry);
      const fullPath = path.join(workspaceDir, rel);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile()) files.set(rel, stat.mtimeMs);
      } catch {
        // skip
      }
    }
    return files;
  } catch {
    return new Map();
  }
}

function countChangedFiles(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): number {
  let count = 0;
  for (const [file, mtime] of after) {
    const prevMtime = before.get(file);
    if (prevMtime === undefined || mtime > prevMtime) count++;
  }
  return count;
}

function looksLikePlanOnly(text: string): boolean {
  const lower = text.toLowerCase();
  const planSignals = [
    "voici mon plan",
    "voici le plan",
    "plan d'action",
    "étapes :",
    "étape 1",
    "step 1",
    "i'll start by",
    "here's my plan",
    "here is my plan",
    "commençons par",
    "je commence par analyser",
    "je vais d'abord",
    "plan de travail",
    "let me start by",
    "let me first",
    "let me analyze",
    "je vais commencer par",
  ];
  const hasPlanSignal = planSignals.some((s) => lower.includes(s));
  if (!hasPlanSignal) return false;

  const productionSignals = [
    "fichier créé",
    "fichier écrit",
    "j'ai créé",
    "j'ai écrit",
    "file created",
    "file written",
    "wrote ",
    "created ",
    "✓",
    "successfully",
  ];
  const hasProduction = productionSignals.some((s) => lower.includes(s));
  return !hasProduction;
}

export class OpencodeBackend implements ExecutionBackend {
  readonly slot = "code" as const;
  readonly apiPort = OPENCODE_PORT;

  async isAvailable(): Promise<boolean> {
    try {
      console.warn(`[backend:opencode] Health check → ${OPENCODE_BASE}`);
      const res = await fetch(OPENCODE_BASE, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const ok = res.ok || res.status === 404;
      console.warn(
        `[backend:opencode] Health check → ${res.status} (${ok ? "available" : "down"})`,
      );
      return ok;
    } catch (err: unknown) {
      console.warn(
        `[backend:opencode] Health check → UNREACHABLE:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  async execute(ctx: BackendContext): Promise<BackendResult> {
    const { node, workspaceDir, systemPrompt, userPrompt, signal } = ctx;
    const tag = `[backend:opencode] [${node.name}]`;

    console.warn(
      `${tag} ▶ Starting execute — type=${node.type}, workspace=${workspaceDir}`,
    );
    ctx.onProgress("Création de la session OpenCode…");

    const dirParam = `directory=${encodeURIComponent(workspaceDir)}`;
    const validModels = await loadValidModels();
    console.warn(`${tag} Valid models: [${[...validModels].join(", ")}]`);
    const model = resolveModel(node.model, ctx.fallbackModel, validModels);
    console.warn(
      `${tag} Resolved model: ${model ? `${model.providerID}/${model.modelID}` : "(default — no override)"}`,
    );

    const snapshotBefore = await snapshotWorkspaceFiles(workspaceDir);
    console.warn(`${tag} Files in workspace before: ${snapshotBefore.size}`);

    console.warn(`${tag} Creating session → POST /session?directory=...`);
    const sessionRes = await this.fetchJSON<SessionResponse>(
      `${OPENCODE_BASE}/session?${dirParam}`,
      {
        method: "POST",
        body: JSON.stringify({
          title: `Orch: ${node.name}`,
          permission: buildPermissions(workspaceDir),
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(SESSION_TIMEOUT_MS)])
          : AbortSignal.timeout(SESSION_TIMEOUT_MS),
      },
    );

    const sessionId = sessionRes.id;
    console.warn(`${tag} ✓ Session created: ${sessionId}`);

    ctx.onProgress("Exécution de l'agent OpenCode…");

    const startTime = Date.now();
    let resultText = await this.sendMessage(
      sessionId,
      dirParam,
      systemPrompt,
      userPrompt,
      model,
      signal,
      tag,
    );

    const snapshotAfterFirst = await snapshotWorkspaceFiles(workspaceDir);
    const changedFiles = countChangedFiles(snapshotBefore, snapshotAfterFirst);
    console.warn(
      `${tag} After first message: ${changedFiles} new/modified files, result ${resultText.length} chars`,
    );

    if (changedFiles === 0 && looksLikePlanOnly(resultText)) {
      for (let cont = 1; cont <= MAX_CONTINUATIONS; cont++) {
        if (signal?.aborted) break;

        console.warn(
          `${tag} ⚠ Plan-only detected — sending continuation ${cont}/${MAX_CONTINUATIONS}`,
        );
        ctx.onProgress(
          `Continuation ${cont}/${MAX_CONTINUATIONS} — production des fichiers…`,
        );

        const contResult = await this.sendMessage(
          sessionId,
          dirParam,
          undefined,
          CONTINUATION_PROMPT,
          model,
          signal,
          tag,
        );
        resultText += "\n\n" + contResult;

        const snapshotNow = await snapshotWorkspaceFiles(workspaceDir);
        const produced = countChangedFiles(snapshotBefore, snapshotNow);
        console.warn(
          `${tag} After continuation ${cont}: ${produced} new/modified files total`,
        );

        if (produced > 0) {
          console.warn(`${tag} ✓ Files produced after ${cont} continuation(s)`);
          break;
        }
      }
    }

    if (!resultText) {
      console.warn(`${tag} ✗ FAILED — no text extracted from session`);
      throw new BackendUnavailableError(
        "opencode",
        new Error("Empty response from opencode session"),
      );
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.warn(
      `${tag} ✓ DONE in ${totalElapsed}s — result: ${resultText.length} chars (preview: "${resultText.substring(0, 120)}…")`,
    );

    return { resultText, backend: "opencode" };
  }

  private async sendMessage(
    sessionId: string,
    dirParam: string,
    systemPrompt: string | undefined,
    userPrompt: string,
    model: { providerID: string; modelID: string } | undefined,
    signal: AbortSignal | undefined,
    tag: string,
  ): Promise<string> {
    const promptBody: Record<string, unknown> = {
      parts: [{ type: "text", text: userPrompt }],
    };
    if (systemPrompt !== undefined) {
      promptBody.system = systemPrompt;
    }
    if (model) {
      promptBody.model = model;
    }

    const promptSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(PROMPT_TIMEOUT_MS)])
      : AbortSignal.timeout(PROMPT_TIMEOUT_MS);

    console.warn(
      `${tag} Sending message → POST /session/${sessionId}/message (timeout ${PROMPT_TIMEOUT_MS / 1000}s)`,
    );
    console.warn(`${tag}   user prompt: ${userPrompt.length} chars`);
    const msgStart = Date.now();

    let resultText: string;
    try {
      const promptRes = await this.fetchJSON<PromptResponse>(
        `${OPENCODE_BASE}/session/${sessionId}/message?${dirParam}`,
        {
          method: "POST",
          body: JSON.stringify(promptBody),
          signal: promptSignal,
        },
      );
      const elapsed = ((Date.now() - msgStart) / 1000).toFixed(1);
      const partCount = promptRes.parts?.length ?? 0;
      console.warn(`${tag} ✓ Message returned in ${elapsed}s — ${partCount} parts`);
      resultText = extractText(promptRes.parts);
      console.warn(`${tag}   Extracted text: ${resultText.length} chars`);
    } catch (err: unknown) {
      const elapsed = ((Date.now() - msgStart) / 1000).toFixed(1);
      if (signal?.aborted) {
        console.warn(`${tag} ✗ Aborted after ${elapsed}s — cancelling session`);
        await this.abortSession(sessionId, dirParam).catch(() => {});
        throw err;
      }

      console.warn(
        `${tag} ✗ Message failed after ${elapsed}s:`,
        err instanceof Error ? err.message : err,
      );
      console.warn(`${tag}   Attempting fallback message retrieval…`);
      resultText = await this.retrieveLastAssistantMessage(sessionId, dirParam);
      console.warn(`${tag}   Fallback retrieval: ${resultText.length} chars`);
    }

    if (!resultText) {
      console.warn(`${tag} Empty result — retrying message retrieval…`);
      resultText = await this.retrieveLastAssistantMessage(sessionId, dirParam);
      console.warn(`${tag}   Retry retrieval: ${resultText.length} chars`);
    }

    return resultText;
  }

  private async abortSession(sessionId: string, dirParam: string): Promise<void> {
    try {
      await fetch(`${OPENCODE_BASE}/session/${sessionId}/abort?${dirParam}`, {
        method: "POST",
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // best-effort
    }
  }

  private async retrieveLastAssistantMessage(
    sessionId: string,
    dirParam: string,
  ): Promise<string> {
    try {
      const res = await fetch(
        `${OPENCODE_BASE}/session/${sessionId}/message?${dirParam}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) return "";
      const messages = (await res.json()) as readonly {
        role: string;
        parts?: readonly MessagePart[];
      }[];
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      return extractText(last?.parts);
    } catch {
      return "";
    }
  }

  private async fetchJSON<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err: unknown) {
      throw new BackendUnavailableError("opencode", err);
    }

    if (res.status === 401) {
      throw new BackendUnavailableError(
        "opencode",
        new Error("Authentication required (401)"),
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenCode API error ${res.status}: ${body.substring(0, 300)}`);
    }

    return (await res.json()) as T;
  }
}
