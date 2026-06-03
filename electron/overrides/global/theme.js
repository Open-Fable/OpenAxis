/**
 * OpenHub — Universal dark mode enforcer
 * Injected into ALL app webviews via executeJavaScript().
 *
 * Each app uses a different dark mode mechanism:
 * - OpenWork: class="dark" or data-theme="dark" on html/body
 * - OpenCode: already dark by default (color-scheme: dark)
 * - Open Design: data-theme="dark" on <html>, stored in localStorage
 *
 * This script forces dark mode on all apps and observes DOM mutations
 * to re-apply if the app tries to switch to light mode.
 */
(function () {
  'use strict';

  function forceDark() {
    var html = document.documentElement;
    var body = document.body;

    // OpenWork: class="dark" + data-theme="dark"
    if (!html.classList.contains('dark')) html.classList.add('dark');
    html.setAttribute('data-theme', 'dark');

    // OpenWork Electron variant
    if (!html.classList.contains('openwork-electron')) {
      html.classList.add('openwork-electron');
    }
    if (!html.classList.contains('openwork-platform-mac')) {
      html.classList.add('openwork-platform-mac');
    }

    // Body fallback
    if (body && !body.classList.contains('dark')) body.classList.add('dark');

    // Open Design: localStorage config
    try {
      var configKey = 'open-design:config';
      var raw = localStorage.getItem(configKey);
      var config = raw ? JSON.parse(raw) : {};
      if (config.theme !== 'dark') {
        config.theme = 'dark';
        localStorage.setItem(configKey, JSON.stringify(config));
      }
    } catch (e) { /* ignore */ }

    // color-scheme meta tag
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) {
      meta.setAttribute('content', 'dark');
    } else {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'color-scheme');
      meta.setAttribute('content', 'dark');
      document.head.appendChild(meta);
    }

    // theme-color meta tag
    var themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute('content', '#1a1a1a');
    }
  }

  // Apply immediately
  forceDark();

  // Re-apply after DOM is ready (SPA route changes)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', forceDark);
  }

  // Observe attribute changes on <html> to prevent light mode resets
  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'attributes') {
        var target = m.target;
        if (target === document.documentElement || target === document.body) {
          var attr = m.attributeName;
          if (attr === 'class' || attr === 'data-theme' || attr === 'style') {
            forceDark();
            break;
          }
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'style'],
  });

  if (document.body) {
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      if (document.body) {
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'data-theme', 'style'],
        });
      }
    });
  }
})();
