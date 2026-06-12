(function () {
  if (!window.openhub) return;
  if (window.__OPENHUB_REASONING_INJECTED_V2__) return;
  window.__OPENHUB_REASONING_INJECTED_V2__ = true;

  var EFFORT_KEY = "openhub-default-reasoning-effort";
  var MODEL_STORAGE_KEY = "opencode.global.dat:model";
  var PROXY_BASE = "http://localhost:9999";

  var FALLBACK_LEVELS = [
    { id: "none", name: "Aucun" },
    { id: "minimal", name: "Minimal" },
    { id: "low", name: "Bas" },
    { id: "medium", name: "Moyen" },
    { id: "high", name: "Élevé" },
    { id: "xhigh", name: "Très élevé" },
    { id: "max", name: "Maximum" },
  ];

  var ALL_LABELS = FALLBACK_LEVELS.reduce(function (acc, l) {
    acc[l.id] = l.name;
    return acc;
  }, {});

  var currentEffort = localStorage.getItem(EFFORT_KEY) || "medium";
  var activeLevels = FALLBACK_LEVELS;
  var supportsReasoning = true;
  var lastModelSource = "";

  var inlineBtnId = "oh-reasoning-inline-btn";
  var menuId = "oh-reasoning-inline-menu";

  // --- 1. Détection du modèle (LocalStorage + Fallback DOM) ---

  function readModelFromStorage() {
    try {
      var raw = localStorage.getItem(MODEL_STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (data && data.recent && data.recent.length > 0) return data.recent[0];
    } catch {
      // ignore parse errors
    }
    return null;
  }

  function detectModel() {
    var stored = readModelFromStorage();
    if (stored && stored.modelID) return stored;

    // Fallback DOM si localStorage vide
    var btn = document.querySelector('[data-action="prompt-model"]');
    if (!btn) return null;
    var span = btn.querySelector("span.truncate");
    if (!span) return null;
    return { modelID: span.textContent.trim(), providerID: "" };
  }

  function fetchLevelsFromProxy(modelID, providerID) {
    var url =
      PROXY_BASE + "/v1/reasoning/levels?model=" + encodeURIComponent(modelID || "");
    if (providerID) url += "&provider=" + encodeURIComponent(providerID);

    fetch(url)
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        supportsReasoning = data.supportsReasoning;
        activeLevels = data.levels || FALLBACK_LEVELS;

        if (!supportsReasoning) {
          if (currentEffort !== "none") syncEffort("none");
        } else {
          var valid = false;
          for (var i = 0; i < activeLevels.length; i++) {
            if (activeLevels[i].id === currentEffort) {
              valid = true;
              break;
            }
          }
          if (!valid) syncEffort(activeLevels.length > 1 ? activeLevels[1].id : "medium");
        }
        updateInlineButton();
      })
      .catch(function () {});
  }

  function refreshModelSupport() {
    var info = detectModel();
    if (!info) return;
    var sourceKey = (info.modelID || "") + "|" + (info.providerID || "");
    if (sourceKey === lastModelSource) return;
    lastModelSource = sourceKey;
    fetchLevelsFromProxy(info.modelID, info.providerID);
  }

  // --- 2. Gestion de l'effort ---

  function syncEffort(newEffort) {
    currentEffort = newEffort;
    try {
      localStorage.setItem(EFFORT_KEY, currentEffort);
    } catch {
      /* ignore */
    }
    updateInlineButton();
  }

  // --- 3. UI: Injection du bouton Inline ---

  function getChevronSvg() {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5;margin-left:4px;"><path d="m6 9 6 6 6-9"/></svg>';
  }

  function updateInlineButton() {
    var btn = document.getElementById(inlineBtnId);
    if (!btn) return;

    if (!supportsReasoning) {
      btn.style.display = "none";
      return;
    }

    btn.style.display = "flex";
    var label = ALL_LABELS[currentEffort] || "Moyen";
    btn.innerHTML = '<span class="truncate">' + label + "</span>" + getChevronSvg();
  }

  function injectInlineButton() {
    var modelBtn = document.querySelector('[data-action="prompt-model"]');
    if (!modelBtn) return;

    var container = modelBtn.parentElement;
    if (!container) return;

    // Si le bouton existe déjà mais a été déplacé ou détaché, on le nettoie
    var existing = document.getElementById(inlineBtnId);
    if (existing) {
      if (existing.parentElement === container) return; // Déjà au bon endroit
      existing.remove();
    }

    var btn = document.createElement("div");
    btn.id = inlineBtnId;
    // On copie les classes du bouton modèle pour le design
    btn.className = modelBtn.className + " oh-reasoning-btn";
    btn.style.cursor = "pointer";
    btn.style.userSelect = "none";
    btn.style.display = supportsReasoning ? "flex" : "none";
    btn.style.alignItems = "center";
    btn.style.marginLeft = "4px";

    btn.onclick = function (e) {
      e.stopPropagation();
      toggleMenu();
    };

    // Injection juste après le bouton modèle
    modelBtn.insertAdjacentElement("afterend", btn);
    updateInlineButton();
  }

  // --- 4. UI: Menu Portal (attaché au body) ---

  function toggleMenu() {
    var existing = document.getElementById(menuId);
    if (existing) {
      closeMenu();
      return;
    }
    buildMenu();
  }

  function buildMenu() {
    var trigger = document.getElementById(inlineBtnId);
    if (!trigger) return;

    var rect = trigger.getBoundingClientRect();
    var menu = document.createElement("div");
    menu.id = menuId;

    // Style du menu (Portal)
    menu.style.cssText =
      "position:fixed;z-index:100000;background:var(--background-strong, #1e1e1e);border:1px solid var(--border-weak-base, #2a2a2a);border-radius:10px;padding:4px;min-width:140px;box-shadow:0 8px 30px rgba(0,0,0,0.5);font-family:inherit;";

    // Positionnement dynamique
    var menuHeight = activeLevels.length * 32 + 20;
    var top = rect.bottom + 8;
    if (top + menuHeight > window.innerHeight) {
      top = rect.top - menuHeight - 8;
    }
    menu.style.top = top + "px";
    menu.style.left = Math.min(rect.left, window.innerWidth - 150) + "px";

    activeLevels.forEach(function (item) {
      var opt = document.createElement("div");
      var isActive = item.id === currentEffort;

      opt.style.cssText =
        "padding:6px 12px;cursor:pointer;border-radius:6px;font-size:13px;display:flex;align-items:center;justify-content:space-between;color:" +
        (isActive
          ? "var(--text-interactive-base, #14b8a6)"
          : "var(--text-base, #999999)") +
        ";background:" +
        (isActive
          ? "var(--surface-interactive-base, rgba(20,184,166,0.1))"
          : "transparent") +
        ";";

      opt.textContent = item.name;
      if (isActive) {
        opt.innerHTML +=
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
      }

      opt.onmouseenter = function () {
        if (!isActive) opt.style.background = "rgba(255,255,255,0.05)";
      };
      opt.onmouseleave = function () {
        if (!isActive) opt.style.background = "transparent";
      };

      opt.onclick = function (e) {
        e.stopPropagation();
        syncEffort(item.id);
        closeMenu();
      };

      menu.appendChild(opt);
    });

    document.body.appendChild(menu);

    // Fermeture au clic extérieur
    setTimeout(function () {
      window.addEventListener("click", globalClickClose);
    }, 0);
  }

  function globalClickClose(e) {
    if (!e.target.closest("#" + menuId)) {
      closeMenu();
    }
  }

  function closeMenu() {
    var menu = document.getElementById(menuId);
    if (menu) menu.remove();
    window.removeEventListener("click", globalClickClose);
  }

  // --- 5. Initialisation et Surveillance ---

  refreshModelSupport();

  // Surveillance du DOM pour ré-injection si SolidJS re-render la barre
  var observer = new MutationObserver(function () {
    injectInlineButton();
    refreshModelSupport();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Sync avec les autres fenêtres via storage
  window.addEventListener("storage", function (e) {
    if (e.key === EFFORT_KEY) {
      currentEffort = e.newValue || "medium";
      updateInlineButton();
    }
  });

  // Polling fallback — localStorage sync only (observer handles DOM re-injection)
  setInterval(function () {
    var stored = localStorage.getItem(EFFORT_KEY);
    if (stored && stored !== currentEffort) {
      currentEffort = stored;
      updateInlineButton();
    }
  }, 3000);
})();
