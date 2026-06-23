(function () {
  "use strict";
  if (window.__OH_PROJECTS_HUB_V2_REDESIGN__) return;
  window.__OH_PROJECTS_HUB_V2_REDESIGN__ = true;

  const hub = window.openaxis;
  if (!hub) return;

  let selectMode = false;
  const selectedIds = new Set();
  let cachedProjects = [];
  let cachedConversations = [];
  let hubFolders = [];
  let hubFolderOpen = {};
  let hubSearchQuery = "";
  let hubSort = "recent";
  let hubFilter = "all";
  let hubGenOpen = false;
  let hubArchivedOpen = false;

  let hubCtxTarget = null;

  // ── Inline i18n ──
  let lang = (hub && hub.language) || "fr";
  const DICT = {
    fr: {
      projects: "Projets",
      select: "Sélectionner",
      newProject: "Nouveau",
      close: "Fermer",
      nSelected: "{n} sélectionné",
      nSelectedPlural: "{n} sélectionnés",
      cancel: "Annuler",
      deleteN: "Supprimer ({n})",
      back: "← Retour",
      newChat: "Nouveau chat",
      conversations: "Conversations",
      deleteProject: "Supprimer",
      deleteProjectLabel:
        "Supprimer définitivement ce projet et toutes ses conversations dans OpenWork.",
      instructions: "Instructions personnalisées",
      instructionsAria: "Instructions du projet",
      save: "Enregistrer",
      files: "Fichiers du projet",
      filesHint: "Explorez ou ajoutez des fichiers pour ce projet.",
      confirmDeleteN: "Supprimer {n} projet définitivement ?",
      confirmDeleteNPlural: "Supprimer {n} projets définitivement ?",
      instructionsSaved: "Instructions enregistrées",
      saveError: "Échec de l'enregistrement : {err}",
      type: "Type : {v}",
      lastModified: "Dernière modif : {v}",
      noProjects: "Aucun projet trouvé.",
      noPersonal: "Aucun projet personnel.",
      detailChatHint: "Utilisez le bouton Nouveau Chat pour démarrer dans ce contexte.",
      unlinkFolder: "Dissocier le dossier",
      loading: "Chargement...",
      confirmUnlink:
        "Voulez-vous dissocier ce dossier du projet ? (Les fichiers ne seront pas supprimés du disque)",
      noFiles: "Aucun fichier trouvé dans le dossier lié.",
      filesError: "Erreur lors du chargement des fichiers.",
      confirmDeleteFile: 'Supprimer définitivement le fichier "{name}" ?',
      confirmDeleteDir: 'Supprimer définitivement le dossier "{name}" ?',
      deleteError: "Erreur lors de la suppression : {err}",
      noFolder: "Aucun dossier lié à ce projet.",
      linkFolder: "Lier un dossier maintenant",
      orchestrator: "orchestrateur",
      projet: "projet",
      confirmDeleteProject: 'Supprimer définitivement le projet "{name}" ?',
      searchPlaceholder: "Rechercher...",
      sortRecent: "Récents",
      sortAZ: "A → Z",
      sortType: "Type",
      noChats: "Aucun chat lié à ce projet.",
      sectionPinned: "Épinglés",
      sectionFolders: "Dossiers",
      sectionAll: "Tous les projets",
      sectionArchived: "Archivés",
      sectionGenerated: "Projets de l'orchestrateur",
      ctxOpen: "Ouvrir",
      ctxRename: "Renommer",
      ctxPin: "Épingler",
      ctxUnpin: "Désépingler",
      ctxMoveTo: "Déplacer vers",
      ctxRemoveFolder: "Retirer du dossier",
      ctxNewFolder: "Nouveau dossier...",
      ctxArchive: "Archiver",
      ctxUnarchive: "Désarchiver",
      ctxDuplicate: "Dupliquer",
      ctxDelete: "Supprimer",
      promptRename: "Nouveau nom du projet :",
      promptNewFolder: "Nom du nouveau dossier :",
      toastProjectRenamed: "Projet renommé",
      toastProjectPinned: "Projet épinglé",
      toastProjectUnpinned: "Projet désépinglé",
      toastProjectArchived: "Projet archivé",
      toastProjectUnarchived: "Projet désarchivé",
      toastProjectDuplicated: "Projet dupliqué",
      toastProjectDeleted: "Projet supprimé",
      toastMovedTo: "Déplacé dans le dossier {name}",
      toastRemovedFromFolder: "Retiré du dossier",
      copySuffix: " (Copie)",
    },
    en: {
      projects: "Projects",
      select: "Select",
      newProject: "New",
      close: "Close",
      nSelected: "{n} selected",
      nSelectedPlural: "{n} selected",
      cancel: "Cancel",
      deleteN: "Delete ({n})",
      back: "← Back",
      newChat: "New chat",
      conversations: "Conversations",
      deleteProject: "Delete",
      deleteProjectLabel:
        "Permanently delete this project and all its conversations in OpenWork.",
      instructions: "Custom instructions",
      instructionsAria: "Project instructions",
      save: "Save",
      files: "Project files",
      filesHint: "Explore or add files for this project.",
      confirmDeleteN: "Permanently delete {n} project?",
      confirmDeleteNPlural: "Permanently delete {n} projects?",
      instructionsSaved: "Instructions saved",
      saveError: "Failed to save: {err}",
      type: "Type: {v}",
      lastModified: "Last modified: {v}",
      noProjects: "No projects found.",
      noPersonal: "No personal projects.",
      detailChatHint: "Use the New Chat button to start in this context.",
      unlinkFolder: "Unlink folder",
      loading: "Loading...",
      confirmUnlink:
        "Unlink this folder from the project? (Files will not be deleted from disk)",
      noFiles: "No files found in the linked folder.",
      filesError: "Error loading files.",
      confirmDeleteFile: 'Permanently delete file "{name}"?',
      confirmDeleteDir: 'Permanently delete folder "{name}"?',
      deleteError: "Delete error: {err}",
      noFolder: "No folder linked to this project.",
      linkFolder: "Link a folder now",
      orchestrator: "orchestrator",
      projet: "project",
      confirmDeleteProject: 'Permanently delete project "{name}"?',
      searchPlaceholder: "Search...",
      sortRecent: "Recent",
      sortAZ: "A → Z",
      sortType: "Type",
      noChats: "No chats linked to this project.",
      sectionPinned: "Pinned",
      sectionFolders: "Folders",
      sectionAll: "All projects",
      sectionArchived: "Archived",
      sectionGenerated: "Orchestrator Projects",
      ctxOpen: "Open",
      ctxRename: "Rename",
      ctxPin: "Pin",
      ctxUnpin: "Unpin",
      ctxMoveTo: "Move to",
      ctxRemoveFolder: "Remove from folder",
      ctxNewFolder: "New folder...",
      ctxArchive: "Archive",
      ctxUnarchive: "Unarchive",
      ctxDuplicate: "Duplicate",
      ctxDelete: "Delete",
      promptRename: "New project name:",
      promptNewFolder: "New folder name:",
      toastProjectRenamed: "Project renamed",
      toastProjectPinned: "Project pinned",
      toastProjectUnpinned: "Project unpinned",
      toastProjectArchived: "Project archived",
      toastProjectUnarchived: "Project unarchived",
      toastProjectDuplicated: "Project duplicated",
      toastProjectDeleted: "Project deleted",
      toastMovedTo: "Moved to folder {name}",
      toastRemovedFromFolder: "Removed from folder",
      copySuffix: " (Copy)",
    },
  };

  function t(key, vars) {
    let str = (DICT[lang] || DICT.fr)[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        str = str.replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
      });
    }
    return str;
  }

  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function isOrchestratorProject(p) {
    return (
      p.generated === true ||
      (typeof p.type === "string" && p.type.length > 0) ||
      typeof p.x === "number"
    );
  }

  // ── Toast UI ──
  function showToast(msg, type = "success") {
    let wrap = document.getElementById("oh-toast-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "oh-toast-wrap";
      wrap.className = "oh-toast-wrap";
      document.body.appendChild(wrap);
    }
    const toast = document.createElement("div");
    toast.className = `oh-toast oh-toast-${type}`;
    toast.textContent = msg;
    wrap.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("oh-toast-out");
      setTimeout(() => toast.remove(), 250);
    }, 3000);
  }

  // ── HTML Overlay Structure ──
  const overlay = document.createElement("div");
  overlay.id = "oh-projects-hub-overlay";
  overlay.innerHTML = `
    <div class="projects-hub-toprow">
      <h2 class="projects-hub-heading">${t("projects")}</h2>
      <div class="projects-hub-actions" id="oh-hub-default-actions">
        <div class="projects-hub-search" role="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input type="text" id="projectSearchInput" placeholder="${t("searchPlaceholder")}" aria-label="Rechercher un projet" />
          <span class="hub-search-kbd" aria-hidden="true">&#8984;K</span>
        </div>
        <select class="projects-hub-sort" id="hubSortSelect" aria-label="Trier les projets">
          <option value="recent">${t("sortRecent")}</option>
          <option value="az">${t("sortAZ")}</option>
          <option value="type">${t("sortType")}</option>
        </select>
        <button class="hub-btn-ghost" id="oh-select-mode-btn">${t("select")}</button>
        <button class="projects-hub-btn-new" id="oh-new-project" aria-label="Créer un nouveau projet">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 15px; height: 15px" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>${t("newProject")}</span>
        </button>
        <button class="btn-icon" id="oh-close-hub" aria-label="Fermer le gestionnaire de projets">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 18px; height: 18px" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div class="hub-select-bar" id="oh-hub-select-actions">
        <span class="hub-select-count" id="oh-select-count">0 sélectionné</span>
        <button class="hub-btn-ghost" id="oh-cancel-select">${t("cancel")}</button>
        <button class="hub-btn-danger" id="oh-delete-selected-btn">Supprimer (0)</button>
      </div>
    </div>
    <div class="projects-hub-filters" id="hubFilters" role="radiogroup" aria-label="Filtrer par type"></div>
    <div class="projects-hub-scroll" id="projectsHubScroll">
      <div id="hubPinnedSection" role="region" aria-label="Projets épinglés"></div>
      <div id="hubFoldersSection" role="region" aria-label="Dossiers"></div>
      <div id="hubAllSection" role="region" aria-label="Tous les projets"></div>
      <div id="hubArchivedSection" role="region" aria-label="Projets archivés"></div>
      <div id="hubGeneratedSection" role="region" aria-label="Projets de l'orchestrateur"></div>
    </div>
    <div class="hub-ctx-menu" id="hubCtxMenu" role="menu" aria-label="Actions du projet"></div>
  `;

  const detailView = document.createElement("div");
  detailView.id = "oh-project-detail-view";
  detailView.innerHTML = `
    <header class="project-details-header">
      <div class="project-details-title">
        <button class="btn-back" id="oh-back-to-hub">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 18px; height: 18px">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span class="project-details-title-span" id="oh-detail-name">Nom du Projet</span>
      </div>
    </header>
    <div class="project-details-body">
      <aside class="project-details-sidebar">
        <div class="project-details-sidebar-header">
          <button class="oh-btn-primary" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;" id="oh-new-chat-in-proj">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            <span>${t("newChat")}</span>
          </button>
        </div>
        <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 12px 20px 8px; font-weight: 600;">${t("conversations")}</div>
        <div class="project-conv-list" id="oh-detail-convs"></div>
      </aside>
      <main class="project-details-main">
        <div class="project-details-main-inner">
          <div class="project-context-grid">
            <div class="project-section context-panel">
              <div class="project-section-title">${t("instructions")}</div>
              <div class="project-section-desc">Définissez le rôle et le comportement de l'IA pour ce projet.</div>
              <textarea class="instructions-textarea" id="oh-detail-instructions" placeholder="Ex: Tu es un assistant spécialisé en marketing..." maxlength="8000"></textarea>
              <div style="display: flex; justify-content: flex-end">
                <button class="oh-btn-primary" id="oh-save-instructions">${t("save")}</button>
              </div>
            </div>
            <div class="project-section context-panel">
              <div class="project-section-title">${t("files")}</div>
              <div class="project-section-desc">Dossier lié au projet pour contextualiser le travail.</div>
              <div class="file-list" id="oh-detail-files">
                <!-- local files list or link button -->
              </div>
            </div>
          </div>
          <div class="project-detail-danger">
            <span class="project-detail-danger-label">${t("deleteProjectLabel")}</span>
            <button class="hub-btn-danger" id="oh-delete-project-btn">${t("deleteProject")}</button>
          </div>
        </div>
      </main>
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(detailView);

  // ── Conversations Loading ──
  async function loadConversations() {
    try {
      if (hub.readChatBackup) {
        const raw = await hub.readChatBackup();
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            cachedConversations = parsed;
          }
        }
      }
    } catch (e) {
      console.warn("Failed to load conversations:", e);
    }
  }

  // ── Select Mode Helpers ──
  function enterSelectMode() {
    selectMode = true;
    selectedIds.clear();
    document.getElementById("oh-hub-default-actions").style.display = "none";
    document.getElementById("oh-hub-select-actions").style.display = "flex";
    document.getElementById("oh-hub-select-actions").classList.add("active");
    updateSelectCount();
    renderGrid();
  }

  function exitSelectMode() {
    selectMode = false;
    selectedIds.clear();
    document.getElementById("oh-hub-default-actions").style.display = "flex";
    document.getElementById("oh-hub-select-actions").style.display = "none";
    document.getElementById("oh-hub-select-actions").classList.remove("active");
    renderGrid();
  }

  function toggleCardSelect(id) {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
    updateSelectCount();
    renderGrid();
  }

  function updateSelectCount() {
    const n = selectedIds.size;
    const countEl = document.getElementById("oh-select-count");
    const deleteBtn = document.getElementById("oh-delete-selected-btn");
    if (countEl) {
      countEl.textContent = t(n > 1 ? "nSelectedPlural" : "nSelected", { n: n });
    }
    if (deleteBtn) {
      deleteBtn.textContent = t("deleteN", { n: n });
      deleteBtn.disabled = n === 0;
    }
  }

  // ── Event Handlers ──
  document.addEventListener("click", async (e) => {
    const target = e.target;

    // Toggle context menu on left-click of three dots button
    const menuBtn = target.closest(".p-card-menu");
    if (menuBtn) {
      e.stopPropagation();
      e.preventDefault();
      const pid = menuBtn.dataset.pid;
      const p = cachedProjects.find((x) => x.id === pid);
      if (p) {
        const menu = document.getElementById("hubCtxMenu");
        if (menu && menu.style.display === "block" && hubCtxTarget === p) {
          hubHideCtxMenu();
        } else {
          hubShowCtxMenu(p, menuBtn);
        }
      }
      return;
    }

    // Selection mode
    if (target.id === "oh-select-mode-btn" || target.closest("#oh-select-mode-btn")) {
      enterSelectMode();
    }
    if (target.id === "oh-cancel-select" || target.closest("#oh-cancel-select")) {
      exitSelectMode();
    }
    if (
      target.id === "oh-delete-selected-btn" ||
      target.closest("#oh-delete-selected-btn")
    ) {
      const n = selectedIds.size;
      if (n === 0) return;
      if (!confirm(t(n > 1 ? "confirmDeleteNPlural" : "confirmDeleteN", { n: n })))
        return;
      const ids = Array.from(selectedIds);
      for (const id of ids) {
        await hub.deleteProject(id);
      }
      showToast(t("toastProjectDeleted"), "success");
      exitSelectMode();
      await refreshData();
    }

    // Detail actions
    if (target.id === "oh-back-to-hub" || target.closest("#oh-back-to-hub")) {
      detailView.classList.remove("oh-visible");
      overlay.classList.add("oh-visible");
    }
    if (target.id === "oh-close-hub" || target.closest("#oh-close-hub")) {
      overlay.classList.remove("oh-visible");
    }

    // Save instructions
    if (target.id === "oh-save-instructions" || target.closest("#oh-save-instructions")) {
      const id = detailView.dataset.projectId;
      const p = cachedProjects.find((x) => x.id === id);
      if (p) {
        const updated = {
          ...p,
          instructions: document.getElementById("oh-detail-instructions").value,
        };
        try {
          await hub.saveProject(updated);
          showToast(t("instructionsSaved"));
          await refreshData();
        } catch (err) {
          showToast(
            t("saveError", { err: err && err.message ? err.message : "?" }),
            "error",
          );
        }
      }
    }

    // New chat in project (routes back to openwork's chat domain)
    if (target.id === "oh-new-chat-in-proj" || target.closest("#oh-new-chat-in-proj")) {
      const id = detailView.dataset.projectId;
      await hub.setActiveProject(id);
      const nwBtn =
        document.querySelector('[data-testid="new-chat-button"]') ||
        document.querySelector('button[aria-label*="New Chat"]') ||
        document.querySelector('button[aria-label*="Nouveau Chat"]');
      if (nwBtn) nwBtn.click();
      detailView.classList.remove("oh-visible");
      overlay.classList.remove("oh-visible");
    }

    // New project modal
    if (target.id === "oh-new-project" || target.closest("#oh-new-project")) {
      if (window.__OH_OPEN_MODAL) {
        window.__OH_OPEN_MODAL(null);
      }
    }

    // Delete single project from details
    if (
      target.id === "oh-delete-project-btn" ||
      target.closest("#oh-delete-project-btn")
    ) {
      const id = detailView.dataset.projectId;
      const p = cachedProjects.find((x) => x.id === id);
      if (p && confirm(t("confirmDeleteProject", { name: p.name }))) {
        await hub.deleteProject(id);
        showToast(t("toastProjectDeleted"), "success");
        detailView.classList.remove("oh-visible");
        await refreshData();
      }
    }

    // Context Menu click dispatch
    const ctxItem = target.closest(".hub-ctx-item");
    if (ctxItem) {
      e.stopPropagation();
      const action = ctxItem.dataset.action;
      const extra = ctxItem.dataset.folder || "";
      if (action !== "toggle-move") {
        await hubHandleCtxAction(action, extra);
      } else {
        const sub = document.getElementById("hubCtxSubmenuMove");
        if (sub) sub.classList.toggle("open");
      }
    } else if (!target.closest(".p-card-menu") && !target.closest(".hub-ctx-menu")) {
      hubHideCtxMenu();
    }
  });

  // ── Keyboard listeners ──
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && selectMode) {
      exitSelectMode();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      const searchInput = document.getElementById("projectSearchInput");
      if (searchInput && overlay.classList.contains("oh-visible")) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    }
  });

  // Search input handler
  let hubSearchTimer = null;
  const searchInput = document.getElementById("projectSearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", function () {
      clearTimeout(hubSearchTimer);
      hubSearchTimer = setTimeout(function () {
        hubSearchQuery = searchInput.value.trim();
        renderGrid();
      }, 150);
    });
    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        searchInput.value = "";
        hubSearchQuery = "";
        renderGrid();
        searchInput.blur();
      }
    });
  }

  // Sort select handler
  const sortSelect = document.getElementById("hubSortSelect");
  if (sortSelect) {
    sortSelect.addEventListener("change", function () {
      hubSort = sortSelect.value;
      renderGrid();
    });
  }

  // ── Types and Icons ──
  const HUB_TYPE_ICONS = {
    assistant:
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    code: '<path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/>',
    design:
      '<path d="M12 2a10 10 0 0 0 0 20c.59 0 1.07-.48 1.07-1.07V17.93A1.07 1.07 0 0 1 14.14 17h3A1.07 1.07 0 0 0 18.2 16a10 10 0 0 0-6.2-14Z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="11.5" r="1"/>',
    work: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
    orchestrator:
      '<path d="m3 6 9 6 9-6"/><path d="M3 10v6l9 6 9-6v-6"/><path d="m3 10 9 6 9-6"/>',
    verifier:
      '<path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/>',
    recherche: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  };

  function hubGetProjectType(p) {
    return p.type || "assistant";
  }

  function hubTypeLabel(type) {
    const labels = {
      all: lang === "en" ? "All" : "Tous",
      assistant: lang === "en" ? "Assistant" : "Assistant",
      orchestrator: lang === "en" ? "Orchestrator" : "Orchestrateur",
      code: lang === "en" ? "Code" : "Code",
      design: lang === "en" ? "Design" : "Design",
      work: lang === "en" ? "Work" : "Work",
      recherche: lang === "en" ? "Search" : "Recherche",
      verifier: lang === "en" ? "Verifier" : "Vérificateur",
    };
    return labels[type] || type;
  }

  function hubMatchesFilter(p, filter) {
    if (filter === "all") return true;
    var t = hubGetProjectType(p);
    if (filter === "assistant") return !t || t === "assistant";
    return t === filter;
  }

  function hubMatchesSearch(p, q) {
    if (!q) return true;
    var low = q.toLowerCase();
    var name = (p.name || "").toLowerCase();
    var type = (hubTypeLabel(hubGetProjectType(p)) || "Assistant").toLowerCase();
    return name.indexOf(low) !== -1 || type.indexOf(low) !== -1;
  }

  function hubSortProjects(list, mode) {
    var sorted = list.slice();
    sorted.sort(function (a, b) {
      var aIsAssistant = hubGetProjectType(a) === "assistant" ? 0 : 1;
      var bIsAssistant = hubGetProjectType(b) === "assistant" ? 0 : 1;
      if (aIsAssistant !== bIsAssistant) return aIsAssistant - bIsAssistant;
      if (mode === "az") return (a.name || "").localeCompare(b.name || "");
      if (mode === "type") {
        var ta = hubGetProjectType(a),
          tb = hubGetProjectType(b);
        var cmp = ta.localeCompare(tb);
        return cmp !== 0 ? cmp : (b.updatedAt || 0) - (a.updatedAt || 0);
      }
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return sorted;
  }

  function hubRelativeDate(ts) {
    if (!ts) return "";
    var now = Date.now();
    var d = new Date(ts);
    var today = new Date(now);
    today.setHours(0, 0, 0, 0);
    var yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d >= today) return lang === "en" ? "Today" : "Aujourd'hui";
    if (d >= yesterday) return lang === "en" ? "Yesterday" : "Hier";
    var locale = lang === "en" ? "en-US" : "fr-FR";
    return d.toLocaleDateString(locale, { day: "numeric", month: "short" });
  }

  // ── Card Builder ──
  function hubBuildCard(p, opts) {
    opts = opts || {};
    var type = hubGetProjectType(p);
    var typeLabel = hubTypeLabel(type);
    var typeColor = p.color || "#14b8a6";
    var iconSvg = HUB_TYPE_ICONS[type] || HUB_TYPE_ICONS.recherche;
    var bgAlpha = typeColor.replace("#", "");
    var iconBg =
      "rgba(" +
      parseInt(bgAlpha.substring(0, 2), 16) +
      "," +
      parseInt(bgAlpha.substring(2, 4), 16) +
      "," +
      parseInt(bgAlpha.substring(4, 6), 16) +
      ",0.12)";
    var chatCount = cachedConversations.filter((c) => c.projectId === p.id).length;
    var dateStr = hubRelativeDate(p.updatedAt);
    var isSelected = selectedIds.has(p.id);

    var card = document.createElement("div");
    card.className =
      "p-card" +
      (p.pinned ? " p-card-pinned" : "") +
      (opts.muted ? " p-card-muted" : "") +
      (isSelected ? " p-card-selected" : "");
    card.tabIndex = 0;
    card.dataset.projectId = p.id;
    card.id = "oh-card-" + p.id;

    if (selectMode) {
      card.setAttribute("role", "checkbox");
      card.setAttribute("aria-checked", isSelected ? "true" : "false");
    } else {
      card.setAttribute("role", "button");
    }

    var checkboxHtml = selectMode
      ? '<div class="p-card-checkbox' +
        (isSelected ? " checked" : "") +
        '" aria-hidden="true">' +
        (isSelected
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
          : "") +
        "</div>"
      : "";

    if (opts.muted) {
      card.innerHTML =
        checkboxHtml +
        '<div class="p-card-body" style="margin-top:0;">' +
        '<div class="p-card-name" style="color:var(--text-secondary);">' +
        escapeHtml(p.name) +
        "</div>" +
        '<div class="p-card-meta"><span class="p-card-date">' +
        dateStr +
        "</span></div>" +
        "</div>";
    } else {
      card.innerHTML =
        checkboxHtml +
        '<div class="p-card-top">' +
        '<div class="p-card-icon" style="background:' +
        iconBg +
        ";color:" +
        typeColor +
        ';" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        iconSvg +
        "</svg>" +
        "</div>" +
        (!selectMode
          ? '<button class="p-card-menu" aria-label="Menu" aria-haspopup="menu" data-pid="' +
            p.id +
            '">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>' +
            "</button>"
          : "") +
        "</div>" +
        '<div class="p-card-body">' +
        '<div class="p-card-name">' +
        escapeHtml(p.name) +
        "</div>" +
        '<div class="p-card-meta">' +
        '<span class="p-card-type" style="color:var(--text-secondary);">' +
        typeLabel +
        "</span>" +
        '<span class="p-card-date">' +
        dateStr +
        "</span>" +
        (chatCount > 0
          ? '<span class="p-card-chats"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><span>' +
            chatCount +
            "</span></span>"
          : "") +
        "</div>" +
        "</div>";
    }

    card.addEventListener("click", function (e) {
      if (e.target.closest(".p-card-menu")) return;
      if (selectMode) {
        toggleCardSelect(p.id);
      } else {
        showDetail(p);
      }
    });

    card.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
      hubShowCtxMenu(p, card);
    });

    return card;
  }

  // ── Context Menu Actions ──
  function hubShowCtxMenu(project, anchorEl) {
    let menu = document.getElementById("hubCtxMenu");
    if (!menu) return;
    hubCtxTarget = project;

    const isPinned = project.pinned;
    const isArchived = project.archived;

    let folderItems = "";
    hubFolders.forEach(function (f) {
      var active = project.folder === f.name;
      folderItems +=
        '<button class="hub-ctx-item' +
        (active ? " hub-ctx-item-active" : "") +
        '" data-action="move-folder" data-folder="' +
        escapeHtml(f.name) +
        '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h16a2 2 0 002-2V8a2 2 0 00-2-2h-7.93a2 2 0 01-1.66-.9l-.82-1.2A2 2 0 007.93 3H4a2 2 0 00-2 2v13c0 1.1.9 2 2 2Z"/></svg>' +
        escapeHtml(f.name) +
        (active ? " ✓" : "") +
        "</button>";
    });
    if (project.folder) {
      folderItems +=
        '<button class="hub-ctx-item" data-action="remove-folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3h6l-.75 3h-4.5z"/><path d="M4 6h16"/><path d="M6 6v12a2 2 0 002 2h8a2 2 0 002-2V6"/></svg>' +
        t("ctxRemoveFolder") +
        "</button>";
    }
    folderItems +=
      '<div class="hub-ctx-sep"></div>' +
      '<button class="hub-ctx-item" data-action="new-folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>' +
      t("ctxNewFolder") +
      "</button>";

    menu.innerHTML =
      '<button class="hub-ctx-item" data-action="open"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
      t("ctxOpen") +
      "</button>" +
      '<button class="hub-ctx-item" data-action="rename"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4Z"/></svg>' +
      t("ctxRename") +
      "</button>" +
      '<button class="hub-ctx-item" data-action="pin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 2h6l-1.5 5h-3z"/><path d="M6.5 7h11l-1 5H7.5z"/></svg>' +
      (isPinned ? t("ctxUnpin") : t("ctxPin")) +
      "</button>" +
      '<div class="hub-ctx-sep"></div>' +
      '<div class="hub-ctx-sub"><button class="hub-ctx-item" data-action="toggle-move"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h16a2 2 0 002-2V8a2 2 0 00-2-2h-7.93a2 2 0 01-1.66-.9l-.82-1.2A2 2 0 007.93 3H4a2 2 0 00-2 2v13c0 1.1.9 2 2 2Z"/></svg>' +
      t("ctxMoveTo") +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;margin-left:auto;"><polyline points="9 6 15 12 9 18"/></svg></button>' +
      '<div class="hub-ctx-submenu" id="hubCtxSubmenuMove">' +
      folderItems +
      "</div></div>" +
      '<button class="hub-ctx-item" data-action="archive"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8"/><path d="M10 12h4"/></svg>' +
      (isArchived ? t("ctxUnarchive") : t("ctxArchive")) +
      "</button>" +
      '<button class="hub-ctx-item" data-action="duplicate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>' +
      t("ctxDuplicate") +
      "</button>" +
      '<div class="hub-ctx-sep"></div>' +
      '<button class="hub-ctx-item hub-ctx-item-danger" data-action="delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>' +
      t("ctxDelete") +
      "</button>";

    const rect = anchorEl.getBoundingClientRect();
    const hubEl = document.getElementById("oh-projects-hub-overlay");
    const hubRect = hubEl
      ? hubEl.getBoundingClientRect()
      : { left: 0, top: 0, width: 800 };
    const left = Math.min(rect.left - hubRect.left, hubRect.width - 180);
    const top = rect.bottom - hubRect.top + 4;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.display = "block";
  }

  function hubHideCtxMenu() {
    const menu = document.getElementById("hubCtxMenu");
    if (menu) menu.style.display = "none";
    hubCtxTarget = null;
  }

  async function hubHandleCtxAction(action, extraValue) {
    const p = hubCtxTarget;
    hubHideCtxMenu();
    if (!p) return;

    if (action === "open") {
      showDetail(p);
    } else if (action === "rename") {
      const newName = prompt(t("promptRename"), p.name);
      if (newName && newName.trim()) {
        await hub.saveProject({ id: p.id, name: newName.trim() });
        showToast(t("toastProjectRenamed"), "success");
        await refreshData();
      }
    } else if (action === "pin") {
      const wasPinned = p.pinned;
      await hub.saveProject({ id: p.id, name: p.name, pinned: !wasPinned });
      showToast(
        wasPinned ? t("toastProjectUnpinned") : t("toastProjectPinned"),
        "success",
      );
      await refreshData();
    } else if (action === "duplicate") {
      await hub.saveProject({
        name: p.name + t("copySuffix"),
        instructions: p.instructions || "",
        color: p.color || "",
        type: p.type,
      });
      showToast(t("toastProjectDuplicated"), "success");
      await refreshData();
    } else if (action === "archive") {
      const wasArchived = p.archived;
      await hub.saveProject({
        id: p.id,
        name: p.name,
        archived: !wasArchived,
        pinned: wasArchived ? p.pinned : false,
      });
      showToast(
        wasArchived ? t("toastProjectUnarchived") : t("toastProjectArchived"),
        "success",
      );
      await refreshData();
    } else if (action === "move-folder") {
      await hub.saveProject({ id: p.id, name: p.name, folder: extraValue });
      showToast(t("toastMovedTo", { name: extraValue }), "success");
      await refreshData();
    } else if (action === "remove-folder") {
      await hub.saveProject({ id: p.id, name: p.name, folder: "" });
      showToast(t("toastRemovedFromFolder"), "success");
      await refreshData();
    } else if (action === "new-folder") {
      const folderName = prompt(t("promptNewFolder"));
      if (folderName && folderName.trim()) {
        await hub.createFolder(folderName.trim());
        await hub.saveProject({
          id: p.id,
          name: p.name,
          folder: folderName.trim(),
        });
        showToast(t("toastMovedTo", { name: folderName.trim() }), "success");
        await refreshData();
      }
    } else if (action === "delete") {
      if (confirm(t("confirmDeleteProject", { name: p.name }))) {
        await hub.deleteProject(p.id);
        showToast(t("toastProjectDeleted"), "success");
        await refreshData();
      }
    }
  }

  // ── Folders Section Builder ──
  function renderFoldersSection(foldersEl, folders) {
    foldersEl.innerHTML = "";
    const folderNames = Object.keys(folders).sort();
    folderNames.forEach(function (fname) {
      const section = document.createElement("div");
      section.style.marginBottom = "20px";
      const isOpen = hubFolderOpen[fname] !== false;

      const toggle = document.createElement("div");
      toggle.className = "hub-section-toggle";
      toggle.tabIndex = 0;
      toggle.setAttribute("role", "button");
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");

      toggle.innerHTML =
        '<svg class="hub-section-chevron" style="transform:rotate(' +
        (isOpen ? "0" : "-90") +
        'deg)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>' +
        '<svg class="hub-section-icon" style="color:var(--accent-primary);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h16a2 2 0 002-2V8a2 2 0 00-2-2h-7.93a2 2 0 01-1.66-.9l-.82-1.2A2 2 0 007.93 3H4a2 2 0 00-2 2v13c0 1.1.9 2 2 2Z"/></svg>' +
        '<span class="hub-section-label">' +
        escapeHtml(fname) +
        "</span>" +
        '<span class="hub-section-count">' +
        folders[fname].length +
        "</span>" +
        '<span class="hub-folder-actions">' +
        '<button class="hub-folder-btn" data-folder-action="rename" title="' +
        (lang === "en" ? "Rename Folder" : "Renommer le dossier") +
        '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4Z"/></svg></button>' +
        '<button class="hub-folder-btn hub-folder-btn-danger" data-folder-action="delete" title="' +
        (lang === "en" ? "Delete Folder" : "Supprimer le dossier") +
        '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>' +
        "</span>";

      toggle.addEventListener("click", function (e) {
        const btn = e.target.closest(".hub-folder-btn");
        if (btn) {
          e.stopPropagation();
          const action = btn.dataset.folderAction;
          handleFolderAction(action, fname);
          return;
        }
        hubFolderOpen[fname] = !isOpen;
        renderGrid();
      });

      section.appendChild(toggle);

      if (isOpen) {
        const grid = document.createElement("div");
        grid.className = "projects-grid";
        folders[fname].forEach(function (p) {
          grid.appendChild(hubBuildCard(p));
        });
        section.appendChild(grid);
      }

      foldersEl.appendChild(section);
    });
  }

  async function handleFolderAction(action, fname) {
    if (action === "rename") {
      const newName = prompt(
        lang === "en" ? "New folder name:" : "Nouveau nom du dossier :",
        fname,
      );
      if (newName && newName.trim() && newName.trim() !== fname) {
        const folder = hubFolders.find((f) => f.name === fname);
        if (folder) {
          await hub.renameFolder(folder.id, newName.trim());
          const affected = cachedProjects.filter((p) => p.folder === fname);
          for (const p of affected) {
            await hub.saveProject({ ...p, folder: newName.trim() });
          }
          showToast(lang === "en" ? "Folder renamed" : "Dossier renommé");
          await refreshData();
        }
      }
    } else if (action === "delete") {
      if (
        confirm(
          lang === "en"
            ? `Delete folder "${fname}"? Projects inside will be moved out.`
            : `Supprimer le dossier "${fname}" ? Les projets à l'intérieur seront sortis.`,
        )
      ) {
        const folder = hubFolders.find((f) => f.name === fname);
        if (folder) {
          await hub.deleteFolder(folder.id);
          const affected = cachedProjects.filter((p) => p.folder === fname);
          for (const p of affected) {
            await hub.saveProject({ ...p, folder: "" });
          }
          showToast(lang === "en" ? "Folder deleted" : "Dossier supprimé");
          await refreshData();
        }
      }
    }
  }

  // ── Render Sections ──
  function hubRenderSection(container, label, iconSvg, projects, opts) {
    opts = opts || {};
    container.innerHTML = "";
    if (projects.length === 0 && !opts.showEmpty) {
      container.style.display = "none";
      return;
    }
    container.style.display = "block";

    const header = document.createElement("div");
    header.className = "hub-section-header";
    header.innerHTML =
      (iconSvg
        ? '<svg class="hub-section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          iconSvg +
          "</svg>"
        : "") +
      '<span class="hub-section-label">' +
      label +
      "</span>" +
      '<span class="hub-section-count">' +
      projects.length +
      "</span>";
    container.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "projects-grid";
    projects.forEach(function (p) {
      grid.appendChild(hubBuildCard(p, { muted: opts.muted }));
    });
    container.appendChild(grid);
    container.style.marginBottom = "20px";
  }

  // ── Filter Chips ──
  function hubRenderFilters() {
    const bar = document.getElementById("hubFilters");
    if (!bar) return;
    bar.innerHTML = "";
    hubFilterTypes().forEach(function (f) {
      const btn = document.createElement("button");
      btn.className = "hub-chip" + (hubFilter === f.key ? " hub-chip-active" : "");
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", hubFilter === f.key ? "true" : "false");

      btn.innerHTML = f.label;
      btn.addEventListener("click", function () {
        hubFilter = f.key;
        hubRenderFilters();
        renderGrid();
      });
      bar.appendChild(btn);
    });
  }

  function hubFilterTypes() {
    return [
      { key: "all", label: lang === "en" ? "All" : "Tous" },
      {
        key: "assistant",
        label: lang === "en" ? "Assistant" : "Assistant",
        dot: "#85B7EB",
      },
      {
        key: "orchestrator",
        label: lang === "en" ? "Orchestrator" : "Orchestrateur",
        dot: "#5DCAA5",
      },
      { key: "code", label: lang === "en" ? "Code" : "Code", dot: "#97C459" },
      { key: "design", label: lang === "en" ? "Design" : "Design", dot: "#ED93B1" },
      { key: "work", label: lang === "en" ? "Work" : "Work", dot: "#F0997B" },
      { key: "recherche", label: lang === "en" ? "Search" : "Recherche", dot: "#AFA9EC" },
      {
        key: "verifier",
        label: lang === "en" ? "Verifier" : "Vérificateur",
        dot: "#FAC775",
      },
    ];
  }

  // ── Render Content ──
  function renderGrid() {
    const all = cachedProjects || [];

    const filtered = all.filter(function (p) {
      return hubMatchesFilter(p, hubFilter) && hubMatchesSearch(p, hubSearchQuery);
    });
    const archived = filtered.filter(function (p) {
      return p.archived;
    });
    const active = filtered.filter(function (p) {
      return !p.archived;
    });
    const generated = active.filter(isOrchestratorProject);
    const userProjects = active.filter(function (p) {
      return !isOrchestratorProject(p);
    });

    const sorted = hubSortProjects(userProjects, hubSort);
    const pinned = sorted.filter(function (p) {
      return p.pinned;
    });
    const unpinned = sorted.filter(function (p) {
      return !p.pinned;
    });

    const folders = {};
    unpinned.forEach(function (p) {
      if (p.folder) {
        if (!folders[p.folder]) folders[p.folder] = [];
        folders[p.folder].push(p);
      }
    });

    const noFolder = unpinned.filter(function (p) {
      return !p.folder;
    });

    // Pinned
    const pinnedEl = document.getElementById("hubPinnedSection");
    if (pinnedEl) {
      hubRenderSection(
        pinnedEl,
        t("sectionPinned"),
        '<path d="M12 17v5"/><path d="M9 2h6l-1.5 5h-3z"/><path d="M6.5 7h11l-1 5H7.5z"/>',
        pinned,
      );
    }

    // Folders
    const foldersEl = document.getElementById("hubFoldersSection");
    if (foldersEl) {
      renderFoldersSection(foldersEl, folders);
    }

    // All (No folder)
    const allEl = document.getElementById("hubAllSection");
    if (allEl) {
      hubRenderSection(allEl, t("sectionAll"), null, noFolder);
    }

    // Archived
    const archivedEl = document.getElementById("hubArchivedSection");
    if (archivedEl) {
      archivedEl.innerHTML = "";
      if (archived.length > 0) {
        const wrap = document.createElement("div");
        wrap.className = "hub-gen-separator";

        const toggle = document.createElement("div");
        toggle.className = "hub-section-toggle";
        toggle.tabIndex = 0;
        toggle.setAttribute("role", "button");
        toggle.setAttribute("aria-expanded", hubArchivedOpen ? "true" : "false");
        toggle.setAttribute("aria-label", t("sectionArchived"));
        toggle.innerHTML =
          `<svg class="hub-section-chevron" style="transform:rotate(${hubArchivedOpen ? "0" : "-90"}deg)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>` +
          `<svg class="hub-section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8"/><path d="M10 12h4"/></svg>` +
          `<span class="hub-section-label">${t("sectionArchived")}</span>` +
          `<span class="hub-section-count">${archived.length}</span>`;
        toggle.addEventListener("click", function () {
          hubArchivedOpen = !hubArchivedOpen;
          renderGrid();
        });
        toggle.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            hubArchivedOpen = !hubArchivedOpen;
            renderGrid();
          }
        });
        wrap.appendChild(toggle);

        if (hubArchivedOpen) {
          const grid = document.createElement("div");
          grid.className = "projects-grid";
          archived.forEach(function (p) {
            grid.appendChild(hubBuildCard(p, { muted: true }));
          });
          wrap.appendChild(grid);
        }
        archivedEl.appendChild(wrap);
      }
    }

    // Generated/Orchestrator
    const genEl = document.getElementById("hubGeneratedSection");
    if (genEl) {
      genEl.innerHTML = "";
      if (generated.length > 0) {
        const wrap = document.createElement("div");
        wrap.className = "hub-gen-separator";

        const toggle = document.createElement("div");
        toggle.className = "hub-section-toggle";
        toggle.tabIndex = 0;
        toggle.setAttribute("role", "button");
        toggle.setAttribute("aria-expanded", hubGenOpen ? "true" : "false");
        toggle.setAttribute("aria-label", t("sectionGenerated"));
        toggle.innerHTML =
          `<svg class="hub-section-chevron" style="transform:rotate(${hubGenOpen ? "0" : "-90"}deg)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>` +
          `<svg class="hub-section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="m2 14 6-6 6 6"/></svg>` +
          `<span class="hub-section-label">${t("sectionGenerated")}</span>` +
          `<span class="hub-section-count">${generated.length}</span>`;
        toggle.addEventListener("click", function () {
          hubGenOpen = !hubGenOpen;
          renderGrid();
        });
        toggle.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            hubGenOpen = !hubGenOpen;
            renderGrid();
          }
        });
        wrap.appendChild(toggle);

        if (hubGenOpen) {
          const grid = document.createElement("div");
          grid.className = "projects-grid";
          generated.forEach(function (p) {
            grid.appendChild(hubBuildCard(p, { muted: true }));
          });
          wrap.appendChild(grid);
        }
        genEl.appendChild(wrap);
      }
    }
  }

  // ── Show Details View ──
  async function showDetail(project) {
    detailView.dataset.projectId = project.id;
    document.getElementById("oh-detail-name").textContent = project.name;
    document.getElementById("oh-detail-instructions").value = project.instructions || "";

    // Load Chat conversations in details sidebar
    const convList = document.getElementById("oh-detail-convs");
    convList.innerHTML = "";

    const filteredConvs = cachedConversations.filter((c) => c.projectId === project.id);
    if (filteredConvs.length === 0) {
      convList.innerHTML = `<div style="padding:20px; text-align:center; color:var(--text-muted); font-size:12px;">${t("noChats")}</div>`;
    } else {
      filteredConvs.forEach((c) => {
        const item = document.createElement("div");
        item.className = "conv-item";
        item.textContent =
          c.title || (lang === "en" ? "Untitled chat" : "Chat sans titre");
        item.onclick = async () => {
          await hub.setActiveProject(project.id);
          await hub.switchSlot("chat");
        };
        convList.appendChild(item);
      });
    }

    // Local project files explore panel
    const filePanel = document.getElementById("oh-detail-files");
    if (project.path) {
      filePanel.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <div style="font-weight: 500; font-size: 13px; color: var(--text-secondary);">${escapeHtml(project.path)}</div>
          <button class="oh-btn oh-btn-ghost" id="oh-unlink-folder" style="font-size: 11px; padding: 4px 8px; border: 1px solid var(--border-default);">${t("unlinkFolder")}</button>
        </div>
        <div id="oh-file-list-container"><div style="text-align: center; padding: 20px; color: var(--text-muted);">${t("loading")}</div></div>
      `;

      const listContainer = filePanel.querySelector("#oh-file-list-container");

      filePanel.querySelector("#oh-unlink-folder").onclick = async () => {
        if (confirm(t("confirmUnlink"))) {
          const updated = { ...project, path: "" };
          await hub.saveProject(updated);
          showDetail(updated);
          if (window.__OH_REFRESH_HUB) window.__OH_REFRESH_HUB();
        }
      };

      try {
        const files = await hub.getProjectFiles(project.id);
        if (files && files.length > 0) {
          listContainer.innerHTML = "";
          const list = document.createElement("div");
          list.className = "file-list";

          files.forEach((f) => {
            const item = document.createElement("div");
            item.className = "file-item";

            const infoDiv = document.createElement("div");
            infoDiv.style.cssText =
              "display:flex; align-items:center; gap:8px; cursor:pointer; flex:1; overflow:hidden;";

            const icon = f.isDirectory ? "📁" : "📄";
            const iconSpan = document.createElement("span");
            iconSpan.textContent = icon;

            const nameSpan = document.createElement("span");
            nameSpan.style.cssText =
              "overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
            nameSpan.textContent = f.name;

            infoDiv.appendChild(iconSpan);
            infoDiv.appendChild(nameSpan);

            infoDiv.onclick = () => {
              if (!f.isDirectory && hub.openworkDesktopInvoke) {
                hub.openworkDesktopInvoke("__openPath", f.path);
              }
            };

            const delBtn = document.createElement("button");
            delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px; height:14px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`;
            delBtn.className = "hub-folder-btn hub-folder-btn-danger";
            delBtn.onclick = async (e) => {
              e.stopPropagation();
              if (
                confirm(
                  t(f.isDirectory ? "confirmDeleteDir" : "confirmDeleteFile", {
                    name: f.name,
                  }),
                )
              ) {
                const res = await hub.deleteProjectFile(project.id, f.path);
                if (res && res.ok) {
                  showDetail(project);
                } else {
                  showToast(t("deleteError", { err: res?.error || "?" }), "error");
                }
              }
            };

            item.appendChild(infoDiv);
            item.appendChild(delBtn);
            list.appendChild(item);
          });
          listContainer.appendChild(list);
        } else {
          listContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--text-muted);">${t("noFiles")}</div>`;
        }
      } catch {
        listContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--error);">${t("filesError")}</div>`;
      }
    } else {
      filePanel.innerHTML = `
        <div style="text-align: center; padding: 32px 20px; color: var(--text-muted); font-size: 13px; display: flex; flex-direction: column; align-items: center; gap: 12px;">
          <span>${t("noFolder")}</span>
          <button class="oh-btn-primary" id="oh-link-folder-now" style="padding: 10px 24px; height: auto; font-weight: 600; font-size: 14px;">${t("linkFolder")}</button>
        </div>
      `;
      filePanel.querySelector("#oh-link-folder-now").onclick = () => {
        if (window.__OH_OPEN_MODAL) window.__OH_OPEN_MODAL(project);
      };
    }

    overlay.classList.remove("oh-visible");
    detailView.classList.add("oh-visible");
  }

  // ── Init Data Loading ──
  async function refreshData() {
    if (hub.getProjects) {
      cachedProjects = await hub.getProjects();
    }
    if (hub.getFolders) {
      hubFolders = await hub.getFolders();
    }
    await loadConversations();
    renderGrid();
  }

  async function showHub() {
    await refreshData();
    hubRenderFilters();
    overlay.classList.add("oh-visible");
  }

  window.__OH_SHOW_HUB = showHub;
  window.__OH_REFRESH_HUB = refreshData;

  // Language update dispatcher
  if (hub.onLanguageChanged) {
    hub.onLanguageChanged(function (newLang) {
      lang = newLang === "en" ? "en" : "fr";
      // Update UI texts
      document.querySelector(".projects-hub-heading").textContent = t("projects");
      document.getElementById("projectSearchInput").placeholder = t("searchPlaceholder");
      document.getElementById("oh-select-mode-btn").textContent = t("select");
      document.getElementById("oh-new-project").querySelector("span").textContent =
        t("newProject");
      document.getElementById("oh-cancel-select").textContent = t("cancel");
      document.getElementById("oh-new-chat-in-proj").querySelector("span").textContent =
        t("newChat");
      document.getElementById("oh-delete-project-btn").textContent = t("deleteProject");

      const selectOpt = document.getElementById("hubSortSelect");
      if (selectOpt) {
        selectOpt.options[0].textContent = t("sortRecent");
        selectOpt.options[1].textContent = t("sortAZ");
        selectOpt.options[2].textContent = t("sortType");
      }

      if (selectMode) exitSelectMode();
      if (overlay.classList.contains("oh-visible")) renderGrid();
    });
  }
})();
