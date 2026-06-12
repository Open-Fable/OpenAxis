import { contextBridge, ipcRenderer } from "electron";

type SlotName = "work" | "code" | "design" | "chat" | "config" | "projects";

contextBridge.exposeInMainWorld("openhub", {
  switchSlot: (slot: SlotName) => ipcRenderer.invoke("switch-slot", slot),
  showSlotContextMenu: (slot: SlotName) =>
    ipcRenderer.send("show-slot-context-menu", slot),

  exportPdf: () => ipcRenderer.invoke("export-pdf"),

  getSlotStatus: () => ipcRenderer.invoke("get-slot-status"),

  onSlotChanged: (cb: (slot: SlotName) => void) => {
    const handler = (_e: unknown, slot: SlotName) => cb(slot);
    ipcRenderer.on("slot-changed", handler);
    return () => ipcRenderer.removeListener("slot-changed", handler);
  },

  onShowConfig: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("show-config", handler);
    return () => ipcRenderer.removeListener("show-config", handler);
  },

  onApiKeysUpdated: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("api-keys-updated", handler);
    return () => ipcRenderer.removeListener("api-keys-updated", handler);
  },

  webSearch: (query: string) => ipcRenderer.invoke("web-search", query),

  getApiKeys: () => ipcRenderer.invoke("get-api-keys"),

  notifyConfigVisibility: (open: boolean) => ipcRenderer.send("config-visibility", open),
  showNavMenu: (x: number, y: number) => ipcRenderer.send("show-nav-menu", x, y),
  navPopupSelect: (slot: string) => ipcRenderer.send("nav-popup-select", slot),

  notifyTaskDone: (source: string, body?: string) =>
    ipcRenderer.send("task-done", source, body),
  getNotifyMode: () => ipcRenderer.invoke("get-notify-mode"),
  setNotifyMode: (mode: string) => ipcRenderer.invoke("set-notify-mode", mode),
  getNotifySources: () => ipcRenderer.invoke("get-notify-sources"),
  setNotifySources: (sources: Record<string, boolean>) =>
    ipcRenderer.invoke("set-notify-sources", sources),

  getNavMode: () => ipcRenderer.invoke("get-nav-mode"),
  setNavMode: (mode: string) => ipcRenderer.invoke("set-nav-mode", mode),
  onNavModeChanged: (cb: (mode: string) => void) => {
    const handler = (_e: unknown, mode: string) => cb(mode);
    ipcRenderer.on("nav-mode-changed", handler);
    return () => ipcRenderer.removeListener("nav-mode-changed", handler);
  },

  openworkDesktopInvoke: (command: string, ...args: unknown[]) =>
    ipcRenderer.invoke("openwork-desktop-invoke", command, ...args),

  saveApiKeys: (keys: {
    anthropic?: string;
    openai?: string;
    openrouterKey?: string;
    ollamaUrl?: string;
    githubToken?: string;
    braveSearchKey?: string;
  }) => ipcRenderer.invoke("save-api-keys", keys),

  getProjects: () => ipcRenderer.invoke("get-projects"),
  getActiveProject: () => ipcRenderer.invoke("get-active-project"),
  setActiveProject: (id: string | null) => ipcRenderer.invoke("set-active-project", id),
  saveProject: (project: {
    id?: string;
    name: string;
    instructions?: string;
    color?: string;
    type?: string;
    model?: string;
    reasoningEffort?: string;
    linked?: string[];
    dependencies?: string[];
    orchSettings?: Record<string, boolean>;
    task?: string;
    path?: string;
    x?: number;
    y?: number;
  }) => ipcRenderer.invoke("save-project", project),
  deleteProject: (id: string) => ipcRenderer.invoke("delete-project", id),
  pickProjectPath: () => ipcRenderer.invoke("pick-project-path"),

  getWorkflows: () => ipcRenderer.invoke("get-workflows"),
  saveWorkflow: (workflow: {
    id?: string;
    name: string;
    orchProjectId?: string;
    linkedProjectIds?: string[];
    agentTypes?: Record<string, string>;
    workDir?: string;
  }) => ipcRenderer.invoke("save-workflow", workflow),
  deleteWorkflow: (id: string) => ipcRenderer.invoke("delete-workflow", id),

  getOrchRuns: (workflowId?: string) => ipcRenderer.invoke("get-orch-runs", workflowId),
  saveOrchRun: (run: {
    workflowId: string;
    orchProjectId: string;
    task: string;
    status: string;
    nodeResults: Array<{
      projectId: string;
      name: string;
      status: string;
      result?: string;
    }>;
    logs: string[];
    startedAt: number;
    finishedAt: number;
    duration: number;
  }) => ipcRenderer.invoke("save-orch-run", run),
  deleteOrchRun: (id: string) => ipcRenderer.invoke("delete-orch-run", id),
  clearOrchRuns: (workflowId?: string) =>
    ipcRenderer.invoke("clear-orch-runs", workflowId),

  getChatConfig: () => ipcRenderer.invoke("get-chat-config"),

  exportHtmlToPdf: (html: string) => ipcRenderer.invoke("export-html-to-pdf", html),

  getMemory: () => ipcRenderer.invoke("get-memory"),
  setMemoryEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("set-memory-enabled", enabled),
  setMemoryAutoExtract: (enabled: boolean) =>
    ipcRenderer.invoke("set-memory-auto-extract", enabled),
  setMemoryProfile: (profile: string) =>
    ipcRenderer.invoke("set-memory-profile", profile),
  addMemoryFact: (text: string, tags: string[]) =>
    ipcRenderer.invoke("add-memory-fact", text, tags),
  removeMemoryFact: (id: string) => ipcRenderer.invoke("remove-memory-fact", id),
  updateMemoryFact: (id: string, patch: { text?: string; tags?: string[] }) =>
    ipcRenderer.invoke("update-memory-fact", id, patch),
  getSkills: () => ipcRenderer.invoke("get-skills"),
  saveSkill: (skill: { filename?: string; title: string; content: string }) =>
    ipcRenderer.invoke("save-skill", skill),
  deleteSkill: (filename: string) => ipcRenderer.invoke("delete-skill", filename),
  executeOrchestration: (id: string, task: string, workDir?: string) =>
    ipcRenderer.invoke("execute-orchestration", id, task, workDir ?? ""),
  cancelOrchestration: () => ipcRenderer.invoke("cancel-orchestration"),
  getOrchStatusBuffer: () => ipcRenderer.invoke("get-orch-status-buffer"),
  onOrchestrationStatus: (
    cb: (data: {
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
    }) => void,
  ) => {
    const handler = (
      _e: unknown,
      data: {
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
      },
    ) => cb(data);
    ipcRenderer.on("orchestration-status", handler);
    return () => {
      ipcRenderer.removeListener("orchestration-status", handler);
    };
  },
  checkAppUpdates: () => ipcRenderer.invoke("check-app-updates"),
  runAppUpdate: (appName: string) => ipcRenderer.invoke("run-app-update", appName),
  getAutoUpdate: () => ipcRenderer.invoke("get-auto-update"),
  setAutoUpdate: (enabled: boolean) => ipcRenderer.invoke("set-auto-update", enabled),
  runGraphifyUpdate: (dir?: string) => ipcRenderer.invoke("run-graphify-update", dir),
  getWebSearchEnabled: () => ipcRenderer.invoke("get-web-search-enabled"),
  setWebSearchEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("set-web-search-enabled", enabled),
  getVisionProxyEnabled: () => ipcRenderer.invoke("get-vision-proxy-enabled"),
  setVisionProxyEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("set-vision-proxy-enabled", enabled),
  getVisionModel: () => ipcRenderer.invoke("get-vision-model"),
  setVisionModel: (model: string) => ipcRenderer.invoke("set-vision-model", model),
  getVisionDetailLevel: () => ipcRenderer.invoke("get-vision-detail-level"),
  setVisionDetailLevel: (level: string) =>
    ipcRenderer.invoke("set-vision-detail-level", level),

  getAiWorkflowProModel: () => ipcRenderer.invoke("get-ai-workflow-pro-model"),
  setAiWorkflowProModel: (model: string) =>
    ipcRenderer.invoke("set-ai-workflow-pro-model", model),
  getAiWorkflowFlashModel: () => ipcRenderer.invoke("get-ai-workflow-flash-model"),
  setAiWorkflowFlashModel: (model: string) =>
    ipcRenderer.invoke("set-ai-workflow-flash-model", model),
  getAiClassifierModel: () => ipcRenderer.invoke("get-ai-classifier-model"),
  setAiClassifierModel: (model: string) =>
    ipcRenderer.invoke("set-ai-classifier-model", model),

  readChatBackup: () => ipcRenderer.invoke("read-chat-backup"),
  writeChatBackup: (data: string) => ipcRenderer.invoke("write-chat-backup", data),

  readOrchConversations: () => ipcRenderer.invoke("read-orch-conversations"),
  writeOrchConversations: (data: string) =>
    ipcRenderer.invoke("write-orch-conversations", data),

  ollamaCheckModels: () => ipcRenderer.invoke("ollama-check-models"),
  ollamaPullModel: (model: string) => ipcRenderer.send("ollama-pull-model", model),
  ollamaCancelPull: (model: string) => ipcRenderer.send("ollama-cancel-pull", model),
  onOllamaPullProgress: (cb: (progress: unknown) => void) => {
    const handler = (_e: unknown, progress: unknown) => cb(progress);
    ipcRenderer.on("ollama-pull-progress", handler);
    return () => ipcRenderer.removeListener("ollama-pull-progress", handler);
  },
});

