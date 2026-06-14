import express, { Request, Response, NextFunction } from "express";
import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { request as httpRequest } from "http";
import { homedir, platform, arch } from "os";
import { promises as fs } from "fs";
import path from "path";
import { readAllApiKeys, isSafeOllamaUrl } from "../keychain.js";
import { getActiveProject } from "../project-store.js";
import { buildMemoryBlock } from "../memory-store.js";
import {
  getCacheMetrics,
  recordCacheMetric,
  resetCacheMetrics,
} from "../cache-metrics.js";
import {
  getVisionConfig,
  shouldBypassVisionProxy,
  describeImage,
  formatDescriptionForDeepSeek,
  checkOllamaHealth,
} from "./vision.js";

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

// A local workspace path must be an absolute directory inside the user's home.
// The active workspace path is read into LLM prompts (AGENT-MEMORY.md, graphify
// report), so an unconstrained path is a file-disclosure primitive.
function isSafeWorkspacePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || !path.isAbsolute(p)) return false;
  const home = path.resolve(homedir());
  const resolved = path.resolve(p);
  if (resolved === home) return true;
  const rel = path.relative(home, resolved);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function startProxy(): Promise<string> {
  const sessionToken = randomBytes(32).toString("hex");

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // ── Security headers — applied to every response ──
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    // Empêche l'embarquement de la réponse dans un <iframe> par défense
    // en profondeur (double X-Frame-Options sur les navigateurs récents).
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    // Ne jamais divulguer l'URL interne du proxy (127.0.0.1:9999) dans le
    // header Referer des requêtes sortantes déclenchées par la réponse.
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // ── Host-header validation — DNS-rebinding defense ──
  // The proxy binds to loopback, but a malicious web page can rebind a domain it
  // controls to 127.0.0.1 and reach us. CORS only governs *reading* the response,
  // not whether a state-changing request executes — so we reject any request whose
  // Host header is not an expected loopback authority before anything else runs.
  const ALLOWED_HOSTS = new Set([`127.0.0.1:${PROXY_PORT}`, `localhost:${PROXY_PORT}`]);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) {
      res.status(421).json({ error: "Misdirected Request" });
      return;
    }
    next();
  });

  // ── CORS — restrict to known local origins ──
  const ALLOWED_ORIGINS = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4096",
    "http://127.0.0.1:4096",
    "http://localhost:9999",
    "http://127.0.0.1:9999",
  ]);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin ?? "";
    const allowed = ALLOWED_ORIGINS.has(origin);
    res.setHeader(
      "Access-Control-Allow-Origin",
      allowed ? origin : "http://127.0.0.1:9999",
    );
    res.setHeader("Vary", "Origin");
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

  // ── Auth middleware — placed BEFORE all data endpoints ──
  // Only the per-session token (generated with randomBytes) is accepted. There is
  // NO static/shared token: every OpenHub caller obtains the session token from
  // get-chat-config (renderer) or OPENHUB_TOKEN (spawned apps).
  // Only /status, /health, /capabilities, /runtime/versions are exempt (above).
  const PUBLIC_PATHS = new Set([
    "/status",
    "/health",
    "/capabilities",
    "/runtime/versions",
  ]);
  const sessionTokenBuf = Buffer.from(sessionToken);
  const tokenMatches = (candidate: string): boolean => {
    const candidateBuf = Buffer.from(candidate);
    return (
      candidateBuf.length === sessionTokenBuf.length &&
      timingSafeEqual(candidateBuf, sessionTokenBuf)
    );
  };
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (PUBLIC_PATHS.has(req.path)) {
      next();
      return;
    }
    const auth = req.headers["authorization"] ?? "";
    if (!auth.startsWith("Bearer ") || !tokenMatches(auth.slice(7))) {
      res.status(401).json({ error: "Unauthorized" });
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
    const wsPath = body.folderPath ?? "";
    if (!isSafeWorkspacePath(wsPath)) {
      res
        .status(400)
        .json({ error: "folderPath must be an absolute directory inside home" });
      return;
    }
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
          // Never let the upstream override the shell's security headers or set
          // cookies in the Electron session.
          const BLOCKED_UPSTREAM = new Set([
            "set-cookie",
            "content-security-policy",
            "x-frame-options",
            "strict-transport-security",
          ]);
          for (const [key, val] of Object.entries(upstreamHeaders)) {
            if (!val) continue;
            const lower = key.toLowerCase();
            if (lower.startsWith("access-control-")) continue;
            if (BLOCKED_UPSTREAM.has(lower)) continue;
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
        const sRes = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/session${qs}`, {
          signal: AbortSignal.timeout(10000),
        });
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

  // ── Cache Metrics endpoints (authenticated — called by sidebar) ──
  app.get("/v1/cache/metrics", (_req, res) => {
    res.json(getCacheMetrics());
  });
  app.post("/v1/cache/reset", (_req, res) => {
    resetCacheMetrics();
    res.json({ ok: true });
  });

  // Returns the model from the most recent chat completion request + whether it supports reasoning
  app.get("/v1/reasoning/current-model", (_req, res) => {
    res.json({
      model: currentChatModel,
      supportsReasoning: currentChatModel
        ? modelSupportsReasoningEffort(currentChatModel)
        : true,
    });
  });

  // Returns the reasoning levels available for a given model+provider query
  app.get("/v1/reasoning/levels", (req: Request, res: Response) => {
    let model = ((req.query.model as string) || "").toLowerCase();
    const provider = ((req.query.provider as string) || "").toLowerCase();
    if (provider && !model.includes("/")) model = `${provider}/${model}`;
    const supportsReasoning = modelSupportsReasoningEffort(model);
    if (!supportsReasoning) {
      res.json({ supportsReasoning: false, levels: [{ id: "none", name: "Aucun" }] });
      return;
    }
    if (resolveReasoningStyle(model) === "anthropic") {
      res.json({
        supportsReasoning: true,
        levels: [
          { id: "none", name: "Aucun" },
          { id: "minimal", name: "Minimal" },
          { id: "low", name: "Bas" },
          { id: "medium", name: "Moyen" },
          { id: "high", name: "Élevé" },
          { id: "xhigh", name: "Très élevé" },
          { id: "max", name: "Maximum" },
        ],
      });
      return;
    }
    res.json({
      supportsReasoning: true,
      levels: [
        { id: "none", name: "Aucun" },
        { id: "low", name: "Bas" },
        { id: "medium", name: "Moyen" },
        { id: "high", name: "Élevé" },
      ],
    });
  });

  // ── Assistant Orchestrateur (authenticated via the per-session token) ──
  app.post("/v1/orch/assistant", async (req: Request, res: Response) => {
    const { messages, context, questionRounds: qRounds, model: reqModel } = req.body;
    const questionRounds: number = typeof qRounds === "number" ? qRounds : 0;
    const MAX_QUESTION_ROUNDS = 3;
    const settings = await loadOrchSettings();
    const model = reqModel || settings.assistantModel || "deepseek/deepseek-v4-flash";

    const projects = context?.projects || [];
    const workflows = context?.workflows || [];
    const availableModels: string[] = context?.availableModels || [];
    const activeWfId = context?.activeWorkflowId || null;
    const activeWf = activeWfId
      ? workflows.find((w: Record<string, unknown>) => w.id === activeWfId)
      : null;

    // Build context block
    const activeLinkedIds: string[] =
      activeWf && Array.isArray(activeWf.linkedProjectIds)
        ? (activeWf.linkedProjectIds as string[])
        : [];

    const wfLines = workflows
      .map((w: Record<string, unknown>) => {
        const linked = Array.isArray(w.linkedProjectIds) ? w.linkedProjectIds : [];
        return `- id="${String(w.id)}" "${String(w.name)}" (${linked.length} agents liés)`;
      })
      .join("\n");

    const nonOrchProjects = projects.filter(
      (p: Record<string, unknown>) => p.type !== "orchestrator",
    );
    const linkedProjects = nonOrchProjects.filter((p: Record<string, unknown>) =>
      activeLinkedIds.includes(String(p.id)),
    );
    const unlinkedProjects = nonOrchProjects.filter(
      (p: Record<string, unknown>) => !activeLinkedIds.includes(String(p.id)),
    );

    const formatProj = (p: Record<string, unknown>) =>
      `- id="${String(p.id)}" "${String(p.name)}" (type: ${String(p.type || "non défini")}, modèle: ${String(p.model || "défaut")})`;

    const contextBlock = [
      `Workflows (${workflows.length}) :`,
      wfLines || "  Aucun workflow",
      activeWf
        ? `\nWorkflow actif : id="${String(activeWf.id)}" "${String(activeWf.name)}"`
        : "",
      linkedProjects.length > 0
        ? `\nAgents liés au workflow actif (${linkedProjects.length}) :\n${linkedProjects.map(formatProj).join("\n")}`
        : "\nAucun agent lié au workflow actif.",
      unlinkedProjects.length > 0
        ? `\nAgents disponibles non liés (${unlinkedProjects.length}) :\n${unlinkedProjects.map(formatProj).join("\n")}`
        : "",
    ].join("\n");

    const systemPrompt = `Tu es un assistant spécialisé en création de projets. Ton rôle est d'aider n'importe qui, même sans connaissances techniques, à organiser et réaliser ses idées.

RÈGLE ABSOLUE : PARLE COMME UN AMI, pas comme un expert technique.
- Utilise des mots de tous les jours. Pas de jargon, pas d'anglais technique, pas de termes informatiques.
- Imagine que tu expliques à quelqu'un qui ne sait pas ce qu'est un "serveur", une "API" ou du "code".
- Si tu dois parler de quelque chose de technique, dis-le avec des mots simples : "le programme qui gère les comptes", "la partie visible du site", "le stockage des informations".
- Tes phrases doivent être courtes et faciles à lire.
- Sois chaleureux, encourageant, et explique pourquoi chaque chose est utile.

Exemple de bon message :
"J'ai découpé ton idée en 4 morceaux. Chaque morceau fera une tâche précise. Tu peux les valider un par un en cliquant sur Confirmer."

Exemple de mauvais message :
"Je te propose une architecture en microservices avec API REST, JWT et BDD PostgreSQL."

QUAND L'UTILISATEUR EST VAGUE, POSE LUI DES QUESTIONS :
Si la demande de l'utilisateur n'est pas assez précise pour créer des projets, pose-lui des questions pour clarifier.
Tu disposes de ${MAX_QUESTION_ROUNDS} VAGUES de questions au total dans la conversation. Utilise-les intelligemment :
- VAGUE 1 : Questions générales pour comprendre le besoin global (objectif, cible, périmètre)
- VAGUE 2 : Questions de précision après les premières réponses (fonctionnalités détaillées, contraintes, préférences)
- VAGUE 3 : Dernières clarifications avant de proposer les projets (confirmations, choix finaux)
Après chaque réponse de l'utilisateur, ÉVALUE s'il reste des zones floues. Si oui et qu'il te reste des vagues, REPOSE des questions. Ne te précipite pas à proposer des projets tant que tu n'as pas suffisamment d'informations, même si l'utilisateur a déjà répondu à un premier lot de questions.
FORMAT OBLIGATOIRE POUR LES QUESTIONS (NE JAMAIS DÉROGER) :
Tu DOIS utiliser EXACTEMENT le bloc JSON ci-dessous. N'utilise JAMAIS de liste numérotée, de texte en gras, de tirets ou de texte libre pour poser tes questions. Le système affiche les questions dans une interface interactive UNIQUEMENT si tu utilises ce format exact. Si tu poses des questions en texte libre, l'utilisateur ne pourra pas y répondre correctement.

\`\`\`questions
{"questions": [
  {"text": "As-tu déjà une charte graphique (couleurs, logo, polices) ?", "options": ["Oui", "Non", "Je ne sais pas"], "allowCustom": true},
  {"text": "As-tu déjà du contenu (textes, images, vidéos) ?", "options": ["Oui", "Non", "Un peu"], "allowCustom": false},
  {"text": "Quel est ton objectif principal ?", "options": ["Vendre en ligne", "Présenter mon activité", "Blog / Information", "Application interactive"], "allowCustom": true}
]}
\`\`\`

INTERDIT : Poser des questions sous forme de texte libre, listes numérotées (1. 2. 3.), ou listes à puces. TOUTES les questions DOIVENT être dans un bloc \`\`\`questions avec le JSON structuré ci-dessus.

Règles pour les questions :
- Tu as le droit à ${MAX_QUESTION_ROUNDS} tours de questions maximum dans une conversation
- Tu as déjà posé ${questionRounds} tour(s) de questions${questionRounds >= MAX_QUESTION_ROUNDS ? "\n- TU AS ATTEINT LA LIMITE DE QUESTIONS. Ne pose PLUS de questions. Utilise les informations disponibles pour proposer directement des projets." : questionRounds === MAX_QUESTION_ROUNDS - 1 ? "\n- C'est ton DERNIER tour de questions possible. Après celui-ci, tu devras proposer directement." : ""}
- CALIBRE LE NOMBRE DE QUESTIONS selon la précision de la demande :
  - Demande vague ("je veux un site", "j'ai une idée d'app") → pose 10 à 15 questions couvrant : objectif, cible, fonctionnalités, contenu, design, budget, délais, contraintes techniques, concurrence, monétisation, etc.
  - Demande moyennement précise ("je veux un site e-commerce pour vendre des bijoux") → pose 6 à 10 questions sur les détails manquants
  - Demande déjà détaillée → pose 1 à 5 questions de confirmation uniquement
- N'aie PAS PEUR de poser beaucoup de questions. 15 questions bien ciblées valent mieux qu'un projet mal compris.
- Organise les questions par thème (objectif, public, contenu, design, fonctionnalités, contraintes) pour que ce soit clair
- Chaque question doit avoir 2 à 5 options de réponse
- Quand l'utilisateur répond, utilise sa réponse pour adapter ta proposition
- Si l'utilisateur répond "Je ne sais pas", prend une décision raisonnable à sa place
- Les questions doivent être simples, avec des mots de tous les jours
- Après chaque réponse de l'utilisateur, VÉRIFIE s'il reste des informations manquantes. Si oui et qu'il te reste des vagues disponibles (${MAX_QUESTION_ROUNDS - questionRounds} restante(s)), pose un NOUVEAU bloc de questions ciblées sur ce qui manque encore. Ne propose des projets que quand tu as assez d'informations OU que tu as épuisé tes ${MAX_QUESTION_ROUNDS} vagues
- QUESTION OBLIGATOIRE — MODÈLE IA : Dans CHAQUE bloc de questions, inclus TOUJOURS une question sur le modèle d'IA à utiliser pour le projet. Propose UNIQUEMENT les modèles disponibles dans le catalogue ci-dessous. Utilise des noms simplifiés pour les options (pas les identifiants techniques). Ajoute l'option "Je ne sais pas, choisis pour moi" pour les utilisateurs qui ne connaissent pas les modèles.
  Modèles disponibles : ${availableModels.length > 0 ? availableModels.join(", ") : "aucun modèle configuré"}

QUAND TU PROPOSES DES PROJETS :
- Donne-leur des noms que tout le monde comprend, comme "Gestion des comptes" au lieu de "API Authentification".
- Explique ce que fait le projet en une phrase simple.
- N'utilise JAMAIS de mots comme : API, Backend, Frontend, endpoint, JWT, token, CI/CD, pipeline, déploiement, architecture, framework, librairie, middleware, websocket, webhook, SaaS, PaaS, IaaS, serverless, docker, container, microservice, REST, GraphQL, SQL, NoSQL, ORM, responsive, mobile-first, SSR, SPA, SEO, référencement technique, balisage, sémantique, cache, CDN, DNS, HTTPS, SSL, OAuth, SSO, CRUD, MVC, MVP, MVVM, TypeScript, JavaScript, Node.js, React, Vue, Angular, etc.

QUAND L'UTILISATEUR DEMANDE DE CRÉER UN WORKFLOW :
Décompose son besoin en petits morceaux simples. Chaque morceau = un projet.
Ne te limite pas à 2 ou 3 projets. Si tu hésites entre mettre deux tâches dans le même projet ou les séparer, SÉPARE-LES.

Exemple pour "créer un site e-commerce" :
- Analyse de ce qu'il faut faire (recherche)
- Organisation du stockage des données (code)
- Programme côté serveur pour les comptes et la connexion (code)
- Programme côté serveur pour les produits et le catalogue (code)
- Programme côté serveur pour le panier et les commandes (code)
- Programme côté serveur pour les paiements (code)
- Charte graphique : couleurs, polices, style visuel (design)
- Croquis des pages (design)
- Pages principales du site : accueil, catalogue (work)
- Page du panier et de la commande (work)
- Page d'administration du site (work)
- Référencement pour être trouvé sur Google (recherche)
- Tests de sécurité pour vérifier qu'il n'y a pas de failles (verifier)
- Vérificateur qualité pour s'assurer que tout fonctionne ensemble (verifier)
- Mise en ligne automatique du site (work)

AJOUTE PLUSIEURS VÉRIFICATEURS : sécurité, qualité, performance. 
Chaque vérificateur est un projet supplémentaire qui relit et valide le travail des autres projets.
Plus il y a de vérificateurs, plus le résultat final est fiable.

Si tu utilises des blocs action, garde les instructions en langage simple aussi.

TU PEUX PROPOSER DES ACTIONS :
Si l'utilisateur te demande EXPLICITEMENT de créer ou modifier quelque chose, exécute l'action directement :

Créer un workflow :
\`\`\`action
{"type": "create_workflow", "name": "Nom du workflow", "auto": true}
\`\`\`

Définir la tâche globale du workflow (ce que l'orchestrateur doit accomplir dans son ensemble) :
\`\`\`action
{"type": "set_task", "task": "Description claire et complète de ce que le projet doit réaliser. Cette tâche est le résumé global qui guide la répartition du travail entre tous les agents.", "auto": true}
\`\`\`

RÈGLE TÂCHE GLOBALE :
- Quand tu crées un workflow, génère TOUJOURS une action set_task juste après le create_workflow pour définir la tâche globale
- La tâche globale doit résumer l'objectif final du projet en s'appuyant sur les réponses de l'utilisateur
- Elle doit être assez détaillée pour qu'un coordinateur puisse répartir le travail sans ambiguïté
- Si l'utilisateur modifie sa demande ou précise son besoin, mets à jour la tâche globale avec set_task
- L'utilisateur peut aussi te demander directement de changer la tâche globale ("change la tâche", "modifie l'objectif", etc.)

Créer un agent et le lier au workflow actif :
\`\`\`action
{"type": "create_project", "name": "Nom du projet", "instructions": "Instructions détaillées...", "task": "Tâche spécifique de cet agent...", "agentType": "code", "model": "identifiant-du-modele", "linkToWf": true, "dependencies": ["Nom d'un autre agent"], "auto": true}
\`\`\`

RÈGLE MODÈLE À LA CRÉATION :
- Le champ "model" est OPTIONNEL dans create_project
- Si l'utilisateur a choisi un modèle lors des questions, ajoute "model" à CHAQUE create_project avec l'identifiant exact du modèle choisi
- Si l'utilisateur n'a pas encore choisi de modèle, ne mets pas le champ "model" — il pourra être défini plus tard avec set_model
- Quand l'utilisateur demande de "changer le modèle de tous les agents", utilise set_model avec target "all"

RÈGLE CRITIQUE — TOUJOURS RELIER LES AGENTS (dependencies) :
Le champ "dependencies" liste les agents qui doivent TERMINER leur travail AVANT que cet agent démarre.
Référence-les par leur NOM EXACT (agents créés plus haut dans la même réponse) ou par leur id (agents existants du contexte).
C'est ce qui dessine les flèches entre les agents sur le canvas et définit l'ordre d'exécution.
- Les agents de départ (recherche, analyse) n'ont pas de dependencies
- TOUT autre agent DOIT avoir au moins une dépendance vers le ou les agents dont il utilise le travail
- Exemple : "Construction du site" dépend de ["Maquette des pages", "Création des textes"] ; "Vérification qualité" dépend de ["Construction du site"] ; "Mise en ligne" dépend de ["Vérification qualité"]
- Ne livre JAMAIS un ensemble d'agents sans chaîne de dépendances : un graphe où tous les agents sont isolés est une erreur

Lier un agent EXISTANT au workflow actif (utilise l'id du projet depuis le contexte) :
\`\`\`action
{"type": "link_project", "projectId": "id-du-projet", "auto": true}
\`\`\`

Changer le modèle d'IA d'un agent spécifique (par id ou par nom) :
\`\`\`action
{"type": "set_model", "model": "identifiant-du-modele", "projectId": "id-du-projet", "auto": true}
\`\`\`
\`\`\`action
{"type": "set_model", "model": "identifiant-du-modele", "projectName": "Nom de l'agent", "auto": true}
\`\`\`

Changer le modèle d'IA de TOUS les agents du workflow actif d'un coup :
\`\`\`action
{"type": "set_model", "model": "identifiant-du-modele", "target": "all", "auto": true}
\`\`\`

RÈGLE MODÈLE — Utilise UNIQUEMENT les identifiants exacts de la liste des modèles disponibles (voir contexte en bas). Quand l'utilisateur choisit un modèle par son nom simplifié lors d'une question, fais correspondre sa réponse à l'identifiant exact.
Quand l'utilisateur répond à la question sur le modèle, génère automatiquement l'action set_model correspondante avec target "all" (sauf s'il a précisé un agent spécifique).

Les valeurs possibles de agentType (OBLIGATOIRE pour chaque projet) :
- "code" → programme, API, logique serveur, base de données
- "design" → maquettes, charte graphique, style visuel
- "work" → pages visibles du site, interface utilisateur
- "verifier" → vérification qualité, sécurité, tests
- "recherche" → analyse de marché, SEO, documentation

Tu peux créer plusieurs projets à la suite en enchaînant les blocs action.

RÈGLE CRITIQUE — TOUT CRÉER EN UNE SEULE RÉPONSE :
Quand l'utilisateur confirme ou dit "oui", "go", "démarre", "lance", "c'est parti" → génère IMMÉDIATEMENT TOUS les blocs action dans cette même réponse.
Ne dis JAMAIS "Je commence par X" puis attends. Ne découpe JAMAIS la création en plusieurs échanges.
Crée le workflow ET tous les projets dans UN SEUL message.

RÈGLE CRITIQUE — NE JAMAIS CRÉER DE DOUBLONS :
Avant de créer un projet, vérifie TOUJOURS la liste des agents dans le contexte ci-dessous.
Si un agent avec le même nom ou le même rôle existe déjà → utilise link_project avec son id.
Ne crée un projet que si AUCUN agent existant ne correspond.
Quand l'utilisateur demande de "lier", "relier", "rattacher" ou "connecter" des agents → c'est TOUJOURS link_project, JAMAIS create_project.

RÈGLES IMPORTANTES :
- auto=true → l'action est exécutée immédiatement sans confirmation
- auto=false ou absent → l'utilisateur doit confirmer avant exécution
- Chaque projet DOIT avoir un agentType
- Pour lier un agent existant, utilise TOUJOURS son id exact depuis le contexte (le champ id="..." de chaque agent)
- Ne dis JAMAIS que tu as fait quelque chose sans générer le bloc action correspondant
- Explique toujours ce que tu vas faire avant les blocs action
- Sois concis mais complet

Contexte actuel :
${contextBlock}

Modèles IA disponibles (identifiants exacts à utiliser dans set_model) :
${availableModels.length > 0 ? availableModels.map((m: string) => `- ${m}`).join("\n") : "Aucun modèle configuré."}`;

    // Prevent timeout for SSE
    req.socket.setTimeout(0);
    res.socket?.setTimeout(0);

    try {
      const keys = await readAllApiKeys();
      const route = resolveRoute(model, keys);
      const targetUrl = route.targetUrl;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...route.headers,
      };
      const upstreamModel = route.model;

      const allMessages = [
        { role: "system", content: systemPrompt },
        ...(messages || []),
      ];
      let requestBody: string;
      let isGemini = false;

      if (route.provider === "gemini") {
        isGemini = true;
        const googleAuth = await getGoogleAuth();
        if (!googleAuth) {
          res.status(401).json({
            error:
              "Token Google expiré — lance 'opencode auth login' dans un terminal pour te reconnecter",
          });
          return;
        }
        const geminiModel = upstreamModel ?? model.replace("google/", "");
        headers["Authorization"] = `Bearer ${googleAuth.accessToken}`;
        headers["User-Agent"] = buildGeminiUserAgent(geminiModel);
        headers["x-activity-request-id"] = createActivityRequestId();

        const { contents, systemInstruction } = convertOpenAIToGemini(allMessages);
        const innerRequest: Record<string, unknown> = {
          contents,
          generationConfig: { temperature: 0.3 },
          session_id: GEMINI_SESSION_ID,
        };
        if (systemInstruction) innerRequest.systemInstruction = systemInstruction;
        requestBody = JSON.stringify({
          project: googleAuth.managedProjectId,
          model: geminiModel,
          user_prompt_id: randomBytes(16).toString("hex"),
          request: innerRequest,
        });
      } else {
        requestBody = JSON.stringify({
          model: upstreamModel ?? model,
          messages: allMessages,
          stream: true,
          temperature: 0.3,
          max_tokens: 16000,
        });
      }

      const upstream = await fetchWithRetry(targetUrl, {
        method: "POST",
        headers,
        body: requestBody,
      });

      if (!upstream.ok) {
        const errorText = await upstream.text().catch(() => "Unknown error");
        console.error(
          "[proxy] Assistant upstream error:",
          upstream.status,
          errorText.substring(0, 300),
        );
        res
          .status(upstream.status)
          .json({ error: `Upstream error: ${sanitizeUpstreamError(errorText)}` });
        return;
      }

      // SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const reader = upstream.body?.getReader();
      if (!reader) {
        res.write('data: {"error":"No response stream"}\n\n');
        res.end();
        return;
      }

      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim().startsWith("data:")) continue;
          if (isGemini) {
            const converted = convertGeminiChunkToOpenAI(line.trim());
            if (converted) res.write(converted);
          } else {
            res.write(line + "\n");
          }
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[proxy] Assistant error:", errMsg);
      res.write(
        'data: {"error":"' + (errMsg || "Unknown error").replace(/"/g, "'") + '"}\n\n',
      );
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });

  // Settings for assistant model
  const ORCH_ASSISTANT_PATH = path.join(
    homedir(),
    ".config",
    "openhub",
    "orch-assistant.json",
  );

  async function loadOrchSettings(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await fs.readFile(ORCH_ASSISTANT_PATH, "utf-8"));
    } catch {
      return {};
    }
  }

  // ── In-memory selected models ──
  let selectedModelIds: string[] = [];
  let defaultReasoningEffort = "medium";
  let currentChatModel = "";

  // Load default reasoning effort from settings
  try {
    const settingsPath = path.join(homedir(), ".config", "openhub", "settings.json");
    const raw = await fs.readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.defaultReasoningEffort)
      defaultReasoningEffort = parsed.defaultReasoningEffort;
  } catch {
    /* no settings yet */
  }

  // Endpoints for reading/writing default reasoning effort (used by OpenCode indicator)
  app.get("/v1/reasoning/default", (_req, res) => {
    res.json({ effort: defaultReasoningEffort });
  });
  app.post("/v1/reasoning/default", (req: Request, res: Response) => {
    const body = req.body as { effort?: string };
    if (body.effort) {
      defaultReasoningEffort = body.effort;
      // Persist to settings file so it survives restart
      const settingsPath = path.join(homedir(), ".config", "openhub", "settings.json");
      void (async () => {
        try {
          let settings: Record<string, unknown> = {};
          try {
            const raw = await fs.readFile(settingsPath, "utf-8");
            settings = JSON.parse(raw);
          } catch {
            /* no existing */
          }
          settings.defaultReasoningEffort = defaultReasoningEffort;
          await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
        } catch {
          /* non-critical */
        }
      })();
    }
    res.json({ effort: defaultReasoningEffort });
  });

  try {
    const configPath = path.join(homedir(), ".config", "opencode", "opencode.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const providers = cfg.provider as Record<string, unknown> | undefined;
    const ohub = providers?.openhub as Record<string, unknown> | undefined;
    if (ohub?.models) {
      selectedModelIds = Object.keys(ohub.models as Record<string, unknown>);
    }
  } catch {
    /* no persisted config yet */
  }

  app.get("/v1/models", async (_req, res) => {
    const keys = await readAllApiKeys();
    const all = await buildModelList(keys);

    // Migration: if selectedModelIds contains legacy names, map them to current names
    const legacyToNew: Record<string, string> = {
      "claude-sonnet-4-6": "claude-3-7-sonnet-latest",
      "claude-opus-4-6": "claude-3-opus-latest",
      "claude-haiku-4-5": "claude-3-5-haiku-latest",
      "google/gemini-3-flash-preview": "google/gemini-3-flash-preview",
      "google/gemini-3-pro-preview": "google/gemini-3-pro-preview",
      "deepseek/deepseek-v4-pro": "deepseek/deepseek-chat",
      "deepseek/deepseek-v4-flash": "deepseek/deepseek-r1",
    };

    if (selectedModelIds.length > 0) {
      // Create a set of expanded IDs (selected + their new mapped versions)
      const expandedSelection = new Set<string>();
      for (const id of selectedModelIds) {
        expandedSelection.add(id);
        if (legacyToNew[id]) expandedSelection.add(legacyToNew[id]);
      }

      const filtered = all.filter((m) => expandedSelection.has(m.id));
      if (filtered.length > 0) {
        res.json({ object: "list", data: filtered });
        return;
      }
    }

    // Fallback: return everything from our catalog + dynamic OpenRouter models
    res.json({ object: "list", data: all });
  });

  app.get("/v1/models/full", async (_req, res) => {
    const keys = await readAllApiKeys();
    const catalog = getFullModelCatalog();

    const orModels = keys.openrouterKey
      ? await fetchOpenRouterModels(keys.openrouterKey)
      : [];
    const catalogIds = new Set(catalog.map((c) => c.id));
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
      } catch {
        /* create fresh */
      }

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

  function modelSupportsReasoningEffort(id: string): boolean {
    if (!id) return false;
    const l = id.toLowerCase();
    // Skip models known NOT to support the parameter but having o1 in name
    if (l.includes("o1-mini") || l.includes("o1-preview")) return false;

    return (
      l.includes("o1") ||
      l.includes("o3") ||
      l.includes("o4") ||
      l.includes("deepseek") ||
      l.includes("claude-3-7") ||
      l.includes("claude-3.7") ||
      l.includes("thinking") ||
      l.includes("reasoning") ||
      l.includes("reflection") ||
      l.includes("r1") ||
      l.includes("pro-exp") ||
      l.includes("thinking-exp") ||
      l.includes("reasoner") ||
      l.includes("sonnet") || // Many reasoning models use sonnet (3.7)
      l.includes("opus") // Opus might support it in future or current versions
    );
  }

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

      // Track the most recently used model for the reasoning indicator
      currentChatModel = upstreamModel ?? model;

      let messages = rest.messages as
        | Array<{ role: string; content: string }>
        | undefined;

      // ── Vision Proxy: convert images to text for text-only models ──
      if (messages && !bypassInjection && !shouldBypassVisionProxy(model)) {
        const visionConfig = await getVisionConfig(keys.ollamaUrl ?? null);
        if (visionConfig.visionProxyEnabled) {
          let ollamaReachable: boolean | null = null;
          // Bound how many images one request can fan out to the vision model.
          // Each image is a heavy ~45s Ollama call; without a cap a single 10mb
          // body packed with image parts becomes a DoS-amplification primitive.
          const MAX_VISION_IMAGES = 12;
          let visionImagesUsed = 0;
          const rawMessages = messages as Array<{
            role: string;
            content: string | unknown[];
          }>;
          for (let i = 0; i < rawMessages.length; i++) {
            const msg = rawMessages[i];
            if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

            const parts = msg.content as Array<{
              type: string;
              text?: string;
              image_url?: { url: string };
            }>;
            const hasImages = parts.some((p) => p.type === "image_url");
            if (!hasImages) continue;

            if (ollamaReachable === null) {
              ollamaReachable = await checkOllamaHealth(visionConfig.ollamaUrl);
              if (!ollamaReachable) {
                console.warn("[proxy:vision] Ollama non joignable, images non traitées");
                break;
              }
            }

            // Les descriptions d'images sont indépendantes : on les lance en
            // parallèle (Promise.all) au lieu de bloquer séquentiellement.
            // L'ordre des parties (texte/image) est préservé par l'index.
            const resolvedParts = await Promise.all(
              parts.map(async (part) => {
                if (part.type === "text" && part.text) {
                  return part.text;
                }
                if (part.type === "image_url" && part.image_url?.url) {
                  if (visionImagesUsed >= MAX_VISION_IMAGES) {
                    return "[image ignorée : limite de traitement atteinte]";
                  }
                  visionImagesUsed++;
                  try {
                    const description = await describeImage(
                      part.image_url.url,
                      visionConfig,
                    );
                    return formatDescriptionForDeepSeek(
                      description,
                      visionConfig.visionDetailLevel,
                    );
                  } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    console.warn("[proxy:vision] Erreur describeImage:", errMsg);
                    return "[Image non analysée — erreur Ollama]";
                  }
                }
                return "";
              }),
            );
            const textParts = resolvedParts.filter((s) => s !== "");

            (messages as Array<{ role: string; content: string }>)[i] = {
              role: msg.role,
              content: textParts.join("\n"),
            };
          }
          rest.messages = messages;
        }
      }

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
        const mainSystemContent =
          messages.find((m) => m.role === "system")?.content || "";

        // Séparer les blocs : Comportement (Stable) vs Données Projet (Variable)
        const splitMarkers = [
          "You are powered by the model named",
          "Here is some useful information about the environment",
          "Instructions from:",
        ];

        let coreBehavior = mainSystemContent;
        let extractedGraphify = "";

        // Extraction du Graphify s'il est déjà présent dans le prompt
        const graphifyMatch = mainSystemContent.match(
          /Instructions from:.*?graphify-out\/GRAPH_REPORT\.md\n([\s\S]*?)(?=\nInstructions from:|$)/,
        );
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
        const lastUserContent =
          messages.filter((m) => m.role === "user").pop()?.content || "";
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
        } catch {
          /* ignore reading errors */
        }

        // ── 4. Assembler les messages système (Stable Prefix Strategy) ──
        // HIÉRARCHIE : Stable (Main) -> Stable/Lourd (Graphify) -> Semi-stable (Project) -> Stable (Date) -> Mutant (Memory)
        // On place les blocs les plus lourds et stables en haut.
        const structuredSystem = [
          { role: "system", content: coreBehavior.trim() }, // 1. Règles de base
          {
            role: "system",
            content: extractedGraphify
              ? `[KNOWLEDGE GRAPH]\n${extractedGraphify.trim()}`
              : "",
          }, // 2. LE LOURD (Frozen)
          { role: "system", content: projInstructions.trim() }, // 3. Instructions Projet
          {
            role: "system",
            content: `Today's date: ${new Date().toISOString().split("T")[0]}`,
          }, // 4. Date (24h)
          {
            role: "system",
            content: agentMemory ? `[PROJECT MEMORY]\n${agentMemory.trim()}` : "",
          }, // 5. Notes de fin de tâche
          { role: "system", content: memBlock ? memBlock.trim() : "" }, // 6. Mots-clés (Mutant ultime)
        ].filter((m) => m.content !== "");

        // ── 5. Réinjecter sans toucher à l'historique utilisateur ──
        const conversationMessages = messages.filter((m) => m.role !== "system");

        messages = [...structuredSystem, ...conversationMessages];
        rest.messages = messages;
      }

      // Estimate prompt tokens AFTER injection (for cache metrics)
      const finalMessages = rest.messages as
        | Array<{ role: string; content: string }>
        | undefined;
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
          res.status(401).json({
            error:
              "Token Google expiré — lance 'opencode auth login' dans un terminal pour te reconnecter",
          });
          return;
        }
        const geminiModel = upstreamModel ?? model.replace("google/", "");
        headers["Authorization"] = `Bearer ${googleAuth.accessToken}`;
        headers["User-Agent"] = buildGeminiUserAgent(geminiModel);
        headers["x-activity-request-id"] = createActivityRequestId();

        const finalMsgs = (rest.messages ?? []) as Array<{
          role: string;
          content: string;
        }>;
        const { contents, systemInstruction } = convertOpenAIToGemini(finalMsgs);
        const innerRequest: Record<string, unknown> = {
          contents,
          generationConfig: {
            temperature: (rest.temperature as number) ?? 0.7,
            ...(rest.max_tokens ? { maxOutputTokens: rest.max_tokens as number } : {}),
          },
          session_id: GEMINI_SESSION_ID,
        };
        if (systemInstruction) innerRequest.systemInstruction = systemInstruction;

        // Forward OpenAI-format tools to Gemini-native format
        const openaiTools = rest.tools as
          | Array<{
              type: string;
              function: {
                name: string;
                description?: string;
                parameters?: Record<string, unknown>;
              };
            }>
          | undefined;
        if (openaiTools?.length) {
          innerRequest.tools = [
            {
              functionDeclarations: openaiTools
                .filter((t) => t.type === "function")
                .map((t) => ({
                  name: t.function.name,
                  ...(t.function.description
                    ? { description: t.function.description }
                    : {}),
                  ...(t.function.parameters
                    ? {
                        parameters: sanitizeGeminiSchema(
                          t.function.parameters as Record<string, unknown>,
                        ),
                      }
                    : {}),
                })),
            },
          ];
        }
        geminiBody = JSON.stringify({
          project: googleAuth.managedProjectId,
          model: geminiModel,
          user_prompt_id: randomBytes(16).toString("hex"),
          request: innerRequest,
        });
      }

      // ── Parameter Mapping for Reasoning/Thinking (Claude 3.7 & others) ──
      const isAnthropicProvider = provider === "anthropic";
      const isOpenRouter = targetUrl.includes("openrouter.ai");
      const modelId = (upstreamModel ?? model).toLowerCase();
      const isClaude37 = modelId.includes("claude-3-7") || modelId.includes("claude-3.7");

      const finalRest = { ...rest };

      // Apply global default if effort is missing (e.g. from OpenCode)
      if (
        !finalRest.reasoning_effort &&
        modelSupportsReasoningEffort(upstreamModel ?? model)
      ) {
        if (defaultReasoningEffort && defaultReasoningEffort !== "none") {
          finalRest.reasoning_effort = defaultReasoningEffort;
        }
      }

      if (finalRest.reasoning_effort && finalRest.reasoning_effort !== "none") {
        const effort = finalRest.reasoning_effort as string;

        // --- Anthropic Mapping (thinking block) ---
        if (isAnthropicProvider || (isOpenRouter && isClaude37)) {
          let budget = 1024;
          if (effort === "low" || effort === "minimal") budget = 1024;
          else if (effort === "medium") budget = 4000;
          else if (effort === "high") budget = 16000;
          else if (effort === "xhigh") budget = 32000;
          else if (effort === "max") budget = 64000;

          (finalRest as Record<string, unknown>).thinking = {
            type: "enabled",
            budget_tokens: budget,
          };
          delete (finalRest as Record<string, unknown>).reasoning_effort;

          // Ensure max_tokens > budget_tokens
          const currentMaxTokens = (finalRest.max_tokens as number) || 8192;
          if (currentMaxTokens <= budget) {
            finalRest.max_tokens = budget + 4000;
          }
        }
        // --- OpenAI/OpenRouter Mapping (reasoning_effort) ---
        else if (provider === "openai" || isOpenRouter) {
          // Map OpenHub's expanded levels back to OpenAI's supported 3 levels
          if (effort === "minimal") finalRest.reasoning_effort = "low";
          else if (effort === "xhigh" || effort === "max")
            finalRest.reasoning_effort = "high";
          // others (low, medium, high) pass through as is

          // For OpenRouter: force reasoning content to be included
          if (isOpenRouter) {
            (finalRest as Record<string, unknown>).include_reasoning = true;
          }
        }
      } else if (finalRest.reasoning_effort === "none") {
        delete (finalRest as Record<string, unknown>).reasoning_effort;
      }

      const upstream = await fetchWithRetry(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body:
          geminiBody ?? JSON.stringify({ model: upstreamModel ?? model, ...finalRest }),
      });

      // ── 4. Vérification immédiate du statut upstream ──
      // Si le provider renvoie une erreur (400, 429, 500…), on transmet
      // l'erreur réelle au lieu de tenter de lire un stream inexistant.
      if (upstream.status !== 200) {
        const errorText = await upstream.text();
        // Full upstream body is logged server-side only; the client receives a
        // sanitized message (provider error.message when present) to avoid leaking
        // internal URLs, headers, or routing details.
        console.error(`[proxy] Erreur Upstream ${upstream.status}:`, errorText);
        res.status(upstream.status);
        res.setHeader("Content-Type", "application/json");
        res.json({
          error: { message: sanitizeUpstreamError(errorText), type: "upstream_error" },
        });
        return;
      }

      res.status(upstream.status);
      if (provider !== "gemini") {
        // Forward ONLY a safe whitelist. Blindly copying upstream headers would
        // let a (possibly attacker-influenced) upstream inject Set-Cookie,
        // Access-Control-* or Content-Security-Policy and override the security
        // headers set above.
        const FORWARDABLE = new Set(["content-type"]);
        upstream.headers.forEach((v, k) => {
          if (FORWARDABLE.has(k.toLowerCase())) res.setHeader(k, v);
        });
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
              } catch {
                /* ignore */
              }
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
          const toolCalls: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
            thought_signature?: string;
          }> = [];
          for (const ch of accumulatedChunks) {
            const m = ch.match(/data: (.+)/);
            if (m) {
              try {
                const p = JSON.parse(m[1]);
                if (p.choices?.[0]?.delta?.content) {
                  fullContent += p.choices[0].delta.content;
                }
                if (p.choices?.[0]?.delta?.tool_calls) {
                  toolCalls.push(...p.choices[0].delta.tool_calls);
                }
                if (p.usage) finalUsage = p.usage;
              } catch {
                /* ignore */
              }
            }
          }
          const messageObj: Record<string, unknown> = {
            role: "assistant",
            content: fullContent || fullResponseContent || null,
          };
          if (toolCalls.length > 0) messageObj.tool_calls = toolCalls;
          const response: Record<string, unknown> = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: upstreamModel ?? model,
            choices: [
              {
                index: 0,
                message: messageObj,
                finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
                logprobs: null,
              },
            ],
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
              } catch {
                /* ignore parsing errors */
              }
            }
          }
        }

        res.end();
      }

      // ── 6. Enregistrement des métriques de cache ──
      const wsName =
        workspaces.find((w) => w.id === activeWorkspaceId)?.name || "default";
      const usage = responseUsage ?? {};
      const upstreamCached =
        usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? 0;
      const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
      const total_est = estimatedSystemTokens + estimatedNonSystemTokens || 1;
      const actualSystemTokens = promptTokens
        ? Math.round(promptTokens * (estimatedSystemTokens / total_est))
        : estimatedSystemTokens;
      const actualNonSystemTokens = promptTokens
        ? Math.round(promptTokens * (estimatedNonSystemTokens / total_est))
        : estimatedNonSystemTokens;
      recordCacheMetric(
        model,
        wsName,
        actualSystemTokens,
        actualNonSystemTokens,
        upstreamCached,
      );

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
      if (
        msg.includes("fetch") ||
        msg.includes("network") ||
        msg.includes("ENOTFOUND") ||
        msg.includes("ECONNREFUSED")
      ) {
        errorType = "network_error";
      } else if (
        msg.includes("timeout") ||
        msg.includes("Timeout") ||
        msg.includes("abort")
      ) {
        errorType = "provider_timeout";
      } else if (
        msg.includes("token") ||
        msg.includes("context_length") ||
        msg.includes("max_tokens")
      ) {
        errorType = "token_limit_exceeded";
      } else if (msg.includes("rate") || msg.includes("quota") || msg.includes("429")) {
        errorType = "rate_limited";
      }
      console.error(`[proxy] ${errorType}:`, msg, cause);
      // If streaming already started, headers are sent — can't write a JSON body.
      if (res.headersSent) {
        res.end();
      } else {
        res.status(502).json({ error: `Bad gateway — ${errorType}` });
      }
    }
  });

  await new Promise<void>((resolve) => {
    const server = app.listen(PROXY_PORT, PROXY_HOST, () => resolve());
    server.on("error", (err: NodeJS.ErrnoException) => {
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

// Extracts a safe, human-readable message from an upstream provider error body.
// Returns only the provider's `error.message` (capped) — never the raw body, which
// can contain internal URLs, request echoes, or header fragments.
function sanitizeUpstreamError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string };
    const msg = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (typeof msg === "string" && msg.length > 0) {
      return msg.slice(0, 300);
    }
  } catch {
    // Not JSON — fall through to generic message.
  }
  return "The upstream provider returned an error.";
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<globalThis.Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, init);
    if (resp.status !== 429 || attempt === maxRetries) return resp;

    const body = await resp.text();
    const match = body.match(/after\s+(\d+)s/i);
    const waitSec = match ? Math.min(parseInt(match[1], 10), 60) : 5 * (attempt + 1);
    console.warn(
      `[proxy] 429 rate-limited, retrying in ${waitSec}s (attempt ${attempt + 1}/${maxRetries})`,
    );
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  }
  return fetch(url, init);
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const GEMINI_TO_OPENROUTER: Record<string, string> = {};

