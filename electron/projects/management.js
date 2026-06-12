/* management.js — Workflow management overlay */

var mgmtSelectedWfId = null;
var selectedProjectIdsForDelete = [];

function openManagement() {
  document.getElementById("mgmtOverlay").classList.add("open");
  renderManagement();
}

function closeManagement() {
  document.getElementById("mgmtOverlay").classList.remove("open");
}

function renderManagement() {
  renderMgmtWfList();
  if (mgmtSelectedWfId) {
    renderMgmtDetail(mgmtSelectedWfId);
  } else if (workflows.length > 0) {
    mgmtSelectedWfId = workflows[0].id;
    renderMgmtDetail(mgmtSelectedWfId);
  }
}

function renderMgmtWfList() {
  var el = document.getElementById("mgmtWfList");
  var count = document.getElementById("mgmtWfCount");
  if (!el) return;
  count.textContent = workflows.length;
  el.innerHTML = workflows
    .map(function (w) {
      var linked = (w.linkedProjectIds || []).length;
      var isActive = w.id === mgmtSelectedWfId;
      return (
        '<div class="mgmt-wf-item' +
        (isActive ? " active" : "") +
        '" onclick="selectMgmtWf(\'' +
        w.id +
        "')\">" +
        '<span class="mgmt-wf-dot" style="background:var(--accent-primary);"></span>' +
        '<div class="mgmt-wf-info">' +
        '<div class="mgmt-wf-name">' +
        escapeHtml(w.name) +
        "</div>" +
        '<div class="mgmt-wf-count">' +
        linked +
        " projet" +
        (linked !== 1 ? "s" : "") +
        "</div>" +
        "</div>" +
        '<span class="mgmt-wf-arrow" onclick="event.stopPropagation();switchWorkflowFromMgmt(\'' +
        w.id +
        "')\">▶</span>" +
        "</div>"
      );
    })
    .join("");
}

function selectMgmtWf(id) {
  mgmtSelectedWfId = id;
  renderMgmtWfList();
  renderMgmtDetail(id);
}

