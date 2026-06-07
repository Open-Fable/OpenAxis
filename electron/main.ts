import { app, BrowserWindow, ipcMain, dialog, shell, WebContentsView } from "electron";
import path from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import { exec } from "child_process";
import { ProcessManager } from "./process-manager.js";
import { startProxy, getActiveWorkspaceDir } from "./proxy/index.js";
import { loadOverrides } from "./override-loader.js";
import { generateOpenCodeConfig } from "./config-generator.js";
import { readSecret } from "./keychain.js";
import { registerOllamaHandlers } from "./ollama-manager.js";
import {
  getProjects,
  saveProject,
  deleteProject,
  setActiveProject,
  getActiveProject,
} from "./project-store.js";
import {
  getMemory,
  setEnabled as setMemoryEnabled,
  setAutoExtract as setMemoryAutoExtract,
  setProfile as setMemoryProfile,
  addFact,
  removeFact,
  updateFact,
} from "./memory-store.js";
import type { SlotName } from "./types.js";
import { OrchestratorRunner } from "./orchestrator-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HEADER_HEIGHT = 82;
const MIN_WIDTH = 550;
const MIN_HEIGHT = 450;

// Use localhost (not 127.0.0.1) — Vite/opencode bind to ::1 (IPv6) on modern macOS
const SLOT_URLS: Record<Exclude<SlotName, "config" | "chat" | "projects">, string> = {
  work: "http://localhost:5173",
  code: "http://127.0.0.1:4096",
  design: "", // captured at spawn
};

let mainWindow: BrowserWindow | null = null;
const views = new Map<SlotName, WebContentsView>();
let activeSlot: SlotName = "work";
let processManager: ProcessManager | null = null;
let proxyToken = "";

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#18181E",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      // sidebar.html is our own code — no sandbox needed here
      // WebContentsViews (external apps) keep sandbox: true
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.warn(
      `[sidebar:console] [level:${level}] ${message} (at ${sourceId}:${line})`,
    );
  });

  await mainWindow.loadFile(path.join(__dirname, "sidebar.html"));

  mainWindow.on("resize", () => repositionViews());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createSlotView(
  slot: Exclude<SlotName, "config" | "chat" | "projects">,
): WebContentsView {
      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          preload: path.join(__dirname, "preload.js"),
          partition: "persist:chat",
        },
      });

  view.webContents.on("did-navigate", () => injectOverrides(slot, view));
  view.webContents.on("did-navigate-in-page", () => injectOverrides(slot, view));

  // Block drag-and-drop navigation to local files or other unsafe protocols
  view.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      event.preventDefault();
      console.warn(`[main] Blocked navigation in slot "${slot}" to: ${url}`);
    }
  });

  // OAuth + external links: open in system browser instead of Electron popup
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  view.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    // Only log warnings and errors to avoid spam
    if (level >= 2 && !message.includes("Network.streamResourceContent failed")) {
      console.warn(`[${slot}:console] [${level}] ${message} (${sourceId}:${line})`);
    }
  });

  return view;
}

async function injectOverrides(
  slot: Exclude<SlotName, "config" | "chat" | "projects">,
  view: WebContentsView,
): Promise<void> {
  const cssBlocks = await loadOverrides(slot, "css");
  for (const css of cssBlocks) {
    await view.webContents.insertCSS(css);
  }
  const jsBlocks = await loadOverrides(slot, "js");
  for (const js of jsBlocks) {
    await view.webContents.executeJavaScript(js);
  }
}

async function loadViewUrl(view: WebContentsView, url: string): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      console.warn(`[main] loadURL attempt ${attempt}/6: ${url}`);
      await view.webContents.loadURL(url);
      console.warn(`[main] loadURL success: ${url}`);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      console.error(`[main] loadURL failed (${code}): ${url}`);
      if (code === "ERR_CONNECTION_REFUSED" && attempt < 6) {
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        throw err;
      }
    }
  }
}

let configOpen = false;

function repositionViews(): void {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  const contentY = HEADER_HEIGHT;
  const contentHeight = height - HEADER_HEIGHT;

  for (const [slot, view] of views) {
    const isActive = slot === activeSlot;
    // Hide active view when config modal is open so sidebar.html shows through
    view.setVisible(isActive && !configOpen);
    if (isActive) {
      view.setBounds({ x: 0, y: contentY, width: width, height: contentHeight });
    }
  }
}

ipcMain.on("config-visibility", (_e, open: boolean) => {
  configOpen = open;
  repositionViews();
});

