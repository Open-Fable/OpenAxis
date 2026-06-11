import express, { Request, Response, NextFunction } from "express";
import { randomBytes } from "crypto";
import { request as httpRequest } from "http";
import { homedir } from "os";
import { promises as fs } from "fs";
import path from "path";
import { readAllApiKeys } from "../keychain.js";
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

  // ── Cache Metrics endpoints (no auth — called by sidebar) ──
  app.get("/v1/cache/metrics", (_req, res) => {
    res.json(getCacheMetrics());
  });
  app.post("/v1/cache/reset", (_req, res) => {
    resetCacheMetrics();
    res.json({ ok: true });
  });

  // Returns the model from the most recent chat completion request + whether it supports reasoning
  // Placed before auth middleware so the OpenCode page can read it without a token
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

  // ── Assistant Orchestrateur (no auth needed, uses openhub-local token) ──
  app.post("/v1/orch/assistant", async (req: Request, res: Response) => {
    const { messages, context, questionRounds: qRounds, model: reqModel } = req.body;
    const questionRounds: number = typeof qRounds === "number" ? qRounds : 0;
    const MAX_QUESTION_ROUNDS = 3;
    const settings = await loadOrchSettings();
    const model = reqModel || settings.assistantModel || "deepseek/deepseek-v4-flash";

    const projects = context?.projects || [];
    const workflows = context?.workflows || [];
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
Utilise ce format structuré pour poser plusieurs questions à la fois :

\`\`\`questions
{"questions": [
  {"text": "As-tu déjà une charte graphique (couleurs, logo, polices) ?", "options": ["Oui", "Non", "Je ne sais pas"], "allowCustom": true},
  {"text": "As-tu déjà du contenu (textes, images, vidéos) ?", "options": ["Oui", "Non", "Un peu"], "allowCustom": false},
  {"text": "Quel est ton objectif principal ?", "options": ["Vendre en ligne", "Présenter mon activité", "Blog / Information", "Application interactive"], "allowCustom": true}
]}
\`\`\`

Règles pour les questions :
- Pose autant de questions que nécessaire (entre 1 et 15) pour bien comprendre le besoin
- Chaque question doit avoir 2 à 5 options de réponse
- Quand l'utilisateur répond, utilise sa réponse pour adapter ta proposition
- Si l'utilisateur répond "Je ne sais pas", prend une décision raisonnable à sa place
- Les questions doivent être simples, avec des mots de tous les jours
- Tu peux poser des questions de suivi après les réponses de l'utilisateur si tu as besoin de plus de détails
- Tu as le droit à ${MAX_QUESTION_ROUNDS} tours de questions maximum dans une conversation
- Tu as déjà posé ${questionRounds} tour(s) de questions${questionRounds >= MAX_QUESTION_ROUNDS ? "\n- TU AS ATTEINT LA LIMITE DE QUESTIONS. Ne pose PLUS de questions. Utilise les informations disponibles pour proposer directement des projets." : questionRounds === MAX_QUESTION_ROUNDS - 1 ? "\n- C'est ton DERNIER tour de questions possible. Après celui-ci, tu devras proposer directement." : ""}

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

Créer un agent et le lier au workflow actif :
\`\`\`action
{"type": "create_project", "name": "Nom du projet", "instructions": "Instructions détaillées...", "agentType": "code", "linkToWf": true, "auto": true}
\`\`\`

Lier un agent EXISTANT au workflow actif (utilise l'id du projet depuis le contexte) :
\`\`\`action
{"type": "link_project", "projectId": "id-du-projet", "auto": true}
\`\`\`

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
${contextBlock}`;

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
          res
            .status(401)
            .json({
              error:
                "Token Google expiré — lance 'opencode auth login' dans un terminal pour te reconnecter",
            });
          return;
        }
        headers["Authorization"] = `Bearer ${googleAuth.accessToken}`;

        const { contents, systemInstruction } = convertOpenAIToGemini(allMessages);
        const innerRequest: Record<string, unknown> = {
          contents,
          generationConfig: { temperature: 0.3 },
        };
        if (systemInstruction) innerRequest.systemInstruction = systemInstruction;
        requestBody = JSON.stringify({
          project: googleAuth.managedProjectId,
          model: upstreamModel ?? model.replace("google/", ""),
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
          .json({ error: `Upstream error: ${errorText.substring(0, 200)}` });
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

            const textParts: string[] = [];
            for (const part of parts) {
              if (part.type === "text" && part.text) {
                textParts.push(part.text);
              } else if (part.type === "image_url" && part.image_url?.url) {
                try {
                  const description = await describeImage(
                    part.image_url.url,
                    visionConfig,
                  );
                  textParts.push(
                    formatDescriptionForDeepSeek(
                      description,
                      visionConfig.visionDetailLevel,
                    ),
                  );
                } catch (err) {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  console.warn("[proxy:vision] Erreur describeImage:", errMsg);
                  textParts.push("[Image non analysée — erreur Ollama]");
                }
              }
            }

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
        headers["Authorization"] = `Bearer ${googleAuth.accessToken}`;

        const finalMsgs = (rest.messages ?? []) as Array<{
          role: string;
          content: string;
        }>;
        const geminiModel = upstreamModel ?? model.replace("google/", "");
        const { contents, systemInstruction } = convertOpenAIToGemini(finalMsgs);
        const innerRequest: Record<string, unknown> = {
          contents,
          generationConfig: {
            temperature: (rest.temperature as number) ?? 0.7,
            ...(rest.max_tokens ? { maxOutputTokens: rest.max_tokens as number } : {}),
          },
        };
        if (systemInstruction) innerRequest.systemInstruction = systemInstruction;
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
        upstream.headers.forEach((v, k) => {
          // Skip headers that would cause the client to misread the body
          const lower = k.toLowerCase();
          if (lower === "content-encoding") return;
          if (lower === "transfer-encoding") return;
          if (lower === "content-length") return;
          res.setHeader(k, v);
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
          for (const ch of accumulatedChunks) {
            const m = ch.match(/data: (.+)/);
            if (m) {
              try {
                const p = JSON.parse(m[1]);
                if (p.choices?.[0]?.delta?.content) {
                  fullContent += p.choices[0].delta.content;
                }
                if (p.usage) finalUsage = p.usage;
              } catch {
                /* ignore */
              }
            }
          }
          const response: Record<string, unknown> = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: upstreamModel ?? model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: fullContent || fullResponseContent,
                },
                finish_reason: "stop",
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
      res.status(502).json({ error: `Bad gateway — ${errorType}` });
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
    console.log(
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

type GoogleAuth = { accessToken: string; managedProjectId: string } | null;

const OPENCODE_AUTH_URL = "https://console.opencode.ai";
const OPENCODE_CLIENT_ID = "opencode-cli";
const AUTH_JSON_PATH = path.join(homedir(), ".local", "share", "opencode", "auth.json");
const ACCOUNT_JSON_PATH = path.join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "account.json",
);

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
          { credential?: { access?: string; refresh?: string; type?: string } }
        >;
        active?: { google?: string };
      };
      const activeId = parsed.active?.google;
      const cred = activeId ? parsed.accounts?.[activeId]?.credential : undefined;
      if (cred?.access) {
        return {
          accessToken: cred.access,
          refreshToken: cred.refresh ?? null,
          expires: 0,
        };
      }
    } catch {
      /* no fallback */
    }
  }
  return { accessToken: null, refreshToken: null, expires: 0 };
}

