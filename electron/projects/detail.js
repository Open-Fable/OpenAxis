/* detail.js — Contextual detail panel with accordion views */

var _taskSaveTimer = null;
var _instructionsSaveTimer = null;
var _nodeTaskSaveTimer = null;

function openDetailWorkflow() {
  var detail = document.getElementById("orchestrationDetail");
  var active = projects.find(function (p) {
    return p.id === selectedOrchestratorId;
  });
  if (!active) return;
  detail.style.display = "flex";
  document.getElementById("detailTitle").textContent = t("proj.detail.workflow");
  document.getElementById("detailViewWorkflow").style.display = "flex";
  document.getElementById("detailViewAgent").style.display = "none";
  document.getElementById("sharedTaskText").value = active.task || "";
  document.getElementById("systemInstructionsText").value = active.instructions || "";
  var orchModelSelect = document.getElementById("orchModelSelect");
  if (orchModelSelect) {
    orchModelSelect.innerHTML =
      '<option value="">' +
      escapeHtml(t("proj.detail.orchModelNone")) +
      "</option>" +
      models
        .map(function (m) {
          return (
            '<option value="' +
            escapeHtml(m.id) +
            '">' +
            escapeHtml(displayModelName(m.id)) +
            "</option>"
          );
        })
        .join("");
    orchModelSelect.value = active.model || "";
  }
  var orchReasoningSelect = document.getElementById("orchReasoningSelect");
  if (orchReasoningSelect) {
    var effectiveModel = active.model || "";
    if (!effectiveModel) {
      var linked = active.linked || [];
      for (var li = 0; li < linked.length; li++) {
        var lp = projects.find(function (pp) {
          return pp.id === linked[li];
        });
        if (lp && lp.model) {
          effectiveModel = lp.model;
          break;
        }
      }
    }
    updateReasoningOptions(
      orchReasoningSelect,
      effectiveModel,
      active.reasoningEffort || "",
    );
  }
  var adaptWeakToggle = document.getElementById("orchAdaptWeakModel");
  if (adaptWeakToggle) {
    adaptWeakToggle.checked = !!(
      active.orchSettings && active.orchSettings.adaptToWeakModel
    );
  }
  var workdirPath = document.getElementById("orchWorkdirPath");
  var activeWf = activeWorkflowId
    ? workflows.find(function (w) {
        return w.id === activeWorkflowId;
      })
    : null;
  var displayPath = active.path || (activeWf && activeWf.workDir) || "";
  if (displayPath) {
    workdirPath.textContent = displayPath;
    workdirPath.title = displayPath;
  } else {
    workdirPath.textContent = "—";
    workdirPath.title = t("proj.detail.noFolderDefined");
  }
}

function openDetailAgent(nodeId) {
  var node = projects.find(function (p) {
    return p.id === nodeId;
  });
  if (!node) return;
  selectedNodeId = nodeId;
  var detail = document.getElementById("orchestrationDetail");
  detail.style.display = "flex";
  document.getElementById("detailTitle").textContent =
    node.name || t("proj.detail.agentFallback");
  document.getElementById("detailViewWorkflow").style.display = "none";
  document.getElementById("detailViewAgent").style.display = "flex";
  document.getElementById("lblSelectedNodeTask").textContent = t(
    "proj.detail.agentTaskWithName",
    { name: node.name },
  );
  document.getElementById("selectedNodeTaskText").value = node.task || "";
  var prompts = typeof orchPrompts !== "undefined" ? orchPrompts[nodeId] : null;
  var instructionsEl = document.getElementById("selectedNodeInstructionsText");
  if (prompts && prompts.system) {
    instructionsEl.value = prompts.system;
  } else {
    instructionsEl.value = node.instructions || "";
  }
  var userPromptEl = document.getElementById("generatedUserPrompt");
  if (userPromptEl) {
    if (prompts && prompts.user) {
      userPromptEl.textContent = prompts.user;
      userPromptEl.closest(".detail-accordion").style.display = "";
    } else {
      userPromptEl.textContent = "";
      userPromptEl.closest(".detail-accordion").style.display = "none";
    }
  }
  if (node.status && node.status !== "idle") {
    document.getElementById("agentStatusSection").style.display = "";
    var statusLabels = {
      running: t("proj.node.statusRunning"),
      done: t("proj.node.statusDone"),
      error: t("proj.node.statusError"),
      warning: t("proj.node.statusWarning"),
      skipped: t("proj.node.statusSkipped"),
    };
    document.getElementById("agentStatusRow").innerHTML =
      '<span class="status-dot status-dot--' +
      node.status +
      '"></span> ' +
      "<span>" +
      (statusLabels[node.status] || node.status) +
      "</span>";
  } else {
    document.getElementById("agentStatusSection").style.display = "none";
  }
  if (orchResults[nodeId]) {
    document.getElementById("orchResultViewer").textContent = orchResults[nodeId];
    document.getElementById("resultAccordion").open = true;
  } else {
    document.getElementById("orchResultViewer").innerHTML =
      '<div class="orch-result-empty">' +
      escapeHtml(t("proj.detail.resultEmpty")) +
      "</div>";
  }
}

function closeDetail() {
  document.getElementById("orchestrationDetail").style.display = "none";
  selectedNodeId = null;
  renderCanvas();
}

