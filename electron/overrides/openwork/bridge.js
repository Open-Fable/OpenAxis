/**
 * OpenWork desktop bridge polyfill
 * v2.1 — Robuste contre les erreurs null/undefined
 */
(function () {
  "use strict";
  if (window.__OPENWORK_ELECTRON__) return;

  window.__OPENWORK_ELECTRON__ = {
    invokeDesktop: function (command) {
      var args = Array.prototype.slice.call(arguments, 1);

      const mockResponses = {
        getOpenworkUiMcpCommand: [],
        getOpenworkUiMcpEnvironment: {},
        getComputerUseMcpCommand: [],
        getDeviceFingerprint: "openhub-stub",
        __setApplicationMenuVisible: true,
        __setNativeTheme: true,
        getUiControlBridgeInfo: { supported: false },
      };

      if (mockResponses[command] !== undefined) {
        return Promise.resolve(mockResponses[command]);
      }

      // Pour les autres commandes, on essaie le bridge Electron réel ou on renvoie une liste vide par sécurité
      return window.openhub
        .openworkDesktopInvoke(command, ...args)
        .then((res) => (res === null ? [] : res))
        .catch(() => []);
    },
    shell: {
      openExternal: function (url) {
        window.open(url, "_blank", "noopener,noreferrer");
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
        window.open(url || "about:blank", "_blank");
      },
      openUrl: function (url) {
        window.open(url, "_blank");
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
      version: "openhub",
      initialDeepLinks: [],
    },
  };
})();
