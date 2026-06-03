/**
 * OpenWork desktop bridge polyfill
 *
 * Sets window.__OPENWORK_ELECTRON__ so isDesktopRuntime() returns true,
 * unlocking folder-selection UI and desktop boot paths.
 *
 * Workspace API interception (/workspaces/*) is handled at the Electron
 * network level via session.protocol.handle in main.ts — not here.
 */
(function () {
  "use strict";
  if (window.__OPENWORK_ELECTRON__) return;

  window.__OPENWORK_ELECTRON__ = {
    invokeDesktop: function (command) {
      var args = Array.prototype.slice.call(arguments, 1);
      return window.openhub.openworkDesktopInvoke.apply(null, [command].concat(args));
    },
    shell: {
      openExternal: function (url) {
        window.open(url, "_blank", "noopener,noreferrer");
        return Promise.resolve();
      },
    },
    meta: {
      platform: "darwin",
      version: "openhub",
    },
  };
})();
