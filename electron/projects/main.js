/* main.js — Workflow selector, bootstrap, global event listeners */

var CHAT_COLLAPSED_KEY = "openhub-chat-collapsed";
var LAST_WF_KEY = "openhub-last-workflow";

async function loadWorkflows() {
  if (window.openhub.getWorkflows) {
    workflows = await window.openhub.getWorkflows();
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
    document.getElementById("wfName").textContent = "Aucun workflow";
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
        '" onclick="switchWorkflow(\'' +
        w.id +
        "')\">" +
        '<span class="wfd-dot" style="background:var(--accent-primary);"></span> ' +
        escapeHtml(w.name) +
        "</div>"
      );
    })
    .join("");
  if (el.innerHTML) el.innerHTML += '<div class="wf-dropdown-divider"></div>';
  el.innerHTML +=
    '<div class="wf-dropdown-new" onclick="openNewWorkflowModal()">+ Nouveau workflow</div>';
  el.innerHTML +=
    '<div class="wf-dropdown-item" onclick="openManagement()" style="color:var(--text-muted);">Gérer les workflows</div>';
}

async function switchWorkflow(id) {
  activeWorkflowId = id;
  localStorage.setItem(LAST_WF_KEY, id);
  var wf = workflows.find(function (w) {
    return w.id === id;
  });
  if (wf) {
    document.getElementById("wfName").textContent = wf.name;
    document.getElementById("canvasWfName").textContent = wf.name;
    selectedOrchestratorId = wf.orchProjectId;
    var orch = projects.find(function (p) {
      return p.id === wf.orchProjectId;
    });
    if (orch && wf.linkedProjectIds) {
      var synced = Object.assign({}, orch, { linked: wf.linkedProjectIds.slice() });
      await window.openhub.saveProject(synced);
    }
    await loadProjects();
  }
  document.getElementById("wfDropdown").classList.remove("open");
  activeConvId = null;
  await loadConversations();
  renderCanvas();
  updateTaskCard();
  updateChatPanelVisibility();
}

function openNewWorkflowModal() {
  document.getElementById("wfNameInput").value = "";
  openModal("modalWorkflowPrompt");
  setTimeout(function () {
    document.getElementById("wfNameInput").focus();
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
      wfInput.style.borderColor = "var(--error, #ef4444)";
      showToast("Le nom du workflow est obligatoire.", "error");
      return;
    }
    if (name.length > 80) {
      wfInput.focus();
      wfInput.style.borderColor = "var(--error, #ef4444)";
      showToast("Le nom du workflow ne peut pas dépasser 80 caractères.", "error");
      return;
    }
    wfInput.style.borderColor = "";
    var confirmBtn = document.getElementById("btnConfirmWorkflow");
    confirmBtn.disabled = true;
    closeModal("modalWorkflowPrompt");
    try {
      var orch = await window.openhub.saveProject({
        name: "Orchestrateur",
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
        task: "Définissez ici l'objectif global...",
      });
      var wf = await window.openhub.saveWorkflow({
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
      showToast("Workflow '" + name + "' créé", "success");
    } catch (err) {
      showToast("Erreur : " + (err.message || "inconnue"), "error");
    } finally {
      confirmBtn.disabled = false;
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
  });
}

document.addEventListener("DOMContentLoaded", async function () {
  initPanZoom();
  initDetailPanel();
  initExecution();
  initModals();
  initChat();
  initMain();
  await loadModels();
  await loadProjects();
  await loadWorkflows();
  await loadConversations();
  updateChatPanelVisibility();
});
