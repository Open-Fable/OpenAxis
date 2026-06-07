import express, { Request, Response, NextFunction } from "express";
import { randomBytes } from "crypto";
import { request as httpRequest } from "http";
import { homedir } from "os";
import { promises as fs } from "fs";
import path from "path";
import { readAllApiKeys, readSecret } from "../keychain.js";
import { getActiveProject } from "../project-store.js";
import { buildMemoryBlock } from "../memory-store.js";
import { getCacheMetrics, recordCacheMetric, resetCacheMetrics } from "../cache-metrics.js";

const PROXY_PORT = 9999;
const PROXY_HOST = "127.0.0.1";

// ── In-memory workspace store ──
type WorkspaceEntry = {
  id: string;
  name: string;
  path: string;
  preset: string;
  workspaceType: string;
  displayName: string;
};
// Seed the default workspace so session listing knows its directory
const workspaces: WorkspaceEntry[] = [
  {
    id: "openhub-default",
    name: "OpenHub",
    path: homedir(),
    preset: "default",
    workspaceType: "local",
    displayName: "OpenHub",
  },
];
let activeWorkspaceId: string | null = "openhub-default";

export function getActiveWorkspaceDir(): string {
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  return ws?.path ?? homedir();
}

export async function startProxy(): Promise<string> {
  const sessionToken = randomBytes(32).toString("hex");

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // ── CORS — OpenWork webview (localhost:5173) calls 127.0.0.1:9999 cross-origin ──
  // Handle preflight + set headers in a single middleware so Express 5's
  // changed wildcard semantics don't break OPTIONS routing.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,X-OpenWork-Host-Token,x-opencode-directory,x-opencode-workspace",
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // listWorkspaces → GET /workspaces (client expects { items: [...] })
  app.get("/workspaces", (_req, res) => {
    res.json({ items: workspaces, activeId: activeWorkspaceId });
  });

  // createLocalWorkspace → POST /workspaces/local
  app.post("/workspaces/local", (req: Request, res: Response) => {
    const body = req.body as { folderPath?: string; name?: string };
    const wsPath = body.folderPath || "/";
    const id = `openhub-${Date.now()}`;
    const name = body.name || wsPath.split("/").pop() || "workspace";
    const entry: WorkspaceEntry = {
      id,
      name,
      path: wsPath,
      preset: "default",
      workspaceType: "local",
      displayName: name,
    };
    workspaces.push(entry);
    activeWorkspaceId = id;
    res.json({
      selectedId: id,
      activeId: id,
      workspaces: [entry],
    });
  });

  // createRemoteWorkspace → POST /workspaces/remote
  app.post("/workspaces/remote", (req: Request, res: Response) => {
    const body = req.body as { baseUrl?: string; name?: string };
    const id = `openhub-${Date.now()}`;
    const entry: WorkspaceEntry = {
      id,
      name: body.name || "remote",
      path: body.baseUrl || "/",
      preset: "default",
      workspaceType: "remote",
      displayName: body.name || "remote",
    };
    workspaces.push(entry);
    activeWorkspaceId = id;
    res.json({
      selectedId: id,
      activeId: id,
      workspaces: [entry],
    });
  });

  app.post(/^\/workspaces\/[^/]+\/activate/, (req, res) => {
    const id = req.path.split("/")[2] ?? "";
    activeWorkspaceId = id;
    res.json({ ok: true });
  });
  app.put(/^\/workspaces\/[^/]+\/display-name$/, (req, res) => {
    const id = req.path.split("/")[2] ?? "";
    const body = req.body as { displayName?: string };
    const ws = workspaces.find((w) => w.id === id);
    if (ws && body.displayName) {
      // Return new object to avoid mutation of the array entry itself —
      // the array reference stays stable, the entry is replaced.
      const idx = workspaces.indexOf(ws);
      workspaces[idx] = { ...ws, displayName: body.displayName, name: body.displayName };
    }
    res.json({ ok: true });
  });
  app.delete(/^\/workspaces\/[^/]+$/, (req, res) => {
    const id = req.path.split("/")[2] ?? "";
    const idx = workspaces.findIndex((w) => w.id === id);
    if (idx >= 0) workspaces.splice(idx, 1);
    if (activeWorkspaceId === id) activeWorkspaceId = workspaces[0]?.id ?? null;
    res.json({ ok: true });
  });

  // ── Reverse proxy: /workspace/:id/opencode/* → opencode on :4096 ──
  // OpenWork's session view creates an opencode SDK client at
  // <serverBaseUrl>/workspace/<id>/opencode — we strip the prefix and
  // forward to the actual opencode server. Uses raw http.request so
  // SSE streams pass through without buffering.
  const OPENCODE_PORT = 4096;
  const PROMPT_PATH_RE = /^\/session\/[^/]+\/(message|prompt_async)$/;

  async function injectProjectSystem(
    body: Record<string, unknown>,
    upstreamPath: string,
  ): Promise<Record<string, unknown>> {
    if (!PROMPT_PATH_RE.test(upstreamPath)) return body;
    if (body.system) return body;
    const project = await getActiveProject();
    if (!project?.instructions) return body;
    return { ...body, system: project.instructions };
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    const match = req.path.match(/^\/workspace\/[^/]+\/opencode(\/.*)?$/);
    if (!match) {
      next();
      return;
    }
    const upstreamPath = match[1] || "/";
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const isSSE = /\/(event|stream)\b/.test(upstreamPath);
    if (!isSSE) {
      console.warn(`[proxy→opencode] ${req.method} ${upstreamPath}${qs}`);
    }

    // SSE streams must not time out
    if (isSSE) {
      req.socket.setTimeout(0);
      res.socket?.setTimeout(0);
    }

    // Strip browser-specific headers to avoid confusing opencode's CORS logic
    const fwdHeaders: Record<string, string | string[] | undefined> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (key === "host" || key === "origin" || key === "referer") continue;
      fwdHeaders[key] = val;
    }
    fwdHeaders["host"] = `127.0.0.1:${OPENCODE_PORT}`;

    const forward = (bodyJson: string | null) => {
      const outHeaders = { ...fwdHeaders };
      if (bodyJson) {
        outHeaders["content-length"] = String(Buffer.byteLength(bodyJson));
      }
      const proxyReq = httpRequest(
        {
          hostname: "127.0.0.1",
          port: OPENCODE_PORT,
          path: `${upstreamPath}${qs}`,
          method: req.method,
          headers: outHeaders,
        },
        (proxyRes) => {
          const upstreamHeaders = proxyRes.headers;
          for (const [key, val] of Object.entries(upstreamHeaders)) {
            if (!val) continue;
            if (key.toLowerCase().startsWith("access-control-")) continue;
            res.setHeader(key, val);
          }
          if (isSSE) {
            res.removeHeader("Keep-Alive");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("Cache-Control", "no-cache, no-transform");
            res.setHeader("X-Accel-Buffering", "no");
          }
          res.writeHead(proxyRes.statusCode ?? 502);
          if (isSSE) res.flushHeaders();
          proxyRes.pipe(res);
        },
      );
      proxyReq.on("error", (err) => {
        if (!isSSE) console.error(`[proxy→opencode] ERROR ${upstreamPath}:`, err.message);
        if (!res.headersSent) {
          res.status(502).json({ error: "opencode not reachable" });
        }
      });
      res.on("close", () => proxyReq.destroy());

      if (bodyJson) {
        proxyReq.end(bodyJson);
      } else {
        req.pipe(proxyReq);
      }
    };

    if (req.body && req.method !== "GET" && req.method !== "HEAD") {
      void injectProjectSystem(req.body as Record<string, unknown>, upstreamPath)
        .then((body) => forward(JSON.stringify(body)))
        .catch(() => forward(JSON.stringify(req.body)));
    } else {
      forward(null);
    }
  });

  // Session list: proxy to opencode /session with ?directory= from workspace path.
  // Opencode only returns sessions matching the directory parameter; without it
  // it defaults to its own cwd and misses sessions from other workspaces.
  app.get(/^\/workspace\/[^/]+\/sessions$/, (req: Request, res: Response) => {
    const workspaceId = req.path.split("/")[2] ?? "";
    const ws = workspaces.find((w) => w.id === workspaceId);
    // For the default "openhub-default" workspace (from IPC, not in workspaces[]),
    // look up the bootstrap path
    const wsPath = ws?.path ?? "";

    void (async () => {
      try {
        const params = new URLSearchParams();
        if (wsPath) params.set("directory", wsPath);
        // Forward any limit/search params from the original request
        const origParams = new URL(req.url, "http://localhost").searchParams;
        for (const [k, v] of origParams) {
          if (!params.has(k)) params.set(k, v);
        }
        const qs = params.size ? `?${params.toString()}` : "";
        const sRes = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/session${qs}`);
        const raw = (await sRes.json()) as unknown[];
        res.json({ items: Array.isArray(raw) ? raw : [] });
      } catch {
        res.json({ items: [] });
      }
    })();
  });

  // Single session + snapshot + messages: proxy to opencode with format adaptation
  app.get(
    /^\/workspace\/[^/]+\/sessions\/([^/]+)(\/.*)?$/,
    (req: Request, res: Response) => {
      const sessionId = req.path.match(/\/sessions\/([^/]+)/)?.[1] ?? "";
      const suffix = req.path.match(/\/sessions\/[^/]+(\/.*)?$/)?.[1] ?? "";

      if (suffix === "/snapshot" || suffix?.startsWith("/snapshot")) {
        void (async () => {
          try {
            const base = `http://127.0.0.1:${OPENCODE_PORT}`;
            const [sRes, mRes, tRes] = await Promise.all([
              fetch(`${base}/session/${sessionId}`),
              fetch(`${base}/session/${sessionId}/message`),
              fetch(`${base}/session/${sessionId}/todo`),
            ]);
            if (!sRes.ok) {
              res
                .status(sRes.status)
                .json({ code: "not_found", message: "session not found" });
              return;
            }
            const session = (await sRes.json()) as Record<string, unknown>;
            const rawMessages = (await mRes.json().catch(() => [])) as unknown[];
            const todos = (await tRes.json().catch(() => [])) as unknown[];
            // Wrap each message as { info: message, parts: [] } if not already wrapped
            const messages = Array.isArray(rawMessages)
              ? rawMessages.map((m: unknown) => {
                  const msg = m as Record<string, unknown>;
                  return msg.info
                    ? msg
                    : { info: msg, parts: Array.isArray(msg.parts) ? msg.parts : [] };
                })
              : [];
            res.json({
              item: {
                session,
                messages,
                todos: Array.isArray(todos) ? todos : [],
                status: { active: false },
              },
            });
          } catch {
            res
              .status(502)
              .json({ code: "upstream_error", message: "opencode unavailable" });
          }
        })();
        return;
      }

      if (suffix === "/messages" || suffix?.startsWith("/messages")) {
        void (async () => {
          try {
            const mRes = await fetch(
              `http://127.0.0.1:${OPENCODE_PORT}/session/${sessionId}/message`,
            );
            const rawMessages = (await mRes.json().catch(() => [])) as unknown[];
            const messages = Array.isArray(rawMessages)
              ? rawMessages.map((m: unknown) => {
                  const msg = m as Record<string, unknown>;
                  return msg.info
                    ? msg
                    : { info: msg, parts: Array.isArray(msg.parts) ? msg.parts : [] };
                })
              : [];
            res.json({ items: messages });
          } catch {
            res.json({ items: [] });
          }
        })();
        return;
      }

      // Single session GET
      void (async () => {
        try {
          const sRes = await fetch(
            `http://127.0.0.1:${OPENCODE_PORT}/session/${sessionId}`,
          );
          if (!sRes.ok) {
            res
              .status(sRes.status)
              .json({ code: "not_found", message: "session not found" });
            return;
          }
          const session = await sRes.json();
          res.json({ item: session });
        } catch {
          res
            .status(502)
            .json({ code: "upstream_error", message: "opencode unavailable" });
        }
      })();
    },
  );

  // Catch-all for other /workspace/:id/* sub-routes
  app.all(/^\/workspace\/[^/]+\//, (_req, res) => {
    res.json({ items: [], ok: true });
  });

  // ── OpenWork server compatibility endpoints ──
  app.get("/status", (_req, res) =>
    res.json({ running: true, version: "openhub", uptimeMs: process.uptime() * 1000 }),
  );
  app.get("/health", (_req, res) =>
    res.json({ ok: true, version: "openhub", uptimeMs: process.uptime() * 1000 }),
  );
  app.get("/capabilities", (_req, res) =>
    res.json({
      skills: { read: true, write: false },
      plugins: { read: true, write: false },
      extensions: false,
    }),
  );
  app.get("/runtime/versions", (_req, res) =>
    res.json({ runtime: "openhub", versions: {} }),
  );

  // ── Cache Metrics endpoints (no auth — called by sidebar) ──
  app.get("/v1/cache/metrics", (_req, res) => {
    res.json(getCacheMetrics());
  });
  app.post("/v1/cache/reset", (_req, res) => {
    resetCacheMetrics();
    res.json({ ok: true });
  });

  // ── Auth middleware for LLM proxy routes ──
  // Accept both the proxy session token (for LLM calls) and "openhub-local"
  // (hardcoded token OpenWork receives via openworkServerInfo IPC).
  const OPENWORK_LOCAL_TOKEN = "openhub-local";
  app.use((req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers["authorization"] ?? "";
    if (!auth.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const token = auth.slice(7);
    if (token !== sessionToken && token !== OPENWORK_LOCAL_TOKEN) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  // ── In-memory selected models ──
  let selectedModelIds: string[] = [];
  try {
    const configPath = path.join(homedir(), ".config", "opencode", "opencode.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const providers = cfg.provider as Record<string, unknown> | undefined;
    const ohub = providers?.openhub as Record<string, unknown> | undefined;
    if (ohub?.models) {
      selectedModelIds = Object.keys(ohub.models as Record<string, unknown>);
    }
  } catch { /* no persisted config yet */ }

  app.get("/v1/models", async (_req, res) => {
    const keys = await readAllApiKeys();
    const all = await buildModelList(keys);
    if (selectedModelIds.length > 0) {
      const filtered = all.filter(m => selectedModelIds.includes(m.id));
      res.json({ object: "list", data: filtered });
    } else {
      res.json({ object: "list", data: all });
    }
  });

  app.get("/v1/models/full", async (_req, res) => {
    const keys = await readAllApiKeys();
    const catalog = getFullModelCatalog();

    const orModels = keys.openrouterKey
      ? await fetchOpenRouterModels(keys.openrouterKey)
      : [];
    const catalogIds = new Set(catalog.map(c => c.id));
    for (const m of orModels) {
      if (!catalogIds.has(m.id)) {
        catalog.push({ id: m.id, object: "model", source: "openrouter" });
      }
    }

    res.json({ object: "list", data: catalog });
  });

  let cachedSelectedModels: string[] | null = null;
  let selectedModelsExpiry = 0;

  app.get("/v1/models/selected", async (_req, res) => {
    const now = Date.now();
    if (!cachedSelectedModels || now > selectedModelsExpiry) {
      try {
        const configPath = path.join(homedir(), ".config", "opencode", "opencode.json");
        const raw = await fs.readFile(configPath, "utf-8");
        const cfg = JSON.parse(raw) as Record<string, unknown>;
        const providers = cfg.provider as Record<string, unknown> | undefined;
        const ohub = providers?.openhub as Record<string, unknown> | undefined;
        if (ohub?.models) {
          cachedSelectedModels = Object.keys(ohub.models as Record<string, unknown>);
        } else {
          cachedSelectedModels = [];
        }
      } catch {
        cachedSelectedModels = [];
      }
      selectedModelsExpiry = now + 30_000;
    }
    res.json({ selectedModels: cachedSelectedModels });
  });

  app.post("/v1/models/selected", async (req: Request, res: Response) => {
    try {
      const body = req.body as { models?: string[] };
      selectedModelIds = body.models ?? [];
      cachedSelectedModels = selectedModelIds;
      selectedModelsExpiry = Date.now() + 30_000;

      // Persist to opencode.json as the openhub provider model list
      const configPath = path.join(homedir(), ".config", "opencode", "opencode.json");
      let config: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(configPath, "utf-8");
        config = JSON.parse(raw);
      } catch { /* create fresh */ }

      const providers = (config.provider ?? {}) as Record<string, unknown>;
      const ohub = (providers.openhub ?? {}) as Record<string, unknown>;

      const newModels: Record<string, unknown> = {};
      for (const id of selectedModelIds) {
        newModels[id] = {};
      }
      ohub.models = newModels;
      providers.openhub = ohub;
      config.provider = providers;

      await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
      res.json({ ok: true });
    } catch (err) {
      console.error("[proxy] Failed to save selected models:", err);
      res.status(500).json({ error: "Failed to save selected models" });
    }
  });

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    try {
      const keys = await readAllApiKeys();
      const { model, bypassInjection, ...rest } = req.body as {
        model: string;
        bypassInjection?: boolean;
        [k: string]: unknown;
      };
      const route = resolveRoute(model, keys);
      const { targetUrl, headers, model: upstreamModel, provider } = route;

      let messages = rest.messages as Array<{ role: string; content: string }> | undefined;

      if (messages && !bypassInjection) {
        // ── 0. Élagage intelligent du contexte ──
        // Si la conversation dépasse 90 000 tokens estimés, on supprime les
        // messages les plus anciens du milieu en conservant système + échanges
        // récents (les 5 premiers et les 15 derniers messages non-système).
        const ESTIMATED_TOKEN_LIMIT = 90_000;
        let totalTokens = 0;
        for (const m of messages) {
          totalTokens += Math.ceil((m.content || "").length / 3.5);
        }
        if (totalTokens > ESTIMATED_TOKEN_LIMIT) {
          const nonSystemMsgs = messages.filter((m) => m.role !== "system");
          const systemMsgs = messages.filter((m) => m.role === "system");
          const keepFirst = 5;
          const keepLast = 15;
          if (nonSystemMsgs.length > keepFirst + keepLast) {
            const pruned = [
              ...nonSystemMsgs.slice(0, keepFirst),
              ...nonSystemMsgs.slice(-keepLast),
            ];
            messages = [...systemMsgs, ...pruned];
            const prunedTokens = Math.ceil(
              messages.reduce((acc, m) => acc + (m.content || "").length, 0) / 3.5,
            );
            console.warn(
              `[proxy] Contexte élagué : ${totalTokens} → ${prunedTokens} tokens estimés (supprimé ${nonSystemMsgs.length - keepFirst - keepLast} messages du milieu)`,
            );
            rest.messages = messages;
          }
        }

        // ── 1. Démêlage du prompt système principal ──
        let mainSystemContent = messages.find((m) => m.role === "system")?.content || "";
        
        // Séparer les blocs : Comportement (Stable) vs Données Projet (Variable)
        const splitMarkers = [
          "You are powered by the model named",
          "Here is some useful information about the environment",
          "Instructions from:"
        ];
        
        let coreBehavior = mainSystemContent;
        let extractedGraphify = "";

        // Extraction du Graphify s'il est déjà présent dans le prompt
        const graphifyMatch = mainSystemContent.match(/Instructions from:.*?graphify-out\/GRAPH_REPORT\.md\n([\s\S]*?)(?=\nInstructions from:|$)/);
        if (graphifyMatch) {
          extractedGraphify = graphifyMatch[1].trim();
        }

        // Nettoyage : On ne garde que les règles de base (Tone, Style, Rules)
        for (const marker of splitMarkers) {
          const idx = coreBehavior.indexOf(marker);
          if (idx >= 0) coreBehavior = coreBehavior.slice(0, idx).trim();
        }

        // ── 2. Préparation des blocs de contexte gelés ──
        const project = await getActiveProject();
        const projInstructions = project?.instructions || "";
        
        // Extraire le message utilisateur pour la détection intelligente de mots-clés
        const lastUserContent = messages.filter((m) => m.role === "user").pop()?.content || "";
        const memBlock = await buildMemoryBlock(lastUserContent);

        // Lire AGENT-MEMORY.md et tenter de lire Graphify sur disque si absent du prompt
        let agentMemory = "";
        try {
          const workspaceDir = getActiveWorkspaceDir();
          const agentMemPath = path.join(workspaceDir, "AGENT-MEMORY.md");
          agentMemory = await fs.readFile(agentMemPath, "utf-8");
          
          if (!extractedGraphify) {
            const graphPath = path.join(workspaceDir, "graphify-out", "GRAPH_REPORT.md");
            extractedGraphify = await fs.readFile(graphPath, "utf-8");
          }
        } catch { /* ignore reading errors */ }

        // ── 4. Assembler les messages système (Stable Prefix Strategy) ──
        // HIÉRARCHIE : Stable (Main) -> Stable/Lourd (Graphify) -> Semi-stable (Project) -> Stable (Date) -> Mutant (Memory)
        // On place les blocs les plus lourds et stables en haut.
        const structuredSystem = [
          { role: "system", content: coreBehavior.trim() }, // 1. Règles de base
          { role: "system", content: extractedGraphify ? `[KNOWLEDGE GRAPH]\n${extractedGraphify.trim()}` : "" }, // 2. LE LOURD (Frozen)
          { role: "system", content: projInstructions.trim() }, // 3. Instructions Projet
          { role: "system", content: `Today's date: ${new Date().toISOString().split("T")[0]}` }, // 4. Date (24h)
          { role: "system", content: agentMemory ? `[PROJECT MEMORY]\n${agentMemory.trim()}` : "" }, // 5. Notes de fin de tâche
          { role: "system", content: memBlock ? memBlock.trim() : "" }, // 6. Mots-clés (Mutant ultime)
        ].filter(m => m.content !== "");

        // ── 5. Réinjecter sans toucher à l'historique utilisateur ──
        const conversationMessages = messages.filter((m) => m.role !== "system");
        
        messages = [...structuredSystem, ...conversationMessages];
        rest.messages = messages;
      }

      // Estimate prompt tokens AFTER injection (for cache metrics)
      const finalMessages = rest.messages as Array<{ role: string; content: string }> | undefined;
      let estimatedSystemTokens = 0;
      let estimatedNonSystemTokens = 0;
      if (finalMessages) {
        for (const m of finalMessages) {
          const t = Math.ceil((m.content || "").length / 3.5);
          if (m.role === "system") estimatedSystemTokens += t;
          else estimatedNonSystemTokens += t;
        }
      }

      // ── Google Gemini: get OAuth token + wrap in Cloud Code Assist format ──
      let geminiBody: string | null = null;
      if (provider === "gemini") {
        const googleAuth = await getGoogleAuth();
        if (!googleAuth) {
          res.status(401).json({ error: "Google OAuth token not available — run 'opencode auth login' first" });
          return;
        }
        headers["Authorization"] = `Bearer ${googleAuth.accessToken}`;

        const finalMsgs = (rest.messages ?? []) as Array<{ role: string; content: string }>;
        const geminiModel = upstreamModel ?? model.replace("google/", "");
        const { contents, systemInstruction } = convertOpenAIToGemini(finalMsgs);
        const innerRequest: Record<string, unknown> = {
          contents,
          generationConfig: {
            temperature: (rest.temperature as number) ?? 0.7,
            maxOutputTokens: (rest.max_tokens as number) ?? 8192,
          },
        };
        if (systemInstruction) innerRequest.systemInstruction = systemInstruction;

        const cloudCodeAssistBody = {
          project: googleAuth.managedProjectId,
          model: geminiModel,
          user_prompt_id: randomBytes(16).toString("hex"),
          request: innerRequest,
        };
        geminiBody = JSON.stringify(cloudCodeAssistBody);
      }

      const upstream = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: geminiBody ?? JSON.stringify({ model: upstreamModel ?? model, ...rest }),
      });

      // ── 4. Vérification immédiate du statut upstream ──
      // Si le provider renvoie une erreur (400, 429, 500…), on transmet
      // l'erreur réelle au lieu de tenter de lire un stream inexistant.
      if (upstream.status !== 200) {
        const errorText = await upstream.text();
        console.error(`[proxy] Erreur Upstream ${upstream.status}:`, errorText);
        res.status(upstream.status);
        res.setHeader("Content-Type", "application/json");
        try {
          const parsed = JSON.parse(errorText);
          res.json(parsed);
        } catch {
          res.send(errorText);
        }
        return;
      }

      res.status(upstream.status);
      if (provider !== "gemini") {
        upstream.headers.forEach((v, k) => res.setHeader(k, v));
      }

      const clientStreaming = (rest.stream as boolean) ?? true;

      // ── 5. Stream Interception (Maintenance & Prefix Stability) ──
      // On lit le stream pour accumuler la réponse et lancer la maintenance en arrière-plan
      // SANS bloquer l'envoi du signal [DONE] au client.
      const reader = upstream.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }

      const decoder = new TextDecoder();
      let fullResponseContent = "";
      let responseUsage: Record<string, number> | null = null;

      if (provider === "gemini") {
        // Gemini native SSE → OpenAI SSE conversion
        let buffer = "";
        const accumulatedChunks: string[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const converted = convertGeminiChunkToOpenAI(trimmed);
            if (!converted) continue;

            const match = converted.match(/data: (.+)/);
            if (match) {
              try {
                const parsed = JSON.parse(match[1]);
                const delta = parsed.choices?.[0]?.delta?.content || "";
                fullResponseContent += delta;
                if (parsed.usage) {
                  responseUsage = parsed.usage;
                }
              } catch { /* ignore */ }
            }

            if (clientStreaming) {
              res.write(converted);
            } else {
              accumulatedChunks.push(converted);
            }
          }
        }

        if (clientStreaming) {
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          // Non-streaming: reconstruct the full OpenAI response from accumulated chunks
          let fullContent = "";
          let finalUsage: Record<string, number> | null = null;
          for (const ch of accumulatedChunks) {
            const m = ch.match(/data: (.+)/);
            if (m) {
              try {
                const p = JSON.parse(m[1]);
                if (p.choices?.[0]?.delta?.content) {
                  fullContent += p.choices[0].delta.content;
                }
                if (p.usage) finalUsage = p.usage;
              } catch { /* ignore */ }
            }
          }
          const response: Record<string, unknown> = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: upstreamModel ?? model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: fullContent || fullResponseContent },
              finish_reason: "stop",
              logprobs: null,
            }],
          };
          if (finalUsage) response.usage = finalUsage;
          res.setHeader("Content-Type", "application/json");
          res.json(response);
        }
      } else {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          res.write(value);

          // Accumulation asynchrone pour la mémoire
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              if (payload === "[DONE]") continue;
              try {
                const parsed = JSON.parse(payload);
                if (parsed.usage) {
                  responseUsage = parsed.usage;
                }
                const delta = parsed.choices?.[0]?.delta?.content || "";
                fullResponseContent += delta;
              } catch { /* ignore parsing errors */ }
            }
          }
        }

        res.end();
      }

      // ── 6. Enregistrement des métriques de cache ──
      const wsName = workspaces.find((w) => w.id === activeWorkspaceId)?.name || "default";
      const usage = responseUsage ?? {};
      const upstreamCached = usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? 0;
      const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
      const total_est = estimatedSystemTokens + estimatedNonSystemTokens || 1;
      const actualSystemTokens = promptTokens
        ? Math.round(promptTokens * (estimatedSystemTokens / total_est))
        : estimatedSystemTokens;
      const actualNonSystemTokens = promptTokens
        ? Math.round(promptTokens * (estimatedNonSystemTokens / total_est))
        : estimatedNonSystemTokens;
      recordCacheMetric(model, wsName, actualSystemTokens, actualNonSystemTokens, upstreamCached);

      // Lancer la maintenance en tâche de fond (Fire-and-forget)
      // Cela évite d'invalider le cache de la requête actuelle ou de faire ramer le client.
      if (fullResponseContent && messages) {
        void triggerAutoExtraction(messages, fullResponseContent);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause ? ` | cause: ${err.cause}` : "";
      // Détection du type d'erreur pour un diagnostic précis
      let errorType = "upstream_error";
      if (msg.includes("fetch") || msg.includes("network") || msg.includes("ENOTFOUND") || msg.includes("ECONNREFUSED")) {
        errorType = "network_error";
      } else if (msg.includes("timeout") || msg.includes("Timeout") || msg.includes("abort")) {
        errorType = "provider_timeout";
      } else if (msg.includes("token") || msg.includes("context_length") || msg.includes("max_tokens")) {
        errorType = "token_limit_exceeded";
      } else if (msg.includes("rate") || msg.includes("quota") || msg.includes("429")) {
        errorType = "rate_limited";
      }
      console.error(`[proxy] ${errorType}:`, msg, cause);
      res.status(502).json({ error: `Bad gateway — ${errorType}` });
    }
  });

  await new Promise<void>((resolve) => {
    const server = app.listen(PROXY_PORT, PROXY_HOST, () => resolve());
    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.warn(`[proxy] Port ${PROXY_PORT} in use, assuming ghost proxy is ok.`);
        resolve();
      } else {
        console.error("[proxy] server error:", err);
        resolve();
      }
    });
  });

  console.warn(`[proxy] listening on ${PROXY_HOST}:${PROXY_PORT}`);
  return sessionToken;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const GEMINI_TO_OPENROUTER: Record<string, string> = {
  "gemini-3-flash-preview": "google/gemini-3-flash-preview",
  "gemini-3-pro-preview": "google/gemini-3-pro-preview",
  "gemini-3.1-pro-preview": "google/gemini-3.1-pro-preview",
  "gemini-3.5-flash": "google/gemini-3.5-flash",
  "gemini-2.5-pro": "google/gemini-2.5-pro",
  "gemini-2.5-flash": "google/gemini-2.5-flash",
};