// ── Google Gemini direct route (via OAuth) ──

const GEMINI_MODEL_NAME_MAP: Record<string, string> = {
  "google/gemini-2.5-flash": "gemini-2.5-flash",
  "google/gemini-2.5-pro": "gemini-2.5-pro",
  "google/gemini-3-flash-preview": "gemini-3-flash-preview",
  "google/gemini-3-pro-preview": "gemini-3-pro-preview",
};

const GEMINI_API_BASE = "https://cloudcode-pa.googleapis.com";
const GEMINI_SESSION_ID = randomUUID();

// Keys that Gemini's functionDeclarations actually support.
// Everything else ($schema, exclusiveMinimum, additionalProperties, etc.) must
// be stripped or the API returns 400.
const GEMINI_SCHEMA_ALLOWED_KEYS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "format",
  "nullable",
  "allOf",
  "anyOf",
  "oneOf",
  "minLength",
]);

function sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_ALLOWED_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
        if (pv && typeof pv === "object" && !Array.isArray(pv)) {
          props[pk] = sanitizeGeminiSchema(pv as Record<string, unknown>);
        } else {
          props[pk] = pv;
        }
      }
      out[key] = props;
    } else if (
      key === "items" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = sanitizeGeminiSchema(value as Record<string, unknown>);
    } else if (
      (key === "allOf" || key === "anyOf" || key === "oneOf") &&
      Array.isArray(value)
    ) {
      out[key] = value.map((v: unknown) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? sanitizeGeminiSchema(v as Record<string, unknown>)
          : v,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

function buildGeminiUserAgent(model: string): string {
  return `GeminiCLI/0.45.1/${model} (${platform()}; ${arch()}; terminal)`;
}

function createActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}

type GoogleAuth = { accessToken: string; managedProjectId: string } | null;

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Gemini CLI public OAuth "installed app" credentials (same as upstream Gemini CLI).
// Per Google's OAuth spec these native-app credentials are NOT confidential, so the
// literal is shipped as a working default; env vars override it for custom deployments.
const GEMINI_CLIENT_ID =
  process.env.GEMINI_CLIENT_ID ??
  "***REMOVED-CLIENT-ID***";
const GEMINI_CLIENT_SECRET =
  process.env.GEMINI_CLIENT_SECRET ?? "***REMOVED-SECRET***";
const AUTH_JSON_PATH = path.join(homedir(), ".local", "share", "opencode", "auth.json");
const ACCOUNT_JSON_PATH = path.join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "account.json",
);
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60_000;