async function switchSlot(slot: SlotName): Promise<void> {
  console.warn(`\n[main] ── switchSlot("${slot}") ──`);

  if (slot === "config") {
    console.warn(`[main] opening config panel`);
    mainWindow?.webContents.send("show-config");
    return;
  }

  if (!mainWindow) return;

  if (slot === "chat") {
    if (!views.has("chat")) {
      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          preload: path.join(__dirname, "preload.js"),
        },
      });
      view.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("http://") || url.startsWith("https://")) {
          shell.openExternal(url);
        }
        return { action: "deny" };
      });
      view.webContents.on("console-message", (_e, level, message, line, sourceId) => {
        console.warn(
          `[chat:console] [level:${level}] ${message} (at ${sourceId}:${line})`,
        );
      });
      mainWindow.contentView.addChildView(view);
      views.set("chat", view);
      await view.webContents.loadFile(path.join(__dirname, "chat.html"));
    } else {
      mainWindow.contentView.addChildView(views.get("chat")!);
    }
    activeSlot = "chat";
    repositionViews();
    mainWindow.webContents.send("slot-changed", "chat");
    mainWindow.setTitle("OpenHub — Chat");
    return;
  }

  if (slot === "projects") {
    if (!views.has("projects")) {
      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          preload: path.join(__dirname, "preload.js"),
        },
      });
      view.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("http://") || url.startsWith("https://")) {
          shell.openExternal(url);
        }
        return { action: "deny" };
      });
      view.webContents.on("console-message", (_e, level, message, line, sourceId) => {
        console.warn(
          `[projects:console] [level:${level}] ${message} (at ${sourceId}:${line})`,
        );
      });
      mainWindow.contentView.addChildView(view);
      views.set("projects", view);
      await view.webContents.loadFile(path.join(__dirname, "projects.html"));
    } else {
      mainWindow.contentView.addChildView(views.get("projects")!);
    }
    activeSlot = "projects";
    repositionViews();
    mainWindow.webContents.send("slot-changed", "projects");
    mainWindow.setTitle("OpenHub — Projets");
    return;
  }

  // Start the service (or reuse if already running)
  if (processManager) {
    console.warn(`[main] ensureRunning("${slot}")...`);
    const port = await processManager.ensureRunning(slot);
    console.warn(`[main] ensureRunning("${slot}") → port ${port}`);
    if (port !== null && slot === "design") {
      SLOT_URLS[slot] = `http://localhost:${port}`;
    } else if (port !== null && slot === "code") {
      // opencode binds to 127.0.0.1 (IPv4) — use explicit IP so Chromium doesn't try ::1
      SLOT_URLS[slot] = `http://127.0.0.1:${port}`;
    }
  }

  const url = SLOT_URLS[slot];
  console.warn(`[main] slot url: ${url || "(empty)"}`);

  if (!views.has(slot)) {
    console.warn(`[main] creating new WebContentsView for "${slot}"`);
    const view = createSlotView(slot);
    mainWindow.contentView.addChildView(view);
    views.set(slot, view);

    if (url) {
      await loadViewUrl(view, url);
    }
  } else {
    const view = views.get(slot)!;
    const currentUrl = view.webContents.getURL();
    console.warn(`[main] existing view current url: "${currentUrl}"`);

    // Re-add to bring to front (Electron stacks views in add order)
    mainWindow.contentView.addChildView(view);

    const needsLoad =
      !currentUrl ||
      currentUrl === "about:blank" ||
      currentUrl.startsWith("chrome-error://");
    if (needsLoad && url) await loadViewUrl(view, url);
  }

  activeSlot = slot;
  repositionViews();
  mainWindow.webContents.send("slot-changed", slot);

  const slotTitles: Record<string, string> = {
    work: "OpenHub — Work",
    code: "OpenHub — Code",
    design: "OpenHub — Design",
    chat: "OpenHub — Chat",
  };
  mainWindow.setTitle(slotTitles[slot] ?? "OpenHub");

  console.warn(`[main] ── switchSlot("${slot}") done ──\n`);
}

ipcMain.handle("switch-slot", (_e, slot: SlotName) => switchSlot(slot));

