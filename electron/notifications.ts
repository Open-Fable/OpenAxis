// OpenHub — Task-completion notifications
//
// Central decision point for "a task finished in slot X" signals coming from
// the orchestrator (main process) and the renderers (chat, code, work, design
// via the shared preload bridge).

import { BrowserWindow, Notification, shell } from "electron";
import type { SlotName } from "./types";

export type NotifySource = "chat" | "code" | "work" | "design" | "orchestrator";

export type NotifyMode = "always" | "never" | "background" | "other-tab" | "sound";

export type NotifySources = Record<NotifySource, boolean>;

export const NOTIFY_SOURCES: readonly NotifySource[] = [
  "chat",
  "code",
  "work",
  "design",
  "orchestrator",
];

export const NOTIFY_MODES: readonly NotifyMode[] = [
  "always",
  "never",
  "background",
  "other-tab",
  "sound",
];

export const DEFAULT_NOTIFY_MODE: NotifyMode = "other-tab";

export function defaultNotifySources(): NotifySources {
  return { chat: true, code: true, work: true, design: true, orchestrator: true };
}

export function isNotifySource(value: unknown): value is NotifySource {
  return typeof value === "string" && (NOTIFY_SOURCES as string[]).includes(value);
}

export function isNotifyMode(value: unknown): value is NotifyMode {
  return typeof value === "string" && (NOTIFY_MODES as string[]).includes(value);
}

const SOURCE_SLOT: Record<NotifySource, SlotName> = {
  chat: "projects",
  orchestrator: "projects",
  code: "code",
  work: "work",
  design: "design",
};

const SOURCE_LABELS: Record<NotifySource, string> = {
  chat: "Chat",
  code: "Code",
  work: "Work",
  design: "Design",
  orchestrator: "Orchestrateur",
};

const DEFAULT_BODY: Record<NotifySource, string> = {
  chat: "La réponse du chat est prête.",
  code: "La tâche Code est terminée.",
  work: "La tâche Work est terminée.",
  design: "La tâche Design est terminée.",
  orchestrator: "L'orchestration est terminée.",
};

export interface NotifierDeps {
  getWindow: () => BrowserWindow | null;
  getActiveSlot: () => SlotName;
  getMode: () => NotifyMode;
  getSources: () => NotifySources;
  focusSource: (slot: SlotName) => void;
}

export interface Notifier {
  notify: (source: NotifySource, details?: { body?: string }) => void;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  function shouldNotify(source: NotifySource): boolean {
    const mode = deps.getMode();
    if (mode === "never") return false;
    if (deps.getSources()[source] === false) return false;
    if (mode === "always" || mode === "sound") return true;

    const win = deps.getWindow();
    const focused = !!win && !win.isDestroyed() && win.isFocused();
    if (mode === "background") return !focused;

    // mode === "other-tab"
    const onTab = deps.getActiveSlot() === SOURCE_SLOT[source];
    return !focused || !onTab;
  }

  function notify(source: NotifySource, details?: { body?: string }): void {
    if (!isNotifySource(source)) return;
    if (!shouldNotify(source)) return;

    if (deps.getMode() === "sound") {
      shell.beep();
      return;
    }

    if (!Notification.isSupported()) {
      shell.beep();
      return;
    }

    const trimmedBody = details?.body !== undefined ? details.body.trim() : "";
    const notification = new Notification({
      title: `${SOURCE_LABELS[source]} — tâche terminée`,
      body: trimmedBody !== "" ? trimmedBody : DEFAULT_BODY[source],
      silent: false,
    });

    notification.on("click", () => {
      const win = deps.getWindow();
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      deps.focusSource(SOURCE_SLOT[source]);
    });

    notification.show();
  }

  return { notify };
}