// ── Google Gemini direct route (via OAuth) ──

const GEMINI_DIRECT_MODELS = new Set([
  "google/gemini-3-flash-preview",
  "google/gemini-3-pro-preview",
  "google/gemini-3.1-pro-preview",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
]);

const GEMINI_MODEL_NAME_MAP: Record<string, string> = {
  "google/gemini-3-flash-preview": "gemini-3-flash-preview",
  "google/gemini-3-pro-preview": "gemini-3-pro-preview",
  "google/gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
  "google/gemini-2.5-pro": "gemini-2.5-pro",
  "google/gemini-2.5-flash": "gemini-2.5-flash",
};

const GEMINI_API_BASE = "https://cloudcode-pa.googleapis.com";

type GoogleAuth = { accessToken: string; managedProjectId: string } | null;

async function getGoogleAuth(): Promise<GoogleAuth> {
  try {
    const accountPath = path.join(homedir(), ".local", "share", "opencode", "account.json");
    const raw = await fs.readFile(accountPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      accounts?: Record<string, {
        credential?: {
          access?: string;
          expires?: number;
          refresh?: string;
          type?: string;
        };
      }>;
      active?: { google?: string };
    };
    const activeId = parsed.active?.google;
    if (!activeId || !parsed.accounts?.[activeId]?.credential) return null;

    const cred = parsed.accounts[activeId].credential;

    // Extract managed project ID from refresh token format: refreshToken|project|managedProject
    const parts = (cred.refresh ?? "").split("|");
    const managedProjectId = parts[2] || parts[1] || "";

    let accessToken = cred.access ?? null;
    if (accessToken && cred.expires && cred.expires < Date.now()) {
      accessToken = null; // expired, force refresh
    }

    if (!accessToken && cred.refresh && cred.type === "oauth") {
      const newToken = await refreshGoogleToken(cred.refresh);
      if (newToken) accessToken = newToken;
    }

    return accessToken ? { accessToken, managedProjectId } : null;
  } catch {
    return null;
  }
}

