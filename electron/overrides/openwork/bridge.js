/**
 * OpenWork desktop bridge polyfill
 *
 * OpenWork expects window.__OPENWORK_ELECTRON__.invokeDesktop(command, ...args)
 * when running inside its own Electron shell. We polyfill that surface and route
 * calls through our IPC handler (openwork-desktop-invoke in main.ts).
 *
 * This also makes isDesktopRuntime() return true, which unlocks the
 * folder-selection UI that is hidden in plain browser mode.
 */
(function () {
  if (window.__OPENWORK_ELECTRON__) return; // already set

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
