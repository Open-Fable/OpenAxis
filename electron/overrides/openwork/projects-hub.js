(function () {
  "use strict";
  if (window.__OH_PROJECTS_HUB_V2__) return;
  window.__OH_PROJECTS_HUB_V2__ = true;

  const hub = window.openhub;
  if (!hub) return;

  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ── HTML Structure ──
  const overlay = document.createElement("div");
  overlay.id = "oh-projects-hub-overlay";
  overlay.innerHTML = `
        <header class="oh-hub-header">
            <div class="oh-hub-title">Projets</div>
            <div style="display: flex; gap: 12px;">
                <button class="oh-btn-primary" id="oh-new-project">Nouveau projet</button>
                <button class="oh-btn-ghost" id="oh-close-hub">Fermer</button>
            </div>
        </header>
        <div class="oh-hub-grid" id="oh-hub-grid"></div>
    `;

  const detailView = document.createElement("div");
  detailView.id = "oh-project-detail-view";
  detailView.innerHTML = `
        <header class="oh-hub-header">
            <div class="oh-hub-title">
                <button class="oh-btn-ghost" id="oh-back-to-hub">← Retour</button>
                <span id="oh-detail-name">Nom du Projet</span>
            </div>
        </header>
        <div class="oh-detail-body">
            <aside class="oh-detail-sidebar">
                <div style="padding: 20px;">
                    <button class="oh-btn-primary" style="width: 100%" id="oh-new-chat-in-proj">Nouveau chat</button>
                </div>
                <div style="font-size: 11px; text-transform: uppercase; color: #666666; padding: 0 20px 10px; font-weight: 600;">Conversations</div>
                <div id="oh-detail-convs" style="flex: 1; overflow-y: auto; padding: 0 12px;"></div>
                <div style="padding: 20px; border-top: 1px solid #1f1f1f;">
                    <button class="oh-btn oh-btn-danger" style="width: 100%" id="oh-delete-project-btn">Supprimer le projet</button>
                </div>
            </aside>
            <main class="oh-detail-main">
                <div class="oh-context-grid">
                    <div class="oh-panel">
                        <div style="font-weight: 600; margin-bottom: 8px;">Instructions</div>
                        <textarea class="oh-textarea" id="oh-detail-instructions"></textarea>
                        <div style="margin-top: 16px; text-align: right;">
                            <button class="oh-btn-primary" id="oh-save-instructions">Enregistrer</button>
                        </div>
                    </div>
                    <div class="oh-panel">
                        <div style="font-weight: 600; margin-bottom: 8px;">Fichiers</div>
                        <div id="oh-detail-files" style="color: #666666; font-size: 13px;">
                            Ajoutez des fichiers via l'interface OpenWork habituelle pour ce projet.
                        </div>
                    </div>
                </div>
            </main>
        </div>
    `;

  document.body.appendChild(overlay);
  document.body.appendChild(detailView);

  // ── Event Delegation ──
  document.addEventListener("click", async (e) => {
    const target = e.target;

    // Back to hub
    if (target.id === "oh-back-to-hub" || target.closest("#oh-back-to-hub")) {
      detailView.classList.remove("oh-visible");
      overlay.classList.add("oh-visible");
    }

    // Close hub
    if (target.id === "oh-close-hub" || target.closest("#oh-close-hub")) {
      overlay.classList.remove("oh-visible");
    }

    // Save instructions
    if (target.id === "oh-save-instructions" || target.closest("#oh-save-instructions")) {
      const id = detailView.dataset.projectId;
      const projects = await hub.getProjects();
      const p = projects.find((x) => x.id === id);
      if (p) {
        p.instructions = document.getElementById("oh-detail-instructions").value;
        await hub.saveProject(p);
        alert("Instructions enregistrées");
      }
    }

    // New chat in project
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

    // Nouveau projet (FIX: use modal instead of prompt)
    if (target.id === "oh-new-project") {
      if (window.__OH_OPEN_MODAL) {
        window.__OH_OPEN_MODAL(null);
      }
    }

    // Delete project
    if (
      target.id === "oh-delete-project-btn" ||
      target.closest("#oh-delete-project-btn")
    ) {
      const id = detailView.dataset.projectId;
      const projects = await hub.getProjects();
      const p = projects.find((x) => x.id === id);
      if (p && confirm(`Supprimer définitivement le projet "${p.name}" ?`)) {
        await hub.deleteProject(id);
        detailView.classList.remove("oh-visible");
        showHub();
      }
    }
  });

  // ── Logic ──
  async function showHub() {
    const projects = await hub.getProjects();
    const grid = document.getElementById("oh-hub-grid");
    grid.innerHTML = "";

    if (!projects || projects.length === 0) {
      grid.innerHTML =
        '<div style="grid-column:1/-1; text-align:center; padding:48px; color:#666666;">Aucun projet trouvé.</div>';
    } else {
      projects.forEach((p) => {
        const card = document.createElement("div");
        card.className = "oh-project-card";

        const isOrchestrator = p.name.includes("(g") || p.name.includes("Orchestra");
        const icon = isOrchestrator
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 6 9 6 9-6"/><path d="M3 10v6l9 6 9-6v-6"/><path d="m3 10 9 6 9-6"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M8 7h6"/><path d="M8 11h8"/></svg>';
        const type = isOrchestrator ? "orchestrator" : "code";
        const date = new Date(p.updatedAt || Date.now()).toLocaleDateString("fr-FR");

        card.innerHTML = `
                    <div class="oh-project-card-top">
                        <div class="oh-project-card-icon-wrap" data-type="${type}">
                            ${icon}
                        </div>
                        <div class="oh-project-card-name">${escapeHtml(p.name)}</div>
                    </div>
                    <div class="oh-project-card-meta">
                        <div class="oh-project-meta-row">Type: ${type}</div>
                        <div class="oh-project-meta-row">Dernière modif: ${date}</div>
                    </div>
                `;
        card.onclick = (e) => {
          e.stopPropagation();
          showDetail(p);
        };
        grid.appendChild(card);
      });
    }

    overlay.classList.add("oh-visible");
  }

  async function showDetail(project) {
    detailView.dataset.projectId = project.id;
    document.getElementById("oh-detail-name").textContent = project.name;
    document.getElementById("oh-detail-instructions").value = project.instructions || "";

    const convList = document.getElementById("oh-detail-convs");
    convList.innerHTML =
      '<div style="padding:20px; text-align:center; color:#666666; font-size:12px;">Utilisez le bouton Nouveau Chat pour démarrer dans ce contexte.</div>';

    // Render files
    const filePanel = document.getElementById("oh-detail-files");
    if (project.path) {
      filePanel.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                    <div style="font-weight: 600;">Fichiers</div>
                    <button class="oh-btn oh-btn-ghost" id="oh-unlink-folder" style="font-size: 11px; padding: 4px 8px; border: 1px solid var(--border-default);">Dissocier le dossier</button>
                </div>
                <div id="oh-file-list-container"><div style="text-align: center; padding: 20px; color: #666666;">Chargement...</div></div>
            `;

      const listContainer = filePanel.querySelector("#oh-file-list-container");

      filePanel.querySelector("#oh-unlink-folder").onclick = async () => {
        if (
          confirm(
            "Voulez-vous dissocier ce dossier du projet ? (Les fichiers ne seront pas supprimés du disque)",
          )
        ) {
          const updated = { ...project, path: "" };
          await hub.saveProject(updated);
          showDetail(updated); // Refresh view
          if (window.__OH_REFRESH_HUB) window.__OH_REFRESH_HUB();
        }
      };

      try {
        const files = await hub.getProjectFiles(project.id);
        if (files && files.length > 0) {
          listContainer.innerHTML = "";
          const list = document.createElement("div");
          list.className = "oh-file-list";
          list.style.cssText = "display: flex; flex-direction: column; gap: 4px;";

          files.forEach((f) => {
            const item = document.createElement("div");
            item.className = "oh-file-item";
            item.style.cssText =
              "display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: rgba(255,255,255,0.03); border-radius: 8px; font-size: 13px; cursor: pointer; group;";
            item.onmouseover = () => (item.style.background = "rgba(255,255,255,0.06)");
            item.onmouseout = () => (item.style.background = "rgba(255,255,255,0.03)");

            const icon = f.isDirectory ? "📁" : "📄";

            const nameSpan = document.createElement("span");
            nameSpan.style.cssText =
              "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
            nameSpan.textContent = f.name;
            nameSpan.onclick = () => {
              if (!f.isDirectory && hub.openworkDesktopInvoke) {
                hub.openworkDesktopInvoke("__openPath", f.path);
              }
            };

            const delBtn = document.createElement("button");
            delBtn.innerHTML = "🗑️";
            delBtn.style.cssText =
              "border: none; background: transparent; cursor: pointer; opacity: 0.3; font-size: 14px; padding: 4px; border-radius: 4px;";
            delBtn.onmouseover = (e) => {
              e.stopPropagation();
              delBtn.style.opacity = "1";
              delBtn.style.background = "rgba(239, 68, 68, 0.15)";
            };
            delBtn.onmouseout = () => {
              delBtn.style.opacity = "0.3";
              delBtn.style.background = "transparent";
            };
            delBtn.onclick = async (e) => {
              e.stopPropagation();
              if (
                confirm(
                  `Supprimer définitivement ${f.isDirectory ? "le dossier" : "le fichier"} "${f.name}" ?`,
                )
              ) {
                const res = await hub.deleteProjectFile(project.id, f.path);
                if (res && res.ok) {
                  showDetail(project); // Refresh list
                } else {
                  alert("Erreur lors de la suppression: " + (res?.error || "inconnue"));
                }
              }
            };

            item.appendChild(document.createTextNode(icon));
            item.appendChild(nameSpan);
            item.appendChild(delBtn);
            list.appendChild(item);
          });
          listContainer.appendChild(list);
        } else {
          listContainer.innerHTML =
            '<div style="text-align: center; padding: 20px; color: #666666;">Aucun fichier trouvé dans le dossier lié.</div>';
        }
      } catch {
        listContainer.innerHTML =
          '<div style="text-align: center; padding: 20px; color: #ef4444;">Erreur lors du chargement des fichiers.</div>';
      }
    } else {
      filePanel.innerHTML = `
                <div style="text-align: center; padding: 32px 20px; color: #666666; font-size: 13px; display: flex; flex-direction: column; align-items: center; gap: 12px;">
                    <span>Aucun dossier lié à ce projet.</span>
                    <button class="oh-btn-primary" id="oh-link-folder-now" style="padding: 10px 24px; height: auto; font-weight: 600; font-size: 14px;">Lier un dossier maintenant</button>
                </div>
            `;
      filePanel.querySelector("#oh-link-folder-now").onclick = () => {
        if (window.__OH_OPEN_MODAL) window.__OH_OPEN_MODAL(project);
      };
    }

    detailView.classList.add("oh-visible");
  }

  window.__OH_SHOW_HUB = showHub;
  window.__OH_REFRESH_HUB = showHub;
})();