const GEMINI_OAUTH_CLIENT_ID = "***REMOVED-CLIENT-ID***";

async function refreshGoogleToken(refreshToken: string): Promise<string | null> {
  try {
    // Extract the actual refresh token (strip project suffix after | separator)
    const actualToken = refreshToken.split("|")[0];
    const clientSecret = await readSecret("openhub", "google-oauth-client-secret")
      ?? (typeof process !== "undefined" ? process.env.GEMINI_OAUTH_CLIENT_SECRET : null)
      ?? "";

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GEMINI_OAUTH_CLIENT_ID,
        client_secret: clientSecret,
        refresh_token: actualToken,
        grant_type: "refresh_token",
      }),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    // Update account.json with new access token and expiry
    try {
      const accountPath = path.join(homedir(), ".local", "share", "opencode", "account.json");
      const raw = await fs.readFile(accountPath, "utf-8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const accounts = cfg.accounts as Record<string, { credential?: Record<string, unknown> }> | undefined;
      const activeId = (cfg.active as Record<string, string> | undefined)?.google;
      if (activeId && accounts?.[activeId]?.credential) {
        accounts[activeId].credential.access = data.access_token;
        accounts[activeId].credential.expires = Date.now() + (data.expires_in ?? 3600) * 1000;
        await fs.writeFile(accountPath, JSON.stringify(cfg, null, 2), "utf-8");
      }
    } catch { /* non-critical */ }

    return data.access_token;
  } catch {
    return null;
  }
}