ipcMain.handle("export-pdf", async () => {
  const view = views.get(activeSlot as Exclude<SlotName, "config">);
  if (!view) return;

  const { filePath } = await dialog.showSaveDialog({
    defaultPath: "export.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });

  if (!filePath) return;

  const pdf = await view.webContents.printToPDF({ printBackground: true });
  await fs.writeFile(filePath, pdf);
});

ipcMain.handle("get-slot-status", () => processManager?.getStatus() ?? {});

// OpenWork desktop bridge — polyfills window.__OPENWORK_ELECTRON__.invokeDesktop()
ipcMain.handle(
  "openwork-desktop-invoke",
  async (_e, command: string, ...args: unknown[]) => {
    switch (command) {
      case "pickDirectory": {
        const result = await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      }
      case "pickFile": {
        const result = await dialog.showOpenDialog({
          properties: ["openFile"],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      }
      // ── OpenWork boot ──────────────────────────────────────────────────────
      // workspaceBootstrap: return a default local workspace so OpenWork skips
      // the welcome/create-workspace screen and boots directly into the main UI.
      // A pre-populated workspace also routes the boot through runtimeBootstrap
      // (Electron path) which we handle with skipped=true → instant markReady().
      case "workspaceBootstrap":
        return {
          workspaces: [
            {
              id: "openhub-default",
              name: "OpenHub",
              path: homedir(),
              preset: "default",
              workspaceType: "local",
              displayName: "OpenHub",
            },
          ],
          selectedId: "openhub-default",
          activeId: "openhub-default",
        };

      // openworkServerRestart/Info: point to our running opencode serve
      // isOpenworkServerReady() requires running=true + baseUrl + ownerToken
      case "openworkServerRestart":
      case "openworkServerInfo":
        return {
          running: true,
          baseUrl: "http://127.0.0.1:9999",
          ownerToken: "openhub-local",
          clientToken: "openhub-local",
          port: 9999,
          remoteAccessEnabled: false,
        };

      // runtimeBootstrap (Electron path): skipped=true bypasses server check
      case "runtimeBootstrap":
        return {
          ok: true,
          skipped: true,
          openworkServer: {
            running: true,
            baseUrl: "http://127.0.0.1:4096",
            ownerToken: "openhub-local",
            clientToken: "openhub-local",
            port: 4096,
            remoteAccessEnabled: false,
          },
          engine: { baseUrl: "http://127.0.0.1:4096" },
        };

      // ── OpenWork engine ────────────────────────────────────────────────────
      // engineInfo / engineStart: report opencode serve as the running engine
      case "engineInfo":
      case "engineStart":
        return {
          running: true,
          runtime: "direct",
          baseUrl: "http://127.0.0.1:4096",
          projectDir: (args[0] as string) || null,
          hostname: "127.0.0.1",
          port: 4096,
          opencodeUsername: null,
          opencodePassword: null,
          opencodeBinPath: null,
          opencodeBinSource: null,
          pid: null,
          lastStdout: null,
          lastStderr: null,
          execution: null,
        };

      // ── OpenWork workspace mutations ───────────────────────────────────────
      case "workspaceCreate": {
        const wsPath = (args[0] as string) ?? "";
        return {
          id: `openhub-${Date.now()}`,
          name: wsPath.split("/").pop() || "workspace",
          path: wsPath,
          preset: "default",
          workspaceType: "local",
          displayName: wsPath.split("/").pop() || "workspace",
        };
      }
      case "workspaceSetSelected":
      case "workspaceSetRuntimeActive":
      case "workspaceUpdateDisplayName":
      case "workspaceForget":
      case "workspaceAddAuthorizedRoot":
      case "engineStop":
      case "engineRestart":
        return { ok: true };

      // ── Electron update stubs (suppress "not in Electron desktop app" toast) ──
      case "checkForUpdates":
      case "getUpdateStatus":
      case "installUpdate":
      case "quitAndInstall":
        return { available: false, checking: false, version: null };

      case "__homeDir":
        return homedir();
      case "__joinPath":
        return path.join(...(args as string[]));
      case "__openPath":
        return shell.openPath(args[0] as string);
      case "__revealItemInDir":
        shell.showItemInFolder(args[0] as string);
        return null;
      default:
        return null;
    }
  },
);

// ── Project management ──────────────────────────────────────────────────────
ipcMain.handle("get-projects", () => getProjects());
ipcMain.handle("get-active-project", () => getActiveProject());
ipcMain.handle("set-active-project", (_e, id: string | null) => setActiveProject(id));
ipcMain.handle(
  "save-project",
  (_e, project: { id?: string; name: string; instructions: string; color: string }) =>
    saveProject(project),
);
ipcMain.handle("delete-project", (_e, id: string) => deleteProject(id));

let runner: OrchestratorRunner | null = null;
ipcMain.handle("execute-orchestration", async (_e, id: string, task: string) => {
  if (!runner) {
    runner = new OrchestratorRunner((update) => {
      mainWindow?.webContents.send("orchestration-status", update);
      const projView = views.get("projects");
      if (projView) {
        projView.webContents.send("orchestration-status", update);
      }
    });
  }
  await runner.run(id, task);
});

// ── Chat backup (file-system persistence for conversations) ─────────────────
const CHAT_BACKUP_PATH = path.join(homedir(), ".config", "openhub", "chat-backup.json");
ipcMain.handle("read-chat-backup", async () => {
  try {
    return await fs.readFile(CHAT_BACKUP_PATH, "utf-8");
  } catch {
    return null;
  }
});
ipcMain.handle("write-chat-backup", async (_e, data: string) => {
  try {
    await fs.mkdir(path.dirname(CHAT_BACKUP_PATH), { recursive: true });
    await fs.writeFile(CHAT_BACKUP_PATH, data, "utf-8");
    return true;
  } catch {
    return false;
  }
});

// ── Memory management ───────────────────────────────────────────────────────
ipcMain.handle("get-memory", () => getMemory());
ipcMain.handle("set-memory-enabled", (_e, enabled: boolean) => setMemoryEnabled(enabled));
ipcMain.handle("set-memory-auto-extract", (_e, enabled: boolean) =>
  setMemoryAutoExtract(enabled),
);
ipcMain.handle("set-memory-profile", (_e, profile: string) => setMemoryProfile(profile));
ipcMain.handle("add-memory-fact", (_e, text: string, tags: string[]) =>
  addFact(text, tags),
);
ipcMain.handle("remove-memory-fact", (_e, id: string) => removeFact(id));
ipcMain.handle(
  "update-memory-fact",
  (_e, id: string, patch: { text?: string; tags?: string[] }) => updateFact(id, patch),
);

// ── Workspace Skills management ─────────────────────────────────────────────
ipcMain.handle("get-skills", async () => {
  const workspaceDir = getActiveWorkspaceDir();
  const skillsDir = path.join(workspaceDir, ".openhub", "skills");
  try {
    await fs.mkdir(skillsDir, { recursive: true });
    const files = await fs.readdir(skillsDir);
    const skillFiles = files.filter((f) => f.endsWith(".md"));
    const skills = [];
    for (const file of skillFiles) {
      try {
        const content = await fs.readFile(path.join(skillsDir, file), "utf-8");
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : file;
        skills.push({ filename: file, title, content });
      } catch {}
    }
    return skills;
  } catch {
    return [];
  }
});

ipcMain.handle(
  "save-skill",
  async (_e, skill: { filename?: string; title: string; content: string }) => {
    const workspaceDir = getActiveWorkspaceDir();
    const skillsDir = path.join(workspaceDir, ".openhub", "skills");
    await fs.mkdir(skillsDir, { recursive: true });

    const sanitize = (name: string): string => {
      return name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    };

    const filename = skill.filename || `${sanitize(skill.title)}.md`;
    const safeFilename = filename.endsWith(".md") ? filename : `${filename}.md`;
    const cleanFilename = sanitize(safeFilename.slice(0, -3)) + ".md";

    let finalContent = skill.content.trim();
    if (!finalContent.startsWith("# ")) {
      finalContent = `# ${skill.title}\n\n${finalContent}`;
    }

    const filePath = path.join(skillsDir, cleanFilename);
    await fs.writeFile(filePath, finalContent, "utf-8");
    return { ok: true, filename: cleanFilename };
  },
);

ipcMain.handle("delete-skill", async (_e, filename: string) => {
  const workspaceDir = getActiveWorkspaceDir();
  const skillsDir = path.join(workspaceDir, ".openhub", "skills");
  const cleanFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!cleanFilename || cleanFilename.includes("..")) {
    throw new Error("Invalid filename");
  }
  const filePath = path.join(skillsDir, cleanFilename);
  try {
    await fs.unlink(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("get-chat-config", () => ({
  proxyUrl: "http://127.0.0.1:9999",
  token: proxyToken,
}));

ipcMain.handle("export-html-to-pdf", async (_e, html: string) => {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });

  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

    const { filePath } = await dialog.showSaveDialog({
      defaultPath: "document.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });

    if (!filePath) return false;

    const { promises: fs } = await import("fs");
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
    });
    await fs.writeFile(filePath, pdf);
    return true;
  } finally {
    win.destroy();
  }
});

interface BraveSearchResultItem {
  title: string;
  url: string;
  description?: string;
  snippet?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResultItem[];
  };
}

function cleanSearchQuery(query: string): string {
  let cleaned = query.trim();
  
  // Remove quotes
  cleaned = cleaned.replace(/['"«»„“]+|&quot;/g, "");
  
  // Remove common prefix filler phrases (French)
  cleaned = cleaned.replace(/^(fait|fais|ecris|rédige|redige|cherche|trouve|explique|donne)\s+(moi|nous)?\s*(un|une|des)?\s*(essai|essais|resume|résumé|explication|recherche|information|informations|details|détails)?\s*(sur|de|concernant|a propos de|à propos de)\s+/i, "");
  cleaned = cleaned.replace(/^(qu'est-ce que|qu'est ce que|qui est|quel est|quels sont|quelle est|quelles sont)\s+/i, "");
  cleaned = cleaned.replace(/^(peux-tu|peux tu|pourrais-tu|pourrais tu)\s+(me|nous)?\s*(chercher|trouver|expliquer|dire|faire)\s+/i, "");
  
  // Remove common prefix filler phrases (English)
  cleaned = cleaned.replace(/^(write|make|create|do|search|find|explain|give)\s+(me|us)?\s*(a|an|the)?\s*(essay|summary|explanation|search|information|details)?\s*(on|about|for|of)\s+/i, "");
  cleaned = cleaned.replace(/^(what is|who is|which is|what are|who are|which are)\s+/i, "");
  cleaned = cleaned.replace(/^(can you|could you)\s+(search|find|explain|tell|do)\s+/i, "");
  
  // Replace "3eme" or "3ème" or "3e" followed by "guerre" with "troisieme guerre" to avoid school grade confusion
  cleaned = cleaned.replace(/\b3(eme|ème|e)?\s+guerre\b/i, "troisieme guerre");
  
  return cleaned.trim() || query;
}

ipcMain.handle("web-search", async (_e, query: string) => {
  const { readSecret } = await import("./keychain.js");
  const braveSearchKey = await readSecret("openhub", "brave-search-key");
  if (braveSearchKey === null || braveSearchKey === "") {
    throw new Error(
      "Clé Brave Search manquante. Veuillez la configurer dans l'onglet Config ⚙️.",
    );
  }

  const cleanedQuery = cleanSearchQuery(query);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(cleanedQuery)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": braveSearchKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Erreur Brave Search (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as BraveSearchResponse;
  const results =
    data.web?.results?.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? r.snippet ?? "",
    })) ?? [];

  return results;
});

ipcMain.handle("get-api-keys", async () => {
  const { readAllApiKeys } = await import("./keychain.js");
  return readAllApiKeys();
});

ipcMain.handle("save-api-keys", async (_e, keys: Record<string, string>) => {
  const { writeSecret } = await import("./keychain.js");
  const map: Record<string, string> = {
    anthropic: "anthropic-api-key",
    openai: "openai-api-key",
    openrouterKey: "openrouter-api-key",
    googleAiKey: "google-ai-key",
    ollamaUrl: "ollama-url",
    githubToken: "github-token",
    braveSearchKey: "brave-search-key",
  };
  for (const [field, account] of Object.entries(map)) {
    if (keys[field]) await writeSecret("openhub", account, keys[field]);
  }
  // Notify chat view to refresh its model list
  const chatView = views.get("chat");
  if (chatView) chatView.webContents.send("api-keys-updated");
});

// ── Open Design Native Bridge Handlers ──────────────────────────────────────
ipcMain.handle(
  "od-dialog:pick-and-import",
  async (
    _event,
    init: {
      name?: string;
      skillId?: string | null;
      designSystemId?: string | null;
    } | null,
  ) => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      const baseDir = result.filePaths[0].trim();
      if (baseDir.length === 0) {
        return { ok: false, reason: "picker returned an empty path" };
      }

      const body: Record<string, unknown> = { baseDir };
      if (init !== null && init !== undefined) {
        if (init.name !== undefined && init.name !== null && init.name.trim() !== "") {
          body.name = init.name;
        }
        if (init.skillId !== undefined && init.skillId !== null) {
          body.skillId = init.skillId;
        }
        if (init.designSystemId !== undefined && init.designSystemId !== null) {
          body.designSystemId = init.designSystemId;
        }
      }

      const response = await fetch("http://localhost:7456/api/import/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (response.ok !== true) {
        const status = response.status;
        let details: unknown = {};
        try {
          details = await response.json();
        } catch {
          // ignore
        }
        return {
          ok: false,
          reason: `daemon returned HTTP ${status}`,
          details,
        };
      }

      const responseBody = await response.json();
      return { ok: true, response: responseBody };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  },
);

ipcMain.handle(
  "od-dialog:pick-and-replace-working-dir",
  async (_event, init: { projectId?: string } | null) => {
    try {
      const projectId =
        init !== null && init !== undefined && typeof init.projectId === "string"
          ? init.projectId
          : "";
      if (projectId.length === 0) {
        return { ok: false, reason: "project id is required" };
      }

      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      const baseDir = result.filePaths[0].trim();
      if (baseDir.length === 0) {
        return { ok: false, reason: "picker returned an empty path" };
      }

      const response = await fetch(
        `http://localhost:7456/api/projects/${encodeURIComponent(projectId)}/working-dir`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseDir }),
        },
      );

      if (response.ok !== true) {
        const status = response.status;
        let details: unknown = {};
        try {
          details = await response.json();
        } catch {
          // ignore
        }
        return {
          ok: false,
          reason: `daemon returned HTTP ${status}`,
          details,
        };
      }

      const responseBody = await response.json();
      return { ok: true, response: responseBody };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  },
);

