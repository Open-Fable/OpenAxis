// ── Proxy auth — per-session token from main (no static token) ──
var __proxyTokenPromise = null;
function getProxyToken() {
  if (!__proxyTokenPromise) {
    __proxyTokenPromise = (
      window.openhub && window.openhub.getChatConfig
        ? window.openhub.getChatConfig()
        : Promise.resolve(null)
    )
      .then(function (c) {
        return (c && c.token) || "";
      })
      .catch(function () {
        return "";
      });
  }
  return __proxyTokenPromise;
}

var buttons = document.querySelectorAll(".slot-btn[data-slot]");
var indicator = document.getElementById("tab-indicator");
var configPanel = document.getElementById("config-panel");
var backdrop = document.getElementById("config-backdrop");

// ── Dropdown navigation mode ──
var headerEl = document.querySelector(".header");
var dropdownTrigger = document.getElementById("dropdown-trigger");
var triggerIcon = document.getElementById("trigger-icon");
var triggerLabel = document.getElementById("trigger-label");
var currentNavMode = "topbar";

var slotIcons = {
  chat: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>',
  work: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>',
  code: '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>',
  design:
    '<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></svg>',
  projects:
    '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>',
};

var slotLabels = {
  chat: "Chat",
  work: "Work",
  code: "Code",
  design: "Design",
  projects: "Orchestrateur",
};

function applyNavMode(mode) {
  currentNavMode = mode;
  if (mode === "dropdown") {
    headerEl.classList.add("dropdown-mode");
    updateDropdownTrigger(activeSlotName || "chat");
  } else {
    headerEl.classList.remove("dropdown-mode");
    var activeBtn = document.querySelector(".slot-btn.active");
    if (activeBtn) {
      setTimeout(function () {
        updateIndicator(activeBtn);
      }, 50);
    }
  }
}

var activeSlotName = "chat";

function updateDropdownTrigger(slot) {
  activeSlotName = slot;
  triggerLabel.textContent = slotLabels[slot] || slot;
  triggerIcon.innerHTML = slotIcons[slot] || "";
}

dropdownTrigger.addEventListener("click", function () {
  var rect = dropdownTrigger.getBoundingClientRect();
  window.openhub.showNavMenu(Math.round(rect.left), Math.round(rect.bottom + 4));
});

document.getElementById("dropdown-config-btn").addEventListener("click", function () {
  openConfig();
});

// Load saved nav mode on startup
if (window.openhub.getNavMode) {
  window.openhub
    .getNavMode()
    .then(function (mode) {
      applyNavMode(mode || "topbar");
      var sel = document.getElementById("nav-mode-select");
      if (sel) sel.value = mode || "topbar";
    })
    .catch(function () {});
}

// Listen for nav mode changes from main process
if (window.openhub.onNavModeChanged) {
  window.openhub.onNavModeChanged(function (mode) {
    applyNavMode(mode);
    var sel = document.getElementById("nav-mode-select");
    if (sel) sel.value = mode;
  });
}

// Nav mode select in config panel
var navModeSelect = document.getElementById("nav-mode-select");
if (navModeSelect) {
  navModeSelect.addEventListener("change", function () {
    var mode = navModeSelect.value;
    applyNavMode(mode);
    if (window.openhub.setNavMode) {
      window.openhub.setNavMode(mode);
    }
  });
}

function updateIndicator(activeBtn) {
  if (!activeBtn || !indicator) return;
  var slot = activeBtn.dataset.slot;
  indicator.style.width = activeBtn.offsetWidth + "px";
  indicator.style.left = activeBtn.offsetLeft + "px";
  indicator.style.background = "var(--oh-color-bg-active)";
  indicator.style.opacity = "1";
  activeBtn.style.setProperty("--active-color", "var(--oh-color-accent-primary)");
}

// SVG templates for reveal toggle
var eyeOpenSVG =
  '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
var eyeClosedSVG =
  '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>';
function setLoading(slot, isLoading) {
  var btn = document.querySelector('.slot-btn[data-slot="' + slot + '"]');
  if (btn) btn.classList.toggle("loading", isLoading);
}

// Sidebar slot buttons
buttons.forEach(function (btn) {
  btn.addEventListener("click", function () {
    var slot = btn.dataset.slot;
    if (!slot || slot === "config") return;
    setLoading(slot, true);
    window.openhub.switchSlot(slot).catch(function (err) {
      console.error("[sidebar] switchSlot failed:", err);
      setLoading(slot, false);
    });
  });

  btn.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    var slot = btn.dataset.slot;
    if (!slot || slot === "config") return;
    window.openhub.showSlotContextMenu(slot);
  });
});

window.addEventListener("resize", function () {
  var active = document.querySelector(".slot-btn.active");
  if (active) updateIndicator(active);
});

// Keyboard shortcuts ⌘1-5
var shortcutSlots = ["chat", "code", "work", "design", "projects"];
window.addEventListener("keydown", function (e) {
  if (!e.metaKey && !e.ctrlKey) return;
  var idx = parseInt(e.key, 10);
  if (idx >= 1 && idx <= 5) {
    e.preventDefault();
    var slot = shortcutSlots[idx - 1];
    setLoading(slot, true);
    window.openhub.switchSlot(slot).catch(function (err) {
      console.error("[sidebar] shortcut switchSlot failed:", err);
      setLoading(slot, false);
    });
  }
});

// Auto-open chat on startup
document.addEventListener("DOMContentLoaded", function () {
  setLoading("chat", true);
  window.openhub.switchSlot("chat").catch(function (err) {
    console.error("[sidebar] startup switch to chat failed:", err);
    setLoading("chat", false);
  });
  // Initialize indicator position
  setTimeout(function () {
    var chatBtn = document.querySelector('.slot-btn[data-slot="chat"]');
    if (chatBtn) updateIndicator(chatBtn);
  }, 100);
  // Check Ollama models on startup
  setTimeout(loadOllamaStatus, 1500);
});

