import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  WebContentsView,
  Menu,
  nativeTheme,
} from "electron";
import type { IpcMainInvokeEvent, IpcMainEvent } from "electron";
import path from "path";
import { homedir, tmpdir } from "os";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import { exec, execFile } from "child_process";
import { ProcessManager } from "./process-manager.js";
import { startProxy, getActiveWorkspaceDir } from "./proxy/index.js";
import {
  initWorkspaces,
  getWorkspacesSync,
  getActiveWorkspaceIdSync,
  setActiveWorkspaceId,
  addWorkspace,
  removeWorkspace,
  updateWorkspaceDisplayName,
  getStableWorkspaceId,
  isSafeWorkspacePath,
} from "./workspace-store.js";
import { loadOverrides } from "./override-loader.js";
import { syncRemoteOverrides } from "./remote-overrides.js";
import { generateOpenCodeConfig } from "./config-generator.js";
import { parseSemver, compareSemver, findLatestTag } from "./semver-utils.js";
import { readSecret } from "./keychain.js";
import { registerOllamaHandlers } from "./ollama-manager.js";
import {
  getProjects,
  saveProject,
  deleteProject,
  setActiveProject,
  getActiveProject,
  getProjectById,
  getWorkflows,
  saveWorkflow,
  deleteWorkflow,
  getOrchRuns,
  saveOrchRun,
  deleteOrchRun,
  clearOrchRuns,
  getFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  invalidateCache,
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
import { setProxyToken } from "./orchestrator-llm.js";
import {
  createNotifier,
  defaultNotifySources,
  isNotifyMode,
  isNotifySource,
  DEFAULT_NOTIFY_MODE,
  NOTIFY_SOURCES,
  type NotifyMode,
  type NotifySources,
} from "./notifications.js";
import { initUpdater, checkForUpdate, downloadAndInstall } from "./updater.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stop Chromium's os_crypt from using the macOS Keychain to encrypt cookies /
// local storage for the webview partitions. Under ad-hoc signing (no Apple
// Developer ID) macOS doesn't persistently trust the app, so it re-prompts for
// the login password to access the "openaxis Safe Storage" keychain item on
// every launch. `use-mock-keychain` makes os_crypt use an in-process key
// instead — no Keychain, no prompt. (`password-store` is a Linux-only switch and
// is a no-op on macOS; kept for non-macOS runs.)
app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("password-store", "basic");

// Dev: apps live in the cloned repo (../../apps). Packaged: they are bundled as
// extraResources under Resources/apps. Resolved once from app.isPackaged.
const APPS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "apps")
  : path.join(__dirname, "..", "..", "apps");

const HEADER_HEIGHT_TOPBAR = 82;
const HEADER_HEIGHT_DROPDOWN = 38;
let headerHeight = HEADER_HEIGHT_TOPBAR;
const MIN_WIDTH = 550;
const MIN_HEIGHT = 450;

// Use localhost (not 127.0.0.1) — Vite/opencode bind to ::1 (IPv6) on modern macOS
const SLOT_URLS: Record<Exclude<SlotName, "config" | "chat" | "projects">, string> = {
  work: "http://localhost:5173",
  code: "http://127.0.0.1:4096",
  design: "", // captured at spawn
};

const SPLASH_MIN_MS = 1200;

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let splashShownAt = 0;
const views = new Map<SlotName, WebContentsView>();
const insertedCSSKeys = new WeakMap<WebContentsView, string[]>();
let activeSlot: SlotName = "work";
let processManager: ProcessManager | null = null;
let proxyToken = "";

// Renderer console output is logged to the main-process stdout/stderr. A view
// could echo the per-session proxy token (or a provider key) to its console —
// e.g. SDK debug logging — which would then leak into our logs verbatim. Strip
// the known session token and common key shapes before logging, mirroring the
// redaction ProcessManager applies to spawned-child output.
function redactRendererLog(text: string): string {
  let out = text;
  if (proxyToken.length >= 8) {
    out = out.split(proxyToken).join("[REDACTED]");
  }
  return out
    .replace(
      /\b(sk-ant|sk-proj|sk-or|sk|ghp|gho|ghs|github_pat|xoxb|AIza|GOCSPX)[-_][A-Za-z0-9_-]{6,}/g,
      "[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, "Bearer [REDACTED]");
}

function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 320,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  splash.loadFile(path.join(__dirname, "splash.html"));
  return splash;
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 13 },
    backgroundColor: "#18181E",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.warn(
      `[sidebar:console] [level:${level}] ${redactRendererLog(message)} (at ${sourceId}:${line})`,
    );
  });

  mainWindow.once("ready-to-show", () => {
    const elapsed = Date.now() - splashShownAt;
    const remaining = Math.max(0, SPLASH_MIN_MS - elapsed);

    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
      mainWindow?.show();
    }, remaining);
  });

  await mainWindow.loadFile(path.join(__dirname, "sidebar.html"));

  mainWindow.on("resize", () => repositionViews());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const shortcutSlots: SlotName[] = ["chat", "code", "work", "design", "projects"];
  const appMenu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Navigation",
      submenu: shortcutSlots.map((slot, i) => ({
        label: slot.charAt(0).toUpperCase() + slot.slice(1),
        accelerator: `CmdOrCtrl+${i + 1}`,
        click: () => switchSlot(slot),
      })),
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        { role: "close" as const },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);
}

function createSlotView(
  slot: Exclude<SlotName, "config" | "chat" | "projects">,
): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // This view renders untrusted third-party remote UIs (work/code/design).
      // Pin the same-origin policy and block mixed content explicitly instead of
      // relying on Electron defaults, so a future change can't silently weaken it.
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, "preload.cjs"),
      partition: "persist:chat",
    },
  });

  // Match the app shell so a freshly-revealed view never flashes white/black
  // before its first paint.
  view.setBackgroundColor("#18181E");

  // CSS is re-injected on every SPA navigation because SolidJS can clear
  // <head> during route transitions, dropping the injected <style> elements.
  // We use a marker attribute (data-openaxis-css) so old styles are removed
  // before new ones are appended — no duplicate accumulation.
  // JS is re-run on both events because an in-page route swap can drop our
  // injected DOM; the overrides are guarded by window.__OPENAXIS_*_INJECTED__
  // flags so re-running is idempotent.
  // Override injection is DEFERRED until after loadURL completes. Injecting
  // during did-navigate (while modules are loading) blocks the renderer's main
  // thread via IPC round-trips (insertCSS/executeJavaScript), turning a <1s
  // load into 17-27s.  The did-navigate-in-page listener handles SPA route
  // changes after the initial load.
  if (process.env.OPENAXIS_NO_OVERRIDES !== "1") {
    let inPageTimer: ReturnType<typeof setTimeout> | null = null;
    view.webContents.on("did-navigate-in-page", () => {
      if (inPageTimer) clearTimeout(inPageTimer);
      inPageTimer = setTimeout(() => {
        inPageTimer = null;
        injectOverrides(slot, view, true);
      }, 300);
    });
  }

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
      console.warn(
        `[${slot}:console] [${level}] ${redactRendererLog(message)} (${sourceId}:${line})`,
      );
    }
  });

  // Surface renderer crashes instead of failing silently (white screen)
  view.webContents.on("render-process-gone", (_e, details) => {
    console.error(
      `[main] Renderer for slot "${slot}" gone: reason=${details.reason} exitCode=${details.exitCode}`,
    );
  });

  return view;
}

async function injectOverrides(
  slot: Exclude<SlotName, "config" | "chat" | "projects">,
  view: WebContentsView,
  injectCss: boolean,
): Promise<void> {
  const t0 = Date.now();
  // JS first: bridge.js must set window.__OPENWORK_ELECTRON__ before the page's
  // top-level modules evaluate isDesktopRuntime(). Each executeJavaScript is an
  // IPC round-trip that blocks the renderer's main thread, so run them before
  // CSS to minimise interference with module loading.
  const jsBlocks = await loadOverrides(slot, "js");
  console.warn(
    `[override-timing] ${slot} loadOverrides(js) ${jsBlocks.length} blocks +${Date.now() - t0}ms`,
  );
  for (let i = 0; i < jsBlocks.length; i++) {
    const jsBefore = Date.now();
    await view.webContents.executeJavaScript(jsBlocks[i]);
    console.warn(
      `[override-timing] ${slot} executeJS[${i}] done +${Date.now() - t0}ms (took ${Date.now() - jsBefore}ms)`,
    );
  }
  console.warn(`[override-timing] ${slot} JS done +${Date.now() - t0}ms`);

  // CSS: inject as <style> elements via executeJavaScript so they
  // always come LAST in <head> (beats OpenCode's dynamic theme).
  // Old overrides are removed first via marker attribute to prevent
  // duplicate accumulation across SPA navigations.
  if (injectCss) {
    const cssBlocks = await loadOverrides(slot, "css");
    console.warn(
      `[override-timing] ${slot} loadOverrides(css) ${cssBlocks.length} blocks +${Date.now() - t0}ms`,
    );

    // insertCSS for earliest possible paint (avoids flash of unstyled).
    // Remove previously inserted CSS keys first to prevent accumulation
    // across SPA navigations.
    const prevKeys = insertedCSSKeys.get(view);
    if (prevKeys) {
      for (const key of prevKeys) {
        view.webContents.removeInsertedCSS(key).catch(() => {});
      }
    }
    const newKeys: string[] = [];
    for (const css of cssBlocks) {
      try {
        const key = await view.webContents.insertCSS(css);
        newKeys.push(key);
      } catch {
        // Silently skip if webContents is destroyed mid-injection
      }
    }
    insertedCSSKeys.set(view, newKeys);

    // executeJavaScript injects <style> elements with a marker attribute.
    // On repeated calls (SPA navigation) old elements are removed first.
    const styleJs = cssBlocks.map((css) => {
      const escaped = css
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\$/g, "\\$");
      return `(function(){document.querySelectorAll("style[data-openaxis-css]").forEach(function(e){e.remove()});var s=document.createElement("style");s.setAttribute("data-openaxis-css","");s.textContent=\`${escaped}\`;document.head.appendChild(s)})()`;
    });
    await view.webContents.executeJavaScript(styleJs.join(";"));
    console.warn(
      `[override-timing] ${slot} CSS via executeJavaScript done +${Date.now() - t0}ms`,
    );
  }
  console.warn(`[override-timing] ${slot} ALL done +${Date.now() - t0}ms`);
}

