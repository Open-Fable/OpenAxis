/* main.js — Workflow selector, bootstrap, global event listeners */

var CHAT_COLLAPSED_KEY = "openaxis-chat-collapsed";
var LAST_WF_KEY = "openaxis-last-workflow";
var LAST_NODE_KEY = "openaxis-last-node";

async function loadWorkflows() {
  if (window.openaxis.getWorkflows) {
    workflows = await window.openaxis.getWorkflows();
  }
  renderWorkflowSelector();
  if (!activeWorkflowId && workflows.length > 0) {
    var lastWfId = localStorage.getItem(LAST_WF_KEY);
    var target =
      lastWfId &&
      workflows.find(function (w) {
        return w.id === lastWfId;
      })
        ? lastWfId
        : workflows[0].id;
    await switchWorkflow(target);
  } else if (!activeWorkflowId) {
    document.getElementById("wfName").textContent = t("proj.topbar.noWorkflow");
  }
}

function renderWorkflowSelector() {
  var el = document.getElementById("wfDropdown");
  if (!el) return;
  el.innerHTML = workflows
    .map(function (w) {
      return (
        '<div class="wf-dropdown-item' +
        (w.id === activeWorkflowId ? " active" : "") +
        '" data-action="switchWorkflow" data-arg="' +
        w.id +
        '">' +
        '<span class="wfd-dot" style="background:var(--accent-primary);"></span> ' +
        escapeHtml(w.name) +
        "</div>"
      );
    })
    .join("");
  if (el.innerHTML) el.innerHTML += '<div class="wf-dropdown-divider"></div>';
  el.innerHTML +=
    '<div class="wf-dropdown-new" data-action="createWorkflow">' +
    escapeHtml(t("proj.wf.new")) +
    "</div>";
  el.innerHTML +=
    '<div class="wf-dropdown-item" data-action="openManagement" style="color:var(--text-muted);">' +
    escapeHtml(t("proj.wf.manage")) +
    "</div>";
}

async function switchWorkflow(id) {
  activeWorkflowId = id;
  localStorage.setItem(LAST_WF_KEY, id);
  var wf = workflows.find(function (w) {
    return w.id === id;
  });
  if (wf) {
    document.getElementById("wfName").textContent = wf.name;
    selectedOrchestratorId = wf.orchProjectId;
    var orch = projects.find(function (p) {
      return p.id === wf.orchProjectId;
    });
    if (orch && wf.linkedProjectIds) {
      var synced = Object.assign({}, orch, { linked: wf.linkedProjectIds.slice() });
      await window.openaxis.saveProject(synced);
    }
    await loadProjects();
  }
  document.getElementById("wfDropdown").classList.remove("open");
  activeConvId = null;
  await loadConversations();
  renderCanvas();
  restoreSelectedNode();
  updateTaskCard();
  updateChatPanelVisibility();
}

function saveSelectedNode() {
  if (activeWorkflowId && selectedNodeId) {
    localStorage.setItem(LAST_NODE_KEY + "-" + activeWorkflowId, selectedNodeId);
  }
}

function restoreSelectedNode() {
  if (!activeWorkflowId) return;
  var savedNodeId = localStorage.getItem(LAST_NODE_KEY + "-" + activeWorkflowId);
  if (!savedNodeId) return;
  var nodeExists = projects.find(function (p) {
    return p.id === savedNodeId;
  });
  if (!nodeExists) return;
  selectedNodeId = savedNodeId;
  var card = document.querySelector('.node-card[data-id="' + savedNodeId + '"]');
  if (card) card.classList.add("node-card--selected");
  if (nodeExists.type === "orchestrator") {
    openDetailWorkflow();
  } else {
    openDetailAgent(savedNodeId);
  }
}

async function createWorkflow() {
  document.getElementById("wfDropdown").classList.remove("open");
  var base = t("proj.mgmt.newWorkflow");
  var sameNameCount = workflows.filter(function (w) {
    return w.name.indexOf(base) === 0;
  }).length;
  var name = sameNameCount === 0 ? base : base + " " + (sameNameCount + 1);
  try {
    var orch = await window.openaxis.saveProject({
      name: t("proj.node.typeOrchestrator"),
      instructions:
        "Tu es un coordinateur d'agents. Distribue les tâches et assure la cohérence globale.",
      color: "#0d9488",
      type: "orchestrator",
      linked: [],
      orchSettings: {
        autoDistribute: true,
        checkCoherence: true,
        relaunchOnError: true,
      },
      x: 100,
      y: 240,
      task: "",
    });
    var wf = await window.openaxis.saveWorkflow({
      name: name,
      orchProjectId: orch.id,
      linkedProjectIds: [],
      agentTypes: {},
      workDir: "",
    });
    workflows.push(wf);
    activeWorkflowId = wf.id;
    renderWorkflowSelector();
    switchWorkflow(wf.id);
    renderManagement();
    showToast(t("proj.wf.created"), "success");
  } catch (err) {
    showToast(
      t("proj.common.errorWith", { msg: err.message || t("proj.common.unknown") }),
      "error",
    );
  }
}