function convertOpenAIToGemini(
  messages: Array<{ role: string; content: string }>,
): { contents: Array<{ role: string; parts: Array<{ text: string }> }>; systemInstruction?: { parts: Array<{ text: string }> } } {
  const systemMsgs = messages.filter(m => m.role === "system");
  const nonSystemMsgs = messages.filter(m => m.role !== "system");

  const systemInstruction = systemMsgs.length > 0
    ? { parts: systemMsgs.map(m => ({ text: m.content })) }
    : undefined;

  const contents = nonSystemMsgs.map(m => {
    let role = m.role;
    if (role === "assistant") role = "model";
    return { role, parts: [{ text: m.content }] };
  });

  return { contents, systemInstruction };
}

function convertGeminiChunkToOpenAI(
  chunk: string,
): string | null {
  if (!chunk.startsWith("data:")) return null;
  const payload = chunk.slice(5).trim();
  if (!payload) return null;

  try {
    let gemini = JSON.parse(payload);
    // Cloud Code Assist wraps responses in a "response" envelope
    if (gemini.response) gemini = gemini.response;
    const candidate = gemini.candidates?.[0];
    if (!candidate) return null;

    const text = candidate.content?.parts?.[0]?.text || "";
    const rawFinish = candidate.finishReason || null;
    const usage = gemini.usageMetadata;

    let finishReason: string | null = null;
    if (rawFinish) {
      if (rawFinish === "STOP") finishReason = "stop";
      else if (rawFinish === "MAX_TOKENS") finishReason = "length";
      else finishReason = rawFinish.toLowerCase();
    }

    const openai: Record<string, unknown> = {
      choices: [{
        index: 0,
        delta: text ? { content: text } : {},
        finish_reason: finishReason,
        logprobs: null,
      }],
    };

    if (usage) {
      openai.usage = {
        prompt_tokens: usage.promptTokenCount ?? 0,
        completion_tokens: usage.candidatesTokenCount ?? 0,
        total_tokens: usage.totalTokenCount ?? 0,
      };
    }

    return `data: ${JSON.stringify(openai)}\n\n`;
  } catch {
    return null;
  }
}