async function refreshGoogleToken(refreshToken: string): Promise<string | null> {
  // Try opencode backend first (works for tokens obtained via opencode auth login)
  try {
    const resp = await fetch(`${OPENCODE_AUTH_URL}/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OPENCODE_CLIENT_ID,
      }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (data.access_token) {
        const newExpires = Date.now() + (data.expires_in ?? 3600) * 1000;
        const existingRaw = await fs.readFile(AUTH_JSON_PATH, "utf-8").catch(() => "{}");
        const existing = JSON.parse(existingRaw) as Record<string, unknown>;
        const google = (existing.google ?? {}) as Record<string, unknown>;
        const updated = {
          ...existing,
          google: {
            ...google,
            access: data.access_token,
            ...(data.refresh_token ? { refresh: data.refresh_token } : {}),
            expires: newExpires,
          },
        };
        await fs.writeFile(AUTH_JSON_PATH, JSON.stringify(updated, null, 2), "utf-8");
        console.log("[proxy] Google OAuth token refreshed via opencode backend");
        return data.access_token;
      }
    }
  } catch {
    /* backend refresh failed, continue */
  }

  console.warn(
    "[proxy] Google OAuth token expired — run 'opencode auth login' to refresh",
  );
  return null;
}

async function getGoogleAuth(): Promise<GoogleAuth> {
  try {
    const { accessToken, refreshToken, expires } = await readGoogleAuthFile();
    if (!accessToken) return null;

    const parts = (refreshToken ?? "").split("|");
    const managedProjectId = parts[2] || parts[1] || "";

    const isExpired = expires > 0 && Date.now() > expires;
    if (isExpired && refreshToken) {
      const newToken = await refreshGoogleToken(refreshToken);
      if (newToken) return { accessToken: newToken, managedProjectId };
      // Token expired and refresh failed — return null so callers show a clear message
      return null;
    }

    return { accessToken, managedProjectId };
  } catch {
    return null;
  }
}

function convertOpenAIToGemini(messages: Array<{ role: string; content: string }>): {
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  systemInstruction?: { parts: Array<{ text: string }> };
} {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const nonSystemMsgs = messages.filter((m) => m.role !== "system");

  const systemInstruction =
    systemMsgs.length > 0
      ? { parts: systemMsgs.map((m) => ({ text: m.content })) }
      : undefined;

  const contents = nonSystemMsgs.map((m) => {
    let role = m.role;
    if (role === "assistant") role = "model";
    return { role, parts: [{ text: m.content }] };
  });

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
      choices: [
        {
          index: 0,
          delta: text ? { content: text } : {},
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
  return {
    targetUrl: `${keys.ollamaUrl}/v1/chat/completions`,
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
