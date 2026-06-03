/**
 * OpenHub — Universal dark mode enforcer
 * Injected into ALL app webviews via executeJavaScript().
 *
 * Guards against infinite loops: the re-entrancy flag `applying` prevents
 * the MutationObserver from calling forceDark() while it is already running.
 */
(function () {
  "use strict";

  var applying = false;

  function forceDark() {
    if (applying) return;
    applying = true;

    try {
      var html = document.documentElement;
      var body = document.body;

      // Only mutate if needed — avoids unnecessary observer triggers
      if (!html.classList.contains("dark")) html.classList.add("dark");
      if (html.getAttribute("data-theme") !== "dark") html.setAttribute("data-theme", "dark");

      // OpenWork Electron variant classes
      if (!html.classList.contains("openwork-electron")) html.classList.add("openwork-electron");
      if (!html.classList.contains("openwork-platform-mac")) html.classList.add("openwork-platform-mac");

      // Body fallback
      if (body && !body.classList.contains("dark")) body.classList.add("dark");

      // Open Design: localStorage config
      try {
        var raw = localStorage.getItem("open-design:config");
        var config = raw ? JSON.parse(raw) : {};
        if (config.theme !== "dark") {
          config.theme = "dark";
          localStorage.setItem("open-design:config", JSON.stringify(config));
        }
      } catch (e) { /* ignore */ }

    } finally {
      applying = false;
    }
  }

  // Apply immediately
  forceDark();

  // Re-apply after DOM ready (catches SPA initial render)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", forceDark);
  }

  // Watch for apps trying to switch back to light mode
  var observer = new MutationObserver(function () {
    if (!applying) forceDark();
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });

  // Also watch body once it exists
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
})();
