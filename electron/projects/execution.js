/* execution.js — Orchestration execution, status, console, progress, history */

var orchLogLines = [];
var orchUnsubscribe = null;
var orchResults = {};
var orchNodeStatuses = {};
var orchStartedAt = 0;

function clearOrchConsole() {
  orchLogLines = [];
  var el = document.getElementById("orchConsole");
  el.innerHTML = '<span class="console-info">Console d\'orchestration prête.</span>';
}

function appendOrchLog(text, type) {
  orchLogLines.push(text);
  var el = document.getElementById("orchConsole");
  var line = document.createElement("div");
  line.className = "console-" + (type || "chunk");
  line.textContent = text;
  el.appendChild(line);
  var isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (isNearBottom) el.scrollTop = el.scrollHeight;
}

function showNodeResult() {
  var viewer = document.getElementById("orchResultViewer");
  if (!selectedNodeId || !orchResults[selectedNodeId]) {
    viewer.innerHTML =
      '<div class="orch-result-empty">Aucun résultat pour le moment.</div>';
    return;
  }
  viewer.textContent = orchResults[selectedNodeId];
}

function showTopbarProgress(show) {
  document.getElementById("topbarProgress").style.display = show ? "flex" : "none";
}

function updateTopbarProgress(current, total) {
  document.getElementById("topbarProgressText").textContent = current + "/" + total;
  document.getElementById("topbarProgressFill").style.width =
    (current / total) * 100 + "%";
}

function startOrchestration() {
  var activeOrch = projects.find(function (p) {
    return p.id === selectedOrchestratorId;
  });
  if (!activeOrch) {
    showToast("Aucun orchestrateur sélectionné.", "error");
    return;
  }
  var task = document.getElementById("sharedTaskText")
    ? document.getElementById("sharedTaskText").value.trim()
    : (activeOrch.task || "").trim();
  if (!task) {
    showToast("Définis d'abord une tâche globale.", "error");
    return;
  }
  var linked = projects.filter(function (p) {
    return (activeOrch.linked || []).includes(p.id);
  });
  if (linked.length === 0) {
    showToast("Aucun agent lié au workflow.", "error");
    return;
  }
  var emptyTask = linked.filter(function (p) {
    return (
      !(p.task || "").trim() &&
      !(activeOrch.orchSettings && activeOrch.orchSettings.autoDistribute)
    );
  });
  if (emptyTask.length > 0) {
    showToast(
      "Agents sans tâche : " +
        emptyTask
          .map(function (p) {
            return p.name;
          })
          .join(", "),
      "warning",
    );
    return;
  }
  var noModel = linked.filter(function (p) {
    return !p.model && !activeOrch.model;
  });
  if (noModel.length > 0) {
    showToast(
      "Aucun modèle défini pour : " +
        noModel
          .map(function (p) {
            return p.name;
          })
          .join(", "),
      "error",
    );
    return;
  }
  clearOrchConsole();
  orchResults = {};
  orchNodeStatuses = {};
  orchStartedAt = Date.now();
  showTopbarProgress(true);
  document.getElementById("btnExecuteOrch").style.display = "none";
  document.getElementById("btnStopOrch").style.display = "inline-flex";
  appendOrchLog("Lancement de l'orchestration...", "info");
  openDetailWorkflow();
  var consoleAcc = document.getElementById("consoleAccordion");
  if (consoleAcc) consoleAcc.open = true;
  if (orchUnsubscribe) orchUnsubscribe();
  orchUnsubscribe = window.openhub.onOrchestrationStatus(function (data) {
    if (data.chunk) appendOrchLog(data.chunk);
    if (data.result) orchResults[data.projectId] = data.result;
    if (data.progress) {
      updateTopbarProgress(data.progress.current, data.progress.total);
    }
    if (
      data.status === "done" ||
      data.status === "error" ||
      data.status === "skipped" ||
      data.status === "warning"
    ) {
      if (data.projectId !== selectedOrchestratorId) {
        orchNodeStatuses[data.projectId] = data.status;
      }
    }
    if (data.status === "done") appendOrchLog("✓ " + (data.task || "Terminé"), "done");
    if (data.status === "error") appendOrchLog("✗ " + (data.error || "Erreur"), "error");
    if (data.status === "skipped") appendOrchLog("— Ignoré", "skip");
    if (
      data.projectId === selectedOrchestratorId &&
      (data.status === "done" || data.status === "error")
    ) {
      showTopbarProgress(false);
      document.getElementById("btnExecuteOrch").style.display = "inline-flex";
      document.getElementById("btnStopOrch").style.display = "none";
      if (data.status === "done")
        appendOrchLog("✓ Orchestration terminée avec succès !", "done");
      else appendOrchLog("✗ Orchestration terminée sur erreur.", "error");
      saveOrchRun(data.status);
    }
  });
  window.openhub.executeOrchestration(selectedOrchestratorId, task).catch(function () {
    showTopbarProgress(false);
    document.getElementById("btnExecuteOrch").style.display = "inline-flex";
    document.getElementById("btnStopOrch").style.display = "none";
  });
}

