const { contextBridge, ipcRenderer } = require("electron");

type SlotName = "work" | "code" | "design" | "chat" | "config";

contextBridge.exposeInMainWorld("openhub", {
  switchSlot: (slot: SlotName) => ipcRenderer.invoke("switch-slot", slot),

  exportPdf: () => ipcRenderer.invoke("export-pdf"),

  getSlotStatus: () => ipcRenderer.invoke("get-slot-status"),

  onSlotChanged: (cb: (slot: SlotName) => void) => {
    ipcRenderer.on("slot-changed", (_e: unknown, slot: SlotName) => cb(slot));
  },

  onShowConfig: (cb: () => void) => {
    ipcRenderer.on("show-config", () => cb());
  },

  onApiKeysUpdated: (cb: () => void) => {
    ipcRenderer.on("api-keys-updated", () => cb());
  },

  webSearch: (query: string) => ipcRenderer.invoke("web-search", query),

  getApiKeys: () => ipcRenderer.invoke("get-api-keys"),

  notifyConfigVisibility: (open: boolean) => ipcRenderer.send("config-visibility", open),

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
    instructions: string;
    color: string;
  }) => ipcRenderer.invoke("save-project", project),
  deleteProject: (id: string) => ipcRenderer.invoke("delete-project", id),

  getChatConfig: () => ipcRenderer.invoke("get-chat-config"),

  exportHtmlToPdf: (html: string) => ipcRenderer.invoke("export-html-to-pdf", html),

  getMemory: () => ipcRenderer.invoke("get-memory"),
  setMemoryEnabled: (enabled: boolean) => ipcRenderer.invoke("set-memory-enabled", enabled),
  setMemoryProfile: (profile: string) => ipcRenderer.invoke("set-memory-profile", profile),
  addMemoryFact: (text: string, tags: string[]) =>
    ipcRenderer.invoke("add-memory-fact", text, tags),
  removeMemoryFact: (id: string) => ipcRenderer.invoke("remove-memory-fact", id),
  updateMemoryFact: (id: string, patch: { text?: string; tags?: string[] }) =>
    ipcRenderer.invoke("update-memory-fact", id, patch),
});
