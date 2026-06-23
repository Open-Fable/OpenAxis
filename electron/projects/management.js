/* management.js — Workflow management overlay */

var mgmtSelectedWfId = null;
var selectedProjectIds = [];
var allProjFilter = { query: "", type: "", noWorkflow: false };

var AGENT_TYPE_KEYS = ["code", "design", "work", "recherche", "verifier"];
// Resolved at call time so labels follow live language switches.
function agentTypeLabel(type) {
  return AGENT_TYPE_KEYS.indexOf(type) !== -1 ? t("proj.type." + type) : "";
}
var AGENT_TYPE_BADGE_CLASSES = {
  code: "code",
  design: "design",
  work: "work",
  recherche: "search",
  verifier: "verify",
};
var MGMT_AVAILABLE_VISIBLE_LIMIT = 10;

// Per-agent model picker: empty value = inherit the workflow's global model.
function mgmtModelSelectHtml(p) {
  var opts =
    '<option value="">' +
    escapeHtml(t("proj.model.global")) +
    "</option>" +
    (models || [])
      .map(function (m) {
        var sel = p.model === m.id ? " selected" : "";
        return (
          '<option value="' +
          escapeHtml(m.id) +
          '"' +
          sel +
          ">" +
          escapeHtml(displayModelName(m.id)) +
          "</option>"
        );
      })
      .join("");
  return (
    '<select class="mgmt-p-model-select" data-action="setProjectModelFromMgmt" data-arg="' +
    escapeHtml(p.id) +
    '" title="' +
    escapeHtml(t("proj.mgmt.modelOfAgent")) +
    '">' +
    opts +
    "</select>"
  );
}