// Sync active state
window.openhub.onSlotChanged(function (slot) {
  buttons.forEach(function (b) {
    var isActive = b.dataset.slot === slot;
    b.classList.toggle("active", isActive);
    if (isActive) updateIndicator(b);
    b.classList.remove("loading");
  });
  updateDropdownTrigger(slot);
});

// ── Tab switching ──
var SECTION_META = {
  keys: { title: "Clés API", desc: "Stockées en sécurité dans le Keychain macOS." },
  models: { title: "Modèles IA", desc: "Configuration des modèles et fonctionnalités." },
  memory: { title: "Mémoire", desc: "Profil utilisateur et base de connaissances." },
  updates: { title: "Mises à jour", desc: "Gérer les apps et l'apparence." },
  notifs: { title: "Notifications", desc: "Alertes de fin de tâche par source." },
  cache: { title: "Cache", desc: "Statistiques d'efficacité du prompt caching." },
};

function switchConfigTab(tab) {
  var target = tab.dataset.tab;
  var allTabs = document.querySelectorAll(".config-tab");
  allTabs.forEach(function (t) {
    t.classList.remove("active");
    t.setAttribute("aria-selected", "false");
    t.setAttribute("tabindex", "-1");
  });
  document.querySelectorAll(".config-pane").forEach(function (p) {
    p.classList.remove("active");
  });
  tab.classList.add("active");
  tab.setAttribute("aria-selected", "true");
  tab.setAttribute("tabindex", "0");
  var pane = document.getElementById("pane-" + target);
  if (pane) pane.classList.add("active");

  var meta = SECTION_META[target];
  if (meta) {
    var titleEl = document.getElementById("config-section-title");
    var descEl = document.getElementById("config-section-desc");
    if (titleEl) titleEl.textContent = meta.title;
    if (descEl) descEl.textContent = meta.desc;
  }

  var scroll = document.getElementById("config-scroll");
  if (scroll) scroll.scrollTop = 0;

  if (target === "cache") loadCacheMetrics();
  if (target === "models") loadModelsUI();
  if (target === "memory") loadMemoryUI();
  if (target === "notifs") loadNotifyUI();
}

document.querySelectorAll(".config-tab").forEach(function (tab) {
  tab.addEventListener("click", function () {
    switchConfigTab(tab);
  });
});

// Arrow key navigation in vertical tablist
var configNav = document.querySelector('.config-nav[role="tablist"]');
if (configNav) {
  configNav.addEventListener("keydown", function (e) {
    var tabs = Array.from(configNav.querySelectorAll(".config-tab"));
    var idx = tabs.indexOf(document.activeElement);
    if (idx === -1) return;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      var next = tabs[(idx + 1) % tabs.length];
      next.focus();
      switchConfigTab(next);
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      var prev = tabs[(idx - 1 + tabs.length) % tabs.length];
      prev.focus();
      switchConfigTab(prev);
    } else if (e.key === "Home") {
      e.preventDefault();
      tabs[0].focus();
      switchConfigTab(tabs[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      tabs[tabs.length - 1].focus();
      switchConfigTab(tabs[tabs.length - 1]);
    }
  });
}

function loadNotifyUI() {
  if (window.openhub.getNotifyMode) {
    window.openhub.getNotifyMode().then(function (m) {
      var sel = document.getElementById("notify-mode");
      if (sel) sel.value = m || "other-tab";
    });
  }
  if (window.openhub.getNotifySources) {
    window.openhub.getNotifySources().then(function (sources) {
      if (!sources) return;
      document.querySelectorAll("[data-notify-source]").forEach(function (input) {
        var key = input.dataset.notifySource;
        if (typeof sources[key] === "boolean") input.checked = sources[key];
      });
    });
  }
}

// ── Toast system ──
var toastTimer = null;
function showSaveToast(msg) {
  var toast = document.getElementById("config-toast");
  var textEl = document.getElementById("config-toast-text");
  if (!toast) return;
  if (textEl) textEl.textContent = msg || "Enregistré";
  toast.hidden = false;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    toast.classList.remove("visible");
    setTimeout(function () {
      toast.hidden = true;
    }, 250);
  }, 1800);
}

// ── Google Gemini OAuth login ──
function setGeminiStatus(connected, email) {
  var statusEl = document.getElementById("google-login-status");
  var btn = document.getElementById("btn-google-login");
  if (statusEl) {
    statusEl.textContent = connected
      ? "Connecté" + (email ? " : " + email : "")
      : "Non connecté";
  }
  if (btn) btn.textContent = connected ? "Reconnecter" : "Se connecter avec Google";
}

function loadGeminiAuthStatus() {
  if (!window.openhub || !window.openhub.geminiAuthStatus) return;
  window.openhub
    .geminiAuthStatus()
    .then(function (s) {
      setGeminiStatus(!!(s && s.connected), s && s.email);
    })
    .catch(function () {});
}

(function wireGeminiLogin() {
  var btn = document.getElementById("btn-google-login");
  if (!btn || !window.openhub || !window.openhub.geminiLogin) return;
  btn.addEventListener("click", function () {
    btn.disabled = true;
    var prev = btn.textContent;
    btn.textContent = "Connexion…";
    window.openhub
      .geminiLogin()
      .then(function (res) {
        setGeminiStatus(true, res && res.email);
        showSaveToast("Connecté à Google");
      })
      .catch(function (err) {
        btn.textContent = prev;
        var raw = err && err.message ? String(err.message) : "Connexion échouée";
        // Strip Electron's "Error invoking remote method '…': Error: " wrapper.
        showSaveToast(raw.split("Error: ").pop());
      })
      .finally(function () {
        btn.disabled = false;
      });
  });
})();