async function readGoogleAuthFile(): Promise<{
  accessToken: string | null;
  refreshToken: string | null;
  expires: number;
}> {
  try {
    const raw = await fs.readFile(AUTH_JSON_PATH, "utf-8");
    const auth = JSON.parse(raw) as {
      google?: { access?: string; refresh?: string; expires?: number };
    };
    if (auth.google?.access) {
      return {
        accessToken: auth.google.access,
        refreshToken: auth.google.refresh ?? null,
        expires: auth.google.expires ?? 0,
      };
    }
  } catch {
    try {
      const raw = await fs.readFile(ACCOUNT_JSON_PATH, "utf-8");
      const parsed = JSON.parse(raw) as {
        accounts?: Record<
          string,
          {
            credential?: {
              access?: string;
              refresh?: string;
              type?: string;
              expires?: number;
            };
          }
        >;
        active?: { google?: string };
      };
      const activeId = parsed.active?.google;
      const cred = activeId ? parsed.accounts?.[activeId]?.credential : undefined;
      if (cred?.access) {
        return {
          accessToken: cred.access,
          refreshToken: cred.refresh ?? null,
          expires: cred.expires ?? 0,
        };
      }
    } catch {
      /* no fallback */
    }
  }
  return { accessToken: null, refreshToken: null, expires: 0 };
}

