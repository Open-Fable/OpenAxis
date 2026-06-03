const { contextBridge, ipcRenderer } = require("electron");

type SlotName = "work" | "code" | "design" | "config";

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

  webSearch: (query: string) => ipcRenderer.invoke("web-search", query),

  getApiKeys: () => ipcRenderer.invoke("get-api-keys"),

  notifyConfigVisibility: (open: boolean) => ipcRenderer.send("config-visibility", open),

  openworkDesktopInvoke: (command: string, ...args: unknown[]) =>
    ipcRenderer.invoke("openwork-desktop-invoke", command, ...args),

  saveApiKeys: (keys: {
    anthropic?: string;
    openai?: string;
    ollamaUrl?: string;
    githubToken?: string;
    braveSearchKey?: string;
  }) => ipcRenderer.invoke("save-api-keys", keys),
});
