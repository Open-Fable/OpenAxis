import express, { Request, Response, NextFunction } from "express";
import { randomBytes } from "crypto";
import { request as httpRequest } from "http";
import { homedir } from "os";
import { readAllApiKeys } from "../keychain.js";
import { getActiveProject } from "../project-store.js";
import { buildMemoryBlock } from "../memory-store.js";

const PROXY_PORT = 9999;
const PROXY_HOST = "127.0.0.1";

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

  app.get("/v1/models", async (_req, res) => {
    const keys = await readAllApiKeys();
    res.json({ object: "list", data: await buildModelList(keys) });
  });

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    try {
      const keys = await readAllApiKeys();
      const { model, ...rest } = req.body as { model: string; [k: string]: unknown };
      const { targetUrl, headers } = resolveRoute(model, keys);

      const messages = rest.messages as
        | Array<{ role: string; content: string }>
        | undefined;

      if (messages) {
        const memBlock = await buildMemoryBlock();
        if (memBlock) {
          const sysIdx = messages.findIndex((m) => m.role === "system");
          if (sysIdx >= 0) {
            messages[sysIdx] = {
              ...messages[sysIdx],
              content: memBlock + "\n\n" + messages[sysIdx].content,
            };
          } else {
            messages.unshift({ role: "system", content: memBlock });
          }
        }
      }

      const upstream = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ model, ...rest }),
      });

      res.status(upstream.status);
      upstream.headers.forEach((v, k) => res.setHeader(k, v));
      upstream.body?.pipeTo(
        new WritableStream({
          write: (chunk) => {
            res.write(chunk);
          },
          close: () => {
            res.end();
          },
        }),
      );
    } catch (err) {
      console.error("[proxy]", err);
      res.status(502).json({ error: "Bad gateway" });
    }
  });

  await new Promise<void>((resolve) => {
    app.listen(PROXY_PORT, PROXY_HOST, () => resolve());
  });

  console.warn(`[proxy] listening on ${PROXY_HOST}:${PROXY_PORT}`);
  return sessionToken;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

function resolveRoute(
  model: string,
  keys: Awaited<ReturnType<typeof readAllApiKeys>>,
): { targetUrl: string; headers: Record<string, string> } {
  // OpenRouter models use provider/model-name format
  if (model.includes("/") && keys.openrouterKey) {
    return {
      targetUrl: `${OPENROUTER_BASE}/chat/completions`,
      headers: { Authorization: `Bearer ${keys.openrouterKey}` },
    };
  }
  if (model.startsWith("claude-")) {
    return {
      targetUrl: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": keys.anthropic ?? "", "anthropic-version": "2023-06-01" },
    };
  }
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) {
    return {
      targetUrl: "https://api.openai.com/v1/chat/completions",
      headers: { Authorization: `Bearer ${keys.openai ?? ""}` },
    };
  }
  return { targetUrl: `${keys.ollamaUrl}/v1/chat/completions`, headers: {} };
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
      signal: AbortSignal.timeout(8000),
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

async function buildModelList(
  keys: Awaited<ReturnType<typeof readAllApiKeys>>,
): Promise<Array<{ id: string; object: string }>> {
  const direct: string[] = [];
  if (keys.anthropic)
    direct.push("claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5");
  if (keys.openai) direct.push("gpt-4o", "gpt-4o-mini", "o3-mini");
  direct.push("llama3", "mistral", "phi3");

  const orModels = keys.openrouterKey
    ? await fetchOpenRouterModels(keys.openrouterKey)
    : [];

  return [...direct.map((id) => ({ id, object: "model" })), ...orModels];
}
