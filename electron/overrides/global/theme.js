/**
 * OpenHub — Brand theme sync
 * v2.0 — Grand public, respecte prefers-color-scheme macOS
 *
 * Garde les apps synchronisées avec le thème système.
 * Les apps SPA peuvent essayer de forcer leur propre thème ;
 * ce script les ramène à la préférence système.
 *
 * Re-entrancy flag `applying` empêche les boucles infinies MutationObserver.
 */
(function () {
  "use strict";

  if (window.__OPENHUB_THEME_INJECTED__) return;
  window.__OPENHUB_THEME_INJECTED__ = true;

  var applying = false;

  function getSystemTheme() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function syncTheme() {
    if (applying) return;
    applying = true;

    try {
      var theme = getSystemTheme();
      var html = document.documentElement;
      var body = document.body;

      if (theme === "dark") {
        if (!html.classList.contains("dark")) html.classList.add("dark");
        if (html.getAttribute("data-theme") !== "dark")
          html.setAttribute("data-theme", "dark");

        if (body && !body.classList.contains("dark")) body.classList.add("dark");

        try {
          if (localStorage.getItem("openwork.react.settings.theme-mode") !== "dark") {
            localStorage.setItem("openwork.react.settings.theme-mode", "dark");
          }
        } catch {}

        try {
          var raw = localStorage.getItem("open-design:config");
          var config = raw ? JSON.parse(raw) : {};
          if (config.theme !== "dark") {
            config.theme = "dark";
            localStorage.setItem("open-design:config", JSON.stringify(config));
          }
        } catch {}
      } else {
        if (html.classList.contains("dark")) html.classList.remove("dark");
        if (html.getAttribute("data-theme") === "dark")
          html.removeAttribute("data-theme");

        if (body && body.classList.contains("dark")) body.classList.remove("dark");

        try {
          if (localStorage.getItem("openwork.react.settings.theme-mode") !== "light") {
            localStorage.setItem("openwork.react.settings.theme-mode", "light");
          }
        } catch {}

        try {
          var rawLight = localStorage.getItem("open-design:config");
          var configLight = rawLight ? JSON.parse(rawLight) : {};
          if (configLight.theme !== "light") {
            configLight.theme = "light";
            localStorage.setItem("open-design:config", JSON.stringify(configLight));
          }
        } catch {}
      }

      // Platform classes (always needed for Electron)
      if (!html.classList.contains("openwork-electron"))
        html.classList.add("openwork-electron");
      if (!html.classList.contains("openwork-platform-mac"))
        html.classList.add("openwork-platform-mac");
    } finally {
      applying = false;
    }
  }

  syncTheme();

  // Re-sync after DOM ready (catches SPA initial render)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncTheme);
  }

  // Watch for OS theme changes
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTheme);

  // Watch for apps trying to override the theme
  var observer = new MutationObserver(function () {
    if (!applying) syncTheme();
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });

  function watchBody() {
    if (document.body) {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["class", "data-theme"],
      });
    }
  }

  if (document.body) {
    watchBody();
  } else {
    document.addEventListener("DOMContentLoaded", watchBody);
  }

  // ── Global Drag & Drop Handler ──
  var dragOverlay = null;
  var dragCounter = 0;

  function showDragOverlay() {
    if (dragOverlay) return;
    dragOverlay = document.createElement("div");
    dragOverlay.style.position = "fixed";
    dragOverlay.style.inset = "0";
    dragOverlay.style.zIndex = "999999";
    dragOverlay.style.background = "rgba(13, 148, 136, 0.06)";
    dragOverlay.style.border = "2px dashed #0D9488";
    dragOverlay.style.borderRadius = "12px";
    dragOverlay.style.display = "flex";
    dragOverlay.style.alignItems = "center";
    dragOverlay.style.justifyContent = "center";
    dragOverlay.style.pointerEvents = "none";

    var label = document.createElement("div");
    label.style.background = "rgba(0, 0, 0, 0.85)";
    label.style.border = "1px solid #2a2a2a";
    label.style.color = "#ececec";
    label.style.boxShadow = "0 8px 32px rgba(0, 0, 0, 0.3)";
    label.textContent = "Déposer les fichiers à importer";

    dragOverlay.appendChild(label);
    document.body.appendChild(dragOverlay);
  }

  function hideDragOverlay() {
    if (dragOverlay) {
      dragOverlay.remove();
      dragOverlay = null;
    }
  }

  window.addEventListener(
    "dragenter",
    function (e) {
      if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        dragCounter++;
        if (dragCounter === 1) showDragOverlay();
      }
    },
    false,
  );

  window.addEventListener(
    "dragleave",
    function (e) {
      if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
          dragCounter = 0;
          hideDragOverlay();
        }
      }
    },
    false,
  );

  window.addEventListener(
    "dragover",
    function (e) {
      if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
      }
    },
    false,
  );

  window.addEventListener(
    "drop",
    function (e) {
      dragCounter = 0;
      hideDragOverlay();
      if (e.defaultPrevented) return;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        e.preventDefault();
        var fileInput = document.querySelector('input[type="file"]');
        if (fileInput) {
          try {
            var dt = new DataTransfer();
            for (var i = 0; i < e.dataTransfer.files.length; i++) {
              dt.items.add(e.dataTransfer.files[i]);
            }
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event("change", { bubbles: true }));
          } catch (err) {
            console.error("[openhub] Global drop handler failed to set files:", err);
          }
        }
      }
    },
    false,
  );
})();
