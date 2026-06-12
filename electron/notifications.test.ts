import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => {
  class MockNotification {
    static isSupported = vi.fn(() => true);
    title: string;
    body: string;
    silent: boolean;
    constructor(opts: { title: string; body: string; silent: boolean }) {
      this.title = opts.title;
      this.body = opts.body;
      this.silent = opts.silent;
      MockNotification._last = this;
    }
    on = vi.fn();
    show = vi.fn();
    static _last: MockNotification | null = null;
  }
  return {
    BrowserWindow: vi.fn(),
    Notification: MockNotification,
    shell: { beep: vi.fn() },
  };
});

import {
  isNotifySource,
  isNotifyMode,
  defaultNotifySources,
  createNotifier,
  NOTIFY_SOURCES,
  NOTIFY_MODES,
  DEFAULT_NOTIFY_MODE,
  type NotifyMode,
  type NotifySources,
  type NotifierDeps,
} from "./notifications.js";
import type { SlotName } from "./types.js";
import { Notification, shell } from "electron";

function makeDeps(overrides: Partial<NotifierDeps> = {}): NotifierDeps {
  return {
    getWindow: () =>
      ({
        isDestroyed: () => false,
        isFocused: () => false,
        isMinimized: () => false,
        show: vi.fn(),
        focus: vi.fn(),
        restore: vi.fn(),
      }) as never,
    getActiveSlot: () => "work" as SlotName,
    getMode: () => "always" as NotifyMode,
    getSources: () => defaultNotifySources(),
    focusSource: vi.fn(),
    ...overrides,
  };
}