function parseRefreshParts(packed: string): {
  refreshToken: string;
  projectId: string | undefined;
  managedProjectId: string | undefined;
} {
  const [refreshToken = "", projectId = "", managedProjectId = ""] = packed.split("|");
  return {
    refreshToken,
    projectId: projectId || undefined,
    managedProjectId: managedProjectId || undefined,
  };
}

function formatRefreshParts(parts: {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
}): string {
  if (!parts.projectId && !parts.managedProjectId) return parts.refreshToken;
  return `${parts.refreshToken}|${parts.projectId ?? ""}|${parts.managedProjectId ?? ""}`;
}

let refreshInFlight: Promise<string | null> | null = null;

async function refreshGoogleToken(packedRefresh: string): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshGoogleTokenInternal(packedRefresh).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refreshGoogleTokenInternal(packedRefresh: string): Promise<string | null> {
  const parts = parseRefreshParts(packedRefresh);
  if (!parts.refreshToken) return null;
  if (!GEMINI_CLIENT_ID || !GEMINI_CLIENT_SECRET) {
    console.warn(
      "[proxy] Gemini OAuth désactivé : GEMINI_CLIENT_ID / GEMINI_CLIENT_SECRET non configurés (voir .env.example)",
    );
    return null;
  }

  try {
    const resp = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: parts.refreshToken,
        client_id: GEMINI_CLIENT_ID,
        client_secret: GEMINI_CLIENT_SECRET,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn(`[proxy] Google token refresh failed (${resp.status}): ${errText}`);
      if (errText.includes("invalid_grant")) {
        console.warn(
          "[proxy] Refresh token revoked — lance 'opencode auth login' pour te reconnecter",
        );
      }
      return null;
    }

    const data = (await resp.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    const newExpires = Date.now() + data.expires_in * 1000;
    const newRefreshToken = data.refresh_token ?? parts.refreshToken;
    const newPacked = formatRefreshParts({
      refreshToken: newRefreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
    });

    const existingRaw = await fs.readFile(AUTH_JSON_PATH, "utf-8").catch(() => "{}");
    const existing = JSON.parse(existingRaw) as Record<string, unknown>;
    const google = (existing.google ?? {}) as Record<string, unknown>;
    const updated = {
      ...existing,
      google: {
        ...google,
        access: data.access_token,
        refresh: newPacked,
        expires: newExpires,
      },
    };
    await fs.writeFile(AUTH_JSON_PATH, JSON.stringify(updated, null, 2), "utf-8");
    console.warn("[proxy] Google OAuth token refreshed");
    return data.access_token;
  } catch (err) {
    console.error("[proxy] Google token refresh error:", err);
    return null;
  }
}