ipcMain.handle("od-shell:open-external", async (_event, url: string) => {
  if (
    typeof url !== "string" ||
    (!url.startsWith("http://") && !url.startsWith("https://"))
  ) {
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("od-shell:open-path", async (_event, projectId: string) => {
  if (typeof projectId !== "string" || projectId.length === 0) {
    return "open-path: project id is required";
  }
  try {
    const res = await fetch(
      `http://localhost:7456/api/projects/${encodeURIComponent(projectId)}`,
    );
    if (res.ok !== true) {
      return `open-path: project not found (${res.status})`;
    }
    const data = (await res.json()) as { project?: { metadata?: { baseDir?: string } } };
    const baseDir = data?.project?.metadata?.baseDir;
    if (baseDir === undefined || baseDir === null || baseDir === "") {
      return "open-path: no working directory configured for this project";
    }
    const err = await shell.openPath(baseDir);
    return err;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
});

ipcMain.handle("od-pdf:print", async (_event, html: string) => {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });

  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

    const { filePath } = await dialog.showSaveDialog({
      defaultPath: "document.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });

    if (filePath === undefined || filePath === null || filePath === "") {
      return false;
    }

    const { promises: fs } = await import("fs");
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
    });
    await fs.writeFile(filePath, pdf);
    return true;
  } finally {
    win.destroy();
  }
});

interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseSemver(tag: string, appName: string): Semver | null {
  let versionStr = tag;
  if (appName === "open-design") {
    const match = tag.match(/^open-design-v?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/);
    if (!match) return null;
    versionStr = match[1];
  } else if (appName === "opencode") {
    if (tag.startsWith("vscode-")) return null;
    const match = tag.match(/^v?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/);
    if (!match) return null;
    versionStr = match[1];
  } else if (appName === "openwork") {
    if (
      tag.includes("-dev") ||
      tag.startsWith("openwork-orchestrator-") ||
      tag.startsWith("openwrk-")
    )
      return null;
    const match = tag.match(/^v?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/);
    if (!match) return null;
    versionStr = match[1];
  } else {
    return null;
  }

  const parts = versionStr.split("-");
  const mainParts = parts[0].split(".");
  if (mainParts.length !== 3) return null;

  const major = parseInt(mainParts[0], 10);
  const minor = parseInt(mainParts[1], 10);
  const patch = parseInt(mainParts[2], 10);
  if (isNaN(major) || isNaN(minor) || isNaN(patch)) return null;

  return {
    major,
    minor,
    patch,
    prerelease: parts[1] || undefined,
  };
}

function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) {
    return a.prerelease.localeCompare(b.prerelease);
  }
  return 0;
}

