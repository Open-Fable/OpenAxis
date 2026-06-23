(function () {
  "use strict";
  // Verrou unique pour cette version du script
  if (window.__OPENAXIS_WORK_PROJECTS_SIMPLE_V2__) return;
  window.__OPENAXIS_WORK_PROJECTS_SIMPLE_V2__ = true;

  var hub = window.openaxis;

  // ── Inline i18n (webview has no runtime) ──
  var lang = (hub && hub.language) || "fr";
  var DICT = {
    fr: {
      editProject: "Modifier le projet",
      newProject: "Nouveau projet",
      projectName: "Nom du projet",
      namePlaceholder: "Ex: Assistant Marketing",
      color: "Couleur",
      linkedFolder: "Dossier lié",
      noFolder: "Aucun dossier lié",
      choose: "Choisir...",
      instructions: "Instructions",
      instrPlaceholder: "Instructions pour l'IA...",
      cancel: "Annuler",
      save: "Enregistrer",
      create: "Créer",
      saveError: "Échec de l'enregistrement du projet : {err}",
      projects: "Projets",
    },
    en: {
      editProject: "Edit project",
      newProject: "New project",
      projectName: "Project name",
      namePlaceholder: "E.g.: Marketing Assistant",
      color: "Color",
      linkedFolder: "Linked folder",
      noFolder: "No linked folder",
      choose: "Choose...",
      instructions: "Instructions",
      instrPlaceholder: "Instructions for the AI...",
      cancel: "Cancel",
      save: "Save",
      create: "Create",
      saveError: "Failed to save project: {err}",
      projects: "Projects",
    },
  };
  function t(key, vars) {
    var str = (DICT[lang] || DICT.fr)[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        str = str.replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
      });
    }
    return str;
  }

  // Escapes untrusted project fields (name/path/instructions are LLM/user-controlled
  // and persisted) before they are interpolated into HTML — prevents stored XSS.
  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function getFolderIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px; flex-shrink: 0; opacity: 0.7;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
  }

  // ── Modal Logic (Replacement for prompt()) ──────────────────
  var COLORS = [
    "#7c5cfc",
    "#3b82f6",
    "#10b981",
    "#f59e0b",
    "#ef4444",
    "#ec4899",
    "#8b5cf6",
    "#06b6d4",
  ];

  function closeModal() {
    var el = document.getElementById("oh-project-modal-overlay");
    if (el) el.remove();
  }

  function renderModal(editing) {
    closeModal();
    var isEdit = Boolean(editing);
    var overlay = document.createElement("div");
    overlay.id = "oh-project-modal-overlay";
    overlay.onclick = function (e) {
      if (e.target === overlay) closeModal();
    };
    var modal = document.createElement("div");
    modal.id = "oh-project-modal";

    modal.innerHTML = `
      <div class="oh-modal-header">
        <h2>${isEdit ? t("editProject") : t("newProject")}</h2>
        <button class="oh-modal-close">×</button>
      </div>
      <div class="oh-modal-field">
        <label for="oh-modal-name-input">${t("projectName")}</label>
        <input type="text" id="oh-modal-name-input" placeholder="${t("namePlaceholder")}" maxlength="120" value="${editing ? escapeHtml(editing.name) : ""}">
      </div>
      <div class="oh-modal-field">
        <label>${t("color")}</label>
        <div class="oh-color-row" id="oh-modal-color-row"></div>
      </div>
      <div class="oh-modal-field">
        <label for="oh-modal-path-input">${t("linkedFolder")}</label>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="oh-modal-path-input" placeholder="${t("noFolder")}" value="${editing ? escapeHtml(editing.path || "") : ""}" readonly style="flex: 1; cursor: default; opacity: 0.8;">
          <button class="oh-btn oh-btn-ghost" id="oh-modal-pick-path" style="border: 1px solid var(--border-default); white-space: nowrap; background: var(--bg-surface, #1e1e1e); color: var(--text-primary, #ececec); font-weight: 500;">${t("choose")}</button>
        </div>
      </div>
      <div class="oh-modal-field oh-modal-field-grow">
        <label for="oh-modal-instr-input">${t("instructions")}</label>
        <textarea id="oh-modal-instr-input" placeholder="${t("instrPlaceholder")}" maxlength="8000">${editing ? escapeHtml(editing.instructions) : ""}</textarea>
      </div>
      <div class="oh-modal-footer">
        <div style="flex:1"></div>
        <button class="oh-btn oh-btn-ghost" id="oh-modal-cancel">${t("cancel")}</button>
        <button class="oh-btn oh-btn-primary" id="oh-modal-save">${isEdit ? t("save") : t("create")}</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var nameInput = modal.querySelector("#oh-modal-name-input");
    var instrInput = modal.querySelector("#oh-modal-instr-input");
    var pathInput = modal.querySelector("#oh-modal-path-input");
    var pickBtn = modal.querySelector("#oh-modal-pick-path");
    var colorRow = modal.querySelector("#oh-modal-color-row");
    var selectedColor = editing ? editing.color : COLORS[0];
    var selectedPath = editing ? editing.path : "";

    pickBtn.onmouseover = function () {
      pickBtn.style.background = "var(--bg-elevated, #282828)";
    };
    pickBtn.onmouseout = function () {
      pickBtn.style.background = "var(--bg-surface, #1e1e1e)";
    };

    pickBtn.onclick = function () {
      if (window.openaxis.pickProjectPath) {
        window.openaxis.pickProjectPath().then(function (p) {
          if (p) {
            selectedPath = p;
            pathInput.value = p;
          }
        });
      }
    };

    COLORS.forEach(function (c) {
      var swatch = document.createElement("button");
      swatch.className =
        "oh-color-swatch" + (c === selectedColor ? " oh-color-selected" : "");
      swatch.style.background = c;
      swatch.onclick = function () {
        selectedColor = c;
        colorRow.querySelectorAll(".oh-color-swatch").forEach(function (s) {
          s.classList.toggle(
            "oh-color-selected",
            s.style.background === c || s.style.backgroundColor === c,
          );
        });
      };
      colorRow.appendChild(swatch);
    });

    modal.querySelector(".oh-modal-close").onclick = closeModal;
    modal.querySelector("#oh-modal-cancel").onclick = closeModal;
    nameInput.addEventListener("input", function () {
      nameInput.style.borderColor = "";
    });
    var saveBtn = modal.querySelector("#oh-modal-save");
    saveBtn.onclick = function () {
      if (saveBtn.disabled) return;
      var name = nameInput.value.trim();
      if (!name) {
        nameInput.style.borderColor = "#ef4444";
        nameInput.focus();
        return;
      }
      var data = {
        name: name,
        instructions: instrInput.value,
        color: selectedColor,
        path: selectedPath,
      };
      if (isEdit) data.id = editing.id;
      saveBtn.disabled = true;
      hub
        .saveProject(data)
        .then(function () {
          closeModal();
          if (window.__OH_REFRESH_HUB) window.__OH_REFRESH_HUB();
        })
        .catch(function (err) {
          saveBtn.disabled = false;
          alert(t("saveError", { err: err && err.message ? err.message : "?" }));
        });
    };

    nameInput.focus();
  }

  window.__OH_OPEN_MODAL = function (project) {
    renderModal(project);
  };

  // ── Injection Logic ──────────────────────────────────────────

  function injectProjectsButton() {
    if (document.getElementById("oh-simple-projects-btn")) return true;
    var footer = document.querySelector('[data-slot="sidebar-footer"]');
    var targetParent = null;
    var insertBeforeNode = null;

    if (footer) {
      targetParent = footer.parentNode;
      insertBeforeNode = footer;
    } else {
      var allElements = document.querySelectorAll("button, div, span");
      for (var i = 0; i < allElements.length; i++) {
        if (allElements[i].textContent.includes("Add workspace")) {
          var container =
            allElements[i].closest('div[class*="footer"]') ||
            allElements[i].parentElement;
          if (container && container.parentNode) {
            targetParent = container.parentNode;
            insertBeforeNode = container;
            break;
          }
        }
      }
    }

    if (!targetParent) return false;

    var btn = document.createElement("button");
    btn.id = "oh-simple-projects-btn";
    btn.className = "oh-sidebar-simple-btn";
    btn.innerHTML = getFolderIcon() + "<span>" + t("projects") + "</span>";

    btn.onclick = function (e) {
      e.preventDefault();
      if (window.__OH_SHOW_HUB) window.__OH_SHOW_HUB();
    };

    ["oh-work-project-container", "oh-work-nav-group", "oh-project-selector"].forEach(
      function (id) {
        var old = document.getElementById(id);
        if (old) old.remove();
      },
    );

    if (insertBeforeNode) targetParent.insertBefore(btn, insertBeforeNode);
    else targetParent.appendChild(btn);

    return true;
  }

  function ensureInjected() {
    if (!document.getElementById("oh-simple-projects-btn")) {
      injectProjectsButton();
    }
  }

  // Coalescer les rafales de mutations en un seul appel par frame : le body
  // peut muter très fréquemment pendant les re-renders, inutile de relancer
  // ensureInjected() à chaque mutation individuelle.
  var rafScheduled = false;
  var observer = new MutationObserver(function () {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(function () {
      rafScheduled = false;
      ensureInjected();
    });
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    ensureInjected();
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      observer.observe(document.body, { childList: true, subtree: true });
      ensureInjected();
    });
  }

  if (hub && hub.onLanguageChanged) {
    hub.onLanguageChanged(function (newLang) {
      lang = newLang === "en" ? "en" : "fr";
      var btn = document.getElementById("oh-simple-projects-btn");
      if (btn) {
        var span = btn.querySelector("span");
        if (span) span.textContent = t("projects");
      }
    });
  }
})();