async function getGoogleAuth(): Promise<GoogleAuth> {
  try {
    const { accessToken, refreshToken, expires } = await readGoogleAuthFile();
    if (!accessToken) return null;

    const parts = parseRefreshParts(refreshToken ?? "");
    const managedProjectId = parts.managedProjectId ?? "";

    const needsRefresh =
      !expires || expires <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
    if (needsRefresh && refreshToken) {
      const newToken = await refreshGoogleToken(refreshToken);
      if (newToken) return { accessToken: newToken, managedProjectId };
      if (!expires || Date.now() > expires) return null;
    }

    return { accessToken, managedProjectId };
  } catch {
    return null;
  }
}

// Gemini thinking models return a `thoughtSignature` on each functionCall that
// MUST be echoed back when that call is replayed in the conversation history.
// OpenAI-compatible clients (e.g. OpenCode) strip this non-standard field, so we
// cache it keyed by the tool_call id we generate and re-inject it on the way up.
const GEMINI_THOUGHT_SIG_CACHE = new Map<string, string>();
const GEMINI_THOUGHT_SIG_CACHE_MAX = 500;

function cacheThoughtSignature(id: string, sig: string): void {
  if (GEMINI_THOUGHT_SIG_CACHE.size >= GEMINI_THOUGHT_SIG_CACHE_MAX) {
    const oldest = GEMINI_THOUGHT_SIG_CACHE.keys().next().value;
    if (oldest !== undefined) GEMINI_THOUGHT_SIG_CACHE.delete(oldest);
  }
  GEMINI_THOUGHT_SIG_CACHE.set(id, sig);
}