type ProjectImportResult =
  | { ok: true; projectId: string; conversationId: string; entryFile: string | null }
  | { ok: false; canceled: true }
  | { ok: false; reason: string; details?: unknown };

type ProjectReplaceWorkingDirResult =
  | { ok: true; baseDir: string; entryFile: string | null }
  | { ok: false; canceled: true }
  | { ok: false; reason: string; details?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProjectImportResult(input: unknown): ProjectImportResult {
  if (!isRecord(input)) {
    return { ok: false, reason: "desktop import returned an invalid response" };
  }
  if (input.ok !== true) {
    if (input.canceled === true) {
      return { ok: false, canceled: true };
    }
    return {
      ok: false,
      reason:
        typeof input.reason === "string" && input.reason.length > 0
          ? input.reason
          : "unknown failure",
      details: input.details,
    };
  }

  const response = input.response;
  if (!isRecord(response)) {
    return { ok: false, reason: "daemon import response was not an object" };
  }
  const project = response.project;
  const rawProjectId = isRecord(project) ? project.id : null;
  const projectId = typeof rawProjectId === "string" ? rawProjectId : null;
  const conversationId =
    typeof response.conversationId === "string" ? response.conversationId : null;
  const entryFile =
    typeof response.entryFile === "string" || response.entryFile === null
      ? response.entryFile
      : null;

  if (projectId === null || conversationId === null) {
    return {
      ok: false,
      reason: "daemon import response did not include host project identifiers",
    };
  }

  return {
    conversationId,
    entryFile,
    ok: true,
    projectId,
  };
}

function normalizeProjectReplaceWorkingDirResult(
  input: unknown,
): ProjectReplaceWorkingDirResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      reason: "desktop working-dir replace returned an invalid response",
    };
  }
  if (input.ok !== true) {
    if (input.canceled === true) {
      return { ok: false, canceled: true };
    }
    return {
      ok: false,
      reason:
        typeof input.reason === "string" && input.reason.length > 0
          ? input.reason
          : "unknown failure",
      details: input.details,
    };
  }

  const response = input.response;
  if (!isRecord(response)) {
    return { ok: false, reason: "daemon working-dir response was not an object" };
  }
  const baseDir = typeof response.baseDir === "string" ? response.baseDir : null;
  const entryFile =
    typeof response.entryFile === "string" || response.entryFile === null
      ? response.entryFile
      : null;

  if (baseDir === null) {
    return { ok: false, reason: "daemon working-dir response did not include baseDir" };
  }

  return { baseDir, entryFile, ok: true };
}