describe("notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isNotifySource", () => {
    it("accepts valid sources", () => {
      for (const s of NOTIFY_SOURCES) {
        expect(isNotifySource(s)).toBe(true);
      }
    });

    it("rejects invalid values", () => {
      expect(isNotifySource("invalid")).toBe(false);
      expect(isNotifySource(42)).toBe(false);
      expect(isNotifySource(null)).toBe(false);
      expect(isNotifySource(undefined)).toBe(false);
    });
  });

  describe("isNotifyMode", () => {
    it("accepts valid modes", () => {
      for (const m of NOTIFY_MODES) {
        expect(isNotifyMode(m)).toBe(true);
      }
    });

    it("rejects invalid values", () => {
      expect(isNotifyMode("loud")).toBe(false);
      expect(isNotifyMode(0)).toBe(false);
    });
  });

  describe("defaultNotifySources", () => {
    it("returns all sources enabled", () => {
      const sources = defaultNotifySources();
      expect(sources).toEqual({
        chat: true,
        code: true,
        work: true,
        design: true,
        orchestrator: true,
      });
    });

    it("returns a new object each call", () => {
      expect(defaultNotifySources()).not.toBe(defaultNotifySources());
    });
  });

  describe("DEFAULT_NOTIFY_MODE", () => {
    it("is other-tab", () => {
      expect(DEFAULT_NOTIFY_MODE).toBe("other-tab");
    });
  });

  describe("createNotifier", () => {
    function getLastNotif() {
      return (
        Notification as unknown as {
          _last: { body: string; show: ReturnType<typeof vi.fn> } | null;
        }
      )._last;
    }
    function clearLastNotif() {
      (Notification as unknown as { _last: null })._last = null;
    }

    it("sends notification in always mode", () => {
      clearLastNotif();
      const notifier = createNotifier(makeDeps({ getMode: () => "always" }));
      notifier.notify("chat");
      expect(getLastNotif()).not.toBeNull();
      expect(getLastNotif()!.show).toHaveBeenCalled();
    });

    it("does not send in never mode", () => {
      clearLastNotif();
      const notifier = createNotifier(makeDeps({ getMode: () => "never" }));
      notifier.notify("chat");
      expect(getLastNotif()).toBeNull();
    });

    it("respects disabled source", () => {
      clearLastNotif();
      const sources: NotifySources = { ...defaultNotifySources(), code: false };
      const notifier = createNotifier(
        makeDeps({ getMode: () => "always", getSources: () => sources }),
      );
      notifier.notify("code");
      expect(getLastNotif()).toBeNull();
    });

    it("beeps in sound mode", () => {
      clearLastNotif();
      const notifier = createNotifier(makeDeps({ getMode: () => "sound" }));
      notifier.notify("work");
      expect(shell.beep).toHaveBeenCalled();
      expect(getLastNotif()).toBeNull();
    });

    it("notifies when window not focused in background mode", () => {
      clearLastNotif();
      const notifier = createNotifier(
        makeDeps({
          getMode: () => "background",
          getWindow: () =>
            ({ isDestroyed: () => false, isFocused: () => false }) as never,
        }),
      );
      notifier.notify("chat");
      expect(getLastNotif()).not.toBeNull();
    });

    it("does not notify when window focused in background mode", () => {
      clearLastNotif();
      const notifier = createNotifier(
        makeDeps({
          getMode: () => "background",
          getWindow: () => ({ isDestroyed: () => false, isFocused: () => true }) as never,
        }),
      );
      notifier.notify("chat");
      expect(getLastNotif()).toBeNull();
    });

    it("notifies when on different tab in other-tab mode", () => {
      clearLastNotif();
      const notifier = createNotifier(
        makeDeps({
          getMode: () => "other-tab",
          getActiveSlot: () => "work" as SlotName,
          getWindow: () => ({ isDestroyed: () => false, isFocused: () => true }) as never,
        }),
      );
      notifier.notify("code");
      expect(getLastNotif()).not.toBeNull();
    });

    it("does not notify when on same tab and focused in other-tab mode", () => {
      clearLastNotif();
      const notifier = createNotifier(
        makeDeps({
          getMode: () => "other-tab",
          getActiveSlot: () => "code" as SlotName,
          getWindow: () => ({ isDestroyed: () => false, isFocused: () => true }) as never,
        }),
      );
      notifier.notify("code");
      expect(getLastNotif()).toBeNull();
    });

    it("notifies when window unfocused in other-tab mode even on same tab", () => {
      clearLastNotif();
      const notifier = createNotifier(
        makeDeps({
          getMode: () => "other-tab",
          getActiveSlot: () => "code" as SlotName,
          getWindow: () =>
            ({ isDestroyed: () => false, isFocused: () => false }) as never,
        }),
      );
      notifier.notify("code");
      expect(getLastNotif()).not.toBeNull();
    });

    it("uses default body when none provided", () => {
      const notifier = createNotifier(makeDeps({ getMode: () => "always" }));
      notifier.notify("work");
      const last = (Notification as unknown as { _last: { body: string } })._last;
      expect(last.body).toBe("La tâche Work est terminée.");
    });

    it("uses custom body when provided", () => {
      const notifier = createNotifier(makeDeps({ getMode: () => "always" }));
      notifier.notify("chat", { body: "Custom message" });
      const last = (Notification as unknown as { _last: { body: string } })._last;
      expect(last.body).toBe("Custom message");
    });

    it("falls back to default body when custom body is whitespace", () => {
      const notifier = createNotifier(makeDeps({ getMode: () => "always" }));
      notifier.notify("chat", { body: "   " });
      const last = (Notification as unknown as { _last: { body: string } })._last;
      expect(last.body).toBe("La réponse du chat est prête.");
    });

    it("ignores invalid source", () => {
      clearLastNotif();
      const notifier = createNotifier(makeDeps({ getMode: () => "always" }));
      notifier.notify("invalid" as never);
      expect(getLastNotif()).toBeNull();
    });

    it("falls back to beep when Notification not supported", () => {
      clearLastNotif();
      (Notification.isSupported as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const notifier = createNotifier(makeDeps({ getMode: () => "always" }));
      notifier.notify("chat");
      expect(shell.beep).toHaveBeenCalled();
    });

    it("handles null window in background mode", () => {
      clearLastNotif();
      (Notification.isSupported as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const notifier = createNotifier(
        makeDeps({
          getMode: () => "background",
          getWindow: () => null,
        }),
      );
      notifier.notify("chat");
      expect(getLastNotif()).not.toBeNull();
    });
  });
});