// ── Config panel ──
var configFocusTrigger = null;

function openConfig() {
  configFocusTrigger = document.activeElement;
  configPanel.classList.add("open");

  var topRow = document.querySelector(".top-row");
  if (topRow) topRow.style.setProperty("-webkit-app-region", "no-drag");

  // Reset to first tab
  var firstTab = document.getElementById("cfg-tab-keys");
  if (firstTab) switchConfigTab(firstTab);

  window.openhub.notifyConfigVisibility(true);
  if (window.openhub.getApiKeys) {
    window.openhub
      .getApiKeys()
      .then(function (keys) {
        if (!keys) return;
        if (keys.anthropic)
          document.getElementById("key-anthropic").value = keys.anthropic;
        if (keys.openai) document.getElementById("key-openai").value = keys.openai;
        if (keys.openrouterKey)
          document.getElementById("key-openrouter").value = keys.openrouterKey;
        if (keys.ollamaUrl && keys.ollamaUrl !== "http://127.0.0.1:11434")
          document.getElementById("key-ollama").value = keys.ollamaUrl;
        if (keys.githubToken)
          document.getElementById("key-github").value = keys.githubToken;
        if (keys.braveSearchKey)
          document.getElementById("key-brave").value = keys.braveSearchKey;
        // Store initial key values for blur-save comparison
        [
          "key-anthropic",
          "key-openai",
          "key-openrouter",
          "key-ollama",
          "key-github",
          "key-brave",
        ].forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.dataset.initial = el.value;
        });
      })
      .catch(function () {});
  }
  loadModelsUI();
  loadMemoryUI();
  loadUpdateStatus();
  loadCacheMetrics();
  loadGeminiAuthStatus();
  if (window.openhub.getAutoUpdate) {
    window.openhub
      .getAutoUpdate()
      .then(function (enabled) {
        var toggle = document.getElementById("auto-update-toggle");
        if (toggle) toggle.checked = !!enabled;
      })
      .catch(function () {});
  }
  if (window.openhub.getNavMode) {
    window.openhub
      .getNavMode()
      .then(function (mode) {
        var sel = document.getElementById("nav-mode-select");
        if (sel) sel.value = mode || "topbar";
      })
      .catch(function () {});
  }
  loadOllamaStatus();

  // Focus the close button for keyboard users
  setTimeout(function () {
    var closeBtn = document.getElementById("close-config");
    if (closeBtn) closeBtn.focus();
  }, 100);
}

function closeConfig() {
  configPanel.classList.remove("open");
  var topRow = document.querySelector(".top-row");
  if (topRow) topRow.style.removeProperty("-webkit-app-region");
  window.openhub.notifyConfigVisibility(false);
  // Restore focus to the element that opened the dialog
  if (configFocusTrigger && configFocusTrigger.focus) {
    configFocusTrigger.focus();
    configFocusTrigger = null;
  }
}

// ESC to close
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && configPanel.classList.contains("open")) {
    e.preventDefault();
    closeConfig();
  }
});

