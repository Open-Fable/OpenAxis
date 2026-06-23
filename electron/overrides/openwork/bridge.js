/**
 * OpenWork desktop bridge polyfill
 * v2.1 — Robuste contre les erreurs null/undefined
 */
(function () {
  "use strict";
  if (window.__OPENWORK_ELECTRON__) return;

  // Opens a URL in a new tab only if it uses a safe scheme (http/https), always with
  // noopener,noreferrer. Blocks javascript:/data: URLs and reverse-tabnabbing.
  function openSafe(url) {
    try {
      var parsed = new URL(url || "about:blank", window.location.href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      window.open(parsed.href, "_blank", "noopener,noreferrer");
    } catch {
      /* invalid URL — do nothing */
    }
  }

  window.__OPENWORK_ELECTRON__ = {
    invokeDesktop: function (command) {
      var args = Array.prototype.slice.call(arguments, 1);

      const mockResponses = {
        getOpenworkUiMcpCommand: [],
        getOpenworkUiMcpEnvironment: {},
        getComputerUseMcpCommand: [],
        getDeviceFingerprint: "openaxis-stub",
        __setApplicationMenuVisible: true,
        __setNativeTheme: true,
        getUiControlBridgeInfo: { supported: false },
      };

      if (mockResponses[command] !== undefined) {
        return Promise.resolve(mockResponses[command]);
      }

      // Pour les autres commandes, on essaie le bridge Electron réel ou on renvoie une liste vide par sécurité
      return window.openaxis
        .openworkDesktopInvoke(command, ...args)
        .then((res) => (res === null ? [] : res))
        .catch(() => []);
    },
    shell: {
      openExternal: function (url) {
        openSafe(url);
        return Promise.resolve();
      },
      relaunch: function () {
        return Promise.resolve();
      },
    },
    system: {
      getArchitectureInfo: function () {
        return Promise.resolve({
          arch: "arm64",
          releaseUrl: "https://github.com/different-ai/openwork",
        });
      },
      askMicrophoneAccess: function () {
        return Promise.resolve(true);
      },
    },
    browser: {
      createTab: function (url) {
        openSafe(url);
      },
      openUrl: function (url) {
        openSafe(url);
      },
    },
    updater: {
      getChannel: function () {
        return Promise.resolve({ channel: "stable", currentVersion: "0.15.1" });
      },
      setChannel: function (ch) {
        return Promise.resolve({ channel: ch, currentVersion: "0.15.1" });
      },
      check: function () {
        return Promise.resolve({
          available: false,
          currentVersion: "0.15.1",
          reason: "unavailable",
        });
      },
      download: function () {
        return Promise.resolve({ ok: false, reason: "unavailable" });
      },
      installAndRestart: function () {
        return Promise.resolve({ ok: false, reason: "unavailable" });
      },
      onDownloadProgress: function () {
        return function () {};
      },
    },
    meta: {
      platform: "darwin",
      version: "openaxis",
      initialDeepLinks: [],
    },
  };
})();
