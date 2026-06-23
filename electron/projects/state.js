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
var workflows = [];
var activeWorkflowId = null;

// ── Proxy auth — per-session token from main (no static token) ──
var _proxyTokenPromise = null;
function getProxyToken() {
  if (!_proxyTokenPromise) {
    _proxyTokenPromise = window.openaxis
      .getChatConfig()
      .then(function (c) {
        return (c && c.token) || "";
      })
      .catch(function () {
        return "";
      });
  }
  return _proxyTokenPromise;
}

function switchPanelTab(tab) {
  var tabs = ["Chat", "Activity", "History"];
  tabs.forEach(function (t) {
    var btn = document.getElementById("tab" + t);
    var content = document.getElementById("tabContent" + t);
    if (!btn || !content) return;
    var isActive = t.toLowerCase() === tab;
    btn.classList.toggle("active", isActive);
    content.classList.toggle("active", isActive);
  });
  if (tab === "history") loadOrchHistory();
  if (tab === "activity") scrollActivityToBottom();
}

function scrollActivityToBottom() {
  var feed = document.getElementById("activityFeed");
  if (feed) feed.scrollTop = feed.scrollHeight;
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

function getReasoningCategory(modelId) {
  if (!modelId) return "unknown";
  var l = modelId.toLowerCase();

  // Anthropic extended thinking: Claude 3.7+, Sonnet 4+, Opus 4+
  if (
    l.includes("claude-3-7") ||
    l.includes("claude-3.7") ||
    l.includes("claude-sonnet-4") ||
    l.includes("claude-opus-4") ||
    l.includes("claude-4") ||
    (l.includes("anthropic/") && (l.includes("sonnet-4") || l.includes("opus-4"))) ||
    l.includes(":thinking")
  )
    return "anthropic";

  // OpenAI reasoning models (o1, o3, o4) — but NOT o1-mini/o1-preview
  if (l.includes("o1-mini") || l.includes("o1-preview")) return "none";
  if (
    l.match(/(?:^|\/)(o1|o3|o4)/) ||
    l.includes("openai/o1") ||
    l.includes("openai/o3") ||
    l.includes("openai/o4")
  )
    return "openai";

  // DeepSeek reasoning: deepseek-r1, deepseek/r1, deepseek-reasoner, deepseek-v4-flash, deepseek in general
  if (
    l.includes("deepseek") &&
    !l.includes("deepseek-chat") &&
    !l.includes("deepseek-v3")
  )
    return "deepseek";

  // Gemini 2.5+, Gemini 3+ and thinking models
  if (
    l.includes("gemini-2.5") ||
    l.includes("gemini-3") ||
    (l.includes("gemini") && l.includes("thinking"))
  )
    return "gemini";

  // Other reasoning/thinking models
  if (l.includes("thinking") || l.includes("reasoning") || l.includes("reasoner"))
    return "deepseek";

  // Everything else: no reasoning support
  // deepseek-chat, deepseek-v3, deepseek-v4, gpt-4o, claude-3.5, llama, mistral...
  return "none";
}

function updateReasoningOptions(selectEl, modelId, currentValue) {
  var cat = getReasoningCategory(modelId);
  var opts = [];
  if (cat === "none") {
    opts = [{ value: "", label: t("proj.reasoning.notAvailable") }];
  } else if (cat === "openai") {
    opts = [
      { value: "", label: t("proj.reasoning.default") },
      { value: "low", label: t("proj.reasoning.optLow") },
      { value: "medium", label: t("proj.reasoning.optMedium") },
      { value: "high", label: t("proj.reasoning.optHigh") },
    ];
  } else if (cat === "anthropic") {
    opts = [
      { value: "", label: t("proj.reasoning.default") },
      { value: "low", label: t("proj.reasoning.lowAnthropic") },
      { value: "medium", label: t("proj.reasoning.mediumAnthropic") },
      { value: "high", label: t("proj.reasoning.highAnthropic") },
      { value: "xhigh", label: t("proj.reasoning.xhighAnthropic") },
      { value: "max", label: t("proj.reasoning.maxAnthropic") },
    ];
  } else if (cat === "gemini") {
    opts = [
      { value: "", label: t("proj.reasoning.default") },
      { value: "low", label: t("proj.reasoning.lowGemini") },
      { value: "medium", label: t("proj.reasoning.mediumGemini") },
      { value: "high", label: t("proj.reasoning.highGemini") },
      { value: "max", label: t("proj.reasoning.max") },
    ];
  } else if (cat === "deepseek") {
    opts = [
      { value: "", label: t("proj.reasoning.default") },
      { value: "low", label: t("proj.reasoning.low") },
      { value: "medium", label: t("proj.reasoning.medium") },
      { value: "high", label: t("proj.reasoning.high") },
    ];
  } else {
    // unknown — no model selected, show generic set
    opts = [
      { value: "", label: t("proj.reasoning.default") },
      { value: "low", label: t("proj.reasoning.low") },
      { value: "medium", label: t("proj.reasoning.medium") },
      { value: "high", label: t("proj.reasoning.high") },
      { value: "xhigh", label: t("proj.reasoning.xhigh") },
      { value: "max", label: t("proj.reasoning.max") },
    ];
  }
  selectEl.innerHTML = opts
    .map(function (o) {
      return '<option value="' + o.value + '">' + o.label + "</option>";
    })
    .join("");
  selectEl.disabled = cat === "none";
  var validValues = opts.map(function (o) {
    return o.value;
  });
  if (currentValue && validValues.indexOf(currentValue) !== -1) {
    selectEl.value = currentValue;
  } else {
    selectEl.value = "";
  }
}

async function loadModels() {
  var loadingSelect = document.getElementById("projModel");
  if (loadingSelect) {
    loadingSelect.innerHTML =
      '<option value="">' + escapeHtml(t("proj.model.loading")) + "</option>";
  }
  try {
    var config = await window.openaxis.getChatConfig();
    var headers = { Authorization: "Bearer " + config.token };
    var [res, selRes] = await Promise.all([
      fetch(config.proxyUrl + "/v1/models/full", { headers: headers }),
      fetch(config.proxyUrl + "/v1/models/selected", { headers: headers }),
    ]);
    var data = await res.json();
    var selData = await selRes.json();
    var allModels = data.data || [];
    var selectedIds = selData.selectedModels || [];
    models = selectedIds.length
      ? allModels.filter(function (m) {
          return selectedIds.indexOf(m.id) !== -1;
        })
      : allModels;
    var modelSelect = document.getElementById("projModel");
    modelSelect.innerHTML =
      '<option value="">' +
      escapeHtml(t("proj.model.defaultApp")) +
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
    var asstSelect = document.getElementById("assistantModelSelect");
    if (asstSelect) {
      var currentVal = asstSelect.value;
      asstSelect.innerHTML = models
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
    if (loadingSelect) {
      loadingSelect.innerHTML =
        '<option value="">' + escapeHtml(t("proj.model.unavailable")) + "</option>";
    }
  }
}

async function loadProjects() {
  projects = await window.openaxis.getProjects();
  // When a workflow is active, its orchProjectId is authoritative —
  // don't let the store's activeProject overwrite it.
  if (!activeWorkflowId) {
    var active = await window.openaxis.getActiveProject();
    if (active && active.type === "orchestrator") {
      selectedOrchestratorId = active.id;
    } else if (!selectedOrchestratorId) {
      var firstOrch = projects.find(function (p) {
        return p.type === "orchestrator";
      });
      if (firstOrch) selectedOrchestratorId = firstOrch.id;
    }
  }
  renderCanvas();
  updateTaskCard();
}