// Focus trap inside the dialog
configPanel.addEventListener("keydown", function (e) {
  if (e.key !== "Tab") return;
  var focusable = configPanel.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  var first = focusable[0];
  var last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

window.openhub.onShowConfig(openConfig);
document.getElementById("close-config").addEventListener("click", closeConfig);
backdrop.addEventListener("click", closeConfig);

// Auto-save API keys on blur when value changed
[
  "key-anthropic",
  "key-openai",
  "key-openrouter",
  "key-ollama",
  "key-github",
  "key-brave",
].forEach(function (id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("blur", function () {
    // Trim whitespace from paste (clés copiées avec espaces/retours à la ligne)
    var trimmed = el.value.trim();
    if (trimmed !== el.value) el.value = trimmed;
    if (el.value === el.dataset.initial) return;
    var previous = el.dataset.initial;
    el.dataset.initial = el.value;
    window.openhub
      .saveApiKeys({
        anthropic: document.getElementById("key-anthropic").value.trim(),
        openai: document.getElementById("key-openai").value.trim(),
        openrouterKey: document.getElementById("key-openrouter").value.trim(),
        ollamaUrl: document.getElementById("key-ollama").value.trim(),
        githubToken: document.getElementById("key-github").value.trim(),
        braveSearchKey: document.getElementById("key-brave").value.trim(),
      })
      .then(function () {
        showSaveToast("Clé enregistrée");
        if (id === "key-ollama") loadOllamaStatus();
      })
      .catch(function (err) {
        // Ne jamais avaler l'erreur en silence : restaurer l'état et prévenir
        el.dataset.initial = previous;
        showSaveToast("Échec de l'enregistrement de la clé");
        console.error("saveApiKeys failed", err);
      });
  });
});

// Config button
document.querySelector('[data-slot="config"]').addEventListener("click", function () {
  openConfig();
});

// Reveal/hide password
document.querySelectorAll(".btn-reveal").forEach(function (btn) {
  btn.addEventListener("click", function () {
    var input = document.getElementById(btn.dataset.target);
    if (!input) return;
    var isPass = input.type === "password";
    input.type = isPass ? "text" : "password";
    btn.setAttribute("aria-pressed", isPass ? "true" : "false");
    btn.setAttribute("aria-label", isPass ? "Masquer la clé" : "Afficher la clé");
    var svg = btn.querySelector("svg");
    if (svg) {
      var tmp = document.createElement("span");
      tmp.insertAdjacentHTML(
        "afterbegin",
        '<svg viewBox="0 0 24 24">' + (isPass ? eyeClosedSVG : eyeOpenSVG) + "</svg>",
      );
      var newSvg = tmp.querySelector("svg");
      newSvg.style.cssText =
        "width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.75";
      svg.replaceWith(newSvg);
    }
  });
});

// ── Memory UI ──

var memToggle = document.getElementById("memory-toggle");
var memBody = document.getElementById("memory-body");
var memProfile = document.getElementById("memory-profile");
var factListEl = document.getElementById("fact-list");
var newFactInput = document.getElementById("new-fact");
var tokenHint = document.getElementById("memory-token-hint");
var memAutoExtractToggle = document.getElementById("memory-auto-extract-toggle");

function approxTokens(text) {
  return Math.ceil(text.length / 3.5);
}

function displayModelName(id) {
  return id ? id.split("/").pop() || id : id;
}

async function loadModelsUI() {
  const classifierSelect = document.getElementById("ai-classifier");
  const visionSelect = document.getElementById("vision-model");

  var currentClassifier = await (window.openhub.getAiClassifierModel
    ? window.openhub.getAiClassifierModel()
    : Promise.resolve(""));
  var currentVisionModel = await (window.openhub.getVisionModel
    ? window.openhub.getVisionModel()
    : Promise.resolve(""));

  try {
    const __token = await getProxyToken();
    const res = await fetch("http://127.0.0.1:9999/v1/models/full", {
      headers: { Authorization: "Bearer " + __token },
    });
    const data = await res.json();
    const allModels = data.data || [];

    const ollamaModels = allModels.filter((m) => m.source === "ollama");
    const cloudModels = allModels.filter(
      (m) => m.source !== "ollama" && m.source !== "workflow",
    );

    function populate(select, current) {
      select.innerHTML = "";

      if (ollamaModels.length > 0) {
        const group = document.createElement("optgroup");
        group.label = "Local (Ollama)";
        ollamaModels.forEach((m) => {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = displayModelName(m.id);
          if (m.id === current) opt.selected = true;
          group.appendChild(opt);
        });
        select.appendChild(group);
      }

      if (cloudModels.length > 0) {
        const group = document.createElement("optgroup");
        group.label = "Cloud";
        cloudModels.forEach((m) => {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = displayModelName(m.id);
          if (m.id === current) opt.selected = true;
          group.appendChild(opt);
        });
        select.appendChild(group);
      }

      if (current && !allModels.find((m) => m.id === current)) {
        const opt = document.createElement("option");
        opt.value = current;
        opt.textContent = displayModelName(current) + " (Custom)";
        opt.selected = true;
        select.appendChild(opt);
      }
    }

    if (classifierSelect) populate(classifierSelect, currentClassifier);
    if (visionSelect) populate(visionSelect, currentVisionModel);
  } catch (err) {
    console.error("Failed to fetch models:", err);
  }

  if (window.openhub.getWebSearchEnabled) {
    window.openhub.getWebSearchEnabled().then(function (e) {
      document.getElementById("web-search-toggle").checked = !!e;
    });
  }
  if (window.openhub.getVisionProxyEnabled) {
    window.openhub.getVisionProxyEnabled().then(function (e) {
      document.getElementById("vision-proxy-toggle").checked = !!e;
      var vog = document.getElementById("vision-options-group");
      if (vog) vog.style.display = e ? "" : "none";
    });
  }
  if (window.openhub.getVisionDetailLevel) {
    window.openhub.getVisionDetailLevel().then(function (l) {
      document.getElementById("vision-detail-level").value = l || "high";
    });
  }
  if (window.openhub.getDefaultReasoningEffort) {
    window.openhub.getDefaultReasoningEffort().then(function (e) {
      document.getElementById("default-reasoning-effort").value = e || "medium";
    });
  }
  // Also sync proxy value (in case OpenCode indicator changed it)
  fetch("http://127.0.0.1:9999/v1/reasoning/default")
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      if (data && data.effort) {
        document.getElementById("default-reasoning-effort").value = data.effort;
      }
    })
    .catch(function () {});
}

function loadMemoryUI() {
  if (!window.openhub.getMemory) return;
  window.openhub
    .getMemory()
    .then(function (mem) {
      if (!mem) return;
      memToggle.checked = mem.enabled;
      if (memBody) memBody.style.display = mem.enabled ? "" : "none";
      if (memAutoExtractToggle) memAutoExtractToggle.checked = !!mem.autoExtract;
      memProfile.value = mem.profile || "";
      renderFacts(mem.facts || []);
      updateTokenHint(mem);
    })
    .catch(function () {});
}

// ── Updates ──
var updateStates = {};

function loadUpdateStatus() {
  var list = document.getElementById("update-list");
  if (!list) return;
  list.innerHTML = "";
  var apps = [
    { id: "openwork", label: "OpenWork", icon: "W" },
    { id: "opencode", label: "OpenCode", icon: "C" },
    { id: "open-design", label: "Open Design", icon: "D" },
  ];
  for (var i = 0; i < apps.length; i++) {
    var a = apps[i];
    var item = document.createElement("div");
    item.className = "update-item";
    item.dataset.app = a.id;
    item.innerHTML =
      '<div class="update-item-icon">' +
      a.icon +
      "</div>" +
      '<div class="update-item-body">' +
      '<div class="update-item-name">' +
      a.label +
      "</div>" +
      '<div class="update-item-status" id="update-status-' +
      a.id +
      '">Vérification…</div>' +
      "</div>" +
      '<button class="btn-update" id="update-btn-' +
      a.id +
      '">Vérifier</button>';
    list.appendChild(item);
  }
  if (!list.dataset.wired) {
    list.dataset.wired = "1";
    list.addEventListener("click", function (e) {
      var btn = e.target.closest(".btn-update");
      if (!btn) return;
      var row = btn.closest("[data-app]");
      if (row) checkUpdate(row.dataset.app);
    });
  }
  setTimeout(function () {
    for (var j = 0; j < apps.length; j++) checkUpdate(apps[j].id);
  }, 200);
}