function renderMgmtDetail(wfId) {
  var wf = workflows.find(function (w) {
    return w.id === wfId;
  });
  if (!wf) {
    document.getElementById("mgmtDetailName").textContent = "Sélectionne un workflow";
    document.getElementById("mgmtDetailMeta").innerHTML = "";
    document.getElementById("mgmtDetailBody").innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;">Sélectionne un workflow dans la liste.</div>';
    document.getElementById("mgmtDeleteBtn").style.display = "none";
    return;
  }

  document.getElementById("mgmtDetailName").textContent = wf.name;
  var linked = (wf.linkedProjectIds || []).length;
  document.getElementById("mgmtDetailMeta").innerHTML =
    '<span class="tag active"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--success);margin-right:4px;"></span>Actif</span><span>' +
    linked +
    " agent" +
    (linked !== 1 ? "s" : "") +
    "</span>";
  document.getElementById("mgmtDeleteBtn").style.display = "inline-block";

  var linkedProjects = (wf.linkedProjectIds || [])
    .map(function (id) {
      return projects.find(function (p) {
        return p.id === id;
      });
    })
    .filter(Boolean);
  var linkedIds = wf.linkedProjectIds || [];
  var availableProjects = projects.filter(function (p) {
    return p.type !== "orchestrator" && !linkedIds.includes(p.id);
  });

  var html = "";

  html +=
    '<div><div class="mgmt-section-title">Agents liés <span class="count">(' +
    linkedProjects.length +
    ")</span></div>";
  if (linkedProjects.length === 0) {
    html +=
      '<div class="mgmt-proj-grid"><div class="mgmt-proj-empty">Aucun agent lié. Ajoutes-en depuis la liste ci-dessous.</div></div>';
  } else {
    html += '<div class="mgmt-proj-grid">';
    linkedProjects.forEach(function (p) {
      var type = wf.agentTypes && wf.agentTypes[p.id] ? wf.agentTypes[p.id] : "";
      var badge = type
        ? '<span class="mgmt-p-badge ' + type + '">' + type + "</span>"
        : "";
      var inOthers = workflows.filter(function (w2) {
        return w2.id !== wf.id && (w2.linkedProjectIds || []).includes(p.id);
      });
      var inText = "";
      if (inOthers.length > 0) {
        var names = inOthers
          .map(function (w2) {
            return escapeHtml(w2.name);
          })
          .join(", ");
        inText =
          '<span class="mgmt-p-in">Aussi dans <strong>' + names + "</strong></span>";
      }
      html +=
        '<div class="mgmt-proj-card">' +
        '<div class="mgmt-p-icon" style="background:var(--accent-subtle);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>' +
        '<div class="mgmt-p-info"><div class="mgmt-p-name">' +
        escapeHtml(p.name) +
        '</div><div class="mgmt-p-model">' +
        (p.model || "Modèle par défaut") +
        "</div></div>" +
        badge +
        inText +
        '<span class="mgmt-p-remove" onclick="unlinkProjectFromWf(\'' +
        wf.id +
        "','" +
        p.id +
        '\')" title="Dissocier">✕</span>' +
        "</div>";
    });
    html += "</div>";
  }
  html += "</div>";

  html +=
    '<div><div class="mgmt-section-title">Agents disponibles <span class="count">(' +
    availableProjects.length +
    ")</span></div>";
  if (availableProjects.length === 0) {
    html +=
      '<div class="mgmt-proj-grid"><div class="mgmt-proj-empty">Aucun agent disponible. <span class="link" onclick="openNewProjectFromMgmt()">Créer un agent</span></div></div>';
  } else {
    html += '<div class="mgmt-proj-grid">';
    availableProjects.slice(0, 10).forEach(function (p) {
      var inOthers = workflows.filter(function (w2) {
        return w2.id !== wf.id && (w2.linkedProjectIds || []).includes(p.id);
      });
      var inText = "";
      if (inOthers.length > 0) {
        var names = inOthers
          .map(function (w2) {
            return escapeHtml(w2.name);
          })
          .join(", ");
        inText = '<span class="mgmt-p-in">Dans <strong>' + names + "</strong></span>";
      }
      html +=
        '<div class="mgmt-proj-card">' +
        '<div class="mgmt-p-icon" style="background:var(--accent-subtle);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>' +
        '<div class="mgmt-p-info"><div class="mgmt-p-name">' +
        escapeHtml(p.name) +
        '</div><div class="mgmt-p-model">' +
        (p.model || "Modèle par défaut") +
        "</div></div>" +
        inText +
        '<span class="mgmt-p-add" onclick="linkProjectToWf(\'' +
        wf.id +
        "','" +
        p.id +
        "')\">+ Lier</span>" +
        "</div>";
    });
    if (availableProjects.length > 10) {
      html +=
        '<div class="mgmt-proj-empty" style="padding:12px;">+' +
        (availableProjects.length - 10) +
        ' autres agents. <span class="link" onclick="showAllProjectsModal()">Voir tout</span></div>';
    }
    html += "</div>";
  }
  html += "</div>";

  html +=
    '<div><div class="mgmt-section-title">Paramètres</div>' +
    '<div class="mgmt-settings-card">' +
    '<span class="label">Dossier de travail</span>' +
    '<span class="path">' +
    (wf.workDir || "Aucun dossier sélectionné") +
    "</span>" +
    '<span class="pick" onclick="pickWfWorkdir(\'' +
    wf.id +
    "')\">Choisir</span>" +
    "</div>" +
    "</div>";

  document.getElementById("mgmtDetailBody").innerHTML = html;
}

function linkProjectToWf(wfId, projectId) {
  var wf = workflows.find(function (w) {
    return w.id === wfId;
  });
  if (!wf) return;
  if (!wf.linkedProjectIds) wf.linkedProjectIds = [];
  if (wf.linkedProjectIds.includes(projectId)) return;
  wf.linkedProjectIds = [].concat(wf.linkedProjectIds, [projectId]);
  window.openhub.saveWorkflow(wf).then(function () {
    renderMgmtDetail(wfId);
    renderMgmtWfList();
    switchWorkflow(wfId);
    showToast("Agent lié au workflow", "success");
  });
}