async function loadViewUrl(view: WebContentsView, url: string): Promise<void> {
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      console.warn(`[loadURL-timing] attempt ${attempt}/6 ${url} +${Date.now() - t0}ms`);
      const before = Date.now();
      await view.webContents.loadURL(url);
      console.warn(
        `[loadURL-timing] SUCCESS ${url} attempt=${attempt} loadURL took ${Date.now() - before}ms total +${Date.now() - t0}ms`,
      );
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      console.error(
        `[loadURL-timing] FAIL (${code}) ${url} attempt=${attempt} +${Date.now() - t0}ms`,
      );
      if (code === "ERR_CONNECTION_REFUSED" && attempt < 6) {
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        throw err;
      }
    }
  }
}

let configOpen = false;
let onboardingOpen = false;

function repositionViews(): void {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  const contentY = headerHeight;
  const contentHeight = height - headerHeight;

  for (const [slot, view] of views) {
    const isActive = slot === activeSlot;
    view.setVisible(isActive && !configOpen && !onboardingOpen);
    if (isActive) {
      view.setBounds({ x: 0, y: contentY, width: width, height: contentHeight });
    }
  }
}

// --- IPC sender hardening --------------------------------------------------
// The Work/Code/Design slot views load REMOTE web apps yet share this preload,
// so every IPC channel is reachable from an untrusted origin (an XSS in an
// upstream app, a hostile page reached mid-navigation, etc.). Secret-bearing,
// filesystem, exec, store and orchestration channels are therefore restricted to
// the local file:// UI (sidebar/chat/projects/nav-popup). Only the small set the
// slot views genuinely need stays open — each of those does its own argument
// validation (resolveWithinHome, sender check, native picker, …).
const SLOT_ALLOWED_CHANNELS = new Set<string>([
  "switch-slot",
  "show-slot-context-menu",
  "show-nav-menu",
  "nav-popup-select",
  "config-visibility",
  "get-slot-status",
  "task-done",
  "pick-project-path",
  "openwork-desktop-invoke",
  "run-graphify-update",
  "od-shell:open-external",
  "od-shell:open-path",
  "od-pdf:print",
  "od-updater:action",
  "od-dialog:pick-and-import",
  "od-dialog:pick-and-replace-working-dir",
  "od-pet:set-visible",
  "get-language-sync",
  "onboarding-pending-sync",
  "get-projects",
  "get-active-project",
  "set-active-project",
  "save-project",
  "delete-project",
  "get-project-files",
  "delete-project-file",
  "get-folders",
  "create-folder",
  "rename-folder",
  "delete-folder",
  "read-chat-backup",
]);

function senderIsTrusted(e: IpcMainInvokeEvent | IpcMainEvent, channel: string): boolean {
  if (SLOT_ALLOWED_CHANNELS.has(channel)) return true;
  const url = e.senderFrame?.url ?? "";
  return url.startsWith("file://");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC args are a serialization boundary
type IpcArgs = any[];

function ipcHandle(
  channel: string,
  listener: (e: IpcMainInvokeEvent, ...args: IpcArgs) => unknown,
): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!senderIsTrusted(e, channel)) {
      console.warn(
        `[main] IPC '${channel}' refused from ${e.senderFrame?.url ?? "unknown"}`,
      );
      throw new Error("forbidden");
    }
    return listener(e, ...args);
  });
}

function ipcOn(
  channel: string,
  listener: (e: IpcMainEvent, ...args: IpcArgs) => void,
): void {
  ipcMain.on(channel, (e, ...args) => {
    if (!senderIsTrusted(e, channel)) {
      console.warn(
        `[main] IPC '${channel}' refused from ${e.senderFrame?.url ?? "unknown"}`,
      );
      return;
    }
    listener(e, ...args);
  });
}

ipcOn("config-visibility", (_e, open: boolean) => {
  configOpen = open;
  repositionViews();
});

let navPopup: BrowserWindow | null = null;