function resolveRoute(
  model: string,
  keys: Awaited<ReturnType<typeof readAllApiKeys>>,
): { targetUrl: string; headers: Record<string, string>; model?: string; provider: string } {
  // Google Gemini direct route (via OAuth — uses Cloud Code Assist API)
  if (GEMINI_DIRECT_MODELS.has(model)) {
    const geminiModel = GEMINI_MODEL_NAME_MAP[model] ?? model.replace("google/", "");
    return {
      targetUrl: `${GEMINI_API_BASE}/v1internal:streamGenerateContent?alt=sse`,
      headers: { "Content-Type": "application/json" },
      model: geminiModel,
      provider: "gemini",
    };
  }

  // OpenRouter models use provider/model-name format
  const orModel = GEMINI_TO_OPENROUTER[model];
  if (orModel && keys.openrouterKey) {
    return {
      targetUrl: `${OPENROUTER_BASE}/chat/completions`,
      headers: { Authorization: `Bearer ${keys.openrouterKey}` },
      model: orModel,
      provider: "openai",
    };
  }
  if (model.includes("/") && keys.openrouterKey) {
    return {
      targetUrl: `${OPENROUTER_BASE}/chat/completions`,
      headers: { Authorization: `Bearer ${keys.openrouterKey}` },
      provider: "openai",
    };
  }
  if (model.startsWith("claude-")) {
    return {
      targetUrl: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": keys.anthropic ?? "", "anthropic-version": "2023-06-01" },
      provider: "anthropic",
    };
  }
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) {
    return {
      targetUrl: "https://api.openai.com/v1/chat/completions",
      headers: { Authorization: `Bearer ${keys.openai ?? ""}` },
      provider: "openai",
    };
  }
  return { targetUrl: `${keys.ollamaUrl}/v1/chat/completions`, headers: {}, provider: "ollama" };
}

