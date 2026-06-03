import { app, BrowserWindow, ipcMain, dialog, WebContentsView } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { ProcessManager } from "./process-manager.js";
import { startProxy } from "./proxy/index.js";
import { loadOverrides } from "./override-loader.js";
import { generateOpenCodeConfig } from "./config-generator.js";
import { readSecret } from "./keychain.js";
import type { SlotName } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SIDEBAR_WIDTH = 72;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;

// Use localhost (not 127.0.0.1) — Vite/opencode bind to ::1 (IPv6) on modern macOS
const SLOT_URLS: Record<Exclude<SlotName, "config">, string> = {
  work: "http://localhost:5173",
  code: "http://127.0.0.1:4096",
  design: "", // captured at spawn
};

let mainWindow: BrowserWindow | null = null;
const views = new Map<SlotName, WebContentsView>();
let activeSlot: SlotName = "work";
let processManager: ProcessManager | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      // sidebar.html is our own code — no sandbox needed here
      // WebContentsViews (external apps) keep sandbox: true
      nodeIntegration: false,
    },
  });

  await mainWindow.loadFile(path.join(__dirname, "sidebar.html"));

  mainWindow.on("resize", () => repositionViews());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createSlotView(slot: Exclude<SlotName, "config">): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  view.webContents.on("did-navigate", () => injectOverrides(slot, view));
  view.webContents.on("did-navigate-in-page", () => injectOverrides(slot, view));

  return view;
}

async function injectOverrides(
  slot: Exclude<SlotName, "config">,
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

const CONFIG_PANEL_HEIGHT = 160;
let configOpen = false;

function repositionViews(): void {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  const contentX = SIDEBAR_WIDTH;
  const contentWidth = width - SIDEBAR_WIDTH;
  const offsetY = configOpen ? CONFIG_PANEL_HEIGHT : 0;

  for (const [slot, view] of views) {
    const isActive = slot === activeSlot;
    view.setVisible(isActive);
    if (isActive) {
      view.setBounds({
        x: contentX,
        y: offsetY,
        width: contentWidth,
        height: height - offsetY,
      });
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

  const { promises: fs } = await import("fs");
  const pdf = await view.webContents.printToPDF({ printBackground: true });
  await fs.writeFile(filePath, pdf);
});

ipcMain.handle("get-slot-status", () => processManager?.getStatus() ?? {});

ipcMain.handle("get-api-keys", async () => {
  const { readAllApiKeys } = await import("./keychain.js");
  return readAllApiKeys();
});

ipcMain.handle("save-api-keys", async (_e, keys: Record<string, string>) => {
  const { writeSecret } = await import("./keychain.js");
  const map: Record<string, string> = {
    anthropic: "anthropic-api-key",
    openai: "openai-api-key",
    ollamaUrl: "ollama-url",
    githubToken: "github-token",
    braveSearchKey: "brave-search-key",
  };
  for (const [field, account] of Object.entries(map)) {
    if (keys[field]) await writeSecret("openhub", account, keys[field]);
  }
});

app.whenReady().then(async () => {
  const proxyToken = await startProxy();
  processManager = new ProcessManager(proxyToken);

  const anthropicKey = await readSecret("openhub", "anthropic-api-key");
  const openaiKey = await readSecret("openhub", "openai-api-key");
  await generateOpenCodeConfig({ proxyToken, anthropicKey, openaiKey });

  await createWindow();
});

app.on("window-all-closed", () => {
  processManager?.stopAll();
  app.quit();
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
});
