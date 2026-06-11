/* state.js — Global state, utilities, data loading */

window.Orch = {};

var projects = [];
var selectedOrchestratorId = null;
var selectedNodeId = null;
var models = [];
var isExecuting = false;
var layoutMode = "vertical";
var _selectedProjectPath = "";
var dragNode = null;
var linkStartNode = null;
var dragOffset = { x: 0, y: 0 };
var workflows = [];
var activeWorkflowId = null;

function switchPanelTab(tab) {
  var tabChat = document.getElementById("tabChat");
  var tabHistory = document.getElementById("tabHistory");
  var contentChat = document.getElementById("tabContentChat");
  var contentHistory = document.getElementById("tabContentHistory");
  if (tab === "chat") {
    tabChat.classList.add("active");
    tabHistory.classList.remove("active");
    contentChat.classList.add("active");
    contentHistory.classList.remove("active");
  } else {
    tabChat.classList.remove("active");
    tabHistory.classList.add("active");
    contentChat.classList.remove("active");
    contentHistory.classList.add("active");
    loadOrchHistory();
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(msg, type) {
  if (!type) type = "success";
  var container = document.getElementById("toastContainer");
  var toast = document.createElement("div");
  toast.className = "toast toast--" + type;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(function () {
    toast.remove();
  }, 3000);
}

function openModal(id) {
  document.getElementById(id).style.display = "flex";
}
function closeModal(id) {
  document.getElementById(id).style.display = "none";
}

function displayModelName(id) {
  return id ? id.split("/").pop() || id : id;
}

async function loadModels() {
  try {
    var config = await window.openhub.getChatConfig();
    var res = await fetch(config.proxyUrl + "/v1/models", {
      headers: { Authorization: "Bearer " + config.token },
    });
    var data = await res.json();
    models = data.data || [];
    var modelSelect = document.getElementById("projModel");
    modelSelect.innerHTML =
      '<option value="">— Modèle par défaut de l\'application —</option>' +
      models
        .map(function (m) {
          return '<option value="' + m.id + '">' + displayModelName(m.id) + "</option>";
        })
        .join("");
    var asstSelect = document.getElementById("assistantModelSelect");
    if (asstSelect) {
      var currentVal = asstSelect.value;
      asstSelect.innerHTML = models
        .map(function (m) {
          return '<option value="' + m.id + '">' + displayModelName(m.id) + "</option>";
        })
        .join("");
      if (currentVal) {
        asstSelect.value = currentVal;
      } else {
        var flash = models.find(function (m) {
          return m.id && m.id.includes("deepseek-v4-flash");
        });
        if (flash) asstSelect.value = flash.id;
      }
    }
  } catch (err) {
    console.error("[projects] Failed to load models:", err);
  }
}

async function loadProjects() {
  projects = await window.openhub.getProjects();
  var active = await window.openhub.getActiveProject();
  if (active && active.type === "orchestrator") {
    selectedOrchestratorId = active.id;
  } else if (!selectedOrchestratorId) {
    var firstOrch = projects.find(function (p) {
      return p.type === "orchestrator";
    });
    if (firstOrch) selectedOrchestratorId = firstOrch.id;
  }
  renderCanvas();
  updateTaskCard();
}