async function checkUpdate(appId) {
  var statusEl = document.getElementById("update-status-" + appId);
  var btnEl = document.getElementById("update-btn-" + appId);
  if (!statusEl || !btnEl) return;
  statusEl.textContent = "Vérification…";
  statusEl.className = "update-item-status updating";
  btnEl.classList.add("checking");
  btnEl.disabled = true;
  try {
    var results = await window.openhub.checkAppUpdates();
    var info = results && results[appId];
    if (!info) throw new Error("no response");
    if (info.error) throw new Error(info.error);
    if (info.behind > 0) {
      statusEl.textContent = info.localTag + " → " + info.remoteTag;
      statusEl.className = "update-item-status available";
      btnEl.textContent = "Mettre à jour";
      btnEl.className = "btn-update primary";
      btnEl.disabled = false;
      btnEl.onclick = function () {
        runUpdate(appId);
      };
      if (window.openhub.getAutoUpdate) {
        var isAuto = await window.openhub.getAutoUpdate();
        if (isAuto) {
          runUpdate(appId);
        }
      }
    } else {
      statusEl.textContent =
        "À jour" + (info.localTag !== "none" ? " (" + info.localTag + ")" : "");
      statusEl.className = "update-item-status latest";
      btnEl.textContent = "Vérifier";
      btnEl.className = "btn-update";
      btnEl.disabled = false;
      btnEl.onclick = function () {
        checkUpdate(appId);
      };
    }
  } catch (err) {
    statusEl.textContent = "Erreur : " + (err.message || "inconnue");
    statusEl.className = "update-item-status error";
    btnEl.textContent = "Réessayer";
    btnEl.className = "btn-update";
    btnEl.disabled = false;
    btnEl.onclick = function () {
      checkUpdate(appId);
    };
  }
  btnEl.classList.remove("checking");
}

async function runUpdate(appId) {
  var statusEl = document.getElementById("update-status-" + appId);
  var btnEl = document.getElementById("update-btn-" + appId);
  if (!statusEl || !btnEl) return;
  statusEl.textContent = "Mise à jour en cours…";
  statusEl.className = "update-item-status updating";
  btnEl.textContent = "…";
  btnEl.disabled = true;
  try {
    var result = await window.openhub.runAppUpdate(appId);
    if (!result || !result.ok) throw new Error((result && result.error) || "échec");
    statusEl.textContent = "Mise à jour terminée ✓";
    statusEl.className = "update-item-status latest";
    btnEl.textContent = "Vérifier";
    btnEl.className = "btn-update";
    btnEl.disabled = false;
    btnEl.onclick = function () {
      checkUpdate(appId);
    };
  } catch (err) {
    statusEl.textContent = "Erreur : " + (err.message || "inconnue");
    statusEl.className = "update-item-status error";
    btnEl.textContent = "Réessayer";
    btnEl.className = "btn-update";
    btnEl.disabled = false;
    btnEl.onclick = function () {
      runUpdate(appId);
    };
  }
}

function renderFacts(facts) {
  factListEl.innerHTML = "";
  for (var i = 0; i < facts.length; i++) {
    var f = facts[i];
    var div = document.createElement("div");
    div.className = "fact-item";
    div.dataset.id = f.id;
    var span = document.createElement("span");
    span.textContent = f.text;
    span.title = f.text;
    var btn = document.createElement("button");
    btn.className = "fact-remove";
    btn.innerHTML =
      '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    btn.dataset.id = f.id;
    btn.addEventListener("click", function () {
      var id = this.dataset.id;
      window.openhub.removeMemoryFact(id).then(loadMemoryUI);
    });
    div.appendChild(span);
    div.appendChild(btn);
    factListEl.appendChild(div);
  }
}

function updateTokenHint(mem) {
  var hasProfile = !!mem.profile;
  var facts = (mem.facts || []).slice().sort(function (a, b) {
    return b.lastUsedAt - a.lastUsedAt;
  });
  var budget = mem.maxFactTokens || 150;
  var factLines = [];
  var includedFacts = 0;

  for (var i = 0; i < facts.length; i++) {
    var line = "- " + facts[i].text;
    var cost = approxTokens(line);
    if (cost > budget) continue;
    budget -= cost;
    factLines.push(line);
    includedFacts++;
  }

  var parts = [];
  if (mem.enabled && (hasProfile || factLines.length > 0)) {
    parts.push("<memory>");
    if (hasProfile) {
      parts.push("profile: " + mem.profile);
    }
    if (factLines.length > 0) {
      parts.push("facts:");
      for (var j = 0; j < factLines.length; j++) {
        parts.push(factLines[j]);
      }
    }
    parts.push("</memory>");
  }

  var totalTokens = parts.length > 0 ? approxTokens(parts.join("\n")) : 0;
  tokenHint.textContent =
    "~" +
    totalTokens +
    " tokens injectés · " +
    includedFacts +
    "/" +
    (mem.facts || []).length +
    " faits · " +
    (mem.facts || []).length +
    "/50 max";
}

memToggle.addEventListener("change", function () {
  var enabled = memToggle.checked;
  if (memBody) memBody.style.display = enabled ? "" : "none";
  window.openhub.setMemoryEnabled(enabled);
});

if (memAutoExtractToggle) {
  memAutoExtractToggle.addEventListener("change", function () {
    if (window.openhub.setMemoryAutoExtract) {
      window.openhub.setMemoryAutoExtract(memAutoExtractToggle.checked);
    }
  });
}

var autoUpdateToggle = document.getElementById("auto-update-toggle");
if (autoUpdateToggle) {
  autoUpdateToggle.addEventListener("change", function () {
    if (window.openhub.setAutoUpdate) {
      window.openhub.setAutoUpdate(autoUpdateToggle.checked);
    }
  });
}