ipcOn("show-nav-menu", (_e, x: number, y: number) => {
  if (navPopup && !navPopup.isDestroyed()) {
    navPopup.close();
    navPopup = null;
    return;
  }
  if (!mainWindow) return;

  const popupWidth = 260;
  const popupHeight = 252;
  const winBounds = mainWindow.getBounds();
  const contentBounds = mainWindow.getContentBounds();
  const frameTop = contentBounds.y - winBounds.y;
  const frameLeft = contentBounds.x - winBounds.x;

  navPopup = new BrowserWindow({
    width: popupWidth,
    height: popupHeight,
    x: winBounds.x + frameLeft + Math.round(x) - Math.round(popupWidth / 2),
    y: winBounds.y + frameTop + Math.round(y),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    parent: mainWindow,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  if (process.platform === "darwin") {
    navPopup.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    navPopup.setAlwaysOnTop(true, "pop-up-menu");
  }

  navPopup.loadFile(path.join(__dirname, "nav-popup.html"), {
    query: { active: activeSlot },
  });

  navPopup.on("blur", () => {
    if (navPopup && !navPopup.isDestroyed()) {
      navPopup.close();
    }
    navPopup = null;
  });

  navPopup.on("closed", () => {
    navPopup = null;
  });
});

ipcOn("nav-popup-select", (_e, slot: SlotName) => {
  if (navPopup && !navPopup.isDestroyed()) {
    navPopup.close();
    navPopup = null;
  }
  switchSlot(slot);
});

async function switchSlot(slot: SlotName): Promise<void> {
  const __t0 = Date.now();
  const __t = (label: string) =>
    console.warn(`[timing] ${slot} +${Date.now() - __t0}ms ${label}`);
  console.warn(`\n[main] ── switchSlot("${slot}") ──`);

  if (onboardingOpen) return;

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
          webSecurity: false,
          preload: path.join(__dirname, "preload.cjs"),
        },
      });
      view.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("http://") || url.startsWith("https://")) {
          shell.openExternal(url);
        }
        return { action: "deny" };
      });
      // This view only ever renders the local chat.html — block any top-level
      // navigation to remote/file/data URLs (defense against content-driven escapes).
      view.webContents.on("will-navigate", (event, url) => {
        if (!url.startsWith("file://")) {
          event.preventDefault();
          console.warn(`[main] Blocked navigation in chat view to: ${url}`);
        }
      });
      view.webContents.on("console-message", (_e, level, message, line, sourceId) => {
        console.warn(
          `[chat:console] [level:${level}] ${redactRendererLog(message)} (at ${sourceId}:${line})`,
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
    mainWindow.setTitle("OpenAxis — Chat");
    return;
  }

  if (slot === "projects") {
    if (!views.has("projects")) {
      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: false,
          preload: path.join(__dirname, "preload.cjs"),
        },
      });
      view.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("http://") || url.startsWith("https://")) {
          shell.openExternal(url);
        }
        return { action: "deny" };
      });
      // This view only ever renders the local projects.html — block any top-level
      // navigation to remote/file/data URLs.
      view.webContents.on("will-navigate", (event, url) => {
        if (!url.startsWith("file://")) {
          event.preventDefault();
          console.warn(`[main] Blocked navigation in projects view to: ${url}`);
        }
      });
      view.webContents.on("console-message", (_e, level, message, line, sourceId) => {
        console.warn(
          `[projects:console] [level:${level}] ${redactRendererLog(message)} (at ${sourceId}:${line})`,
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
    mainWindow.setTitle("OpenAxis — Projets");
    return;
  }

  // Start the service (or reuse if already running)
  if (processManager) {
    console.warn(`[main] ensureRunning("${slot}")...`);
    __t("ensureRunning start");
    const port = await processManager.ensureRunning(slot);
    __t(`ensureRunning done → port ${port}`);
    console.warn(`[main] ensureRunning("${slot}") → port ${port}`);
    if (port !== null && slot === "design") {
      // Daemon-served build (:7456) binds 127.0.0.1 only, so use an explicit IP
      // (Chromium would otherwise resolve "localhost" to ::1 and fail). The
      // next-dev fallback (:3456) keeps localhost as before.
      SLOT_URLS[slot] =
        port === 7456 ? `http://127.0.0.1:${port}` : `http://localhost:${port}`;
    } else if (port !== null && slot === "code") {
      // opencode binds to 127.0.0.1 (IPv4) — use explicit IP so Chromium doesn't try ::1
      SLOT_URLS[slot] = `http://127.0.0.1:${port}`;
    }
  }

  const url = SLOT_URLS[slot];
  console.warn(`[main] slot url: ${url || "(empty)"}`);

  // Load BEFORE revealing: the previous slot stays on screen (with a sidebar
  // spinner) during the load — no black flash.
  if (!views.has(slot)) {
    __t("createSlotView start");
    const view = createSlotView(slot);
    __t("createSlotView done");

    // ── Exhaustive WebContents lifecycle logging ──
    const wc = view.webContents;
    wc.once("dom-ready", () => __t("EVENT dom-ready"));
    wc.once("did-finish-load", () => __t("EVENT did-finish-load"));
    wc.once("did-start-loading", () => __t("EVENT did-start-loading"));
    wc.once("did-stop-loading", () => __t("EVENT did-stop-loading"));
    wc.once("did-start-navigation", (_e, navUrl) =>
      __t(`EVENT did-start-navigation → ${navUrl}`),
    );
    wc.once("did-navigate", (_e, navUrl) => __t(`EVENT did-navigate → ${navUrl}`));
    wc.once("did-fail-load", (_e, code, desc) =>
      __t(`EVENT did-fail-load code=${code} desc=${desc}`),
    );
    wc.once("render-process-gone", (_e, details) =>
      __t(`EVENT render-process-gone reason=${details.reason}`),
    );
    wc.once("responsive", () => __t("EVENT responsive"));
    wc.once("unresponsive", () => __t("EVENT unresponsive"));
    wc.once("did-frame-finish-load", (_e, isMain) =>
      __t(`EVENT did-frame-finish-load isMainFrame=${isMain}`),
    );
    wc.once("page-title-updated", (_e, title) =>
      __t(`EVENT page-title-updated → ${title}`),
    );

    // Give the view real bounds BEFORE loadURL so Chromium's renderer has a
    // non-zero viewport. A 0×0 view throttles IPC (insertCSS, executeJS) and
    // module loading — root cause of the 27s hang. The view is VISIBLE with
    // bounds so the renderer runs at full priority.
    const [cw, ch] = mainWindow.getContentSize();
    view.setBounds({ x: 0, y: headerHeight, width: cw, height: ch - headerHeight });
    __t("setBounds (visible) before load");

    __t("addChildView start");
    mainWindow.contentView.addChildView(view);
    __t("addChildView done");
    views.set(slot, view);
    if (url) {
      __t("loadViewUrl start");
      await loadViewUrl(view, url);
      __t("loadViewUrl done");
      // Inject overrides AFTER the page has fully loaded — injecting during
      // did-navigate blocks the renderer for 17-27s via IPC round-trips.
      if (process.env.OPENAXIS_NO_OVERRIDES !== "1") {
        __t("injectOverrides start (post-load)");
        await injectOverrides(slot, view, true);
        __t("injectOverrides done (post-load)");
      }
    }
  } else {
    const view = views.get(slot)!;
    const currentUrl = view.webContents.getURL();
    console.warn(`[main] existing view current url: "${currentUrl}"`);
    mainWindow.contentView.addChildView(view);
    const needsLoad =
      !currentUrl ||
      currentUrl === "about:blank" ||
      currentUrl.startsWith("chrome-error://");
    if (needsLoad && url) {
      __t("loadViewUrl start (reuse)");
      await loadViewUrl(view, url);
      __t("loadViewUrl done (reuse)");
    }
  }

  activeSlot = slot;
  repositionViews();
  __t("repositionViews done (revealed)");
  mainWindow.webContents.send("slot-changed", slot);

  const slotTitles: Record<string, string> = {
    work: "OpenAxis — Work",
    code: "OpenAxis — Code",
    design: "OpenAxis — Design",
    chat: "OpenAxis — Chat",
  };
  mainWindow.setTitle(slotTitles[slot] ?? "OpenAxis");

  console.warn(`[main] ── switchSlot("${slot}") done ──\n`);
}

ipcHandle("switch-slot", (_e, slot: SlotName) => switchSlot(slot));

async function stopSlot(slot: SlotName): Promise<void> {
  const view = views.get(slot);
  if (view) {
    mainWindow?.contentView.removeChildView(view);
    views.delete(slot);
  }
  if (slot === "work" || slot === "code" || slot === "design") {
    processManager?.stop(slot as Exclude<SlotName, "config" | "chat" | "projects">);
  }
  if (activeSlot === slot) {
    const fallback: SlotName = slot === "chat" ? "work" : "chat";
    await switchSlot(fallback);
  }
}

ipcOn("show-slot-context-menu", (_e, slot: SlotName) => {
  const slotLabels: Record<string, string> = {
    work: "Work",
    code: "Code",
    design: "Design",
    chat: "Chat",
    projects: "Orchestrateur",
  };
  const label = slotLabels[slot] ?? slot;
  const menu = Menu.buildFromTemplate([
    {
      label: `Fermer ${label}`,
      click: () => stopSlot(slot),
    },
  ]);
  menu.popup({ window: mainWindow ?? undefined });
});

ipcHandle("export-pdf", async () => {
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

ipcHandle("get-slot-status", () => processManager?.getStatus() ?? {});

// OpenWork desktop bridge — polyfills window.__OPENWORK_ELECTRON__.invokeDesktop()
ipcHandle("openwork-desktop-invoke", async (_e, command: string, ...args: unknown[]) => {
  switch (command) {
    case "pickDirectory": {
      const result = await dialog.showOpenDialog(mainWindow!, {
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
    case "workspaceBootstrap": {
      const workspaces = getWorkspacesSync();
      const activeId = getActiveWorkspaceIdSync() ?? "openaxis-default";
      return {
        workspaces,
        selectedId: activeId,
        activeId,
      };
    }

    // openworkServerRestart/Info: point to our running opencode serve
    // isOpenworkServerReady() requires running=true + baseUrl + ownerToken
    case "openworkServerRestart":
    case "openworkServerInfo":
      return {
        running: true,
        baseUrl: "http://127.0.0.1:9999",
        ownerToken: proxyToken,
        clientToken: proxyToken,
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
          ownerToken: proxyToken,
          clientToken: proxyToken,
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
      const input = args[0] as Record<string, unknown> | null | undefined;
      let wsPath = "";
      let preset = "default";
      let name = "";
      if (input && typeof input === "object") {
        wsPath =
          typeof input["folderPath"] === "string" ? (input["folderPath"] as string) : "";
        preset =
          typeof input["preset"] === "string" ? (input["preset"] as string) : "default";
        name = typeof input["name"] === "string" ? (input["name"] as string) : "";
      } else if (typeof input === "string") {
        wsPath = input;
      }

      if (!isSafeWorkspacePath(wsPath)) {
        throw new Error("Invalid or unsafe workspace path");
      }

      const resolvedName = name || wsPath.split("/").pop() || "workspace";
      const id = getStableWorkspaceId(wsPath);
      const entry = {
        id,
        name: resolvedName,
        path: wsPath,
        preset,
        workspaceType: "local",
        displayName: resolvedName,
      };

      const added = await addWorkspace(entry);
      await setActiveWorkspaceId(added.id);

      const workspaces = getWorkspacesSync();
      return {
        selectedId: added.id,
        activeId: added.id,
        workspaces,
      };
    }
    case "workspaceSetSelected":
    case "workspaceSetRuntimeActive": {
      const id = args[0] as string;
      if (typeof id === "string" && id.trim()) {
        await setActiveWorkspaceId(id);
      }
      return { ok: true };
    }
    case "workspaceUpdateDisplayName": {
      const input = args[0] as Record<string, unknown> | null | undefined;
      if (
        input &&
        typeof input === "object" &&
        typeof input["id"] === "string" &&
        typeof input["displayName"] === "string"
      ) {
        await updateWorkspaceDisplayName(
          input["id"] as string,
          input["displayName"] as string,
        );
      }
      return { ok: true };
    }
    case "workspaceForget": {
      const id = args[0] as string;
      if (typeof id === "string" && id.trim()) {
        await removeWorkspace(id);
      }
      return { ok: true };
    }
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
    case "__joinPath": {
      const segments = args as string[];
      // Block "..", and any absolute segment past the first — path.join does not
      // reset on a later absolute segment, but an absolute first segment (e.g.
      // the home dir) is the legitimate base for these joins.
      if (
        segments.some(
          (s, i) =>
            typeof s !== "string" || s.includes("..") || (i > 0 && path.isAbsolute(s)),
        )
      ) {
        return null;
      }
      return path.join(...segments);
    }
    case "__openPath": {
      const resolved = await resolveWithinHome(args[0]);
      if (!resolved) return "";
      return shell.openPath(resolved);
    }
    case "__revealItemInDir": {
      const resolvedItem = await resolveWithinHome(args[0]);
      if (!resolvedItem) return null;
      shell.showItemInFolder(resolvedItem);
      return null;
    }
    default:
      return null;
  }
});

// ── Project management ──────────────────────────────────────────────────────
ipcHandle("reload-project-store", () => invalidateCache());
ipcHandle("get-projects", () => getProjects());
ipcHandle("get-active-project", () => getActiveProject());
ipcHandle("set-active-project", (_e, id: string | null) => setActiveProject(id));
ipcHandle("save-project", (_e, project: Parameters<typeof saveProject>[0]) =>
  saveProject(project),
);
ipcHandle("delete-project", (_e, id: string) => deleteProject(id));
ipcHandle("get-project-files", async (_e, projectId: string) => {
  const p = await getProjectById(projectId);
  if (!p || !p.path) return [];
  try {
    const entries = await fs.readdir(p.path, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        path: path.join(p.path!, entry.name),
        isDirectory: entry.isDirectory(),
      }));
  } catch (error) {
    console.error("Error reading project files:", error);
    return [];
  }
});
ipcHandle("delete-project-file", async (_e, projectId: string, filePath: string) => {
  const p = await getProjectById(projectId);
  if (!p || !p.path) return { ok: false, error: "Project path not found" };
  const relative = path.relative(p.path, filePath);
  const isSafe = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!isSafe) {
    return { ok: false, error: "Access denied: file is outside the project workspace" };
  }
  try {
    await fs.rm(filePath, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// ── Folder management ───────────────────────────────────────────────────────
ipcHandle("get-folders", () => getFolders());
ipcHandle("create-folder", (_e, name: string) => createFolder(name));
ipcHandle("rename-folder", (_e, id: string, name: string) => renameFolder(id, name));
ipcHandle("delete-folder", (_e, id: string) => deleteFolder(id));

ipcHandle("pick-project-path", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcHandle("get-workflows", () => getWorkflows());
ipcHandle("save-workflow", (_e, workflow) => saveWorkflow(workflow));
ipcHandle("delete-workflow", (_e, id: string) => deleteWorkflow(id));

ipcHandle("get-orch-runs", (_e, workflowId?: string) => getOrchRuns(workflowId));
ipcHandle("save-orch-run", (_e, run) => saveOrchRun(run));
ipcHandle("delete-orch-run", (_e, id: string) => deleteOrchRun(id));
ipcHandle("clear-orch-runs", (_e, workflowId?: string) => clearOrchRuns(workflowId));

let runner: OrchestratorRunner | null = null;

interface StatusUpdate {
  projectId: string;
  status: string;
  task?: string;
  error?: string;
  result?: string;
  systemPrompt?: string;
  userPrompt?: string;
  chunk?: string;
  progress?: { current: number; total: number };
  substep?: { current: number; total: number; title: string };
  dependencies?: string[];
}

const orchStatusBuffer = new Map<string, StatusUpdate>();
const orchActivityLog: Array<{
  ts: number;
  projectId: string;
  status: string;
  label?: string;
}> = [];
const MAX_ACTIVITY_LOG = 200;

function broadcastOrchStatus(update: StatusUpdate) {
  orchStatusBuffer.set(update.projectId, update);

  if (update.status && update.status !== "idle") {
    if (orchActivityLog.length >= MAX_ACTIVITY_LOG) orchActivityLog.shift();
    orchActivityLog.push({
      ts: Date.now(),
      projectId: update.projectId,
      status: update.status,
      label: update.task || update.substep?.title || update.error,
    });
  }

  mainWindow?.webContents.send("orchestration-status", update);
  const projView = views.get("projects");
  if (projView) {
    projView.webContents.send("orchestration-status", update);
  }
}

function ensureRunner(): OrchestratorRunner {
  if (!runner) {
    runner = new OrchestratorRunner(
      (update) => {
        broadcastOrchStatus(update);
        if (
          update.projectId === runner?.activeOrchestratorId &&
          (update.status === "done" || update.status === "error")
        ) {
          notifier.notify("orchestrator", {
            body:
              update.status === "done"
                ? "L'orchestration est terminée avec succès."
                : "L'orchestration s'est arrêtée sur une erreur.",
          });
        }
      },
      () => processManager,
    );
  }
  return runner;
}

ipcHandle(
  "execute-orchestration",
  async (_e, id: string, task: string, workDir?: string, workflowName?: string) => {
    orchStatusBuffer.clear();
    orchActivityLog.length = 0;
    await ensureRunner().run(id, task, workDir, workflowName);
  },
);

ipcHandle(
  "iterate-orchestration",
  async (_e, id: string, feedback: string, workflowId: string) => {
    if (!feedback?.trim()) throw new Error("Le feedback est vide.");
    const runs = await getOrchRuns(workflowId);
    const previousRun = runs[0];
    if (!previousRun) throw new Error("Aucune exécution précédente pour ce workflow.");
    const wf = (await getWorkflows()).find((w) => w.id === workflowId);
    await ensureRunner().iterate(id, feedback.trim(), previousRun, wf?.workDir, wf?.name);
  },
);

ipcHandle("cancel-orchestration", () => {
  runner?.cancel();
});

ipcHandle("get-orch-status-buffer", () => {
  return {
    statuses: Object.fromEntries(orchStatusBuffer),
    activity: [...orchActivityLog],
  };
});

// ── Chat backup (file-system persistence for conversations) ─────────────────
const CHAT_BACKUP_PATH = path.join(homedir(), ".config", "openaxis", "chat-backup.json");
ipcHandle("read-chat-backup", async () => {
  try {
    return await fs.readFile(CHAT_BACKUP_PATH, "utf-8");
  } catch {
    return null;
  }
});
ipcHandle("write-chat-backup", async (_e, data: string) => {
  try {
    await fs.mkdir(path.dirname(CHAT_BACKUP_PATH), { recursive: true });
    await fs.writeFile(CHAT_BACKUP_PATH, data, "utf-8");
    return true;
  } catch {
    return false;
  }
});

// ── Orchestrator conversations (file-system persistence) ─────────────────────
const ORCH_CONVS_PATH = path.join(
  homedir(),
  ".config",
  "openaxis",
  "orch-conversations.json",
);
ipcHandle("read-orch-conversations", async () => {
  try {
    return await fs.readFile(ORCH_CONVS_PATH, "utf-8");
  } catch {
    return null;
  }
});
ipcHandle("write-orch-conversations", async (_e, data: string) => {
  try {
    await fs.mkdir(path.dirname(ORCH_CONVS_PATH), { recursive: true });
    await fs.writeFile(ORCH_CONVS_PATH, data, "utf-8");
    return true;
  } catch {
    return false;
  }
});

// ── Memory management ───────────────────────────────────────────────────────
ipcHandle("get-memory", () => getMemory());
ipcHandle("set-memory-enabled", (_e, enabled: boolean) => setMemoryEnabled(enabled));
ipcHandle("set-memory-auto-extract", (_e, enabled: boolean) =>
  setMemoryAutoExtract(enabled),
);
ipcHandle("set-memory-profile", (_e, profile: string) => setMemoryProfile(profile));
ipcHandle("add-memory-fact", (_e, text: string, tags: string[]) => addFact(text, tags));
ipcHandle("remove-memory-fact", (_e, id: string) => removeFact(id));
ipcHandle(
  "update-memory-fact",
  (_e, id: string, patch: { text?: string; tags?: string[] }) => updateFact(id, patch),
);

// ── Workspace Skills management ─────────────────────────────────────────────
ipcHandle("get-skills", async () => {
  const workspaceDir = getActiveWorkspaceDir();
  const skillsDir = path.join(workspaceDir, ".openaxis", "skills");
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

ipcHandle(
  "save-skill",
  async (_e, skill: { filename?: string; title: string; content: string }) => {
    const workspaceDir = getActiveWorkspaceDir();
    const skillsDir = path.join(workspaceDir, ".openaxis", "skills");
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

ipcHandle("delete-skill", async (_e, filename: string) => {
  const workspaceDir = getActiveWorkspaceDir();
  const skillsDir = path.join(workspaceDir, ".openaxis", "skills");
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

ipcHandle("get-chat-config", () => ({
  proxyUrl: "http://127.0.0.1:9999",
  token: proxyToken,
}));

// Offscreen window for rendering renderer-supplied HTML to PDF. It runs in an
// isolated session whose network is fully blocked, so the embedded HTML cannot
// fetch remote resources or exfiltrate any data it contains.
function createLockedPdfWindow(): BrowserWindow {
  const partition = `pdf-export-${randomBytes(6).toString("hex")}`;
  const sess = session.fromPartition(partition);
  sess.webRequest.onBeforeRequest((details, cb) => {
    const allowed = details.url.startsWith("data:") || details.url.startsWith("about:");
    cb({ cancel: !allowed });
  });
  return new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition,
    },
  });
}

ipcHandle("export-html-to-pdf", async (_e, html: string) => {
  const win = createLockedPdfWindow();

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
  cleaned = cleaned.replace(
    /^(fait|fais|ecris|rédige|redige|cherche|trouve|explique|donne)\s+(moi|nous)?\s*(un|une|des)?\s*(essai|essais|resume|résumé|explication|recherche|information|informations|details|détails)?\s*(sur|de|concernant|a propos de|à propos de)\s+/i,
    "",
  );
  cleaned = cleaned.replace(
    /^(qu'est-ce que|qu'est ce que|qui est|quel est|quels sont|quelle est|quelles sont)\s+/i,
    "",
  );
  cleaned = cleaned.replace(
    /^(peux-tu|peux tu|pourrais-tu|pourrais tu)\s+(me|nous)?\s*(chercher|trouver|expliquer|dire|faire)\s+/i,
    "",
  );

  // Remove common prefix filler phrases (English)
  cleaned = cleaned.replace(
    /^(write|make|create|do|search|find|explain|give)\s+(me|us)?\s*(a|an|the)?\s*(essay|summary|explanation|search|information|details)?\s*(on|about|for|of)\s+/i,
    "",
  );
  cleaned = cleaned.replace(
    /^(what is|who is|which is|what are|who are|which are)\s+/i,
    "",
  );
  cleaned = cleaned.replace(
    /^(can you|could you)\s+(search|find|explain|tell|do)\s+/i,
    "",
  );

  // Replace "3eme" or "3ème" or "3e" followed by "guerre" with "troisieme guerre" to avoid school grade confusion
  cleaned = cleaned.replace(/\b3(eme|ème|e)?\s+guerre\b/i, "troisieme guerre");

  return cleaned.trim() || query;
}

ipcHandle("web-search", async (_e, query: string) => {
  // Interrupteur maître : si « Recherche Internet » est désactivé dans Config,
  // on ne cherche jamais — quel que soit l'état du chat (kill-switch global).
  if (!webSearchEnabled) return [];
  const { readSecret } = await import("./keychain.js");
  const braveSearchKey = await readSecret("openaxis", "brave-search-key");
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

ipcHandle("get-api-keys", async () => {
  const { readAllApiKeys, maskSecret } = await import("./keychain.js");
  const keys = await readAllApiKeys();
  // Secrets are NEVER returned in clear to the renderer — only a masked preview.
  // ollamaUrl is not a secret and must stay editable, so it is returned in full.
  const res: Record<string, string | null> = {
    anthropic: maskSecret(keys.anthropic),
    openai: maskSecret(keys.openai),
    deepseek: maskSecret(keys.deepseek),
    openrouterKey: maskSecret(keys.openrouterKey),
    googleAiKey: maskSecret(keys.googleAiKey),
    githubToken: maskSecret(keys.githubToken),
    braveSearchKey: maskSecret(keys.braveSearchKey),
    ollamaUrl: keys.ollamaUrl,
  };
  for (const [id, val] of Object.entries(keys.customKeys)) {
    res[`custom-provider-key-${id}`] = maskSecret(val);
  }
  return res;
});

ipcHandle("save-api-keys", async (_e, keys: Record<string, string>) => {
  const { writeSecret, deleteSecret, isMaskedValue, isSafeOllamaUrl } =
    await import("./keychain.js");
  const map: Record<string, string> = {
    anthropic: "anthropic-api-key",
    openai: "openai-api-key",
    deepseek: "deepseek-api-key",
    openrouterKey: "openrouter-api-key",
    googleAiKey: "google-ai-key",
    ollamaUrl: "ollama-url",
    githubToken: "github-token",
    braveSearchKey: "brave-search-key",
    googleOauthClientSecret: "google-oauth-client-secret",
  };
  // Garde-fou de frontière : un secret ne dépasse jamais raisonnablement cette taille.
  const MAX_SECRET_LENGTH = 8192;
  for (const [field, account] of Object.entries(map)) {
    const raw = keys[field];
    if (raw === undefined) continue;

    const value = raw.trim().replace(/[\x00-\x1F\x7F]/g, "");
    if (value === "") {
      await deleteSecret("openaxis", account).catch((err) => {
        console.warn(`[main] Failed to delete secret ${account}:`, err);
      });
      continue;
    }

    // Never overwrite a real secret with the masked preview echoed back by the UI.
    if (isMaskedValue(value)) continue;

    if (value.length > MAX_SECRET_LENGTH) {
      console.warn(`[main] save-api-keys: ${account} rejected (trop long)`);
      continue;
    }
    if (field === "ollamaUrl" && !isSafeOllamaUrl(value)) {
      console.warn("[main] save-api-keys: ollama-url rejected (unsafe host)");
      continue;
    }
    await writeSecret("openaxis", account, value);
  }

  // Save custom provider keys
  for (const [field, raw] of Object.entries(keys)) {
    if (field.startsWith("custom-provider-key-") && raw !== undefined) {
      const value = raw.trim().replace(/[\x00-\x1F\x7F]/g, "");
      if (value === "") {
        await deleteSecret("openaxis", field).catch((err) => {
          console.warn(`[main] Failed to delete custom provider secret ${field}:`, err);
        });
        continue;
      }
      if (isMaskedValue(value)) continue;
      if (value.length > MAX_SECRET_LENGTH) {
        console.warn(`[main] save-api-keys: ${field} rejected (trop long)`);
        continue;
      }
      await writeSecret("openaxis", field, value);
    }
  }

  // Sync the generated opencode.json configuration immediately so the models list matches the new keys
  const updatedKeys = await (await import("./keychain.js")).readAllApiKeys();
  await generateOpenCodeConfig({
    proxyToken: proxyToken ?? "",
    anthropicKey: updatedKeys.anthropic,
    openaiKey: updatedKeys.openai,
    deepseekKey: updatedKeys.deepseek,
    openrouterKey: updatedKeys.openrouterKey,
    customProviders: customProviders,
  });

  // Notify chat view to refresh its model list
  const chatView = views.get("chat");
  if (chatView) chatView.webContents.send("api-keys-updated");
});

ipcHandle("get-custom-providers", () => {
  return customProviders;
});

ipcHandle(
  "save-custom-providers",
  async (
    _e,
    list: Array<{ id: string; name: string; baseUrl: string; models: string[] }>,
  ) => {
    if (!Array.isArray(list)) {
      throw new Error("save-custom-providers: list must be an array");
    }

    // Validate and sanitize custom providers
    const validatedList = list
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const id = String(item.id || "").trim();
        const name = String(item.name || "").trim();
        const baseUrl = String(item.baseUrl || "").trim();
        const models = Array.isArray(item.models)
          ? item.models.map((m) => String(m || "").trim()).filter(Boolean)
          : [];
        if (!id || !name || !baseUrl) return null;
        return { id, name, baseUrl, models };
      })
      .filter(Boolean) as Array<{
      id: string;
      name: string;
      baseUrl: string;
      models: string[];
    }>;

    // Compare old and new providers to delete removed keys from secrets.enc
    const { deleteSecret } = await import("./keychain.js");
    for (const old of customProviders) {
      if (!validatedList.some((p) => p.id === old.id)) {
        await deleteSecret("openaxis", `custom-provider-key-${old.id}`).catch((err) => {
          console.warn(`[main] Failed to delete custom provider key for ${old.id}:`, err);
        });
      }
    }

    customProviders = validatedList;
    await saveSettings();

    // Reload opencode config so that custom models are included in opencode config
    const { readAllApiKeys } = await import("./keychain.js");
    const keys = await readAllApiKeys();
    await generateOpenCodeConfig({
      proxyToken: proxyToken ?? "",
      anthropicKey: keys.anthropic,
      openaiKey: keys.openai,
      deepseekKey: keys.deepseek,
      openrouterKey: keys.openrouterKey,
      customProviders: customProviders,
    });

    // Notify chat view to refresh its model list
    const chatView = views.get("chat");
    if (chatView) chatView.webContents.send("api-keys-updated");
  },
);

// ── Google OAuth login for Gemini (in-app) ──────────────────────────────────
ipcHandle("gemini-login", async () => {
  const { loginWithGoogle } = await import("./gemini-oauth.js");
  return loginWithGoogle((url) => shell.openExternal(url));
});
ipcHandle("gemini-auth-status", async () => {
  const { getGeminiAuthStatus } = await import("./gemini-oauth.js");
  return getGeminiAuthStatus();
});

// ── Open Design Native Bridge Handlers ──────────────────────────────────────
ipcHandle(
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

ipcHandle(
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

ipcHandle("od-shell:open-external", async (_event, url: string) => {
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

ipcHandle("od-shell:open-path", async (_event, projectId: string) => {
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
    // The daemon response is external data — confine the path to the user's home
    // before handing it to the OS shell (same guard as __openPath).
    const resolved = await resolveWithinHome(baseDir);
    if (!resolved) return "open-path: refused (outside home)";
    const err = await shell.openPath(resolved);
    return err;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
});

ipcHandle("od-pdf:print", async (_event, html: string) => {
  const win = createLockedPdfWindow();

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

const APP_NAMES = ["openwork", "opencode", "open-design"];

ipcHandle("check-app-updates", async () => {
  // Packaged builds have no .git — the 3 apps update with the shell itself.
  if (app.isPackaged) return {};
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
  const entries = await Promise.all(
    APP_NAMES.map(async (name) => {
      try {
        const dir = path.join(APPS_DIR, name);
        await fs.access(dir);

        await execPromise(`git fetch origin +refs/tags/*:refs/tags/* 2>/dev/null; true`, {
          cwd: dir,
        });

        const localTagsRaw = (
          await execPromise(`git tag --merged HEAD 2>/dev/null || echo ""`, { cwd: dir })
        )
          .split("\n")
          .filter(Boolean);
        let localTag = findLatestTag(localTagsRaw, name);

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

        return [name, { behind, localTag, remoteTag, branch: "" }] as const;
      } catch (err) {
        return [
          name,
          {
            behind: 0,
            error: err instanceof Error ? err.message : String(err),
          },
        ] as const;
      }
    }),
  );
  for (const [name, result] of entries) {
    results[name] = result;
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

    // Use a safer execution method for version check (no shell)
    const out = await execFilePromise(cmd, ["--version"], { timeout: 5000 });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

ipcHandle("run-app-update", async (_e, appName: string) => {
  if (app.isPackaged) return { ok: false, error: "packaged" };
  if (!APP_NAMES.includes(appName)) return { ok: false, error: "unknown app" };
  try {
    const dir = path.join(APPS_DIR, appName);
    await fs.access(dir);

    const branch = (
      await execPromise(`git rev-parse --abbrev-ref HEAD`, { cwd: dir })
    ).trim();
    // Reject any branch name containing shell metacharacters before it is ever
    // interpolated into a command (defense against a maliciously-named ref).
    const safeBranch = GIT_BRANCH_RE.test(branch) ? branch : "";
    await execPromise(`git remote prune origin 2>/dev/null; true`, { cwd: dir });
    await execPromise(
      `git fetch --tags origin +refs/tags/*:refs/tags/* 2>/dev/null; true`,
      { cwd: dir },
    );
    await execPromise(`git stash --quiet 2>/dev/null; true`, { cwd: dir });
    if (safeBranch) {
      await execFilePromise("git", ["pull", "--rebase", "origin", safeBranch], {
        cwd: dir,
      }).catch(() => undefined);
    } else {
      await execFilePromise("git", ["pull", "--rebase"], { cwd: dir }).catch(
        () => undefined,
      );
    }
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
      if (shouldUpdateBinary && versionAfter !== null) {
        console.warn(
          `[update] opencode version mismatch: binary=v${binaryVersion ?? "?"} source=v${versionAfter}, syncing binary...`,
        );
        try {
          // Install the exact version that matches the source code (no pipe-to-shell)
          const installed = await installOpencodeBinary(versionAfter, dir);
          if (!installed) throw new Error("installer refused or failed");
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
        console.warn(
          `[update] opencode binary already at v${versionAfter}, no sync needed`,
        );
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

let navMode: "topbar" | "dropdown" = "topbar";
let autoUpdateEnabled = false;
let toastDismissedAt = 0;
const TOAST_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
let webSearchEnabled = false;
let visionProxyEnabled = true;
let visionModel = "openbmb/minicpm-v4.6";
let visionDetailLevel = "high";
let aiWorkflowProModel = "deepseek/deepseek-v4-pro";
let aiWorkflowFlashModel = "deepseek/deepseek-v4-flash";
let aiClassifierModel = "deepseek/deepseek-v4-flash";
let customProviders: Array<{
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
}> = [];
let notifyMode: NotifyMode = DEFAULT_NOTIFY_MODE;
let notifySources: NotifySources = defaultNotifySources();
type AppLanguage = "fr" | "en";
let language: AppLanguage = "fr";
let onboardingCompleted = false;
const SETTINGS_PATH = path.join(homedir(), ".config", "openaxis", "settings.json");

// First-run default: follow the macOS UI language, French otherwise.
function detectDefaultLanguage(): AppLanguage {
  try {
    return app.getLocale().toLowerCase().startsWith("fr") ? "fr" : "en";
  } catch {
    return "fr";
  }
}

function parseLanguage(raw: unknown): AppLanguage {
  return raw === "en" || raw === "fr" ? raw : detectDefaultLanguage();
}

const notifier = createNotifier({
  getWindow: () => mainWindow,
  getActiveSlot: () => activeSlot,
  getMode: () => notifyMode,
  getSources: () => notifySources,
  focusSource: (slot) => {
    switchSlot(slot).catch((err) => {
      console.error("[notifications] switchSlot failed:", err);
    });
  },
});

function parseNotifySources(raw: unknown, base?: NotifySources): NotifySources {
  const sources = base ? { ...base } : defaultNotifySources();
  if (typeof raw !== "object" || raw === null) return sources;
  const record = raw as Record<string, unknown>;
  for (const key of NOTIFY_SOURCES) {
    if (typeof record[key] === "boolean") sources[key] = record[key] as boolean;
  }
  return sources;
}

async function loadSettings(): Promise<void> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    navMode = parsed.navMode === "dropdown" ? "dropdown" : "topbar";
    headerHeight = navMode === "dropdown" ? HEADER_HEIGHT_DROPDOWN : HEADER_HEIGHT_TOPBAR;
    autoUpdateEnabled = !!parsed.autoUpdate;
    toastDismissedAt =
      typeof parsed.toastDismissedAt === "number" ? parsed.toastDismissedAt : 0;
    webSearchEnabled = !!parsed.webSearchEnabled;
    visionProxyEnabled = !!parsed.visionProxyEnabled;
    visionModel = parsed.visionModel || "openbmb/minicpm-v4.6";
    visionDetailLevel = parsed.visionDetailLevel || "high";
    aiWorkflowProModel = parsed.aiWorkflowProModel || "deepseek/deepseek-v4-pro";
    aiWorkflowFlashModel = parsed.aiWorkflowFlashModel || "deepseek/deepseek-v4-flash";
    aiClassifierModel = parsed.aiClassifierModel || "deepseek/deepseek-v4-flash";
    notifyMode = isNotifyMode(parsed.notifyMode)
      ? parsed.notifyMode
      : DEFAULT_NOTIFY_MODE;
    notifySources = parseNotifySources(parsed.notifySources);
    language = parseLanguage(parsed.language);
    onboardingCompleted =
      parsed.onboardingCompleted !== undefined ? !!parsed.onboardingCompleted : true; // existing settings file without the flag → existing user, skip onboarding
    customProviders = Array.isArray(parsed.customProviders) ? parsed.customProviders : [];
  } catch {
    // If settings.json exists but can't be read/parsed (e.g. format change after
    // update), the user is an existing user — skip onboarding rather than showing
    // it again. Only show onboarding when the file genuinely doesn't exist (first run).
    const settingsExists = await fs
      .stat(SETTINGS_PATH)
      .then(() => true)
      .catch(() => false);

    navMode = "topbar";
    headerHeight = HEADER_HEIGHT_TOPBAR;
    autoUpdateEnabled = false;
    toastDismissedAt = 0;
    webSearchEnabled = false;
    visionProxyEnabled = true;
    visionModel = "openbmb/minicpm-v4.6";
    visionDetailLevel = "high";
    aiWorkflowProModel = "deepseek/deepseek-v4-pro";
    aiWorkflowFlashModel = "deepseek/deepseek-v4-flash";
    aiClassifierModel = "deepseek/deepseek-v4-flash";
    notifyMode = DEFAULT_NOTIFY_MODE;
    notifySources = defaultNotifySources();
    language = detectDefaultLanguage();
    onboardingCompleted = settingsExists; // existing user with corrupt settings → skip onboarding
    customProviders = [];
  }
}

async function saveSettings(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
    await fs.writeFile(
      SETTINGS_PATH,
      JSON.stringify(
        {
          navMode,
          autoUpdate: autoUpdateEnabled,
          toastDismissedAt,
          webSearchEnabled,
          visionProxyEnabled,
          visionModel,
          visionDetailLevel,
          aiWorkflowProModel,
          aiWorkflowFlashModel,
          aiClassifierModel,
          notifyMode,
          notifySources,
          language,
          onboardingCompleted,
          customProviders,
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch {}
}

ipcHandle("get-nav-mode", () => navMode);
ipcHandle("set-nav-mode", async (_e, mode: string) => {
  navMode = mode === "dropdown" ? "dropdown" : "topbar";
  headerHeight = navMode === "dropdown" ? HEADER_HEIGHT_DROPDOWN : HEADER_HEIGHT_TOPBAR;
  await saveSettings();
  repositionViews();
  mainWindow?.webContents.send("nav-mode-changed", navMode);
});

ipcHandle("get-auto-update", () => autoUpdateEnabled);
ipcHandle("set-auto-update", async (_e, enabled: boolean) => {
  autoUpdateEnabled = enabled;
  await saveSettings();
});

// ── UI language ──────────────────────────────────────────────────────────
// Broadcast a language change to every native renderer so they re-translate
// live (third-party app views have no listener and simply ignore it).
function broadcastLanguage(): void {
  mainWindow?.webContents.send("language-changed", language);
  for (const view of views.values()) {
    view.webContents.send("language-changed", language);
  }
}

// Synchronous read so each surface can translate its first paint without FOUC.
ipcOn("get-language-sync", (e) => {
  e.returnValue = language;
});
ipcHandle("get-language", () => language);
ipcHandle("set-language", async (_e, lang: string) => {
  language = lang === "en" ? "en" : "fr";
  await saveSettings();
  broadcastLanguage();
});

// ── Onboarding ──────────────────────────────────────────────────────────
ipcOn("onboarding-pending-sync", (e) => {
  e.returnValue = !onboardingCompleted;
});

ipcOn("onboarding-visibility", (_e, open: boolean) => {
  onboardingOpen = open;
  repositionViews();
});

ipcHandle("complete-onboarding", async () => {
  onboardingCompleted = true;
  onboardingOpen = false;
  await saveSettings();
  repositionViews();
});

ipcHandle("reset-onboarding", async () => {
  onboardingCompleted = false;
  await saveSettings();
});

// ── Self-update (Partie 2) ───────────────────────────────────────────────

// ── Update toast (floating bottom-right notification) ────────────────────
const TOAST_WIDTH = 380;
const TOAST_HEIGHT = 76;
const TOAST_MARGIN = 16;
let updateToast: BrowserWindow | null = null;

function repositionToast(): void {
  if (!updateToast || !mainWindow) return;
  const [wx, wy] = mainWindow.getPosition();
  const [ww, wh] = mainWindow.getSize();
  updateToast.setPosition(
    wx + ww - TOAST_WIDTH - TOAST_MARGIN,
    wy + wh - TOAST_HEIGHT - TOAST_MARGIN,
  );
}

function showUpdateToast(version: string): void {
  if (updateToast || !mainWindow) return;
  if (Date.now() - toastDismissedAt < TOAST_COOLDOWN_MS) return;

  updateToast = new BrowserWindow({
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    backgroundColor: "#00000000",
    parent: mainWindow,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  if (process.platform === "darwin") {
    updateToast.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    updateToast.setAlwaysOnTop(true, "status");
  }

  repositionToast();

  updateToast.loadFile(path.join(__dirname, "update-toast.html"), {
    query: { version },
  });

  mainWindow.on("move", repositionToast);
  mainWindow.on("resize", repositionToast);

  updateToast.on("closed", () => {
    updateToast = null;
    mainWindow?.off("move", repositionToast);
    mainWindow?.off("resize", repositionToast);
  });
}

function dismissUpdateToast(): void {
  if (!updateToast) return;
  updateToast.close();
}

ipcHandle("dismiss-update-toast", async () => {
  toastDismissedAt = Date.now();
  await saveSettings();
  dismissUpdateToast();
});

ipcHandle("get-app-mode", () => ({ isPackaged: app.isPackaged }));

ipcHandle("self-update-check", async () => {
  const info = await checkForUpdate();
  if (info) showUpdateToast(info.version);
  return info ? { version: info.version } : null;
});

ipcHandle("self-update-install", async () => {
  await downloadAndInstall();
});

// Read-only versions of the 3 bundled apps (written at build time by
// package-apps.sh). Returns null in dev (no versions.json) — the UI only shows
// this section in packaged mode anyway.
ipcHandle("get-bundled-versions", async () => {
  try {
    const raw = await fs.readFile(path.join(APPS_DIR, "versions.json"), "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
});

ipcHandle("run-graphify-update", async (_e, dir?: string) => {
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
        error:
          "Veuillez d'abord ouvrir un projet spécifique pour lancer la cartographie.",
      };
    }

    // Refuse to operate outside the user's home tree (cwd is handed to graphify).
    if (!(await resolveWithinHome(workspaceDir))) {
      return {
        ok: false,
        error: "Dossier de projet invalide (hors du répertoire utilisateur).",
      };
    }

    // Electron apps launched from Finder/Dock inherit a minimal PATH that
    // excludes ~/.local/bin, nvm paths, etc. Build an enriched PATH so we
    // can locate user-installed binaries like graphify and npm.
    const home = homedir();
    const extraDirs = [
      path.join(home, ".local", "bin"),
      path.join(home, ".nvm", "versions", "node"),
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ];
    // For nvm, pick the latest installed version's bin directory.
    try {
      const nvmBase = path.join(home, ".nvm", "versions", "node");
      const versions = await fs.readdir(nvmBase);
      if (versions.length > 0) {
        versions.sort();
        extraDirs.push(path.join(nvmBase, versions[versions.length - 1], "bin"));
      }
    } catch {
      // nvm not installed — ignore
    }
    const enrichedPath =
      extraDirs.join(path.delimiter) + path.delimiter + (process.env.PATH ?? "");
    const pathEnv = { env: { ...process.env, PATH: enrichedPath } };

    // Check if graphify is installed (execFile — no shell)
    let graphifyBin = "";
    try {
      graphifyBin = (await execFilePromise("which", ["graphify"], pathEnv)).trim();
    } catch {
      // not found
    }

    if (!graphifyBin) {
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
          await execFilePromise("npm", ["install", "-g", "graphify-ai"], pathEnv);
          graphifyBin = (await execFilePromise("which", ["graphify"], pathEnv)).trim();
        } catch {
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

    // Run update in the actual project directory (execFile — no shell)
    console.warn(`[graphify] Running update in: ${workspaceDir}`);
    await execFilePromise(graphifyBin || "graphify", ["update", "."], {
      cwd: workspaceDir,
      ...pathEnv,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcHandle("get-web-search-enabled", () => webSearchEnabled);
ipcHandle("set-web-search-enabled", async (_e, enabled: boolean) => {
  webSearchEnabled = enabled;
  await saveSettings();
});

ipcHandle("get-vision-proxy-enabled", () => visionProxyEnabled);
ipcHandle("set-vision-proxy-enabled", async (_e, enabled: boolean) => {
  visionProxyEnabled = enabled;
  await saveSettings();
});

ipcHandle("get-vision-model", () => visionModel);
ipcHandle("set-vision-model", async (_e, model: string) => {
  visionModel = model;
  await saveSettings();
});

ipcHandle("get-vision-detail-level", () => visionDetailLevel);
ipcHandle("set-vision-detail-level", async (_e, level: string) => {
  visionDetailLevel = level;
  await saveSettings();
});

ipcHandle("get-available-models", async () => {
  const { readAllApiKeys } = await import("./keychain.js");
  const { buildModelList } = await import("./proxy/index.js");
  const { getGeminiAuthStatus } = await import("./gemini-oauth.js");
  const keys = await readAllApiKeys();
  const models = await buildModelList(keys);
  const geminiAuth = await getGeminiAuthStatus();
  return models
    .filter((m) => m.source !== "gemini" || geminiAuth.connected)
    .map((m) => ({ id: m.id, source: m.source }));
});

// AI Intelligence Settings
ipcHandle("get-ai-workflow-pro-model", () => aiWorkflowProModel);
ipcHandle("set-ai-workflow-pro-model", async (_e, model: string) => {
  aiWorkflowProModel = model;
  await saveSettings();
});

ipcHandle("get-ai-workflow-flash-model", () => aiWorkflowFlashModel);
ipcHandle("set-ai-workflow-flash-model", async (_e, model: string) => {
  aiWorkflowFlashModel = model;
  await saveSettings();
});

ipcHandle("get-ai-classifier-model", () => aiClassifierModel);
ipcHandle("set-ai-classifier-model", async (_e, model: string) => {
  aiClassifierModel = model;
  await saveSettings();
});

// Notifications de fin de tâche
ipcHandle("get-notify-mode", () => notifyMode);
ipcHandle("set-notify-mode", async (_e, mode: unknown) => {
  if (!isNotifyMode(mode)) return;
  notifyMode = mode;
  await saveSettings();
});

ipcHandle("get-notify-sources", () => ({ ...notifySources }));
ipcHandle("set-notify-sources", async (_e, sources: unknown) => {
  notifySources = parseNotifySources(sources, notifySources);
  await saveSettings();
});

const NOTIFY_BODY_MAX = 200;
const TASK_DONE_SENDER_SLOT: Record<string, SlotName> = {
  chat: "projects",
  code: "code",
  work: "work",
  design: "design",
};
ipcOn("task-done", (e, source: unknown, body?: unknown) => {
  if (!isNotifySource(source)) return;
  const expectedView = views.get(TASK_DONE_SENDER_SLOT[source]);
  if (!expectedView || e.sender !== expectedView.webContents) return;
  const safeBody =
    typeof body === "string" && body.trim() !== ""
      ? body.trim().slice(0, NOTIFY_BODY_MAX)
      : undefined;
  notifier.notify(source, safeBody !== undefined ? { body: safeBody } : undefined);
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

// Runs a binary with an explicit argument array and NO shell — values can never be
// interpreted as shell metacharacters. Use this whenever a dynamic value (path,
// version, branch) would otherwise be interpolated into a command string.
function execFilePromise(
  file: string,
  args: readonly string[],
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args as string[],
      { ...opts, timeout: opts.timeout ?? 120000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      },
    );
  });
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const GIT_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

// Resolves `target` and confirms it stays inside the user's home directory using a
// path-segment check (NOT a string prefix, which would accept siblings like
// `/Users/bob-evil` for home `/Users/bob`). When the path exists, its realpath is
// re-checked so a symlink cannot escape the home boundary. Returns the safe
// canonical path, or null if it escapes.
async function resolveWithinHome(target: unknown): Promise<string | null> {
  if (typeof target !== "string" || target === "") return null;
  const home = path.resolve(homedir());
  const isInside = (p: string): boolean => {
    const rel = path.relative(home, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const resolved = path.resolve(target);
  if (!isInside(resolved)) return null;
  try {
    const real = await fs.realpath(resolved);
    if (!isInside(real)) return null;
    return real;
  } catch {
    // Path does not exist yet — the lexical containment check above already passed.
    return resolved;
  }
}

const OPENCODE_INSTALL_URL = "https://opencode.ai/install";

// Installs a specific opencode binary version WITHOUT piping a remote script into a
// shell. The installer is downloaded to a temp file over HTTPS, then executed with
// the (semver-validated) version passed via an environment variable — never
// interpolated into a command string. Returns true on success.
async function installOpencodeBinary(version: string, cwd: string): Promise<boolean> {
  if (!SEMVER_RE.test(version)) {
    console.warn(`[update] refusing to install non-semver opencode version: ${version}`);
    return false;
  }
  const scriptPath = path.join(
    tmpdir(),
    `opencode-install-${randomBytes(8).toString("hex")}.sh`,
  );
  try {
    const resp = await fetch(OPENCODE_INSTALL_URL);
    if (!resp.ok) throw new Error(`download failed (${resp.status})`);
    const script = await resp.text();
    await fs.writeFile(scriptPath, script, { mode: 0o700 });
    await execFilePromise("bash", [scriptPath], {
      cwd,
      env: { ...process.env, VERSION: version },
    });
    return true;
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => undefined);
  }
}

ipcHandle("od-updater:action", () => {
  return { state: "unsupported" };
});

async function ensureBinarySynced(): Promise<void> {
  // Packaged builds ship a pinned opencode binary and don't bundle the opencode
  // source repo — there is nothing to sync against, so skip (avoids a misleading
  // ENOENT warning on every launch).
  if (app.isPackaged) return;
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
    const synced = await installOpencodeBinary(sourceVersion, opencodeDir);
    if (synced) console.warn(`[main] opencode binary synced to v${sourceVersion} ✓`);
  } catch (err) {
    console.warn(`[main] failed to sync opencode binary at startup (non-fatal):`, err);
  }
}

// Web UIs loaded in the WebContentsViews (work/code/design/chat/projects) could
// request OS-sensitive capabilities. Use an ALLOWLIST: only the few permissions
// the apps actually need are granted; everything else (camera/mic, geolocation,
// hid/serial/usb, clipboard-read, window management, idle detection, plus any
// future Electron permission type) is denied by default.
const ALLOWED_PERMISSIONS = new Set([
  "notifications",
  "fullscreen",
  "clipboard-sanitized-write",
]);

// Defense-in-depth navigation guard applied to EVERY web contents the app ever
// creates (main window, splash, nav popup, slot/chat/projects views, and any
// future child). Per-view handlers exist too, but this closes the gap for
// windows that lack one and catches webContents created later.
function applyNavigationHardening(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });
    const blockOffFile = (event: { preventDefault: () => void }, url: string): void => {
      if (
        !url.startsWith("file://") &&
        !url.startsWith("http://") &&
        !url.startsWith("https://")
      ) {
        event.preventDefault();
        console.warn(`[main] Blocked navigation to non-web scheme: ${url}`);
      }
    };
    contents.on("will-navigate", (event, url) => blockOffFile(event, url));
    contents.on("will-redirect", (event, url) => blockOffFile(event, url));
  });
}

function applyPermissionHardening(): void {
  for (const sess of [session.defaultSession, session.fromPartition("persist:chat")]) {
    sess.setPermissionRequestHandler((_wc, permission, callback) => {
      if (!ALLOWED_PERMISSIONS.has(permission)) {
        console.warn(`[main] Denied permission request: ${permission}`);
        callback(false);
        return;
      }
      callback(true);
    });
    sess.setPermissionCheckHandler((_wc, permission) => {
      return ALLOWED_PERMISSIONS.has(permission);
    });
  }
}

async function enrichPathGlobally(): Promise<void> {
  const home = homedir();
  const extraDirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".nvm", "versions", "node"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];

  // NVM
  try {
    const nvmBase = path.join(home, ".nvm", "versions", "node");
    const versions = await fs.readdir(nvmBase);
    if (versions.length > 0) {
      versions.sort();
      extraDirs.push(path.join(nvmBase, versions[versions.length - 1], "bin"));
    }
  } catch {
    // ignore
  }

  // FNM
  try {
    const fnmDir = path.join(
      home,
      "Library",
      "Application Support",
      "fnm",
      "aliases",
      "default",
      "bin",
    );
    extraDirs.push(path.join(home, ".fnm"));
    extraDirs.push(path.join(home, "Library", "Application Support", "fnm"));
    extraDirs.push(fnmDir);
  } catch {
    // ignore
  }

  // Volta
  extraDirs.push(path.join(home, ".volta", "bin"));

  // npm-global / yarn / bun / pnpm
  extraDirs.push(
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".npm-packages", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, "Library", "pnpm"),
  );

  const existingPath = process.env.PATH ?? "";
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const dir of [...extraDirs, ...existingPath.split(path.delimiter)]) {
    if (!dir) continue;
    try {
      const resolved = path.resolve(dir);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        merged.push(dir);
      }
    } catch {
      // ignore
    }
  }

  process.env.PATH = merged.join(path.delimiter);
}

app
  .whenReady()
  .then(async () => {
    const bootT0 = Date.now();
    const bootT = (label: string) =>
      console.warn(`[boot-timing] ${label} +${Date.now() - bootT0}ms`);

    await enrichPathGlobally();

    nativeTheme.themeSource = "dark";
    applyNavigationHardening();
    splashWindow = createSplash();
    splashShownAt = Date.now();
    bootT("splash shown");

    applyPermissionHardening();

    bootT("loadSettings start");
    await loadSettings();
    await initWorkspaces();
    bootT("loadSettings done");
    registerOllamaHandlers();
    bootT("startProxy start");
    proxyToken = await startProxy();
    setProxyToken(proxyToken);
    bootT("startProxy done");

    bootT("readSecrets start");
    const [anthropicKey, openaiKey, deepseekKey, openrouterKey, googleAiKey] =
      await Promise.all([
        readSecret("openaxis", "anthropic-api-key"),
        readSecret("openaxis", "openai-api-key"),
        readSecret("openaxis", "deepseek-api-key"),
        readSecret("openaxis", "openrouter-api-key"),
        readSecret("openaxis", "google-ai-key"),
      ]);
    bootT("readSecrets done");

    processManager = new ProcessManager(
      proxyToken,
      { googleAiKey },
      {
        isPackaged: app.isPackaged,
        appsDir: APPS_DIR,
        resourcesPath: process.resourcesPath,
        userDataDir: app.getPath("userData"),
      },
    );
    bootT("ProcessManager created");

    // Sync binary in background so it doesn't block UI startup
    ensureBinarySynced().catch((err) => {
      console.error("[main] background binary sync failed:", err);
    });

    // Sync remote overrides (OTA patches) in background — packaged builds only
    if (app.isPackaged) {
      syncRemoteOverrides().catch((err) => {
        console.warn("[main] remote overrides sync failed:", err);
      });
    }

    bootT("generateOpenCodeConfig start");
    await generateOpenCodeConfig({
      proxyToken,
      anthropicKey,
      openaiKey,
      deepseekKey,
      openrouterKey,
      customProviders,
    });
    bootT("generateOpenCodeConfig done");

    // Start opencode ASAP — don't let the gh token lookup (up to 5s timeout)
    // delay the background boot. Work slot also needs the opencode engine.
    bootT("ensureRunning(code) fire-and-forget");
    processManager.ensureRunning("code").catch((err) => {
      console.warn("[main] background opencode start failed:", err);
    });

    // Resolve a GitHub token for the self-updater — runs concurrently with
    // opencode boot + window creation so it never blocks the startup path.
    const ghTokenP = (async () => {
      if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
      try {
        return (await execFilePromise("gh", ["auth", "token"], { timeout: 5000 })).trim();
      } catch {
        return "";
      }
    })();

    bootT("createWindow start");
    await createWindow();
    bootT("createWindow done");

    // Initialize the self-updater after the window is up — the gh token
    // lookup ran in parallel and is ready (or timed out) by now.
    const ghToken = await ghTokenP;
    initUpdater({
      getProcessManager: () => processManager,
      onStatusChange: (status) => {
        mainWindow?.webContents.send("self-update-status", status);
        updateToast?.webContents.send("self-update-status", status);
        if (status.stage === "available") {
          mainWindow?.webContents.send("self-update-available", status.version);
          showUpdateToast(status.version);
        }
      },
      githubToken: ghToken || undefined,
    });

    // Background self-update check (U4: only when packaged, best-effort)
    if (app.isPackaged && autoUpdateEnabled) {
      checkForUpdate().catch((err) => {
        console.warn("[main] background self-update check failed:", err);
      });
    }
  })
  .catch((err) => {
    console.error("[main] fatal startup error:", err);
    dialog.showErrorBox(
      "OpenAxis — Startup Error",
      `The application failed to start:\n\n${err instanceof Error ? err.message : String(err)}`,
    );
    app.quit();
  });

app.on("window-all-closed", () => {
  processManager?.stopAll();
  app.quit();
});

app.on("before-quit", () => {
  processManager?.stopAll();
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    processManager?.stopAll();
    process.exit(0);
  });
}

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