contextBridge.exposeInMainWorld("__od__", {
  version: 1,
  client: {
    type: "desktop",
    platform: process.platform,
  },
  shell: {
    openExternal: async (url: string) => {
      try {
        const opened = (await ipcRenderer.invoke(
          "od-shell:open-external",
          url,
        )) as boolean;
        return opened === true
          ? { ok: true }
          : { ok: false, reason: "external URL was not opened" };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    openPath: async (projectId: string) => {
      try {
        const result = (await ipcRenderer.invoke("od-shell:open-path", projectId)) as
          | string
          | null;
        if (typeof result === "string" && result.length > 0) {
          return { ok: false, reason: result };
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
  project: {
    pickAndImport: async (init?: {
      name?: string;
      skillId?: string | null;
      designSystemId?: string | null;
    }) => {
      try {
        const res = await ipcRenderer.invoke("od-dialog:pick-and-import", init ?? null);
        return normalizeProjectImportResult(res);
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    pickAndReplaceWorkingDir: async (projectId: string) => {
      try {
        const res = await ipcRenderer.invoke("od-dialog:pick-and-replace-working-dir", {
          projectId,
        });
        return normalizeProjectReplaceWorkingDirResult(res);
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
  pdf: {
    print: async (html: string, nonce?: string, options?: { deck?: boolean }) => {
      try {
        await ipcRenderer.invoke("od-pdf:print", html, nonce ?? null, options ?? null);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
  pet: {
    setVisible: (visible: boolean) => {
      ipcRenderer.send("od-pet:set-visible", !!visible);
    },
  },
  updater: {
    check: async () => ipcRenderer.invoke("od-updater:action", "check"),
    download: async () => ipcRenderer.invoke("od-updater:action", "download"),
    install: async () => ipcRenderer.invoke("od-updater:action", "install"),
    quit: async () => ipcRenderer.invoke("od-updater:action", "quit"),
    status: async () => ipcRenderer.invoke("od-updater:action", "status"),
    subscribe: (listener: (status: unknown) => void) => {
      const handler = (_event: unknown, status: unknown): void => {
        listener(status);
      };
      ipcRenderer.on("od-updater:status-changed", handler);
      return () => {
        ipcRenderer.removeListener("od-updater:status-changed", handler);
      };
    },
  },
});