var notifyModeSelect = document.getElementById("notify-mode");
if (notifyModeSelect) {
  notifyModeSelect.addEventListener("change", function () {
    if (window.openhub.setNotifyMode) {
      window.openhub.setNotifyMode(notifyModeSelect.value);
    }
  });
}

document.querySelectorAll("[data-notify-source]").forEach(function (input) {
  input.addEventListener("change", function () {
    if (!window.openhub.setNotifySources) return;
    var sources = {};
    document.querySelectorAll("[data-notify-source]").forEach(function (el) {
      sources[el.dataset.notifySource] = el.checked;
    });
    window.openhub.setNotifySources(sources);
  });
});

var webSearchToggle = document.getElementById("web-search-toggle");
if (webSearchToggle) {
  webSearchToggle.addEventListener("change", function () {
    if (window.openhub.setWebSearchEnabled) {
      window.openhub.setWebSearchEnabled(webSearchToggle.checked);
    }
  });
}

var visionProxyToggle = document.getElementById("vision-proxy-toggle");
var visionOptionsGroup = document.getElementById("vision-options-group");
if (visionProxyToggle) {
  visionProxyToggle.addEventListener("change", function () {
    if (visionOptionsGroup)
      visionOptionsGroup.style.display = visionProxyToggle.checked ? "" : "none";
    if (window.openhub.setVisionProxyEnabled) {
      window.openhub.setVisionProxyEnabled(visionProxyToggle.checked);
    }
  });
}

var aiClassifierInput = document.getElementById("ai-classifier");
if (aiClassifierInput) {
  aiClassifierInput.addEventListener("change", function () {
    if (window.openhub.setAiClassifierModel) {
      window.openhub.setAiClassifierModel(aiClassifierInput.value);
    }
  });
}

var visionModelInput = document.getElementById("vision-model");
if (visionModelInput) {
  visionModelInput.addEventListener("change", function () {
    if (window.openhub.setVisionModel) {
      window.openhub.setVisionModel(visionModelInput.value);
    }
  });
}

var visionDetailSelect = document.getElementById("vision-detail-level");
if (visionDetailSelect) {
  visionDetailSelect.addEventListener("change", function () {
    if (window.openhub.setVisionDetailLevel) {
      window.openhub.setVisionDetailLevel(visionDetailSelect.value);
    }
  });
}

var defaultReasoningSelect = document.getElementById("default-reasoning-effort");
if (defaultReasoningSelect) {
  defaultReasoningSelect.addEventListener("change", function () {
    var val = defaultReasoningSelect.value;
    if (window.openhub.setDefaultReasoningEffort) {
      window.openhub.setDefaultReasoningEffort(val);
    }
    // Sync to localStorage for OpenCode indicator
    try {
      localStorage.setItem("openhub-default-reasoning-effort", val);
    } catch (e) {}
    // Also sync to proxy for OpenCode indicator
    getProxyToken().then(function (__token) {
      fetch("http://127.0.0.1:9999/v1/reasoning/default", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + __token,
        },
        body: JSON.stringify({ effort: val }),
      }).catch(function () {});
    });
  });
}

// Toast feedback for all toggle/select changes (delegated)
var configScroll = document.getElementById("config-scroll");
if (configScroll) {
  configScroll.addEventListener("change", function (e) {
    var t = e.target;
    if (t.tagName === "INPUT" && t.type === "checkbox") showSaveToast("Enregistré");
    else if (t.tagName === "SELECT") showSaveToast("Enregistré");
  });
}

var profileTimer = null;
memProfile.addEventListener("input", function () {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(function () {
    window.openhub.setMemoryProfile(memProfile.value);
    loadMemoryUI();
    showSaveToast("Profil enregistré");
  }, 600);
});
memProfile.addEventListener("blur", function () {
  clearTimeout(profileTimer);
  window.openhub.setMemoryProfile(memProfile.value);
  loadMemoryUI();
});

document.getElementById("btn-add-fact").addEventListener("click", function () {
  var text = newFactInput.value.trim();
  if (!text) {
    newFactInput.style.borderColor = "var(--oh-color-error)";
    setTimeout(function () {
      newFactInput.style.borderColor = "";
    }, 1500);
    return;
  }
  if (text.length > 500) {
    newFactInput.style.borderColor = "var(--oh-color-error)";
    setTimeout(function () {
      newFactInput.style.borderColor = "";
    }, 1500);
    return;
  }
  newFactInput.value = "";
  window.openhub
    .addMemoryFact(text, [])
    .then(loadMemoryUI)
    .catch(function (err) {
      // Restaurer la saisie en cas d'échec pour ne pas perdre le texte
      newFactInput.value = text;
      newFactInput.style.borderColor = "var(--oh-color-error)";
      setTimeout(function () {
        newFactInput.style.borderColor = "";
      }, 1500);
      console.error("addMemoryFact failed", err);
    });
});

newFactInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("btn-add-fact").click();
  }
});

// ── Ollama Model Management ──
var ollamaManagerEl = document.getElementById("ollama-model-manager");
var ollamaModelListEl = document.getElementById("ollama-model-list");