// Override a single agent's model (or clear it to fall back to the global model).
async function setProjectModelFromMgmt(projectId, model) {
  var idx = projects.findIndex(function (pp) {
    return pp.id === projectId;
  });
  if (idx === -1) return;
  var updated = Object.assign({}, projects[idx], { model: model || undefined });
  await window.openaxis.saveProject(updated);
  projects[idx] = updated;
}

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
        '" data-action="selectMgmtWf" data-arg="' +
        w.id +
        '">' +
        '<span class="mgmt-wf-dot" style="background:var(--accent-primary);"></span>' +
        '<div class="mgmt-wf-info">' +
        '<div class="mgmt-wf-name">' +
        escapeHtml(w.name) +
        "</div>" +
        '<div class="mgmt-wf-count">' +
        escapeHtml(
          linked === 1
            ? t("proj.mgmt.agentCountSingular", { count: linked })
            : t("proj.mgmt.agentCountPlural", { count: linked }),
        ) +
        "</div>" +
        "</div>" +
        '<span class="mgmt-wf-arrow" data-action="switchWorkflowFromMgmt" data-arg="' +
        w.id +
        '">▶</span>' +
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
    document.getElementById("mgmtDetailName").textContent = t("proj.mgmt.selectWorkflow");
    document.getElementById("mgmtDetailMeta").innerHTML = "";
    document.getElementById("mgmtDetailBody").innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;">' +
      escapeHtml(t("proj.mgmt.selectWorkflowShort")) +
      "</div>";
    document.getElementById("mgmtMenuBtn").style.display = "none";
    return;
  }

  document.getElementById("mgmtDetailName").textContent = wf.name;
  var linked = (wf.linkedProjectIds || []).length;
  document.getElementById("mgmtDetailMeta").innerHTML =
    '<span class="tag active"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--success);margin-right:4px;"></span>' +
    escapeHtml(t("proj.mgmt.active")) +
    "</span><span>" +
    escapeHtml(
      linked === 1
        ? t("proj.mgmt.agentCountSingular", { count: linked })
        : t("proj.mgmt.agentCountPlural", { count: linked }),
    ) +
    "</span>";
  document.getElementById("mgmtMenuBtn").style.display = "inline-flex";

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
    '<div><div class="mgmt-section-title">' +
    escapeHtml(t("proj.mgmt.linkedAgents")) +
    ' <span class="count">(' +
    linkedProjects.length +
    ")</span></div>";
  if (linkedProjects.length === 0) {
    html +=
      '<div class="mgmt-proj-grid"><div class="mgmt-proj-empty">' +
      escapeHtml(t("proj.mgmt.noLinkedAgents")) +
      "</div></div>";
  } else {
    html += '<div class="mgmt-proj-grid">';
    linkedProjects.forEach(function (p) {
      var type = wf.agentTypes && wf.agentTypes[p.id] ? wf.agentTypes[p.id] : "";
      var safeType = escapeHtml(type);
      var badge = type
        ? '<span class="mgmt-p-badge ' + safeType + '">' + safeType + "</span>"
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
          '<span class="mgmt-p-in">' +
          escapeHtml(t("proj.mgmt.alsoIn")) +
          " <strong>" +
          names +
          "</strong></span>";
      }
      html +=
        '<div class="mgmt-proj-card">' +
        '<div class="mgmt-p-icon" style="background:var(--accent-subtle);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>' +
        '<div class="mgmt-p-info"><div class="mgmt-p-name">' +
        escapeHtml(p.name) +
        '</div><div class="mgmt-p-model">' +
        mgmtModelSelectHtml(p) +
        "</div></div>" +
        badge +
        inText +
        '<span class="mgmt-p-dup" title="' +
        escapeHtml(t("proj.mgmt.duplicate")) +
        '" data-action="duplicateProjectFromMgmt" data-arg="' +
        p.id +
        '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></span>' +
        '<span class="mgmt-p-remove" data-action="unlinkProjectFromWf" data-arg="' +
        wf.id +
        '" data-arg2="' +
        p.id +
        '" title="' +
        escapeHtml(t("proj.mgmt.unlink")) +
        '">✕</span>' +
        "</div>";
    });
    html += "</div>";
  }
  html += "</div>";

  html +=
    '<div><div class="mgmt-section-title">' +
    escapeHtml(t("proj.mgmt.availableAgents")) +
    ' <span class="count">(' +
    availableProjects.length +
    ")</span>" +
    (availableProjects.length > 0
      ? '<input class="mgmt-inline-search" id="mgmtAvailSearch" placeholder="' +
        escapeHtml(t("proj.mgmt.filterPlaceholder")) +
        '" autocomplete="off" aria-label="' +
        escapeHtml(t("proj.mgmt.filterAria")) +
        '" data-action="filterAvailableProjects" />'
      : "") +
    "</div>";
  if (availableProjects.length === 0) {
    html +=
      '<div class="mgmt-proj-grid"><div class="mgmt-proj-empty">' +
      escapeHtml(t("proj.mgmt.noAvailableAgents")) +
      ' <span class="link" data-action="openNewProjectFromMgmt">' +
      escapeHtml(t("proj.mgmt.createAgent")) +
      "</span></div></div>";
  } else {
    html += '<div class="mgmt-proj-grid">';
    availableProjects.forEach(function (p, idx) {
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
          '<span class="mgmt-p-in">' +
          escapeHtml(t("proj.mgmt.in")) +
          " <strong>" +
          names +
          "</strong></span>";
      }
      var typeLabel = agentTypeLabel(p.type);
      var searchStr = escapeHtml(
        (p.name + " " + (p.model || "") + " " + typeLabel).toLowerCase(),
      );
      var hidden = idx >= MGMT_AVAILABLE_VISIBLE_LIMIT ? ' style="display:none;"' : "";
      html +=
        '<div class="mgmt-proj-card mgmt-avail-item" data-search="' +
        searchStr +
        '"' +
        hidden +
        ">" +
        '<div class="mgmt-p-icon" style="background:var(--accent-subtle);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>' +
        '<div class="mgmt-p-info"><div class="mgmt-p-name">' +
        escapeHtml(p.name) +
        '</div><div class="mgmt-p-model">' +
        (p.model
          ? escapeHtml(displayModelName(p.model))
          : escapeHtml(t("proj.model.global"))) +
        "</div></div>" +
        inText +
        '<span class="mgmt-p-add" data-action="linkProjectToWf" data-arg="' +
        wf.id +
        '" data-arg2="' +
        p.id +
        '">' +
        escapeHtml(t("proj.mgmt.link")) +
        "</span>" +
        "</div>";
    });
    if (availableProjects.length > MGMT_AVAILABLE_VISIBLE_LIMIT) {
      html +=
        '<div class="mgmt-proj-empty" id="mgmtAvailMore" style="padding:12px;">' +
        escapeHtml(
          t("proj.mgmt.moreAgents", {
            count: availableProjects.length - MGMT_AVAILABLE_VISIBLE_LIMIT,
          }),
        ) +
        '<span class="link" data-action="showAllProjectsModal">' +
        escapeHtml(t("proj.mgmt.viewAll")) +
        "</span>.</div>";
    }
    html +=
      '<div class="mgmt-proj-empty" id="mgmtAvailNoMatch" style="padding:12px;display:none;">' +
      escapeHtml(t("proj.mgmt.noMatch")) +
      "</div>";
    html += "</div>";
  }
  html += "</div>";

  html +=
    '<div><div class="mgmt-section-title">' +
    escapeHtml(t("proj.mgmt.settings")) +
    "</div>" +
    '<div class="mgmt-settings-card">' +
    '<span class="label">' +
    escapeHtml(t("proj.mgmt.workFolder")) +
    "</span>" +
    '<span class="path">' +
    escapeHtml(wf.workDir || t("proj.mgmt.noFolderSelected")) +
    "</span>" +
    '<span class="pick" data-action="pickWfWorkdir" data-arg="' +
    wf.id +
    '">' +
    escapeHtml(t("proj.mgmt.choose")) +
    "</span>" +
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
  window.openaxis.saveWorkflow(wf).then(function () {
    renderMgmtDetail(wfId);
    renderMgmtWfList();
    switchWorkflow(wfId);
    showToast(t("proj.toast.agentLinked"), "success");
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
  window.openaxis.saveWorkflow(wf).then(function () {
    renderMgmtDetail(wfId);
    renderMgmtWfList();
    switchWorkflow(wfId);
    showToast(t("proj.toast.agentUnlinked"), "success");
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
  if (!window.openaxis.pickProjectPath) return;
  window.openaxis.pickProjectPath().then(function (p) {
    if (!p) return;
    var wf = workflows.find(function (w) {
      return w.id === wfId;
    });
    if (!wf) return;
    wf.workDir = p;
    window.openaxis.saveWorkflow(wf);
    var orch = projects.find(function (proj) {
      return proj.id === wf.orchProjectId;
    });
    if (orch) {
      orch.path = p;
      window.openaxis.saveProject(orch);
    }
    renderMgmtDetail(wfId);
    showToast(t("proj.toast.workdirUpdatedMgmt"), "success");
  });
}

function toggleMgmtMenu(event) {
  event.stopPropagation();
  document.getElementById("mgmtMenu").classList.toggle("open");
}

function closeMgmtMenu() {
  var menu = document.getElementById("mgmtMenu");
  if (menu) menu.classList.remove("open");
}

function renameCurrentWorkflow() {
  closeMgmtMenu();
  if (!mgmtSelectedWfId) return;
  openRenameWorkflowModal(mgmtSelectedWfId);
}

function deleteCurrentWorkflow() {
  closeMgmtMenu();
  if (!mgmtSelectedWfId) return;
  if (!confirm(t("proj.confirm.deleteWorkflow"))) return;
  var wf = workflows.find(function (w) {
    return w.id === mgmtSelectedWfId;
  });
  if (!wf) return;
  window.openaxis.deleteWorkflow(mgmtSelectedWfId).then(function () {
    workflows = workflows.filter(function (w) {
      return w.id !== mgmtSelectedWfId;
    });
    if (activeWorkflowId === mgmtSelectedWfId && workflows.length > 0) {
      switchWorkflow(workflows[0].id);
    } else if (activeWorkflowId === mgmtSelectedWfId) {
      activeWorkflowId = null;
      selectedOrchestratorId = null;
      document.getElementById("wfName").textContent = t("proj.topbar.noWorkflow");
      renderCanvas();
    }
    mgmtSelectedWfId = workflows.length > 0 ? workflows[0].id : null;
    renderManagement();
    renderWorkflowSelector();
    showToast(t("proj.toast.workflowDeleted"), "success");
  });
}

function showAllProjectsModal() {
  selectedProjectIds = [];
  allProjFilter = { query: "", type: "", noWorkflow: false };
  if (!window.openaxis.getProjects) return;
  window.openaxis.getProjects().then(function (allProjs) {
    var nonOrchProjs = (allProjs || []).filter(function (p) {
      return p.type !== "orchestrator";
    });
    var html =
      '<input class="form-input" id="mgmtSearchProj" placeholder="' +
      escapeHtml(t("proj.allProj.searchPlaceholder")) +
      '" aria-label="' +
      escapeHtml(t("proj.allProj.searchAria")) +
      '" style="margin-bottom:8px;" data-action="filterMgmtProjects" />';
    html += '<div class="mgmt-filter-chips" id="mgmtFilterChips">';
    html +=
      '<button class="filter-chip active" data-kind="type" data-action="setAllProjTypeFilter" data-arg="">' +
      escapeHtml(t("proj.allProj.filterAll")) +
      "</button>";
    AGENT_TYPE_KEYS.forEach(function (type) {
      html +=
        '<button class="filter-chip" data-kind="type" data-action="setAllProjTypeFilter" data-arg="' +
        type +
        '">' +
        escapeHtml(agentTypeLabel(type)) +
        "</button>";
    });
    html +=
      '<button class="filter-chip filter-chip--toggle" data-action="toggleNoWorkflowFilter">' +
      escapeHtml(t("proj.allProj.filterNoWorkflow")) +
      "</button>";
    html += "</div>";
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
          : t("proj.allProj.noWorkflow");
      var typeLabel = agentTypeLabel(p.type);
      var badge = typeLabel
        ? '<span class="mgmt-p-badge ' +
          (AGENT_TYPE_BADGE_CLASSES[p.type] || "") +
          '">' +
          typeLabel +
          "</span>"
        : "";
      var searchStr = escapeHtml(
        (p.name + " " + (p.model || "") + " " + typeLabel).toLowerCase(),
      );
      html +=
        '<div class="mgmt-proj-card mgmt-proj-search-item" id="proj-card-' +
        p.id +
        '" data-search="' +
        searchStr +
        '" data-type="' +
        escapeHtml(p.type || "") +
        '" data-noworkflow="' +
        (inWfs.length === 0 ? "1" : "0") +
        '">' +
        '<label class="mgmt-p-checkbox"><input type="checkbox" data-action="toggleProjectSelection" data-arg="' +
        p.id +
        '" /></label>' +
        '<div class="mgmt-p-icon" style="background:var(--accent-subtle);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>' +
        '<div class="mgmt-p-info"><div class="mgmt-p-name">' +
        escapeHtml(p.name) +
        "</div></div>" +
        badge +
        '<span class="mgmt-p-in">' +
        escapeHtml(t("proj.allProj.in")) +
        " <strong>" +
        inText +
        "</strong></span>";
      if (
        mgmtSelectedWfId &&
        !inWfs.some(function (w) {
          return w.id === mgmtSelectedWfId;
        })
      ) {
        html +=
          '<span class="mgmt-p-add" data-action="linkProjectToWfAndClose" data-arg="' +
          mgmtSelectedWfId +
          '" data-arg2="' +
          p.id +
          '">' +
          escapeHtml(t("proj.allProj.linkAndClose")) +
          "</span>";
      } else if (mgmtSelectedWfId) {
        html +=
          '<span class="mgmt-p-already">' +
          escapeHtml(t("proj.allProj.alreadyLinked")) +
          "</span>";
      }
      html +=
        '<span class="mgmt-p-dup" title="' +
        escapeHtml(t("proj.allProj.duplicate")) +
        '" data-action="duplicateProjectFromModal" data-arg="' +
        p.id +
        '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></span>';
      html += "</div>";
    });
    html += "</div>";
    document.getElementById("mgmtAllProjBody").innerHTML = html;
    applyAllProjFilters();
    updateAllProjDeleteBtn();
    openModal("modal-all-projects");
  });
}

function applyAllProjFilters() {
  var q = allProjFilter.query.toLowerCase();
  var items = document.querySelectorAll("#mgmtProjList .mgmt-proj-search-item");
  var shown = 0;
  items.forEach(function (item) {
    var matchesQuery = !q || (item.dataset.search || "").indexOf(q) !== -1;
    var matchesType = !allProjFilter.type || item.dataset.type === allProjFilter.type;
    var matchesWf = !allProjFilter.noWorkflow || item.dataset.noworkflow === "1";
    var isVisible = matchesQuery && matchesType && matchesWf;
    item.style.display = isVisible ? "" : "none";
    if (isVisible) shown++;
  });
  var count = document.getElementById("mgmtAllProjCount");
  if (count) {
    count.textContent =
      shown === items.length
        ? items.length === 1
          ? t("proj.allProj.countSingular", { count: items.length })
          : t("proj.allProj.countPlural", { count: items.length })
        : t("proj.allProj.countFiltered", { shown: shown, total: items.length });
  }
}

function setAllProjTypeFilter(btn, type) {
  allProjFilter = Object.assign({}, allProjFilter, { type: type });
  document
    .querySelectorAll('#mgmtFilterChips .filter-chip[data-kind="type"]')
    .forEach(function (chip) {
      chip.classList.toggle("active", chip === btn);
    });
  applyAllProjFilters();
}

function toggleNoWorkflowFilter(btn) {
  allProjFilter = Object.assign({}, allProjFilter, {
    noWorkflow: !allProjFilter.noWorkflow,
  });
  btn.classList.toggle("active", allProjFilter.noWorkflow);
  applyAllProjFilters();
}

function toggleProjectSelection(id) {
  var idx = selectedProjectIds.indexOf(id);
  if (idx === -1) {
    selectedProjectIds.push(id);
  } else {
    selectedProjectIds.splice(idx, 1);
  }
  var card = document.getElementById("proj-card-" + id);
  if (card) card.classList.toggle("selected", selectedProjectIds.includes(id));
  updateAllProjDeleteBtn();
}

function updateAllProjDeleteBtn() {
  var n = selectedProjectIds.length;
  var deleteBtn = document.getElementById("btnDeleteSelectedProjs");
  if (deleteBtn) {
    deleteBtn.style.display = n > 0 ? "inline-flex" : "none";
    deleteBtn.textContent = t("proj.allProj.deleteBtn", { count: n });
  }
  var linkBtn = document.getElementById("btnLinkSelectedProjs");
  if (linkBtn) {
    linkBtn.style.display = n > 0 && mgmtSelectedWfId ? "inline-flex" : "none";
    linkBtn.textContent = t("proj.allProj.linkBtn", { count: n });
  }
}

async function duplicateProjectFromModal(id) {
  var saved = await duplicateProject(id);
  if (saved) showAllProjectsModal();
}

async function duplicateProjectFromMgmt(id) {
  var saved = await duplicateProject(id);
  if (saved && mgmtSelectedWfId) renderMgmtDetail(mgmtSelectedWfId);
}

async function linkSelectedProjects() {
  if (!mgmtSelectedWfId || selectedProjectIds.length === 0) return;
  var wf = workflows.find(function (w) {
    return w.id === mgmtSelectedWfId;
  });
  if (!wf) return;
  var alreadyLinked = wf.linkedProjectIds || [];
  var toAdd = selectedProjectIds.filter(function (id) {
    return !alreadyLinked.includes(id);
  });
  if (toAdd.length === 0) {
    showToast(t("proj.toast.alreadyLinked"), "info");
    return;
  }
  wf.linkedProjectIds = [].concat(alreadyLinked, toAdd);
  await window.openaxis.saveWorkflow(wf);
  selectedProjectIds = [];
  closeModal("modal-all-projects");
  renderMgmtDetail(wf.id);
  renderMgmtWfList();
  switchWorkflow(wf.id);
  showToast(
    toAdd.length > 1
      ? t("proj.toast.agentsLinkedCountPlural", { count: toAdd.length })
      : t("proj.toast.agentsLinkedCountSingular", { count: toAdd.length }),
    "success",
  );
}

async function deleteSelectedProjects() {
  if (selectedProjectIds.length === 0) return;
  var n = selectedProjectIds.length;
  var modal = document.getElementById("modalConfirmDelete");
  var titleEl = modal.querySelector(".confirm-title");
  var descEl = modal.querySelector(".confirm-desc");
  var origTitle = titleEl.textContent;
  titleEl.textContent =
    n > 1
      ? t("proj.confirmDelete.titleMultiPlural", { count: n })
      : t("proj.confirmDelete.titleMultiSingular", { count: n });
  descEl.textContent = t("proj.confirmDelete.desc");
  modal.classList.add("open");

  return new Promise(function (resolve) {
    document.getElementById("confirmDeleteBtn").onclick = async function () {
      modal.classList.remove("open");
      titleEl.textContent = origTitle;
      var idsToDelete = selectedProjectIds.slice();
      selectedProjectIds = [];
      for (var i = 0; i < idsToDelete.length; i++) {
        var id = idsToDelete[i];
        await window.openaxis.deleteProject(id);
        projects.forEach(async function (p) {
          if (p.type === "orchestrator" && p.linked && p.linked.includes(id)) {
            p.linked = p.linked.filter(function (lid) {
              return lid !== id;
            });
            await window.openaxis.saveProject(p);
          }
        });
        if (selectedOrchestratorId === id) selectedOrchestratorId = null;
      }
      closeModal("modal-all-projects");
      showToast(
        idsToDelete.length > 1
          ? t("proj.toast.agentsDeletedPlural", { count: idsToDelete.length })
          : t("proj.toast.agentsDeletedSingular", { count: idsToDelete.length }),
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
  allProjFilter = Object.assign({}, allProjFilter, { query: query || "" });
  applyAllProjFilters();
}

function filterAvailableProjects(query) {
  var q = (query || "").toLowerCase();
  var items = document.querySelectorAll(".mgmt-avail-item");
  var moreRow = document.getElementById("mgmtAvailMore");
  var noMatchRow = document.getElementById("mgmtAvailNoMatch");
  var shown = 0;
  items.forEach(function (item, idx) {
    var isVisible = q
      ? (item.dataset.search || "").indexOf(q) !== -1
      : idx < MGMT_AVAILABLE_VISIBLE_LIMIT;
    item.style.display = isVisible ? "" : "none";
    if (isVisible) shown++;
  });
  if (moreRow) {
    moreRow.style.display =
      !q && items.length > MGMT_AVAILABLE_VISIBLE_LIMIT ? "" : "none";
  }
  if (noMatchRow) noMatchRow.style.display = q && shown === 0 ? "" : "none";
}

function openNewProjectFromMgmt() {
  resetProjectModal();
  openModal("modalProject");
}