function saveOrchRun(finalStatus) {
  if (!selectedOrchestratorId || !activeWorkflowId) return;
  var activeOrch = projects.find(function (p) {
    return p.id === selectedOrchestratorId;
  });
  var finishedAt = Date.now();
  var nodeResults = [];
  var linked = activeOrch ? activeOrch.linked || [] : [];
  linked.forEach(function (pid) {
    var node = projects.find(function (p) {
      return p.id === pid;
    });
    if (!node) return;
    nodeResults.push({
      projectId: pid,
      name: node.name,
      status: orchNodeStatuses[pid] || "skipped",
      result: orchResults[pid] || undefined,
    });
  });
  var run = {
    workflowId: activeWorkflowId,
    orchProjectId: selectedOrchestratorId,
    task: (activeOrch && activeOrch.task) || "",
    status:
      finalStatus === "done"
        ? "done"
        : finalStatus === "cancelled"
          ? "cancelled"
          : "error",
    nodeResults: nodeResults,
    logs: orchLogLines.slice(),
    startedAt: orchStartedAt,
    finishedAt: finishedAt,
    duration: finishedAt - orchStartedAt,
  };
  window.openhub.saveOrchRun(run).then(function () {
    loadOrchHistory();
  });
}

function loadOrchHistory() {
  if (!activeWorkflowId || !window.openhub.getOrchRuns) return;
  window.openhub.getOrchRuns(activeWorkflowId).then(function (runs) {
    renderOrchHistory(runs || []);
  });
}

function formatDuration(ms) {
  if (ms < 1000) return ms + "ms";
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  s = s % 60;
  return m + "m " + s + "s";
}

