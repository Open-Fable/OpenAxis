// OpenAxis i18n runtime — shared by every native renderer surface.
// Loaded as a plain <script src="i18n/runtime.js"> BEFORE each surface's own
// logic and before its dictionary script. Exposes window.I18N and window.t.
//
// Static markup: tag elements with data-i18n="key" (textContent),
// data-i18n-html="key" (innerHTML), or data-i18n-{placeholder,title,aria-label}.
// Dynamic strings: call window.t("key", { var: value }).
(function () {
  "use strict";

  var FALLBACK = "fr";
  var dict = { fr: {}, en: {} };

  function normalize(value) {
    return value === "en" || value === "fr" ? value : FALLBACK;
  }

  var lang = normalize(window.openaxis && window.openaxis.language);
  var listeners = [];

  function register(translations) {
    if (!translations) return;
    ["fr", "en"].forEach(function (l) {
      var src = translations[l];
      if (!src) return;
      var target = dict[l];
      for (var key in src) {
        if (Object.prototype.hasOwnProperty.call(src, key)) target[key] = src[key];
      }
    });
  }

  function interpolate(str, vars) {
    if (!vars) return str;
    return str.replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(vars, name)
        ? String(vars[name])
        : match;
    });
  }

  function t(key, vars) {
    var value = dict[lang] && dict[lang][key] != null ? dict[lang][key] : null;
    if (value == null) {
      value = dict[FALLBACK] && dict[FALLBACK][key] != null ? dict[FALLBACK][key] : null;
    }
    if (value == null) return key;
    return interpolate(value, vars);
  }

  var ATTR_MAP = {
    "data-i18n-placeholder": "placeholder",
    "data-i18n-title": "title",
    "data-i18n-aria-label": "aria-label",
  };

  function applyI18n(root) {
    var scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    scope.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    Object.keys(ATTR_MAP).forEach(function (dataAttr) {
      scope.querySelectorAll("[" + dataAttr + "]").forEach(function (el) {
        el.setAttribute(ATTR_MAP[dataAttr], t(el.getAttribute(dataAttr)));
      });
    });
  }

  function setLanguage(next) {
    lang = normalize(next);
    applyI18n(document);
    listeners.forEach(function (cb) {
      try {
        cb(lang);
      } catch {
        /* a faulty listener must not break the others */
      }
    });
  }

  function onChange(cb) {
    if (typeof cb === "function") listeners.push(cb);
  }

  window.I18N = {
    t: t,
    register: register,
    apply: applyI18n,
    setLanguage: setLanguage,
    onChange: onChange,
    get lang() {
      return lang;
    },
  };
  window.t = t;

  // Re-apply live when the main process broadcasts a language change.
  if (window.openaxis && window.openaxis.onLanguageChanged) {
    window.openaxis.onLanguageChanged(function (next) {
      setLanguage(next);
    });
  }

  // Translate static markup once the DOM is ready (idempotent).
  function boot() {
    applyI18n(document);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