function unlinkProjectFromWf(wfId, projectId) {
  var wf = workflows.find(function (w) {
    return w.id === wfId;
  });
  if (!wf) return;
  wf.linkedProjectIds = (wf.linkedProjectIds || []).filter(function (id) {
    return id !== projectId;
  });
  window.openhub.saveWorkflow(wf).then(function () {
    renderMgmtDetail(wfId);
    renderMgmtWfList();
    switchWorkflow(wfId);
    showToast("Agent dissocié du workflow", "success");
  });
}

function switchWorkflowFromMgmt(wfId) {
  switchWorkflow(wfId);
  closeManagement();
}

function openWorkflowInOrch() {
  if (mgmtSelectedWfId) {
    switchWorkflowFromMgmt(mgmtSelectedWfId);
  }
}

function pickWfWorkdir(wfId) {
  if (!window.openhub.pickProjectPath) return;
  window.openhub.pickProjectPath().then(function (p) {
    if (!p) return;
    var wf = workflows.find(function (w) {
      return w.id === wfId;
    });
    if (!wf) return;
    wf.workDir = p;
    window.openhub.saveWorkflow(wf).then(function () {
      renderMgmtDetail(wfId);
      showToast("Dossier de travail mis à jour", "success");
    });
  });
}

function deleteCurrentWorkflow() {
  if (!mgmtSelectedWfId) return;
  if (!confirm("Supprimer ce workflow ? Les agents liés ne seront pas supprimés."))
    return;
  var wf = workflows.find(function (w) {
    return w.id === mgmtSelectedWfId;
  });
  if (!wf) return;
  window.openhub.deleteWorkflow(mgmtSelectedWfId).then(function () {
    workflows = workflows.filter(function (w) {
      return w.id !== mgmtSelectedWfId;
    });
    if (activeWorkflowId === mgmtSelectedWfId && workflows.length > 0) {
      switchWorkflow(workflows[0].id);
    } else if (activeWorkflowId === mgmtSelectedWfId) {
      activeWorkflowId = null;
      selectedOrchestratorId = null;
      document.getElementById("wfName").textContent = "Aucun workflow";
      renderCanvas();
    }
    mgmtSelectedWfId = workflows.length > 0 ? workflows[0].id : null;
    renderManagement();
    renderWorkflowSelector();
    showToast("Workflow supprimé", "success");
  });
}

function showAllProjectsModal() {
  selectedProjectIdsForDelete = [];
  if (!window.openhub.getProjects) return;
  window.openhub.getProjects().then(function (allProjs) {
    var nonOrchProjs = (allProjs || []).filter(function (p) {
      return p.type !== "orchestrator";
    });
    var html =
      '<input class="form-input" id="mgmtSearchProj" placeholder="Rechercher un agent…" style="margin-bottom:8px;" oninput="filterMgmtProjects(this.value)" />';
    html += '<div id="mgmtProjList">';
    nonOrchProjs.forEach(function (p) {
      var inWfs = workflows.filter(function (w) {
        return (w.linkedProjectIds || []).includes(p.id);
      });
      var inText =
        inWfs.length > 0
          ? inWfs
              .map(function (w) {
                return escapeHtml(w.name);
              })
              .join(", ")
          : "Aucun workflow";
      html +=
        '<div class="mgmt-proj-card mgmt-proj-search-item" id="proj-card-' +
        p.id +
        '">' +
        '<label class="mgmt-p-checkbox"><input type="checkbox" onchange="toggleProjectSelection(\'' +
        p.id +
        "')\" /></label>" +
        '<div class="mgmt-p-icon" style="background:var(--accent-subtle);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>' +
        '<div class="mgmt-p-info"><div class="mgmt-p-name">' +
        escapeHtml(p.name) +
        "</div></div>" +
        '<span class="mgmt-p-in">Dans <strong>' +
        inText +
        "</strong></span>";
      if (
        mgmtSelectedWfId &&
        !inWfs.some(function (w) {
          return w.id === mgmtSelectedWfId;
        })
      ) {
        html +=
          '<span class="mgmt-p-add" onclick="linkProjectToWf(\'' +
          mgmtSelectedWfId +
          "','" +
          p.id +
          "');closeModal('modal-all-projects')\">+ Lier</span>";
      } else if (mgmtSelectedWfId) {
        html += '<span class="mgmt-p-already">✓ Lié</span>';
      }
      html += "</div>";
    });
    html += "</div>";
    document.getElementById("mgmtAllProjBody").innerHTML = html;
    document.getElementById("mgmtAllProjCount").textContent =
      nonOrchProjs.length + " agents";
    updateAllProjDeleteBtn();
    openModal("modal-all-projects");
  });
}