function convertOpenAIToGemini(
  messages: Array<{
    role: string;
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
      thought_signature?: string;
    }>;
    tool_call_id?: string;
  }>,
): {
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  systemInstruction?: { parts: Array<{ text: string }> };
} {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const nonSystemMsgs = messages.filter((m) => m.role !== "system");

  const systemInstruction =
    systemMsgs.length > 0
      ? { parts: systemMsgs.map((m) => ({ text: m.content || "" })) }
      : undefined;

  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

  for (const m of nonSystemMsgs) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          /* keep empty */
        }
        const fcPart: Record<string, unknown> = {
          functionCall: { name: tc.function.name, args },
        };
        const sig = tc.thought_signature ?? GEMINI_THOUGHT_SIG_CACHE.get(tc.id);
        if (sig) {
          fcPart.thought_signature = sig;
        }
        parts.push(fcPart);
      }
      contents.push({ role: "model", parts });
    } else if (m.role === "tool") {
      // Gemini expects functionResponse parts grouped under a single "user" turn
      const frPart = {
        functionResponse: {
          name: "tool_response",
          response: { content: m.content || "" },
        },
      };
      const prev = contents[contents.length - 1];
      if (prev && prev.role === "user" && prev.parts[0]?.functionResponse) {
        prev.parts.push(frPart);
      } else {
        contents.push({ role: "user", parts: [frPart] });
      }
    } else {
      let role = m.role;
      if (role === "assistant") role = "model";
      contents.push({ role, parts: [{ text: m.content || "" }] });
    }
  }

  return { contents, systemInstruction };
}