function findLatestTag(tags: string[], appName: string): string {
  let latestTag = "none";
  let latestSemver: Semver | null = null;

  for (const tag of tags) {
    const parsed = parseSemver(tag, appName);
    if (!parsed) continue;

    if (!latestSemver || compareSemver(parsed, latestSemver) > 0) {
      latestSemver = parsed;
      latestTag = tag;
    }
  }

  return latestTag;
}

const APPS_DIR = path.join(__dirname, "..", "..", "apps");
const APP_NAMES = ["openwork", "opencode", "open-design"];

ipcMain.handle("check-app-updates", async () => {
  const results: Record<
    string,
    {
      behind: number;
      error?: string;
      localTag?: string;
      remoteTag?: string;
      branch?: string;
    }
  > = {};
  for (const name of APP_NAMES) {
    try {
      const dir = path.join(APPS_DIR, name);
      await fs.access(dir);

      // 1. Fetch tags from origin
      await execPromise(`git fetch origin +refs/tags/*:refs/tags/* 2>/dev/null; true`, {
        cwd: dir,
      });

      // 2. Get tags reachable from HEAD
      const localTagsRaw = (
        await execPromise(`git tag --merged HEAD 2>/dev/null || echo ""`, { cwd: dir })
      )
        .split("\n")
        .filter(Boolean);
      let localTag = findLatestTag(localTagsRaw, name);

      // 3. Get all tags in the repository (includes newly fetched tags)
      const remoteTagsRaw = (
        await execPromise(`git tag 2>/dev/null || echo ""`, { cwd: dir })
      )
        .split("\n")
        .filter(Boolean);
      const remoteTag = findLatestTag(remoteTagsRaw, name);

      let behind = 0;
      let isUpstreamUpToDate = false;
      try {
        const behindCountStr = (
          await execPromise(`git rev-list --count HEAD..@{u} 2>/dev/null`, { cwd: dir })
        ).trim();
        const behindCount = parseInt(behindCountStr, 10);
        if (!isNaN(behindCount)) {
          if (behindCount > 0) {
            behind = 1;
          } else {
            isUpstreamUpToDate = true;
          }
        }
      } catch {
        // No upstream branch or command failed, will fallback to tag comparison
      }

      if (isUpstreamUpToDate) {
        behind = 0;
        localTag = remoteTag;
      } else {
        if (localTag !== "none" && remoteTag !== "none") {
          const localParsed = parseSemver(localTag, name);
          const remoteParsed = parseSemver(remoteTag, name);
          if (
            localParsed &&
            remoteParsed &&
            compareSemver(remoteParsed, localParsed) > 0
          ) {
            behind = 1;
          }
        } else if (localTag === "none" && remoteTag !== "none") {
          behind = 1;
        }
      }

      results[name] = { behind, localTag, remoteTag, branch: "" };
    } catch (err) {
      results[name] = {
        behind: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return results;
});

async function getOpencodeBinaryVersion(): Promise<string | null> {
  try {
    const binaryPath = path.join(homedir(), ".opencode", "bin", "opencode");
    let cmd = "opencode";
    
    try {
      await fs.access(binaryPath);
      cmd = binaryPath;
    } catch {
      // binary not at expected location, fallback to PATH
    }

    // Use a safer execution method for version check
    const out = await execPromise(`"${cmd}" --version`, { timeout: 5000 });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

ipcMain.handle("run-app-update", async (_e, appName: string) => {
  if (!APP_NAMES.includes(appName)) return { ok: false, error: "unknown app" };
  try {
    const dir = path.join(APPS_DIR, appName);
    await fs.access(dir);

    const branch = (
      await execPromise(`git rev-parse --abbrev-ref HEAD`, { cwd: dir })
    ).trim();
    await execPromise(`git remote prune origin 2>/dev/null; true`, { cwd: dir });
    await execPromise(
      `git fetch --tags origin +refs/tags/*:refs/tags/* 2>/dev/null; true`,
      { cwd: dir },
    );
    await execPromise(
      `git stash --quiet 2>/dev/null; git pull --rebase origin ${branch} 2>/dev/null; true`,
      { cwd: dir },
    );
    const lockFile = fs
      .access(path.join(dir, "pnpm-lock.yaml"))
      .then(() => "pnpm install")
      .catch(() =>
        fs
          .access(path.join(dir, "package-lock.json"))
          .then(() => "npm install")
          .catch(() => null),
      );
    const cmd = await lockFile;
    if (cmd) await execPromise(cmd, { cwd: dir });

    // ── Auto-sync opencode binary when source version changed ────────────────
    if (appName === "opencode") {
      let versionAfter: string | null = null;
      try {
        const pkgRaw = await fs.readFile(
          path.join(dir, "packages", "opencode", "package.json"),
          "utf-8",
        );
        versionAfter = (JSON.parse(pkgRaw) as { version?: string }).version ?? null;
      } catch {
        // ignore
      }

      const binaryVersion = await getOpencodeBinaryVersion();

      // If the binary version doesn't match the source version, update the binary
      const shouldUpdateBinary = versionAfter !== null && versionAfter !== binaryVersion;
      if (shouldUpdateBinary) {
        console.warn(
          `[update] opencode version mismatch: binary=v${binaryVersion ?? "?"} source=v${versionAfter}, syncing binary...`,
        );
        try {
          // Install the exact version that matches the source code
          // We use a shorter timeout for this specific command to avoid hanging too long
          await execPromise(
            `curl -fsSL https://opencode.ai/install | VERSION=${versionAfter} bash`,
            { cwd: dir },
          );
          console.warn(`[update] opencode binary synced to v${versionAfter} ✓`);
        } catch (binErr) {
          const msg = binErr instanceof Error ? binErr.message : String(binErr);
          console.warn(`[update] binary sync failed (non-fatal): ${msg}`);
          // Non-fatal: return ok but include a warning so the UI can inform the user
          return {
            ok: true,
            warning: `Le code source OpenCode a été mis à jour vers v${versionAfter} mais la mise à jour du binaire (v${binaryVersion ?? "?"}) a échoué. Lancez manuellement : curl -fsSL https://opencode.ai/install | bash`,
          };
        }
      } else if (versionAfter !== null && versionAfter === binaryVersion) {
        console.warn(`[update] opencode binary already at v${versionAfter}, no sync needed`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});


let autoUpdateEnabled = false;
let webSearchEnabled = false;
let visionProxyEnabled = true;
let visionModel = "openbmb/minicpm-v4.6";
let visionDetailLevel = "high";
let aiWorkflowProModel = "deepseek/deepseek-v4-pro";
let aiWorkflowFlashModel = "deepseek/deepseek-v4-flash";
let aiClassifierModel = "deepseek/deepseek-v4-flash";
const SETTINGS_PATH = path.join(homedir(), ".config", "openhub", "settings.json");

async function loadSettings(): Promise<void> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    autoUpdateEnabled = !!parsed.autoUpdate;
    webSearchEnabled = !!parsed.webSearchEnabled;
    visionProxyEnabled = !!parsed.visionProxyEnabled;
    visionModel = parsed.visionModel || "openbmb/minicpm-v4.6";
    visionDetailLevel = parsed.visionDetailLevel || "high";
    aiWorkflowProModel = parsed.aiWorkflowProModel || "deepseek/deepseek-v4-pro";
    aiWorkflowFlashModel = parsed.aiWorkflowFlashModel || "deepseek/deepseek-v4-flash";
    aiClassifierModel = parsed.aiClassifierModel || "deepseek/deepseek-v4-flash";
  } catch {
    autoUpdateEnabled = false;
    webSearchEnabled = false;
    visionProxyEnabled = true;
    visionModel = "openbmb/minicpm-v4.6";
    visionDetailLevel = "high";
    aiWorkflowProModel = "deepseek/deepseek-v4-pro";
    aiWorkflowFlashModel = "deepseek/deepseek-v4-flash";
    aiClassifierModel = "deepseek/deepseek-v4-flash";
  }
}

async function saveSettings(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
    await fs.writeFile(
      SETTINGS_PATH,
      JSON.stringify(
        {
          autoUpdate: autoUpdateEnabled,
          webSearchEnabled,
          visionProxyEnabled,
          visionModel,
          visionDetailLevel,
          aiWorkflowProModel,
          aiWorkflowFlashModel,
          aiClassifierModel,
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch {}
}

ipcMain.handle("get-auto-update", () => autoUpdateEnabled);
ipcMain.handle("set-auto-update", async (_e, enabled: boolean) => {
  autoUpdateEnabled = enabled;
  await saveSettings();
});

ipcMain.handle("run-graphify-update", async (_e, dir?: string) => {
  try {
    let workspaceDir: string;
    if (dir && dir !== "") {
      workspaceDir = path.normalize(path.resolve(dir));
    } else {
      workspaceDir = path.normalize(getActiveWorkspaceDir());
    }

    const homeDir = path.normalize(homedir());

    if (workspaceDir === homeDir || workspaceDir === path.normalize("/")) {
      return {
        ok: false,
        error: "Veuillez d'abord ouvrir un projet spécifique pour lancer la cartographie.",
      };
    }

    // Check if graphify is installed
    let hasGraphify = false;
    try {
      await execPromise("which graphify");
      hasGraphify = true;
    } catch {
      hasGraphify = false;
    }

    if (!hasGraphify) {
      const { response } = await dialog.showMessageBox({
        type: "question",
        title: "Installer Graphify ?",
        message: "Graphify n'est pas détecté sur votre système.",
        detail:
          "Graphify crée une carte sémantique de votre code. Cela permet à l'IA de comprendre l'architecture globale sans lire tous les fichiers, ce qui économise beaucoup d'argent et de tokens.\n\nVoulez-vous installer Graphify globalement via npm ?",
        buttons: ["Installer", "Plus tard"],
        defaultId: 0,
        cancelId: 1,
      });

      if (response === 0) {
        try {
          // Utilise sudo si nécessaire ou tente une install standard
          await execPromise("npm install -g graphify-ai");
        } catch (err) {
          return {
            ok: false,
            error:
              "Échec de l'installation. Veuillez lancer 'npm install -g graphify-ai' manuellement dans votre terminal.",
          };
        }
      } else {
        return { ok: false, error: "Installation annulée." };
      }
    }

    // Run update in the actual project directory
    console.warn(`[graphify] Running update in: ${workspaceDir}`);
    await execPromise("graphify update .", { cwd: workspaceDir });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("get-web-search-enabled", () => webSearchEnabled);
ipcMain.handle("set-web-search-enabled", async (_e, enabled: boolean) => {
  webSearchEnabled = enabled;
  await saveSettings();
});

ipcMain.handle("get-vision-proxy-enabled", () => visionProxyEnabled);
ipcMain.handle("set-vision-proxy-enabled", async (_e, enabled: boolean) => {
  visionProxyEnabled = enabled;
  await saveSettings();
});

ipcMain.handle("get-vision-model", () => visionModel);
ipcMain.handle("set-vision-model", async (_e, model: string) => {
  visionModel = model;
  await saveSettings();
});

ipcMain.handle("get-vision-detail-level", () => visionDetailLevel);
ipcMain.handle("set-vision-detail-level", async (_e, level: string) => {
  visionDetailLevel = level;
  await saveSettings();
});

// AI Intelligence Settings
ipcMain.handle("get-ai-workflow-pro-model", () => aiWorkflowProModel);
ipcMain.handle("set-ai-workflow-pro-model", async (_e, model: string) => {
  aiWorkflowProModel = model;
  await saveSettings();
});

ipcMain.handle("get-ai-workflow-flash-model", () => aiWorkflowFlashModel);
ipcMain.handle("set-ai-workflow-flash-model", async (_e, model: string) => {
  aiWorkflowFlashModel = model;
  await saveSettings();
});

ipcMain.handle("get-ai-classifier-model", () => aiClassifierModel);
ipcMain.handle("set-ai-classifier-model", async (_e, model: string) => {
  aiClassifierModel = model;
  await saveSettings();
});

function execPromise(
  cmd: string,
  opts: { cwd?: string; timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { ...opts, timeout: opts.timeout ?? 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

ipcMain.handle("od-updater:action", () => {
  return { state: "unsupported" };
});

async function ensureBinarySynced(): Promise<void> {
  const opencodeDir = path.join(APPS_DIR, "opencode");
  try {
    const pkgRaw = await fs.readFile(
      path.join(opencodeDir, "packages", "opencode", "package.json"),
      "utf-8",
    );
    const sourceVersion = (JSON.parse(pkgRaw) as { version?: string }).version;
    if (!sourceVersion) return;

    const binaryVersion = await getOpencodeBinaryVersion();
    if (binaryVersion === sourceVersion) return;

    console.warn(
      `[main] opencode version mismatch: binary=v${binaryVersion ?? "?"} source=v${sourceVersion}. Syncing...`,
    );
    await execPromise(
      `curl -fsSL https://opencode.ai/install | VERSION=${sourceVersion} bash`,
      { cwd: opencodeDir },
    );
    console.warn(`[main] opencode binary synced to v${sourceVersion} ✓`);
  } catch (err) {
    console.warn(`[main] failed to sync opencode binary at startup (non-fatal):`, err);
  }
}

app.whenReady().then(async () => {
  await loadSettings();
  registerOllamaHandlers();
  proxyToken = await startProxy();

  const anthropicKey = await readSecret("openhub", "anthropic-api-key");
  const openaiKey = await readSecret("openhub", "openai-api-key");
  const openrouterKey = await readSecret("openhub", "openrouter-api-key");
  const googleAiKey = await readSecret("openhub", "google-ai-key");

  processManager = new ProcessManager(proxyToken, { googleAiKey });

  // Sync binary in background so it doesn't block UI startup
  ensureBinarySynced().catch((err) => {
    console.error("[main] background binary sync failed:", err);
  });

  await generateOpenCodeConfig({ proxyToken, anthropicKey, openaiKey, openrouterKey });

  // Start opencode in the background — Work slot needs the opencode engine
  // for workspace sessions. Don't await: let it start while window loads.
  processManager.ensureRunning("code").catch((err) => {
    console.warn("[main] background opencode start failed:", err);
  });

  await createWindow();
});

app.on("window-all-closed", () => {
  processManager?.stopAll();
  app.quit();
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
});

// Global error handling for the proxy and other background tasks
process.on("uncaughtException", (err) => {
  console.error("[main] Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[main] Unhandled Rejection at:", promise, "reason:", reason);
});