function toggleProjectSelection(id) {
  var idx = selectedProjectIdsForDelete.indexOf(id);
  if (idx === -1) {
    selectedProjectIdsForDelete.push(id);
  } else {
    selectedProjectIdsForDelete.splice(idx, 1);
  }
  var card = document.getElementById("proj-card-" + id);
  if (card) card.classList.toggle("selected", selectedProjectIdsForDelete.includes(id));
  updateAllProjDeleteBtn();
}

function updateAllProjDeleteBtn() {
  var btn = document.getElementById("btnDeleteSelectedProjs");
  if (!btn) return;
  var n = selectedProjectIdsForDelete.length;
  if (n > 0) {
    btn.style.display = "inline-flex";
    btn.textContent = "Supprimer (" + n + ")";
  } else {
    btn.style.display = "none";
  }
}

async function deleteSelectedProjects() {
  if (selectedProjectIdsForDelete.length === 0) return;
  var n = selectedProjectIdsForDelete.length;
  var modal = document.getElementById("modalConfirmDelete");
  var titleEl = modal.querySelector(".confirm-title");
  var descEl = modal.querySelector(".confirm-desc");
  var origTitle = titleEl.textContent;
  titleEl.textContent = "Supprimer " + n + " agent" + (n > 1 ? "s" : "") + " ?";
  descEl.textContent = "Cette action est irréversible. Tous les liens seront supprimés.";
  modal.classList.add("open");

  return new Promise(function (resolve) {
    document.getElementById("confirmDeleteBtn").onclick = async function () {
      modal.classList.remove("open");
      titleEl.textContent = origTitle;
      var idsToDelete = selectedProjectIdsForDelete.slice();
      selectedProjectIdsForDelete = [];
      for (var i = 0; i < idsToDelete.length; i++) {
        var id = idsToDelete[i];
        await window.openhub.deleteProject(id);
        projects.forEach(async function (p) {
          if (p.type === "orchestrator" && p.linked && p.linked.includes(id)) {
            p.linked = p.linked.filter(function (lid) {
              return lid !== id;
            });
            await window.openhub.saveProject(p);
          }
        });
        if (selectedOrchestratorId === id) selectedOrchestratorId = null;
      }
      closeModal("modal-all-projects");
      showToast(
        idsToDelete.length +
          " agent" +
          (idsToDelete.length > 1 ? "s supprimés" : " supprimé"),
        "success",
      );
      await loadProjects();
      resolve();
    };
    document.getElementById("cancelDeleteBtn").onclick = function () {
      modal.classList.remove("open");
      titleEl.textContent = origTitle;
      resolve();
    };
  });
}

function filterMgmtProjects(query) {
  var items = document.querySelectorAll(".mgmt-proj-search-item");
  var q = query.toLowerCase();
  items.forEach(function (item) {
    var name = item.querySelector(".mgmt-p-name");
    item.style.display = name && name.textContent.toLowerCase().includes(q) ? "" : "none";
  });
}

function openNewProjectFromMgmt() {
  resetProjectModal();
  openModal("modalProject");
}