async function loadOllamaStatus() {
  if (!window.openhub.ollamaCheckModels) return;
  try {
    const status = await window.openhub.ollamaCheckModels();
    if (!status.running || status.missing.length === 0) {
      ollamaManagerEl.style.display = "none";
      return;
    }

    ollamaManagerEl.style.display = "block";
    ollamaModelListEl.innerHTML = "";

    status.missing.forEach((model) => {
      const isPulling = status.pulling.includes(model);
      const safeId = model.replace(/[:.]/g, "-");

      const card = document.createElement("div");
      card.className = "ollama-model-card";

      const header = document.createElement("div");
      header.className = "ollama-model-header";

      const nameSpan = document.createElement("span");
      nameSpan.className = "ollama-model-name";
      nameSpan.textContent = displayModelName(model);

      const statusSpan = document.createElement("span");
      statusSpan.className = "ollama-model-status";
      statusSpan.id = "ollama-status-" + safeId;
      statusSpan.textContent = isPulling ? "En cours..." : "Manquant";

      header.appendChild(nameSpan);
      header.appendChild(statusSpan);
      card.appendChild(header);

      const progressCont = document.createElement("div");
      progressCont.className = "ollama-progress-container";
      progressCont.id = "ollama-progress-cont-" + safeId;
      progressCont.style.display = isPulling ? "block" : "none";

      const progressBar = document.createElement("div");
      progressBar.className = "ollama-progress-bar";
      progressBar.id = "ollama-progress-bar-" + safeId;

      progressCont.appendChild(progressBar);
      card.appendChild(progressCont);

      const actions = document.createElement("div");
      actions.className = "ollama-actions";
      actions.id = "ollama-actions-" + safeId;

      const btn = document.createElement("button");
      btn.className = "btn-ollama" + (isPulling ? " cancel" : "");
      btn.textContent = isPulling ? "Annuler" : "Installer";
      btn.addEventListener("click", () => {
        if (isPulling) {
          window.openhub.ollamaCancelPull(model);
          hideOllamaProgress(model);
        } else {
          window.openhub.ollamaPullModel(model);
          showOllamaProgress(model);
        }
      });

      actions.appendChild(btn);
      card.appendChild(actions);
      ollamaModelListEl.appendChild(card);

      // Auto-trigger installation if not already pulling
      if (!isPulling) {
        window.openhub.ollamaPullModel(model);
        showOllamaProgress(model);
      }
    });
  } catch (err) {
    console.error("[ollama-manager] Failed to check models:", err);
  }
}

function showOllamaProgress(model) {
  const safeId = model.replace(/[:.]/g, "-");
  document.getElementById("ollama-progress-cont-" + safeId).style.display = "block";
  document.getElementById("ollama-status-" + safeId).textContent = "Initialisation...";
  const actions = document.getElementById("ollama-actions-" + safeId);
  actions.textContent = "";
  const btn = document.createElement("button");
  btn.className = "btn-ollama cancel";
  btn.textContent = "Annuler";
  btn.addEventListener("click", () => {
    window.openhub.ollamaCancelPull(model);
    hideOllamaProgress(model);
  });
  actions.appendChild(btn);
}

function hideOllamaProgress(model) {
  const safeId = model.replace(/[:.]/g, "-");
  document.getElementById("ollama-progress-cont-" + safeId).style.display = "none";
  document.getElementById("ollama-status-" + safeId).textContent = "Manquant";
  const actions = document.getElementById("ollama-actions-" + safeId);
  actions.textContent = "";
  const btn = document.createElement("button");
  btn.className = "btn-ollama";
  btn.textContent = "Installer";
  btn.addEventListener("click", () => {
    window.openhub.ollamaPullModel(model);
    showOllamaProgress(model);
  });
  actions.appendChild(btn);
}

if (window.openhub.onOllamaPullProgress) {
  window.openhub.onOllamaPullProgress((progress) => {
    const id = progress.model.replace(/[:.]/g, "-");
    const statusEl = document.getElementById("ollama-status-" + id);
    const barEl = document.getElementById("ollama-progress-bar-" + id);
    const contEl = document.getElementById("ollama-progress-cont-" + id);
    const actionsEl = document.getElementById("ollama-actions-" + id);

    if (!statusEl) return;

    if (progress.status === "success") {
      statusEl.textContent = "Installé ✓";
      statusEl.style.color = "var(--oh-color-success)";
      if (contEl) contEl.style.display = "none";
      if (actionsEl) actionsEl.style.display = "none";
      // Refresh in 2 seconds to hide the manager if all models are installed
      setTimeout(loadOllamaStatus, 2000);
    } else if (progress.status === "error") {
      statusEl.textContent = "Erreur : " + (progress.error || "échec");
      statusEl.style.color = "var(--oh-color-error)";
      if (actionsEl) {
        // Build via DOM (not innerHTML/onclick) so the model id can never
        // break out of a string into executable markup.
        const model = progress.model;
        const retryBtn = document.createElement("button");
        retryBtn.className = "btn-ollama";
        retryBtn.textContent = "Réessayer";
        retryBtn.addEventListener("click", () => {
          window.openhub.ollamaPullModel(model);
          showOllamaProgress(model);
        });
        actionsEl.replaceChildren(retryBtn);
      }
    } else if (progress.status === "canceled") {
      hideOllamaProgress(progress.model);
    } else {
      // "pulling manifest", "downloading", etc.
      let text = progress.status;
      if (progress.percent !== undefined) {
        text += " (" + progress.percent + "%)";
        if (barEl) barEl.style.width = progress.percent + "%";
        if (contEl) contEl.style.display = "block";
      }
      statusEl.textContent = text;
    }
  });
}