function formatDate(ts) {
  var d = new Date(ts);
  var pad = function (n) {
    return n < 10 ? "0" + n : "" + n;
  };
  return (
    pad(d.getDate()) +
    "/" +
    pad(d.getMonth() + 1) +
    "/" +
    d.getFullYear() +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

function renderOrchHistory(runs) {
  var container = document.getElementById("orchHistoryList");
  if (!container) return;
  if (runs.length === 0) {
    container.innerHTML =
      '<div class="history-empty">Aucune exécution enregistrée.</div>';
    return;
  }
  container.innerHTML = "";
  runs.forEach(function (run) {
    var item = document.createElement("div");
    item.className = "history-item";
    item.onclick = function () {
      showRunDetail(run);
    };

    var statusIcon = run.status === "done" ? "✓" : "✗";
    var statusClass =
      run.status === "done" ? "history-status--done" : "history-status--error";
    var nodeCount = run.nodeResults ? run.nodeResults.length : 0;
    var doneCount = run.nodeResults
      ? run.nodeResults.filter(function (n) {
          return n.status === "done";
        }).length
      : 0;

    item.innerHTML =
      '<div class="history-item-left">' +
      '<span class="history-status ' +
      statusClass +
      '">' +
      statusIcon +
      "</span>" +
      '<div class="history-item-info">' +
      '<span class="history-item-task">' +
      escapeHtml((run.task || "").substring(0, 60)) +
      "</span>" +
      '<span class="history-item-meta">' +
      formatDate(run.startedAt) +
      " · " +
      formatDuration(run.duration) +
      " · " +
      doneCount +
      "/" +
      nodeCount +
      " agents</span>" +
      "</div>" +
      "</div>" +
      '<svg class="history-item-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';

    container.appendChild(item);
  });
}

function showRunDetail(run) {
  var container = document.getElementById("orchHistoryList");
  if (!container) return;
  container.innerHTML = "";

  var back = document.createElement("button");
  back.className = "history-back-btn";
  back.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg> Retour';
  back.onclick = function () {
    loadOrchHistory();
  };
  container.appendChild(back);

  var header = document.createElement("div");
  header.className = "history-detail-header";
  var statusLabel =
    run.status === "done" ? "Succès" : run.status === "cancelled" ? "Annulée" : "Erreur";
  var statusClass =
    run.status === "done" ? "history-status--done" : "history-status--error";
  var statusIcon = run.status === "done" ? "✓" : run.status === "cancelled" ? "—" : "✗";
  header.innerHTML =
    '<span class="history-status ' +
    statusClass +
    '" style="font-size:14px;">' +
    statusIcon +
    "</span>" +
    "<div>" +
    '<div class="history-detail-task">' +
    escapeHtml(run.task || "") +
    "</div>" +
    '<div class="history-detail-meta">' +
    statusLabel +
    " · " +
    formatDate(run.startedAt) +
    " · " +
    formatDuration(run.duration) +
    "</div>" +
    "</div>";
  container.appendChild(header);

  if (run.nodeResults && run.nodeResults.length > 0) {
    var nodesTitle = document.createElement("div");
    nodesTitle.className = "history-section-title";
    nodesTitle.textContent = "Résultats par agent";
    container.appendChild(nodesTitle);

    run.nodeResults.forEach(function (nr) {
      var nodeEl = document.createElement("details");
      nodeEl.className = "history-node";
      var icon = nr.status === "done" ? "✓" : nr.status === "error" ? "✗" : "—";
      var nodeClass = "history-status--" + nr.status;
      nodeEl.innerHTML =
        '<summary class="history-node-summary">' +
        '<span class="history-status ' +
        nodeClass +
        '">' +
        icon +
        "</span>" +
        "<span>" +
        escapeHtml(nr.name) +
        "</span>" +
        "</summary>";
      if (nr.result) {
        var resultDiv = document.createElement("div");
        resultDiv.className = "history-node-result";
        resultDiv.textContent = nr.result;
        nodeEl.appendChild(resultDiv);
      }
      container.appendChild(nodeEl);
    });
  }

  if (run.logs && run.logs.length > 0) {
    var logsTitle = document.createElement("div");
    logsTitle.className = "history-section-title";
    logsTitle.textContent = "Logs";
    container.appendChild(logsTitle);

    var logsEl = document.createElement("div");
    logsEl.className = "history-logs";
    logsEl.textContent = run.logs.join("\n");
    container.appendChild(logsEl);
  }

  var delBtn = document.createElement("button");
  delBtn.className = "btn btn--ghost history-delete-btn";
  delBtn.textContent = "Supprimer cette exécution";
  delBtn.onclick = function () {
    window.openhub.deleteOrchRun(run.id).then(function () {
      loadOrchHistory();
    });
  };
  container.appendChild(delBtn);
}

function initExecution() {
  document.getElementById("btnExecuteOrch").onclick = startOrchestration;

  document.getElementById("btnStopOrch").onclick = function () {
    if (window.openhub.cancelOrchestration) {
      window.openhub.cancelOrchestration();
      appendOrchLog("Orchestration arrêtée par l'utilisateur.", "error");
      showTopbarProgress(false);
      document.getElementById("btnExecuteOrch").style.display = "inline-flex";
      document.getElementById("btnStopOrch").style.display = "none";
      saveOrchRun("cancelled");
    }
  };

  if (window.openhub.onOrchestrationStatus) {
    window.openhub.onOrchestrationStatus(function (data) {
      var node = projects.find(function (p) {
        return p.id === data.projectId;
      });
      if (node) {
        node.status = data.status;
        if (data.task) node.task = data.task;
        var nodeCard = document.querySelector('.node-card[data-id="' + node.id + '"]');
        if (nodeCard) {
          nodeCard.className =
            "node-card " +
            (node.id === selectedNodeId ? "node-card--selected" : "") +
            " node-card--" +
            data.status;
          var statusLabel = "En attente";
          var statusClass = "status-dot--idle";
          if (data.status === "running") {
            statusLabel = "En cours";
            statusClass = "status-dot--running";
          } else if (data.status === "done") {
            statusLabel = "Terminé";
            statusClass = "status-dot--done";
          } else if (data.status === "error") {
            statusLabel = "Erreur";
            statusClass = "status-dot--error";
          } else if (data.status === "warning") {
            statusLabel = "Attention";
            statusClass = "status-dot--warning";
          } else if (data.status === "skipped") {
            statusLabel = "Ignoré";
            statusClass = "status-dot--skipped";
          }
          nodeCard.querySelector(".node-card-status span:last-child").textContent =
            statusLabel;
          nodeCard.querySelector(".status-dot").className = "status-dot " + statusClass;
        }
        drawConnections();
      }
      if (
        data.projectId === selectedOrchestratorId &&
        (data.status === "done" || data.status === "error")
      ) {
        document.getElementById("btnExecuteOrch").disabled = false;
        isExecuting = false;
        showToast(
          data.status === "done"
            ? "Orchestration terminée avec succès"
            : "Orchestration arrêtée sur erreur",
          data.status === "done" ? "success" : "error",
        );
      }
    });
  }
}