function openRenameWorkflowModal(wfId) {
  var wf = workflows.find(function (w) {
    return w.id === wfId;
  });
  if (!wf) return;
  var input = document.getElementById("wfNameInput");
  input.value = wf.name;
  document.getElementById("btnConfirmWorkflow").dataset.wfId = wfId;
  openModal("modalWorkflowPrompt");
  setTimeout(function () {
    input.focus();
    input.select();
  }, 100);
}

function collapseChat() {
  document.getElementById("chatPanel").style.display = "none";
  document.getElementById("chatCollapsedBar").style.display = "flex";
  localStorage.setItem(CHAT_COLLAPSED_KEY, "1");
}

function expandChat() {
  document.getElementById("chatPanel").style.display = "flex";
  document.getElementById("chatCollapsedBar").style.display = "none";
  localStorage.setItem(CHAT_COLLAPSED_KEY, "0");
}

function updateChatPanelVisibility() {
  var hasProjects = projects.some(function (p) {
    return p.type === "orchestrator" && p.id === selectedOrchestratorId;
  });
  var activeOrch = projects.find(function (p) {
    return p.id === selectedOrchestratorId;
  });
  var hasLinked = activeOrch && activeOrch.linked && activeOrch.linked.length > 0;
  var savedState = localStorage.getItem(CHAT_COLLAPSED_KEY);
  if (savedState === "1" && hasLinked) {
    collapseChat();
  } else if (!hasLinked) {
    expandChat();
  } else if (savedState === "0" || savedState === null) {
    expandChat();
  }
}

function initMain() {
  document.getElementById("btnConfirmWorkflow").onclick = async function () {
    var wfInput = document.getElementById("wfNameInput");
    var name = wfInput.value.trim();
    if (!name) {
      wfInput.focus();
      wfInput.style.borderColor = "var(--error)";
      showToast(t("proj.wf.renameRequired"), "error");
      return;
    }
    if (name.length > 80) {
      wfInput.focus();
      wfInput.style.borderColor = "var(--error)";
      showToast(t("proj.wf.renameTooLong"), "error");
      return;
    }
    wfInput.style.borderColor = "";
    var wf = workflows.find(
      function (w) {
        return w.id === this.dataset.wfId;
      }.bind(this),
    );
    if (!wf) {
      closeModal("modalWorkflowPrompt");
      return;
    }
    this.disabled = true;
    try {
      wf.name = name;
      await window.openaxis.saveWorkflow(wf);
      if (activeWorkflowId === wf.id) {
        document.getElementById("wfName").textContent = name;
      }
      renderWorkflowSelector();
      renderManagement();
      closeModal("modalWorkflowPrompt");
      showToast(t("proj.wf.renamed"), "success");
    } catch (err) {
      showToast(
        t("proj.common.errorWith", { msg: err.message || t("proj.common.unknown") }),
        "error",
      );
    } finally {
      this.disabled = false;
    }
  };

  document.getElementById("btnCollapseChat").onclick = collapseChat;
  document.getElementById("btnExpandChat").onclick = expandChat;

  document.getElementById("btnNewProject").onclick = function () {
    resetProjectModal();
    openModal("modalProject");
  };

  document.addEventListener("keydown", function (e) {
    if (
      e.key === "Enter" &&
      document.getElementById("modalWorkflowPrompt").style.display === "flex"
    ) {
      document.getElementById("btnConfirmWorkflow").click();
    }
  });

  document.addEventListener("click", function (e) {
    var sel = document.querySelector(".wf-selector");
    var dd = document.getElementById("wfDropdown");
    if (sel && dd && !sel.contains(e.target)) {
      dd.classList.remove("open");
    }
    var convSel = document.getElementById("convSelector");
    var convDd = document.getElementById("convDropdown");
    if (convSel && convDd && !convSel.contains(e.target)) {
      convDd.classList.remove("open");
    }
    var menuWrap = document.querySelector(".mgmt-menu-wrap");
    if (menuWrap && !menuWrap.contains(e.target)) {
      closeMgmtMenu();
    }
  });
}

document.addEventListener("DOMContentLoaded", async function () {
  initPanZoom();
  initDetailPanel();
  initExecution();
  initModals();
  initChat();
  initMain();
  await restoreConvsFromDisk();
  await loadModels();
  await loadProjects();
  await loadWorkflows();
  await loadConversations();
  updateChatPanelVisibility();
});

// Re-render JS-built chrome whose labels aren't covered by [data-i18n] when the
// language changes live. data-i18n elements are already re-applied by the runtime
// before these listeners run.
if (window.I18N && window.I18N.onChange) {
  window.I18N.onChange(function () {
    try {
      renderWorkflowSelector();
      if (activeWorkflowId) {
        var wf = workflows.find(function (w) {
          return w.id === activeWorkflowId;
        });
        if (wf) document.getElementById("wfName").textContent = wf.name;
      } else {
        document.getElementById("wfName").textContent = t("proj.topbar.noWorkflow");
      }
      renderCanvas();
      renderConvDropdown();
      var convTitleEl = document.getElementById("convTitle");
      if (convTitleEl && !getActiveConv()) {
        convTitleEl.textContent = t("proj.chat.newConversation");
      }
      updateTaskCard();
      updateDetailPanel();
      renderManagement();
      loadOrchHistory();
    } catch {
      /* a missing optional view must not break the language switch */
    }
  });
}
