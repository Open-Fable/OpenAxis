/*
 * OpenAxis → OpenCode — native directory picker bridge
 *
 * Intercepts OpenCode's web-based DialogSelectDirectory and opens the
 * native macOS Finder instead. Uses OpenCode's deep link mechanism
 * for smooth in-app navigation, with localStorage + full reload as
 * fallback if the deep link doesn't trigger within 600ms.
 */
(function () {
  if (!window.openaxis) return;
  if (window.__OPENAXIS_OPENCODE_BRIDGE_INJECTED__) return;
  window.__OPENAXIS_OPENCODE_BRIDGE_INJECTED__ = true;

  var picking = false;
  var DEEP_LINK_EVENT = "opencode:deep-link";

  function base64Encode(value) {
    var bytes = new TextEncoder().encode(value);
    var binary = Array.from(bytes, function (b) {
      return String.fromCharCode(b);
    }).join("");
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  function addProjectToLocalStorage(directory) {
    var STORAGE_KEY = "opencode.global.dat:server";
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      var projects = data.projects;
      if (!projects || typeof projects !== "object") return;

      var serverKey = Object.keys(projects)[0];
      if (!serverKey) {
        serverKey = location.origin;
        projects[serverKey] = [];
      }
      var list = projects[serverKey];
      if (!Array.isArray(list)) {
        list = [];
        projects[serverKey] = list;
      }
      for (var i = 0; i < list.length; i++) {
        if (list[i].worktree === directory) return;
      }
      list.unshift({ worktree: directory, expanded: true });
      data.lastProject = data.lastProject || {};
      data.lastProject[serverKey] = directory;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // ignore
    }
  }

  function pickAndOpen() {
    if (picking) return;
    picking = true;
    window.openaxis
      .openworkDesktopInvoke("pickDirectory")
      .then(function (dir) {
        picking = false;
        if (!dir) return;
        console.warn("[bridge] picked directory:", dir);

        // 1. Write to localStorage as safety net (persists across reload)
        addProjectToLocalStorage(dir);

        // 2. Try deep link — OpenCode's layout handles it via SolidJS router
        //    (no page reload, project added to sidebar reactively)
        var deepLinkUrl = "opencode://open-project?directory=" + encodeURIComponent(dir);

        window.dispatchEvent(
          new CustomEvent(DEEP_LINK_EVENT, {
            detail: { urls: [deepLinkUrl] },
          }),
        );

        // 3. Fallback: if the URL hasn't changed after 600ms,
        //    the deep link didn't navigate — do a full reload
        var before = location.pathname;
        setTimeout(function () {
          if (location.pathname === before) {
            var encoded = base64Encode(dir);
            location.href = "/" + encoded + "/session";
          }
        }, 600);
      })
      .catch(function () {
        picking = false;
      });
  }

  // ── 1. Sidebar "+" button ──
  document.addEventListener(
    "click",
    function (event) {
      var btn = event.target.closest(
        '[data-component="sidebar-rail"] [data-component="icon-button"][data-icon="plus"]',
      );
      if (!btn) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      pickAndOpen();
    },
    { capture: true },
  );

  // ── 2. Detect DialogSelectDirectory (home page, prompt input, etc.) ──
  var observer = new MutationObserver(function (mutations) {
    if (picking) return;
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (!(node instanceof HTMLElement)) continue;
        if (
          !node.querySelector("[data-component='dialog']") &&
          node.getAttribute?.("data-component") !== "dialog"
        )
          continue;
        scheduleDialogCheck(node);
      }
    }
  });

  function scheduleDialogCheck(root) {
    var dialog =
      root.querySelector("[data-component='dialog']") ||
      (root.getAttribute && root.getAttribute("data-component") === "dialog"
        ? root
        : null);
    if (!dialog) return;
    requestAnimationFrame(function () {
      if (picking) return;
      if (isDirectoryPickerDialog(dialog)) {
        closeDialog(dialog);
        pickAndOpen();
      }
    });
  }

  function isDirectoryPickerDialog(dialog) {
    if (!dialog.isConnected) return false;

    // Must have a file tree / folder structure (not just a generic list)
    var tree = dialog.querySelector(
      '[role="tree"], [data-directory-tree], .file-tree, [class*="directory"]',
    );
    if (!tree) return false;

    var input = dialog.querySelector("input");
    if (!input) return false;

    // Exclude provider/service selection dialogs
    if (dialog.querySelector('[role="tablist"]')) return false;
    if (
      dialog.textContent &&
      /\b(provider|model|fournisseur|modèle)\b/i.test(dialog.textContent)
    )
      return false;

    return true;
  }

  function closeDialog(dialog) {
    var closeBtn = dialog.querySelector("[data-slot='dialog-close-button']");
    if (closeBtn) {
      closeBtn.click();
      return;
    }
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }
})();