// Cache OpenRouter model list for 5 minutes to avoid hammering their API
let orModelCache: Array<{ id: string; object: string }> | null = null;
let orModelCacheExpiry = 0;

async function fetchOpenRouterModels(
  apiKey: string,
): Promise<Array<{ id: string; object: string }>> {
  const now = Date.now();
  if (orModelCache && now < orModelCacheExpiry) return orModelCache;

  try {
    const res = await fetch(`${OPENROUTER_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(4000), // Timeout plus agressif (4s)
    });
    if (!res.ok) return orModelCache ?? [];
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const list = (data.data ?? []).map((m) => ({ id: m.id, object: "model" }));
    orModelCache = list;
    orModelCacheExpiry = now + 5 * 60 * 1000;
    return list;
  } catch {
    return orModelCache ?? [];
  }
}

function getFullModelCatalog(): Array<{ id: string; object: string; source: string }> {
  return [
    { id: "claude-sonnet-4-6", object: "model", source: "direct" },
    { id: "claude-opus-4-6", object: "model", source: "direct" },
    { id: "claude-haiku-4-5", object: "model", source: "direct" },
    { id: "gpt-4o", object: "model", source: "direct" },
    { id: "gpt-4o-mini", object: "model", source: "direct" },
    { id: "o3-mini", object: "model", source: "direct" },
    { id: "google/gemini-3-flash-preview", object: "model", source: "gemini" },
    { id: "google/gemini-3-pro-preview", object: "model", source: "gemini" },
    { id: "google/gemini-3.1-pro-preview", object: "model", source: "gemini" },
    { id: "google/gemini-2.5-pro", object: "model", source: "gemini" },
    { id: "google/gemini-2.5-flash", object: "model", source: "gemini" },
    { id: "anthropic/claude-opus-4", object: "model", source: "openrouter" },
    { id: "anthropic/claude-sonnet-4-5", object: "model", source: "openrouter" },
    { id: "openai/gpt-4o", object: "model", source: "openrouter" },
    { id: "deepseek/deepseek-r1", object: "model", source: "openrouter" },
    { id: "deepseek/deepseek-v4-pro", object: "model", source: "openrouter" },
    { id: "deepseek/deepseek-v4-flash", object: "model", source: "openrouter" },
    { id: "meta-llama/llama-3.3-70b-instruct", object: "model", source: "openrouter" },
    { id: "llama3", object: "model", source: "local" },
    { id: "mistral", object: "model", source: "local" },
  ];
}

async function buildModelList(
  keys: Awaited<ReturnType<typeof readAllApiKeys>>,
): Promise<Array<{ id: string; object: string; source: string }>> {
  const catalog = getFullModelCatalog();
  const catalogIds = new Set(catalog.map(c => c.id));

  const available: Array<{ id: string; object: string; source: string }> = [];

  for (const m of catalog) {
    if (m.source === "direct") {
      const isAnthropic = m.id.startsWith("claude-") && !m.id.includes("/");
      const isOpenAI = m.id.startsWith("gpt-") || m.id.startsWith("o1") || m.id.startsWith("o3");
      if (isAnthropic && !keys.anthropic) continue;
      if (isOpenAI && !keys.openai) continue;
      available.push(m);
    } else if (m.source === "gemini") {
      available.push(m);
    } else if (m.source === "openrouter") {
      if (!keys.openrouterKey) continue;
      available.push(m);
    } else {
      // local, workflow — always available
      available.push(m);
    }
  }

  // Add dynamic OpenRouter models not already in the catalog
  if (keys.openrouterKey) {
    const orModels = await fetchOpenRouterModels(keys.openrouterKey);
    for (const m of orModels) {
      if (!catalogIds.has(m.id)) {
        available.push({ ...m, source: "openrouter" });
      }
    }
  }

  return available;
}

/**
 * Appelle un modèle LLM en interne (utilisé pour la maintenance/extraction)
 * avec protection contre la récursion.
 */
async function callModel(
  model: string,
  messages: Array<{ role: string; content: string }>,
  keys: Awaited<ReturnType<typeof readAllApiKeys>>,
): Promise<string> {
  const { targetUrl, headers, model: upstreamModel } = resolveRoute(model, keys);
  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        model: upstreamModel ?? model,
        messages,
        temperature: 0.1,
        bypassInjection: true, // Évite la récursion infinie
      }),
    });
    if (!res.ok) return "";
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? "";
  } catch {
    return "";
  }
}

/**
 * Analyse la réponse et met à jour AGENT-MEMORY.md si nécessaire.
 * S'exécute en tâche de fond pour ne pas impacter la latence utilisateur.
 */
async function triggerAutoExtraction(
  history: Array<{ role: string; content: string }>,
  assistantResponse: string,
) {
  try {
    const keys = await readAllApiKeys();
    const lastUserMessage = history.filter((m) => m.role === "user").pop()?.content || "";
    
    if (!lastUserMessage || !assistantResponse) return;

    // TODO: Implémenter la logique d'extraction intelligente ici 
    // Pour l'instant, on utilise callModel pour satisfaire TS et préparer le terrain.
    if (process.env.DEBUG_MAINTENANCE) {
      const summary = await callModel("workflow-deepseek-v4-flash", [
        { role: "system", content: "Résume en 5 mots." },
        { role: "user", content: assistantResponse }
      ], keys);
      console.warn("[proxy:maintenance] Résumé de réponse:", summary);
    }
    
    console.warn("[proxy:maintenance] Extraction déclenchée (Background)");
  } catch (err: any) {
    console.error("[proxy:maintenance] Erreur:", err.message);
  }
}