// Dynamic service status polling
function pollServiceStatuses() {
  if (!window.openhub || !window.openhub.getSlotStatus) return;
  window.openhub
    .getSlotStatus()
    .then(function (status) {
      if (!status) return;
      ["work", "code", "design"].forEach(function (slot) {
        var btn = document.querySelector('.slot-btn[data-slot="' + slot + '"]');
        if (!btn) return;
        if (btn.classList.contains("loading")) return;

        var info = status[slot];
        if (info && info.healthy) {
          btn.classList.add("ready");
        } else {
          btn.classList.remove("ready");
        }
      });
    })
    .catch(function (err) {
      console.error("[sidebar] failed to fetch slot status:", err);
    });
}
// ── Prompt Caching Metrics Dashboard ──
function loadCacheMetrics() {
  fetch("http://127.0.0.1:9999/v1/cache/metrics")
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      var stats = data.stats;
      var records = data.records;

      // Update stats cards with null-safe values
      var ratioVal = (stats.savings_ratio || 0) * 100;
      document.getElementById("cache-hit-ratio").textContent = ratioVal.toFixed(1) + "%";
      document.getElementById("cache-hit-ratio-bar").style.width =
        ratioVal.toFixed(1) + "%";
      document.getElementById("cache-saved-tokens").textContent = (
        stats.total_cached_tokens || 0
      ).toLocaleString();
      document.getElementById("cache-total-tokens").textContent = (
        stats.total_prompt_tokens || 0
      ).toLocaleString();

      var emptyState = document.getElementById("cache-empty-state");
      var detailsContainer = document.getElementById("cache-details-container");

      if (stats.total_requests === 0) {
        emptyState.style.display = "block";
        detailsContainer.style.display = "none";
        return;
      }

      emptyState.style.display = "none";
      detailsContainer.style.display = "block";

      // Helper to clean table body
      function renderBreakdownTable(tbodyId, breakdown) {
        var tbody = document.getElementById(tbodyId);
        if (!tbody) return;
        tbody.innerHTML = "";

        if (!breakdown || typeof breakdown !== "object") return;

        var sorted = Object.keys(breakdown)
          .map(function (key) {
            var entry = breakdown[key] || {};
            var reqs = entry.requests || 0;
            var cached = entry.cached_tokens || 0;
            var promptT = entry.prompt_tokens || 0;
            return {
              name: key,
              requests: reqs,
              cached_tokens: cached,
              prompt_tokens: promptT,
              ratio: promptT > 0 ? (cached / promptT) * 100 : 0,
            };
          })
          .sort(function (a, b) {
            return b.cached_tokens - a.cached_tokens;
          });

        sorted.forEach(function (item) {
          var tr = document.createElement("tr");

          var tdName = document.createElement("td");
          tdName.style.fontWeight = "600";
          tdName.textContent = item.name;
          tr.appendChild(tdName);

          var tdReqs = document.createElement("td");
          tdReqs.style.textAlign = "right";
          tdReqs.textContent = item.requests.toLocaleString();
          tr.appendChild(tdReqs);

          var tdSaved = document.createElement("td");
          tdSaved.style.textAlign = "right";
          tdSaved.textContent = item.cached_tokens.toLocaleString();
          tr.appendChild(tdSaved);

          var tdRatio = document.createElement("td");
          tdRatio.style.textAlign = "right";
          tdRatio.style.fontWeight = "600";
          tdRatio.style.color =
            item.ratio > 50 ? "var(--oh-color-success)" : "var(--oh-color-text-primary)";
          tdRatio.textContent = item.ratio.toFixed(1) + "%";
          tr.appendChild(tdRatio);

          tbody.appendChild(tr);
        });
      }

      renderBreakdownTable("cache-model-table-body", stats.breakdown_by_model);
      renderBreakdownTable("cache-workspace-table-body", stats.breakdown_by_workspace);
    })
    .catch(function (err) {
      console.error("Failed to load cache metrics:", err);
    });
}

var btnResetCache = document.getElementById("btn-reset-cache");
var cacheResetArea = document.getElementById("cache-reset-area");
if (btnResetCache && cacheResetArea) {
  btnResetCache.addEventListener("click", function () {
    cacheResetArea.innerHTML =
      '<span class="reset-confirm">' +
      '<span style="font-size:12px;color:var(--oh-color-text-secondary);">Confirmer ?</span> ' +
      '<button class="btn-confirm-yes">Oui</button> ' +
      '<button class="btn-confirm-no">Non</button>' +
      "</span>";
    cacheResetArea
      .querySelector(".btn-confirm-yes")
      .addEventListener("click", function () {
        fetch("http://127.0.0.1:9999/v1/cache/reset", { method: "POST" })
          .then(function () {
            loadCacheMetrics();
            showSaveToast("Cache réinitialisé");
          })
          .catch(function (err) {
            console.error("Failed to reset metrics:", err);
          });
        cacheResetArea.innerHTML =
          '<button class="btn-danger-ghost" id="btn-reset-cache">Réinitialiser</button>';
        rebindResetCache();
      });
    cacheResetArea
      .querySelector(".btn-confirm-no")
      .addEventListener("click", function () {
        cacheResetArea.innerHTML =
          '<button class="btn-danger-ghost" id="btn-reset-cache">Réinitialiser</button>';
        rebindResetCache();
      });
  });
}
function rebindResetCache() {
  var btn = document.getElementById("btn-reset-cache");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var area = document.getElementById("cache-reset-area");
    if (!area) return;
    area.innerHTML =
      '<span class="reset-confirm">' +
      '<span style="font-size:12px;color:var(--oh-color-text-secondary);">Confirmer ?</span> ' +
      '<button class="btn-confirm-yes">Oui</button> ' +
      '<button class="btn-confirm-no">Non</button>' +
      "</span>";
    area.querySelector(".btn-confirm-yes").addEventListener("click", function () {
      fetch("http://127.0.0.1:9999/v1/cache/reset", { method: "POST" })
        .then(function () {
          loadCacheMetrics();
          showSaveToast("Cache réinitialisé");
        })
        .catch(function (err) {
          console.error("Failed to reset metrics:", err);
        });
      area.innerHTML =
        '<button class="btn-danger-ghost" id="btn-reset-cache">Réinitialiser</button>';
      rebindResetCache();
    });
    area.querySelector(".btn-confirm-no").addEventListener("click", function () {
      area.innerHTML =
        '<button class="btn-danger-ghost" id="btn-reset-cache">Réinitialiser</button>';
      rebindResetCache();
    });
  });
}

setInterval(pollServiceStatuses, 3000);
setTimeout(pollServiceStatuses, 500);
