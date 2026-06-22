// OpenHub onboarding stepper — first-run wizard.
// Loaded by sidebar.html as an external script (CSP: script-src 'self').
(function () {
  "use strict";

  var TOTAL_STEPS = 5;
  var currentStep = 1;
  var pullUnsub = null;

  var VISION_MODEL = "openbmb/minicpm-v4.6";
  var MEMORY_MODEL = "qwen2.5:1.5b";

  // ── Boot check ──────────────────────────────────────────────────────────
  function boot() {
    if (!window.openhub || !window.openhub.onboardingPending) return;
    if (!window.openhub.onboardingPending()) return;

    var overlay = document.getElementById("onboarding-overlay");
    if (!overlay) return;

    overlay.classList.add("open");
    window.openhub.notifyOnboardingVisibility(true);

    renderStep();
    subscribePullProgress();
  }

  // ── Navigation ──────────────────────────────────────────────────────────
  function bindNav() {
    var btnNext = document.getElementById("ob-next");
    var btnPrev = document.getElementById("ob-prev");
    var btnSkip = document.getElementById("ob-skip");

    if (btnNext)
      btnNext.addEventListener("click", function () {
        goTo(currentStep + 1);
      });
    if (btnPrev)
      btnPrev.addEventListener("click", function () {
        goTo(currentStep - 1);
      });
    if (btnSkip)
      btnSkip.addEventListener("click", function () {
        goTo(currentStep + 1);
      });

    var btnStart = document.getElementById("ob-start");
    if (btnStart)
      btnStart.addEventListener("click", function () {
        goTo(2);
      });

    var btnFinish = document.getElementById("ob-finish");
    if (btnFinish) btnFinish.addEventListener("click", finish);
  }

  function goTo(step) {
    if (step < 1 || step > TOTAL_STEPS) return;
    currentStep = step;
    renderStep();

    if (step === 4) loadOllamaStep();
  }

  function renderStep() {
    var sections = document.querySelectorAll(".onboarding-step");
    sections.forEach(function (s, i) {
      s.classList.toggle("active", i + 1 === currentStep);
    });

    var fill = document.getElementById("ob-progress-fill");
    if (fill) fill.style.width = (currentStep / TOTAL_STEPS) * 100 + "%";

    var counter = document.getElementById("ob-step-counter");
    if (counter) {
      counter.textContent = window.t
        ? window.t("onboarding.step", { current: currentStep, total: TOTAL_STEPS })
        : "Step " + currentStep + " of " + TOTAL_STEPS;
    }

    var btnPrev = document.getElementById("ob-prev");
    var btnNext = document.getElementById("ob-next");
    var btnSkip = document.getElementById("ob-skip");
    var btnFinish = document.getElementById("ob-finish");

    if (btnPrev)
      btnPrev.style.display = currentStep > 1 && currentStep < TOTAL_STEPS ? "" : "none";
    if (btnNext) btnNext.style.display = currentStep < TOTAL_STEPS - 1 ? "" : "none";
    if (btnSkip) btnSkip.style.display = currentStep === 3 ? "" : "none";
    if (btnFinish) btnFinish.style.display = currentStep === TOTAL_STEPS ? "" : "none";

    // Step 4 (Ollama) shows its own "Continue" button in the footer
    var btnOllamaContinue = document.getElementById("ob-ollama-continue");
    if (btnOllamaContinue)
      btnOllamaContinue.style.display = currentStep === 4 ? "" : "none";
  }

  async function finish() {
    if (!window.openhub) return;
    await window.openhub.completeOnboarding();
    var overlay = document.getElementById("onboarding-overlay");
    if (overlay) overlay.classList.remove("open");

    if (pullUnsub) {
      pullUnsub();
      pullUnsub = null;
    }
  }

  // ── Language step ───────────────────────────────────────────────────────
  function bindLang() {
    var btns = document.querySelectorAll(".ob-lang-btn");
    btns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var lang = btn.getAttribute("data-lang");
        if (!lang || !window.openhub) return;

        btns.forEach(function (b) {
          b.classList.remove("selected");
        });
        btn.classList.add("selected");
        window.openhub.setLanguage(lang);
      });
    });

    // Pre-select current language
    if (window.openhub && window.openhub.getLanguage) {
      window.openhub.getLanguage().then(function (lang) {
        btns.forEach(function (b) {
          b.classList.toggle("selected", b.getAttribute("data-lang") === lang);
        });
      });
    }
  }

  // ── Model selects — rebuild options from available keys ─────────────────
  var SOURCE_LABELS = {
    direct: "Direct API",
    openrouter: "OpenRouter",
    local: "Ollama (local)",
  };

  function formatModelName(id) {
    var parts = id.split("/");
    var name = parts.length > 1 ? parts[1] : parts[0];
    return name.replace(/-/g, " ").replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
  }

  function populateSelect(select, models, currentValue) {
    var prevValue = select.value || currentValue || "";
    select.innerHTML = "";

    var groups = {};
    models.forEach(function (m) {
      var src = m.source || "other";
      if (!groups[src]) groups[src] = [];
      groups[src].push(m);
    });

    var order = ["openai", "anthropic", "deepseek", "direct", "openrouter", "local"];
    Object.keys(groups).forEach(function (k) {
      if (order.indexOf(k) === -1) order.push(k);
    });

    order.forEach(function (src) {
      var list = groups[src];
      if (!list || !list.length) return;
      var grp = document.createElement("optgroup");
      grp.label = SOURCE_LABELS[src] || src;
      list.forEach(function (m) {
        var opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = formatModelName(m.id);
        grp.appendChild(opt);
      });
      select.appendChild(grp);
    });

    if (
      prevValue &&
      select.querySelector('option[value="' + CSS.escape(prevValue) + '"]')
    ) {
      select.value = prevValue;
    }
  }

  async function refreshModelSelects() {
    if (!window.openhub || !window.openhub.getAvailableModels) return;
    var models;
    try {
      models = await window.openhub.getAvailableModels();
    } catch {
      return;
    }
    if (!models || !models.length) return;

    var proSelect = document.getElementById("ob-pro-model");
    var flashSelect = document.getElementById("ob-flash-model");
    var proValue = window.openhub.getAiWorkflowProModel
      ? await window.openhub.getAiWorkflowProModel()
      : "";
    var flashValue = window.openhub.getAiWorkflowFlashModel
      ? await window.openhub.getAiWorkflowFlashModel()
      : "";

    if (proSelect) populateSelect(proSelect, models, proValue);
    if (flashSelect) populateSelect(flashSelect, models, flashValue);
  }

  // ── Preferences step ───────────────────────────────────────────────────
  function bindPrefs() {
    // API key inputs — save on blur
    var keyFields = [
      { id: "ob-key-anthropic", key: "anthropic" },
      { id: "ob-key-openai", key: "openai" },
      { id: "ob-key-openrouter", key: "openrouter" },
      { id: "ob-key-ollama", key: "ollama" },
    ];

    keyFields.forEach(function (field) {
      var input = document.getElementById(field.id);
      if (!input) return;
      input.addEventListener("blur", function () {
        if (!input.value.trim() || !window.openhub) return;
        var keys = {};
        keys[field.key] = input.value.trim();
        window.openhub.saveApiKeys(keys).then(function () {
          refreshModelSelects();
        });
      });
    });

    // Google login — désactivé depuis le 18 juin 2026. opencode auth login dans le terminal.

    // Reveal buttons
    document
      .querySelectorAll("#onboarding-step-prefs .btn-reveal")
      .forEach(function (btn) {
        btn.addEventListener("click", function () {
          var targetId = btn.getAttribute("data-target");
          var input = targetId ? document.getElementById(targetId) : null;
          if (!input) return;
          var isPassword = input.type === "password";
          input.type = isPassword ? "text" : "password";
          btn.setAttribute("aria-pressed", isPassword ? "true" : "false");
        });
      });

    // Model selects — populated dynamically from available keys
    var proSelect = document.getElementById("ob-pro-model");
    if (proSelect) {
      proSelect.addEventListener("change", function () {
        if (window.openhub) window.openhub.setAiWorkflowProModel(proSelect.value);
      });
    }

    var flashSelect = document.getElementById("ob-flash-model");
    if (flashSelect) {
      flashSelect.addEventListener("change", function () {
        if (window.openhub) window.openhub.setAiWorkflowFlashModel(flashSelect.value);
      });
    }

    refreshModelSelects();

    // Notify mode
    var notifySelect = document.getElementById("ob-notify-mode");
    if (notifySelect && window.openhub) {
      window.openhub.getNotifyMode().then(function (v) {
        notifySelect.value = v;
      });
      notifySelect.addEventListener("change", function () {
        window.openhub.setNotifyMode(notifySelect.value);
      });
    }

    // Memory toggles
    var memToggle = document.getElementById("ob-memory-enabled");
    if (memToggle && window.openhub) {
      window.openhub.getMemory().then(function (mem) {
        if (mem) memToggle.checked = !!mem.enabled;
      });
      memToggle.addEventListener("change", function () {
        window.openhub.setMemoryEnabled(memToggle.checked);
      });
    }

    var autoToggle = document.getElementById("ob-memory-auto");
    if (autoToggle && window.openhub) {
      window.openhub.getMemory().then(function (mem) {
        if (mem) autoToggle.checked = !!mem.autoExtract;
      });
      autoToggle.addEventListener("change", function () {
        window.openhub.setMemoryAutoExtract(autoToggle.checked);
      });
    }
  }

  // ── Ollama step ─────────────────────────────────────────────────────────
  async function loadOllamaStep() {
    var notice = document.getElementById("ob-ollama-notice");
    var models = document.getElementById("ob-ollama-models");
    if (!notice || !models || !window.openhub) return;

    notice.style.display = "none";
    models.style.display = "none";

    var status;
    try {
      status = await window.openhub.ollamaCheckModels();
    } catch {
      notice.style.display = "";
      return;
    }

    if (!status.running) {
      notice.style.display = "";
      return;
    }

    models.style.display = "";
    renderOllamaCard("ob-ollama-vision", VISION_MODEL, status);
    renderOllamaCard("ob-ollama-memory", MEMORY_MODEL, status);
  }

  function renderOllamaCard(cardId, model, status) {
    var card = document.getElementById(cardId);
    if (!card) return;

    var statusEl = card.querySelector(".ob-ollama-status");
    var actionBtn = card.querySelector(".ob-ollama-action");
    var progressWrap = card.querySelector(".ob-ollama-progress");

    if (cardId === "ob-ollama-memory") {
      card.style.opacity = "0.5";
      card.style.pointerEvents = "none";
      if (statusEl) {
        statusEl.className = "ob-ollama-status ob-ollama-status--missing";
        statusEl.textContent = window.t ? window.t("cfg.tab.memory.badge") : "Soon";
      }
      if (actionBtn) {
        actionBtn.style.display = "";
        actionBtn.textContent = window.t
          ? window.t("cfg.memory.soon.title")
          : "Coming soon";
        actionBtn.disabled = true;
      }
      if (progressWrap) progressWrap.style.display = "none";
      return;
    }

    var isInstalled = status.installed && status.installed.indexOf(model) !== -1;

    if (statusEl) {
      statusEl.className =
        "ob-ollama-status " +
        (isInstalled ? "ob-ollama-status--installed" : "ob-ollama-status--missing");
      statusEl.textContent = window.t
        ? window.t(isInstalled ? "ollama.installed" : "ollama.missing")
        : isInstalled
          ? "Installed ✓"
          : "Missing";
    }

    if (actionBtn) {
      actionBtn.style.display = isInstalled ? "none" : "";
      actionBtn.textContent = window.t ? window.t("common.install") : "Install";
      actionBtn.disabled = false;
      actionBtn.onclick = function () {
        startPull(cardId, model);
      };
    }

    if (progressWrap) progressWrap.style.display = "none";
  }

  function startPull(cardId, model) {
    var card = document.getElementById(cardId);
    if (!card || !window.openhub) return;

    var actionBtn = card.querySelector(".ob-ollama-action");
    var progressWrap = card.querySelector(".ob-ollama-progress");
    var statusEl = card.querySelector(".ob-ollama-status");

    if (actionBtn) {
      actionBtn.textContent = window.t ? window.t("common.cancel") : "Cancel";
      actionBtn.onclick = function () {
        cancelPull(cardId, model);
      };
    }
    if (progressWrap) progressWrap.style.display = "";
    if (statusEl) {
      statusEl.className = "ob-ollama-status";
      statusEl.textContent = window.t ? window.t("ollama.pulling") : "In progress...";
    }

    window.openhub.ollamaPullModel(model);
  }

  function cancelPull(cardId, model) {
    if (window.openhub) window.openhub.ollamaCancelPull(model);

    var card = document.getElementById(cardId);
    if (!card) return;
    var actionBtn = card.querySelector(".ob-ollama-action");
    var progressWrap = card.querySelector(".ob-ollama-progress");
    var statusEl = card.querySelector(".ob-ollama-status");

    if (actionBtn) {
      actionBtn.textContent = window.t ? window.t("common.install") : "Install";
      actionBtn.onclick = function () {
        startPull(cardId, model);
      };
    }
    if (progressWrap) progressWrap.style.display = "none";
    if (statusEl) {
      statusEl.className = "ob-ollama-status ob-ollama-status--missing";
      statusEl.textContent = window.t ? window.t("ollama.missing") : "Missing";
    }
  }

  function subscribePullProgress() {
    if (!window.openhub || !window.openhub.onOllamaPullProgress) return;

    pullUnsub = window.openhub.onOllamaPullProgress(function (progress) {
      if (!progress || !progress.model) return;

      var cardId =
        progress.model === VISION_MODEL
          ? "ob-ollama-vision"
          : progress.model === MEMORY_MODEL
            ? "ob-ollama-memory"
            : null;
      if (!cardId) return;

      var card = document.getElementById(cardId);
      if (!card) return;

      var statusEl = card.querySelector(".ob-ollama-status");
      var actionBtn = card.querySelector(".ob-ollama-action");
      var progressWrap = card.querySelector(".ob-ollama-progress");
      var bar = card.querySelector(".ob-ollama-progress-bar");
      var text = card.querySelector(".ob-ollama-progress-text");

      if (progress.status === "success") {
        if (statusEl) {
          statusEl.className = "ob-ollama-status ob-ollama-status--installed";
          statusEl.textContent = window.t ? window.t("ollama.installed") : "Installed ✓";
        }
        if (actionBtn) actionBtn.style.display = "none";
        if (progressWrap) progressWrap.style.display = "none";
        return;
      }

      if (progress.status === "error") {
        if (statusEl) {
          statusEl.className = "ob-ollama-status ob-ollama-status--error";
          statusEl.textContent = window.t
            ? window.t("common.errorWith", {
                msg: progress.error || (window.t ? window.t("common.failed") : "failed"),
              })
            : "Error: " + (progress.error || "failed");
        }
        if (actionBtn) {
          actionBtn.textContent = window.t ? window.t("common.retry") : "Retry";
          actionBtn.onclick = function () {
            startPull(cardId, progress.model);
          };
        }
        if (progressWrap) progressWrap.style.display = "none";
        return;
      }

      if (progress.status === "canceled") {
        cancelPull(cardId, progress.model);
        return;
      }

      // Normal progress
      var pct = typeof progress.percent === "number" ? Math.round(progress.percent) : 0;
      if (bar) bar.style.width = pct + "%";
      if (text)
        text.textContent = (progress.status || "") + (pct > 0 ? " (" + pct + "%)" : "");
      if (progressWrap) progressWrap.style.display = "";
    });
  }

  // ── Ollama download + recheck ───────────────────────────────────────────
  function bindOllamaActions() {
    var btnDownload = document.getElementById("ob-ollama-download");
    if (btnDownload) {
      btnDownload.addEventListener("click", function () {
        if (window.openhub) {
          window.openhub.openExternal("https://ollama.com/download");
        }
      });
    }

    var btnRecheck = document.getElementById("ob-ollama-recheck");
    if (btnRecheck) {
      btnRecheck.addEventListener("click", function () {
        loadOllamaStep();
      });
    }

    var btnContinue = document.getElementById("ob-ollama-continue");
    if (btnContinue) {
      btnContinue.addEventListener("click", function () {
        goTo(5);
      });
    }
  }

  // ── Restart (redo from settings) ────────────────────────────────────────
  function listenRestart() {
    var overlay = document.getElementById("onboarding-overlay");
    if (!overlay) return;
    overlay.addEventListener("onboarding-restart", function () {
      localStorage.removeItem("openhub-chat-welcome-shown");
      overlay.classList.add("open");
      if (window.openhub && window.openhub.notifyOnboardingVisibility) {
        window.openhub.notifyOnboardingVisibility(true);
      }
      currentStep = 1;
      renderStep();
      if (!pullUnsub) subscribePullProgress();
    });
  }

  // ── Init ────────────────────────────────────────────────────────────────
  function init() {
    bindNav();
    bindLang();
    bindPrefs();
    bindOllamaActions();
    listenRestart();
    boot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