function updateDetailPanel() {
  var active = projects.find(function (p) {
    return p.id === selectedOrchestratorId;
  });
  if (!active || active.type !== "orchestrator") {
    document.getElementById("orchestrationDetail").style.display = "none";
    return;
  }
  if (selectedNodeId) {
    openDetailAgent(selectedNodeId);
  }
}

function updateTaskCard() {
  var active = projects.find(function (p) {
    return p.id === selectedOrchestratorId;
  });
  var el = document.getElementById("taskCardText");
  if (!el) return;
  if (document.activeElement === el) return;
  el.value = active && active.task ? active.task.trim() : "";
  autosizeTaskCard(el);
}

var TASK_CARD_MAX_HEIGHT = 96;

function autosizeTaskCard(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, TASK_CARD_MAX_HEIGHT) + "px";
}

function initDetailPanel() {
  var taskCardEl = document.getElementById("taskCardText");
  if (taskCardEl) {
    taskCardEl.oninput = function () {
      autosizeTaskCard(this);
      var self = this;
      clearTimeout(_taskSaveTimer);
      _taskSaveTimer = setTimeout(function () {
        var active = projects.find(function (p) {
          return p.id === selectedOrchestratorId;
        });
        if (!active) return;
        active.task = self.value;
        window.openaxis.saveProject(active);
        var shared = document.getElementById("sharedTaskText");
        if (shared && document.activeElement !== shared) shared.value = self.value;
      }, 400);
    };
    taskCardEl.onkeydown = function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.blur();
      }
    };
  }

  document.getElementById("sharedTaskText").oninput = function () {
    var self = this;
    clearTimeout(_taskSaveTimer);
    _taskSaveTimer = setTimeout(function () {
      var active = projects.find(function (p) {
        return p.id === selectedOrchestratorId;
      });
      if (active) {
        active.task = self.value;
        window.openaxis.saveProject(active);
        updateTaskCard();
      }
    }, 400);
  };

  document.getElementById("systemInstructionsText").oninput = function () {
    var self = this;
    clearTimeout(_instructionsSaveTimer);
    _instructionsSaveTimer = setTimeout(function () {
      var active = projects.find(function (p) {
        return p.id === selectedOrchestratorId;
      });
      if (active) {
        active.instructions = self.value;
        window.openaxis.saveProject(active);
      }
    }, 400);
  };

  document.getElementById("selectedNodeTaskText").oninput = function () {
    var self = this;
    clearTimeout(_nodeTaskSaveTimer);
    _nodeTaskSaveTimer = setTimeout(function () {
      var node = projects.find(function (p) {
        return p.id === selectedNodeId;
      });
      if (node) {
        node.task = self.value;
        window.openaxis.saveProject(node);
      }
    }, 400);
  };

  document.getElementById("orchModelSelect").onchange = function () {
    var active = projects.find(function (p) {
      return p.id === selectedOrchestratorId;
    });
    if (active) {
      var updated = Object.assign({}, active, { model: this.value });
      window.openaxis.saveProject(updated);
      var idx = projects.indexOf(active);
      if (idx !== -1) projects[idx] = updated;
    }
    var rSelect = document.getElementById("orchReasoningSelect");
    if (rSelect) {
      updateReasoningOptions(rSelect, this.value, rSelect.value);
    }
  };

  document.getElementById("orchReasoningSelect").onchange = function () {
    var active = projects.find(function (p) {
      return p.id === selectedOrchestratorId;
    });
    if (active) {
      var updated = Object.assign({}, active, {
        reasoningEffort: this.value || undefined,
      });
      window.openaxis.saveProject(updated);
      var idx = projects.indexOf(active);
      if (idx !== -1) projects[idx] = updated;
    }
  };

  document.getElementById("orchAdaptWeakModel").onchange = function () {
    var active = projects.find(function (p) {
      return p.id === selectedOrchestratorId;
    });
    if (active) {
      // Merge: preserve the other pilot settings (orchSettings is replaced, not
      // merged, on save) — only flip the weak-model flag.
      var merged = Object.assign(
        { autoDistribute: true, checkCoherence: true, relaunchOnError: true },
        active.orchSettings || {},
        { adaptToWeakModel: this.checked },
      );
      var updated = Object.assign({}, active, { orchSettings: merged });
      window.openaxis.saveProject(updated);
      var idx = projects.indexOf(active);
      if (idx !== -1) projects[idx] = updated;
    }
  };

  document.getElementById("btnEditSelectedNode").onclick = function () {
    if (selectedNodeId) editProject(selectedNodeId);
  };

  document.getElementById("btnCloseDetail").onclick = closeDetail;

  document.getElementById("btnPickOrchWorkdir").onclick = async function () {
    if (!window.openaxis.pickProjectPath) return;
    var p = await window.openaxis.pickProjectPath();
    if (!p || !selectedOrchestratorId) return;
    var active = projects.find(function (proj) {
      return proj.id === selectedOrchestratorId;
    });
    if (!active) return;
    active.path = p;
    await window.openaxis.saveProject(active);
    if (activeWorkflowId) {
      var wf = workflows.find(function (w) {
        return w.id === activeWorkflowId;
      });
      if (wf) {
        wf.workDir = p;
        await window.openaxis.saveWorkflow(wf);
      }
    }
    document.getElementById("orchWorkdirPath").textContent = p;
    document.getElementById("orchWorkdirPath").title = p;
    showToast(t("proj.toast.workdirUpdated"), "success");
  };
}