function convertGeminiChunkToOpenAI(chunk: string): string | null {
  if (!chunk.startsWith("data:")) return null;
  const payload = chunk.slice(5).trim();
  if (!payload) return null;

  try {
    let gemini = JSON.parse(payload);
    // Cloud Code Assist wraps responses in a "response" envelope
    if (gemini.response) gemini = gemini.response;
    const candidate = gemini.candidates?.[0];
    if (!candidate) return null;

    const parts = candidate.content?.parts ?? [];
    // Debug: log raw parts when they contain function calls
    if (parts.some((p: Record<string, unknown>) => p.functionCall)) {
      const fnNames = parts
        .filter((p: Record<string, unknown>) => p.functionCall)
        .map((p: Record<string, unknown>) => (p.functionCall as { name?: string }).name);
      console.warn("[proxy:gemini] functionCall(s):", fnNames.join(", "));
    }
    const text =
      parts.find((p: Record<string, unknown>) => typeof p.text === "string" && !p.thought)
        ?.text || "";
    const functionCalls = parts.filter(
      (p: Record<string, unknown>) => p.functionCall,
    ) as Array<{
      functionCall: { name: string; args: Record<string, unknown> };
      thought_signature?: string;
      thoughtSignature?: string;
    }>;
    const rawFinish = candidate.finishReason || null;
    const usage = gemini.usageMetadata;

    let finishReason: string | null = null;
    if (rawFinish) {
      if (rawFinish === "STOP")
        finishReason = functionCalls.length > 0 ? "tool_calls" : "stop";
      else if (rawFinish === "MAX_TOKENS") finishReason = "length";
      else finishReason = rawFinish.toLowerCase();
    }

    const delta: Record<string, unknown> = text ? { content: text } : {};
    if (functionCalls.length > 0) {
      delta.tool_calls = functionCalls.map((fc, i) => {
        const sig = fc.thought_signature ?? fc.thoughtSignature;
        const id = `call_gemini_${Date.now()}_${i}`;
        if (sig) cacheThoughtSignature(id, sig);
        return {
          index: i,
          id,
          type: "function",
          function: {
            name: fc.functionCall.name,
            arguments: JSON.stringify(fc.functionCall.args ?? {}),
          },
          ...(sig ? { thought_signature: sig } : {}),
        };
      });
    }

    const openai: Record<string, unknown> = {
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
          logprobs: null,
        },
      ],
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

function resolveReasoningStyle(model: string): "anthropic" | "openai" {
  const m = model.toLowerCase();
  if (m.includes("/")) return "openai";
  if (m.startsWith("claude-")) return "anthropic";
  if (
    m.startsWith("gpt-") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4")
  )
    return "openai";
  return "openai";
}

function resolveRoute(
  model: string,
  keys: Awaited<ReturnType<typeof readAllApiKeys>>,
): {
  targetUrl: string;
  headers: Record<string, string>;
  model?: string;
  provider: string;
} {
  // Aliases for Direct providers
  let upstreamModel = model;
  if (model === "claude-3-7-sonnet-latest") upstreamModel = "claude-3-7-sonnet-20250219";
  else if (model === "claude-3-5-sonnet-latest" || model === "claude-sonnet-4-6")
    upstreamModel = "claude-3-5-sonnet-20241022";
  else if (model === "claude-3-5-haiku-latest" || model === "claude-haiku-4-5")
    upstreamModel = "claude-3-5-haiku-20241022";
  else if (model === "claude-3-opus-latest" || model === "claude-opus-4-6")
    upstreamModel = "claude-3-opus-20240229";

  // Google Gemini via Cloud Code Assist (OAuth)
  if (model.startsWith("google/")) {
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
  // A provider/model id (e.g. "deepseek/deepseek-chat") needs OpenRouter. Without
  // a key it would silently fall through to local Ollama with an id Ollama can't
  // serve → opaque 404 on every call. Fail explicitly instead.
  if (model.includes("/")) {
    throw new Error(
      `Le modèle "${model}" (format fournisseur/modèle) nécessite une clé OpenRouter. Configure une clé OpenRouter, ou choisis un modèle direct (claude-*, gpt-*, google/*) ou un modèle Ollama local.`,
    );
  }
  if (model.startsWith("claude-")) {
    return {
      targetUrl: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": keys.anthropic ?? "", "anthropic-version": "2023-06-01" },
      model: upstreamModel,
      provider: "anthropic",
    };
  }
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) {
    // Note: for OpenAI o1 models, they might need different handling if they don't support reasoning_effort yet via standard API
    return {
      targetUrl: "https://api.openai.com/v1/chat/completions",
      headers: { Authorization: `Bearer ${keys.openai ?? ""}` },
      model: upstreamModel,
      provider: "openai",
    };
  }
  // Default (local) provider: Ollama. Validate the base URL so a tampered
  // ollamaUrl cannot turn the proxy into an SSRF deputy (cloud metadata, etc.).
  const ollamaUrl = isSafeOllamaUrl(keys.ollamaUrl)
    ? keys.ollamaUrl
    : "http://127.0.0.1:11434";
  return {
    targetUrl: `${ollamaUrl}/v1/chat/completions`,
    headers: {},
    provider: "ollama",
  };
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
    // --- Direct Models ---
    { id: "claude-3-7-sonnet-latest", object: "model", source: "direct" },
    { id: "claude-3-5-sonnet-latest", object: "model", source: "direct" },
    { id: "claude-3-5-haiku-latest", object: "model", source: "direct" },
    { id: "claude-3-opus-latest", object: "model", source: "direct" },
    { id: "claude-sonnet-4-6", object: "model", source: "direct" }, // Legacy Alias
    { id: "claude-opus-4-6", object: "model", source: "direct" }, // Legacy Alias
    { id: "claude-haiku-4-5", object: "model", source: "direct" }, // Legacy Alias
    { id: "gpt-4o", object: "model", source: "direct" },
    { id: "gpt-4o-mini", object: "model", source: "direct" },
    { id: "o1", object: "model", source: "direct" },
    { id: "o1-preview", object: "model", source: "direct" },
    { id: "o1-mini", object: "model", source: "direct" },
    { id: "o3-mini", object: "model", source: "direct" },

    // --- Gemini Models (Cloud Code Assist via OAuth) ---
    { id: "google/gemini-2.5-flash", object: "model", source: "gemini" },
    { id: "google/gemini-2.5-pro", object: "model", source: "gemini" },
    { id: "google/gemini-3-flash-preview", object: "model", source: "gemini" },
    { id: "google/gemini-3-pro-preview", object: "model", source: "gemini" },

    // --- OpenRouter Models ---
    { id: "anthropic/claude-3.7-sonnet", object: "model", source: "openrouter" },
    { id: "anthropic/claude-3.7-sonnet:thinking", object: "model", source: "openrouter" },
    { id: "anthropic/claude-opus-4", object: "model", source: "openrouter" },
    { id: "anthropic/claude-sonnet-4-5", object: "model", source: "openrouter" },
    { id: "openai/o1", object: "model", source: "openrouter" },
    { id: "openai/o3-mini", object: "model", source: "openrouter" },
    { id: "openai/gpt-4o", object: "model", source: "openrouter" },
    { id: "deepseek/deepseek-r1", object: "model", source: "openrouter" },
    { id: "deepseek/deepseek-chat", object: "model", source: "openrouter" },
    { id: "deepseek/deepseek-v3", object: "model", source: "openrouter" },
    { id: "deepseek/deepseek-v4-pro", object: "model", source: "openrouter" }, // Restored
    { id: "deepseek/deepseek-v4-flash", object: "model", source: "openrouter" }, // Restored
    { id: "meta-llama/llama-3.3-70b-instruct", object: "model", source: "openrouter" },
    {
      id: "google/gemini-2.0-flash-thinking-exp:free",
      object: "model",
      source: "openrouter",
    },

    // --- Local Models ---
    { id: "llama3", object: "model", source: "local" },
    { id: "mistral", object: "model", source: "local" },
  ];
}

async function buildModelList(
  keys: Awaited<ReturnType<typeof readAllApiKeys>>,
): Promise<Array<{ id: string; object: string; source: string }>> {
  const catalog = getFullModelCatalog();
  const catalogIds = new Set(catalog.map((c) => c.id));

  const available: Array<{ id: string; object: string; source: string }> = [];

  for (const m of catalog) {
    if (m.source === "direct") {
      const isAnthropic = m.id.startsWith("claude-") && !m.id.includes("/");
      const isOpenAI =
        m.id.startsWith("gpt-") || m.id.startsWith("o1") || m.id.startsWith("o3");
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
      const summary = await callModel(
        "workflow-deepseek-v4-flash",
        [
          { role: "system", content: "Résume en 5 mots." },
          { role: "user", content: assistantResponse },
        ],
        keys,
      );
      console.warn("[proxy:maintenance] Résumé de réponse:", summary);
    }

    console.warn("[proxy:maintenance] Extraction déclenchée (Background)");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[proxy:maintenance] Erreur:", errMsg);
  }
}
