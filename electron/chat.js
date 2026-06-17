var IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
var MAX_IMAGE_SIZE = 20 * 1024 * 1024;
var MAX_TEXT_SIZE = 512 * 1024;
var PROJ_COLORS = [
  "#0d9488",
  "#0d9488",
  "#0d9488",
  "#d97706",
  "#dc2626",
  "#0d9488",
  "#0d9488",
  "#0d9488",
];

var state = {
  messages: [],
  selectedModel: null,
  models: [],
  isStreaming: false,
  proxyUrl: "",
  token: "",
  abortController: null,
  attachments: [],
  webSearchEnabled: false, // reflète l'interrupteur maître « Recherche Internet » (Config), synchronisé à l'init

  modelPreferences: JSON.parse(localStorage.getItem("openhub-model-preferences") || "{}"),
  initReady: false,
  isSearchMode: false,
};

function getModelEffort(modelId) {
  if (!modelId) return "medium";
  return state.modelPreferences[modelId] || "medium";
}

function setModelEffort(modelId, effort) {
  if (!modelId) return;
  state.modelPreferences[modelId] = effort;
  try {
    localStorage.setItem(
      "openhub-model-preferences",
      JSON.stringify(state.modelPreferences),
    );
  } catch (e) {}
}
var projState = { projects: [], active: null, dropdownOpen: false };
var conversations = [],
  activeConvId = null;
var artifacts = [],
  nextArtifactId = 0;

function $(id) {
  return document.getElementById(id);
}
var els = {
  messages: $("messagesInner"),
  emptyState: $("emptyState"),
  emptyTitle: $("emptyTitle"),
  emptyDesc: $("emptyDesc"),
  input: $("chatInput"),
  btnSend: $("btnSend"),
  btnNavNewChat: $("btnNavNewChat"),
  btnNavSearch: $("btnNavSearch"),
  convList: $("convList"),
  convSearch: $("convSearch"),
  attachPreview: $("attachPreview"),
  fileInput: $("fileInput"),
  dropOverlay: $("dropOverlay"),
  chatTitle: $("chatTitle"),
  modelLabel: $("modelContextLabel"),
  btnModelCtx: $("btnModelContext"),
  btnReasoningCtx: $("btnReasoningContext"),
  reasoningLabel: $("reasoningContextLabel"),
  reasoningWrap: $("reasoningContextWrap"),
};

/* ── File backup helpers ── */
function backupFilePath() {
  return window.openhub && window.openhub.readChatBackup ? "disk" : null;
}
function getHistoryKey() {
  return state.isSearchMode ? "openhub-searches" : "openhub-chats";
}

async function restoreFromBackup() {
  try {
    if (!window.openhub || !window.openhub.readChatBackup) return null;
    if (state.isSearchMode) return null; // No search backup on disk for now
    var raw = await window.openhub.readChatBackup();
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    var valid = parsed.filter(function (c) {
      return c && typeof c === "object" && c.id && Array.isArray(c.messages);
    });
    if (valid.length === 0) return null;
    return valid;
  } catch (_) {
    console.warn("[chat] Backup restore failed:", _);
    return null;
  }
}
async function writeBackup() {
  try {
    if (!window.openhub || !window.openhub.writeChatBackup) return;
    var toSave = conversations
      .filter(function (c) {
        return c && c.messages && c.messages.length > 0;
      })
      .sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      })
      .slice(0, 100);

    if (state.isSearchMode) return; // Skip search backup for now

    await window.openhub.writeChatBackup(JSON.stringify(toSave));
  } catch (_) {
    console.warn("[chat] File backup write failed:", _);
  }
}

/* ── Conversations ── */
async function loadConversations() {
  try {
    // Read localStorage FIRST before restoreFromBackup can be called
    var data = localStorage.getItem(getHistoryKey());
    var localConvs = [];

    try {
      if (data && data !== "[]") {
        var parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          localConvs = parsed.filter(function (c) {
            return c && typeof c === "object" && c.id && Array.isArray(c.messages);
          });
        }
      }
    } catch (e) {
      console.error("[DEBUG] Error parsing localStorage data", e);
    }

    var restored = await restoreFromBackup();
    var restoredCount = (restored && restored.length) || 0;
    var localCount = localConvs.length;

    // We pick the source with more conversations to ensure no data loss
    if (restoredCount > localCount) {
      try {
        localStorage.setItem(getHistoryKey(), JSON.stringify(restored));
      } catch (e) {
        console.error("[DEBUG] Failed to sync localStorage", e);
      }
      return restored;
    } else {
      return localConvs;
    }
  } catch (_) {
    console.error("[DEBUG] loadConversations error:", _);
    return [];
  }
}
function persistConversations() {
  if (!state.initReady) {
    console.warn("[chat] persist blocked: app not ready");
    return;
  }
  try {
    var toSave = conversations
      .filter(function (c) {
        return c && c.messages && c.messages.length > 0;
      })
      .sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      })
      .slice(0, 100);

    var json = JSON.stringify(toSave);
    localStorage.setItem(getHistoryKey(), json);
    writeBackup();
  } catch (_) {
    console.error("[chat] persist error:", _);
  }
}
function getConvTitle(msgs) {
  var f = msgs.find(function (m) {
    return m.role === "user" && m.content;
  });
  if (!f)
    return state.isSearchMode
      ? window.t("chat.title.newSearch")
      : window.t("chat.title.new");
  var t = "";
  if (typeof f.content === "string") {
    t = f.content;
  } else if (f.content && f.content.text) {
    t = f.content.text;
  } else if (Array.isArray(f.content)) {
    t = f.content
      .map(function (p) {
        return p.text || "";
      })
      .join(" ");
  } else {
    t = String(f.content || "Message");
  }
  return t.length > 38 ? t.slice(0, 38) + "…" : t;
}
function getConvPreview(msgs) {
  var a = msgs
    .slice()
    .reverse()
    .find(function (m) {
      return m.role === "assistant" && m.content;
    });
  if (!a) return "";
  var t = "";
  if (typeof a.content === "string") {
    t = a.content;
  } else if (a.content && a.content.text) {
    t = a.content.text;
  } else if (Array.isArray(a.content)) {
    t = a.content
      .map(function (p) {
        return p.text || "";
      })
      .join(" ");
  } else {
    t = String(a.content || "");
  }
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}
function getConvModel(msgs) {
  var a = msgs.find(function (m) {
    return m.model;
  });
  return a ? a.model : null;
}

function togglePin(id) {
  var conv = conversations.find(function (c) {
    return c.id === id;
  });
  if (!conv) return;
  conv.pinned = !conv.pinned;
  persistConversations();
  renderConvList(document.getElementById("convSearch").value);
}

function showConvMenu(e, conv) {
  var existing = document.getElementById("convDropdown");
  if (existing) existing.remove();

  var menu = document.createElement("div");
  menu.id = "convDropdown";
  menu.className = "dropdown";
  menu.style.position = "fixed";

  var rect = e.currentTarget.getBoundingClientRect();
  menu.style.top = rect.bottom + 4 + "px";
  menu.style.right = window.innerWidth - rect.right + "px";
  menu.style.minWidth = "160px";
  menu.style.zIndex = "1000";

  var pinLabel = conv.pinned ? t("chat.conv.detach") : t("chat.conv.pin");
  var pinIcon = conv.pinned
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M10.5 3.5 5 9v3h14V9l-5.5-5.5a2 2 0 0 0-3 0Z"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M10.5 3.5 5 9v3h14V9l-5.5-5.5a2 2 0 0 0-3 0Z"/></svg>';

  menu.innerHTML =
    '<button class="dropdown-item" data-action="pin">' +
    pinIcon +
    "<span>" +
    pinLabel +
    "</span></button>" +
    '<button class="dropdown-item" data-action="rename"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path></svg><span>' +
    t("chat.conv.rename") +
    "</span></button>" +
    '<div style="height:1px;background:var(--border-subtle);margin:4px 0"></div>' +
    '<button class="dropdown-item" data-action="delete" style="color:var(--error)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg><span>' +
    t("chat.conv.delete") +
    "</span></button>";

  document.body.appendChild(menu);

  function close() {
    if (menu.parentNode) menu.parentNode.removeChild(menu);
    window.removeEventListener("mousedown", onWindowClick);
  }

  function onWindowClick(ev) {
    if (!menu.contains(ev.target)) close();
  }

  setTimeout(function () {
    window.addEventListener("mousedown", onWindowClick);
  }, 0);

  menu.querySelector('[data-action="pin"]').addEventListener("click", function (ev) {
    ev.stopPropagation();
    togglePin(conv.id);
    close();
  });
  menu.querySelector('[data-action="rename"]').addEventListener("click", function (ev) {
    ev.stopPropagation();
    startRenaming(conv.id);
    close();
  });
  menu.querySelector('[data-action="delete"]').addEventListener("click", function (ev) {
    ev.stopPropagation();
    deleteConversation(conv.id);
    close();
  });
}

function renderConvList(filter) {
  var list = els.convList;
  if (!list) {
    console.error("[DEBUG] els.convList is missing!");
    return;
  }
  var savedScrollTop = list.scrollTop;
  var sorted = conversations.slice().sort(function (a, b) {
    if (!a || !b) return 0;
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  if (filter) {
    var q = filter.toLowerCase().trim();
    sorted = sorted.filter(function (c) {
      if (!c) return false;
      var titleMatch = (c.title || "").toLowerCase().includes(q);
      var messageMatch = (c.messages || []).some(function (m) {
        if (!m) return false;
        var content = "";
        if (typeof m.content === "string") content = m.content;
        else if (Array.isArray(m.content))
          content = m.content
            .map(function (p) {
              return p.text || "";
            })
            .join(" ");
        else content = String(m.content || "");
        return content.toLowerCase().includes(q);
      });
      return titleMatch || messageMatch;
    });
  }
  list.innerHTML = "";
  if (sorted.length === 0) {
    list.innerHTML =
      '<div class="conv-item" style="text-align:center;color:var(--text-muted);font-size:13px;padding:24px 12px">' +
      (filter
        ? t("chat.conv.noResults", { filter: escapeHtml(filter) })
        : t("chat.conv.emptyList")) +
      "</div>";
    return;
  }
  for (var i = 0; i < sorted.length; i++) {
    (function (conv) {
      if (!conv || !conv.id) return;
      var item = document.createElement("div");
      item.className =
        "conv-item" +
        (conv.id === activeConvId ? " conv-item--active" : "") +
        (conv.pinned ? " conv-item--pinned" : "");
      item.dataset.id = conv.id;
      item.innerHTML =
        '<div class="conv-item-title">' +
        '<svg class="conv-pin-indicator" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M10.5 3.5 5 9v3h14V9l-5.5-5.5a2 2 0 0 0-3 0Z"/></svg>' +
        escapeHtml(conv.title || t("chat.conv.untitled")) +
        "</div>" +
        '<div class="conv-actions">' +
        '<button class="btn-icon btn-more" title="' +
        escapeHtml(t("chat.conv.moreOptions")) +
        '" aria-label="' +
        escapeHtml(t("chat.conv.moreOptions")) +
        '"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>' +
        "</div>";

      var moreBtn = item.querySelector(".btn-more");
      if (moreBtn) {
        moreBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          showConvMenu(e, conv);
        });
      }
      item.addEventListener("click", function () {
        switchToConversation(conv.id);
      });
      item.addEventListener("dblclick", function (e) {
        startRenaming(conv.id);
      });
      list.appendChild(item);
    })(sorted[i]);
  }
  list.scrollTop = savedScrollTop;
}
function formatDate(ts) {
  var d = new Date(ts);
  var now = new Date();
  var diff = now - d;
  if (diff < 86400000) return t("chat.date.today");
  if (diff < 172800000) return t("chat.date.yesterday");
  if (diff < 604800000)
    return [
      t("chat.date.dim"),
      t("chat.date.lun"),
      t("chat.date.mar"),
      t("chat.date.mer"),
      t("chat.date.jeu"),
      t("chat.date.ven"),
      t("chat.date.sam"),
    ][d.getDay()];
  var locale = window.I18N && window.I18N.lang === "en" ? "en-US" : "fr-FR";
  return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

function saveCurrentConversation() {
  if (!activeConvId) return;
  var conv = conversations.find(function (c) {
    return c.id === activeConvId;
  });
  if (!conv || state.messages.length === 0) return;
  conv.messages = state.messages.map(function (m) {
    var obj = { role: m.role, content: m.content, model: m.model };
    if (m.reasoning) obj.reasoning = m.reasoning;
    return obj;
  });
  if (!conv.customTitle) conv.title = getConvTitle(state.messages);
  persistConversations();
}
function switchToConversation(id) {
  if (state.isStreaming) return;
  saveCurrentConversation();
  var conv = conversations.find(function (c) {
    return c.id === id;
  });
  if (!conv) return;
  activeConvId = id;
  state.messages = conv.messages.map(function (m) {
    var obj = { role: m.role, content: m.content, attachments: [], model: m.model };
    if (m.reasoning) obj.reasoning = m.reasoning;
    return obj;
  });
  artifacts = [];
  nextArtifactId = 0;
  clearAttachments();
  els.messages.innerHTML = "";
  els.messages.appendChild(els.emptyState);
  els.emptyState.style.display = state.messages.length > 0 ? "none" : "";
  document.body.classList.toggle("oh-is-new-conv", state.messages.length === 0);
  for (var i = 0; i < state.messages.length; i++) {
    var m = state.messages[i];
    renderMessage(m.role, m.content, [], m.reasoning);
  }
  els.chatTitle.textContent = conv.title;
  renderConvList();
  updateEmptyState();
  updateSendButton();
}
function deleteConversation(id) {
  conversations = conversations.filter(function (c) {
    return c.id !== id;
  });
  persistConversations();
  if (activeConvId === id) {
    var sorted = conversations.slice().sort(function (a, b) {
      return b.updatedAt - a.updatedAt;
    });
    sorted.length > 0 ? switchToConversation(sorted[0].id) : startNewConversation();
  } else renderConvList();
}
function startRenaming(convId) {
  var item = els.convList.querySelector('.conv-item[data-id="' + convId + '"]');
  if (!item) return;
  var titleEl = item.querySelector(".conv-item-title");
  var conv = conversations.find(function (c) {
    return c.id === convId;
  });
  if (!conv || !titleEl) return;
  var input = document.createElement("input");
  input.className = "conv-item-title";
  input.style.cssText =
    "border:none;background:var(--bg-surface);outline:none;font-family:inherit;font-size:14px;font-weight:500;color:var(--text-primary);width:100%;padding:0;margin:0";
  input.value = conv.customTitle ? conv.title : "";
  input.placeholder = conv.title;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  var done = false;
  function save() {
    if (done) return;
    done = true;
    var val = input.value.trim();
    if (val) {
      conv.title = val;
      conv.customTitle = true;
      els.chatTitle.textContent = val;
      persistConversations();
    }
    renderConvList();
  }
  function cancel() {
    if (done) return;
    done = true;
    renderConvList();
  }
  input.addEventListener("blur", save);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      input.removeEventListener("blur", save);
      save();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      input.removeEventListener("blur", save);
      cancel();
    }
  });
}
function startNewConversation() {
  if (state.isStreaming) return;
  saveCurrentConversation();
  var conv = {
    id: Date.now().toString(),
    title: state.isSearchMode ? t("chat.title.newSearch") : t("chat.title.new"),
    messages: [],
    updatedAt: Date.now(),
    pinned: false,
  };
  conversations = conversations.filter(function (c) {
    return c.messages.length > 0;
  });
  conversations.unshift(conv);
  activeConvId = conv.id;
  state.messages = [];
  artifacts = [];
  nextArtifactId = 0;
  clearAttachments();
  els.input.value = "";
  resizeTextarea();
  els.messages.innerHTML = "";
  els.messages.appendChild(els.emptyState);
  els.emptyState.style.display = "";
  document.body.classList.add("oh-is-new-conv");
  els.chatTitle.textContent = state.isSearchMode
    ? t("chat.title.newSearch")
    : t("chat.title.new");
  renderConvList();
  updateEmptyState();
  updateSendButton();
}

/* ── Init ── */
async function init() {
  // ═══ IMMEDIATE DEFAULTS — UI responsive instantly ═══
  state.initReady = true;
  state.proxyUrl = "http://127.0.0.1:9999";
  // Real per-session token is loaded from getChatConfig() below; no static fallback.
  state.token = "";

  // ═══ LOAD CONVERSATIONS (sync from localStorage first) ═══
  var convs = [];

  try {
    var raw = localStorage.getItem(getHistoryKey());
    if (raw && raw !== "[]") {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        convs = parsed.filter(function (c) {
          return c && typeof c === "object" && c.id && Array.isArray(c.messages);
        });
      }
    }
  } catch (e) {}

  // If localStorage empty, try file backup (quick IPC)
  if (convs.length === 0 && !state.isSearchMode) {
    try {
      var backupRaw = await window.openhub.readChatBackup();
      if (backupRaw && backupRaw.length > 10) {
        var parsed = JSON.parse(backupRaw);
        if (Array.isArray(parsed)) {
          convs = parsed.filter(function (c) {
            return c && typeof c === "object" && c.id && Array.isArray(c.messages);
          });
          if (convs.length > 0) {
            localStorage.setItem(getHistoryKey(), backupRaw);
          }
        }
      }
    } catch (e) {
      console.warn("[chat] Backup restore failed:", e);
    }
  }

  conversations = convs || [];

  // Always start with a fresh conversation
  startNewConversation();

  // ═══ BACKGROUND — config, models, projects ═══
  window.openhub
    .getChatConfig()
    .then(function (c) {
      if (c && c.proxyUrl) {
        state.proxyUrl = c.proxyUrl;
        state.token = c.token || "";
      }
      refreshModels().catch(function (e) {
        console.error("[chat] models failed:", e);
      });
    })
    .catch(function () {
      refreshModels().catch(function (e) {
        console.error("[chat] models failed:", e);
      });
    });

  loadProjects().catch(function (e) {
    console.error("[chat] projects failed:", e);
  });

  setInterval(syncProjects, 5000);
  setInterval(writeBackup, 60000);
}

/* ── Projects ── */
function loadProjects() {
  return Promise.all([window.openhub.getProjects(), window.openhub.getActiveProject()])
    .then(function (res) {
      projState.projects = res[0] || [];
      projState.active = res[1] || null;
      renderProjectUI();
    })
    .catch(function (err) {
      console.error("[chat] loadProjects failed:", err);
    });
}
function syncProjects() {
  Promise.all([window.openhub.getProjects(), window.openhub.getActiveProject()])
    .then(function (res) {
      var np = res[0] || [],
        na = res[1] || null;
      if (
        JSON.stringify(np) !== JSON.stringify(projState.projects) ||
        (na ? na.id : null) !== (projState.active ? projState.active.id : null)
      ) {
        projState.projects = np;
        projState.active = na;
        renderProjectUI();
      }
    })
    .catch(function () {});
}
function activateProject(id) {
  window.openhub
    .setActiveProject(id)
    .then(loadProjects)
    .catch(function (err) {
      console.error("[chat] setActiveProject failed:", err);
    });
}
function saveProjectData(data) {
  return window.openhub.saveProject(data).then(function (np) {
    return loadProjects().then(function () {
      return np;
    });
  });
}
function removeProject(id) {
  return window.openhub.deleteProject(id).then(loadProjects);
}
function renderProjectUI() {
  if (window.renderProjectsHub) {
    window.renderProjectsHub();
  }

  // Update the active project name in the pill
  var pill = document.getElementById("activeProjectName");
  if (pill) {
    pill.textContent = projState.active ? projState.active.name : t("chat.project.none");
  }
}

/* ── Model & reasoning ── */
function fetchWithTimeout(url, options, timeout) {
  return Promise.race([
    fetch(url, options),
    new Promise(function (_, reject) {
      setTimeout(function () {
        return reject(new Error("Timeout"));
      }, timeout);
    }),
  ]);
}

function modelSupportsReasoningEffort(id) {
  if (!id) return false;
  var l = id.toLowerCase();
  // Skip models known NOT to support the parameter but having o1 in name
  if (l.includes("o1-mini") || l.includes("o1-preview")) return false;

  return (
    l.includes("o1") ||
    l.includes("o3") ||
    l.includes("o4") ||
    l.includes("deepseek") ||
    l.includes("claude-3-7") ||
    l.includes("claude-3.7") ||
    l.includes("thinking") ||
    l.includes("reasoning") ||
    l.includes("reflection") ||
    l.includes("r1") ||
    l.includes("pro-exp") ||
    l.includes("thinking-exp") ||
    l.includes("reasoner") ||
    l.includes("sonnet") ||
    l.includes("opus")
  );
}

function resolveReasoningStyle(model) {
  if (!model) return "openai";
  var m = model.toLowerCase();
  if (m.includes("/")) return "openai";
  if (m.startsWith("claude-")) return "anthropic";
  return "openai";
}

function getReasoningLevels(id) {
  if (!id) return [];
  if (resolveReasoningStyle(id) === "anthropic") {
    return [
      {
        id: "none",
        name: t("chat.reasoning.none.name"),
        desc: t("chat.reasoning.none.desc"),
      },
      {
        id: "minimal",
        name: t("chat.reasoning.minimal.name"),
        desc: t("chat.reasoning.minimal.desc"),
      },
      {
        id: "low",
        name: t("chat.reasoning.low.name"),
        desc: t("chat.reasoning.low.desc"),
      },
      {
        id: "medium",
        name: t("chat.reasoning.medium.name"),
        desc: t("chat.reasoning.medium.desc"),
      },
      {
        id: "high",
        name: t("chat.reasoning.high.name"),
        desc: t("chat.reasoning.high.desc"),
      },
      {
        id: "xhigh",
        name: t("chat.reasoning.xhigh.name"),
        desc: t("chat.reasoning.xhigh.desc"),
      },
      {
        id: "max",
        name: t("chat.reasoning.max.name"),
        desc: t("chat.reasoning.max.desc"),
      },
    ];
  }

  return [
    {
      id: "none",
      name: t("chat.reasoning.none.name"),
      desc: t("chat.reasoning.none.desc"),
    },
    { id: "low", name: t("chat.reasoning.low.name"), desc: t("chat.reasoning.low.desc") },
    {
      id: "medium",
      name: t("chat.reasoning.medium.name"),
      desc: t("chat.reasoning.medium.desc"),
    },
    {
      id: "high",
      name: t("chat.reasoning.high.name"),
      desc: t("chat.reasoning.high.desc"),
    },
  ];
}
async function refreshModels() {
  try {
    var res = await fetchWithTimeout(
      state.proxyUrl + "/v1/models",
      {
        headers: { Authorization: "Bearer " + state.token },
      },
      4000,
    ); // 4s timeout

    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    state.models = data.data || [];
  } catch (e) {
    console.error("[chat] refreshModels failed:", e);
    if (!state.models) state.models = [];
  }

  var prevModel = state.selectedModel;
  if (state.models.length === 0) {
    state.selectedModel = null;
    if (els.modelLabel) els.modelLabel.textContent = t("chat.model.none");
    updateEmptyState();
    return;
  }

  var found =
    prevModel &&
    state.models.some(function (m) {
      return m.id === prevModel;
    });
  if (!found) {
    var dsFlash = state.models.find(function (m) {
      return m.id === "deepseek/deepseek-v4-flash";
    });
    state.selectedModel = dsFlash ? dsFlash.id : state.models[0].id;
  }

  if (els.modelLabel) {
    els.modelLabel.textContent =
      displayModelName(state.selectedModel) || t("chat.model.ready");
  }
  updateReasoningUI();
  updateEmptyState();
  updateSendButton();
}
function updateEmptyState() {
  var noModels = state.models.length === 0;
  if (state.isSearchMode) {
    els.emptyTitle.textContent = noModels
      ? t("chat.empty.braveMissing")
      : t("chat.empty.searchTitle");
    els.emptyDesc.textContent = noModels
      ? t("chat.empty.braveDesc")
      : t("chat.empty.searchDesc");
  } else {
    els.emptyTitle.textContent = noModels
      ? t("chat.empty.connectApi")
      : t("chat.empty.help");
    els.emptyDesc.textContent = noModels
      ? t("chat.empty.connectApiDesc")
      : t("chat.empty.helpDesc");
  }
}

/* ── Catalog ── */
var catalogState = { allModels: [], selectedIds: [], search: "" };
async function openCatalogModal() {
  showModal("modalCatalog");
  var list = $("catalogList");
  list.innerHTML =
    '<div class="oh-skel-list"><div class="oh-skel-row"><div class="oh-skel-box oh-skeleton"></div><div class="oh-skel-fill"><div class="oh-skeleton oh-skel-line" style="width:68%"></div><div class="oh-skeleton oh-skel-line" style="width:42%;height:10px"></div></div><div class="oh-skel-badge oh-skeleton"></div></div><div class="oh-skel-row"><div class="oh-skel-box oh-skeleton"></div><div class="oh-skel-fill"><div class="oh-skeleton oh-skel-line" style="width:55%"></div><div class="oh-skeleton oh-skel-line" style="width:35%;height:10px"></div></div><div class="oh-skel-badge oh-skeleton"></div></div><div class="oh-skel-row"><div class="oh-skel-box oh-skeleton"></div><div class="oh-skel-fill"><div class="oh-skeleton oh-skel-line" style="width:78%"></div><div class="oh-skeleton oh-skel-line" style="width:50%;height:10px"></div></div><div class="oh-skel-badge oh-skeleton"></div></div><div class="oh-skel-row"><div class="oh-skel-box oh-skeleton"></div><div class="oh-skel-fill"><div class="oh-skeleton oh-skel-line" style="width:62%"></div><div class="oh-skeleton oh-skel-line" style="width:40%;height:10px"></div></div><div class="oh-skel-badge oh-skeleton"></div></div><div class="oh-skel-row"><div class="oh-skel-box oh-skeleton"></div><div class="oh-skel-fill"><div class="oh-skeleton oh-skel-line" style="width:72%"></div><div class="oh-skeleton oh-skel-line" style="width:38%;height:10px"></div></div><div class="oh-skel-badge oh-skeleton"></div></div></div>';
  if (!state.initReady || !state.proxyUrl) {
    list.innerHTML =
      '<div style="padding:40px;text-align:center;color:var(--error)">' +
      escapeHtml(t("chat.catalog.initializing")) +
      "</div>";
    return;
  }
  try {
    var headers = { Authorization: "Bearer " + state.token };
    var [r1, r2] = await Promise.all([
      fetch(state.proxyUrl + "/v1/models/full", { headers: headers }),
      fetch(state.proxyUrl + "/v1/models/selected", { headers: headers }),
    ]);
    var d1 = await r1.json();
    var d2 = await r2.json();
    catalogState.allModels = d1.data || [];
    catalogState.selectedIds = d2.selectedModels || [];
    renderCatalogList();
  } catch (err) {
    list.innerHTML =
      '<div style="padding:40px;text-align:center;color:var(--error)">' +
      escapeHtml(t("chat.catalog.loadError")) +
      "</div>";
  }
}

function renderCatalogList() {
  var container = $("catalogList");
  var q = catalogState.search.toLowerCase().trim();
  var filtered = catalogState.allModels.filter(function (m) {
    return m.id.toLowerCase().includes(q);
  });

  var selectedGroup = [];
  var otherGroups = {};

  filtered.forEach(function (m) {
    var isSelected = catalogState.selectedIds.indexOf(m.id) !== -1;
    if (isSelected) {
      selectedGroup.push(m);
    } else {
      var source = m.source || "direct";
      var p = t("chat.catalog.group.direct");
      if (source === "openrouter") {
        p = "OpenRouter";
      } else if (source === "local") {
        p = t("chat.catalog.group.local");
      } else if (source === "workflow") {
        p = t("chat.catalog.group.workflow");
      }

      if (!otherGroups[p]) otherGroups[p] = [];
      otherGroups[p].push(m);
    }
  });

  container.innerHTML = "";

  function getSourceBadge(source) {
    if (source === "openrouter") {
      return '<span class="oh-catalog-source-badge" style="background:var(--warning-subtle);color:var(--warning);border-radius:var(--radius-sm);padding:2px 6px;font-size:10px;margin-left:8px;font-weight:600;display:inline-block;vertical-align:middle">OpenRouter</span>';
    } else if (source === "local") {
      return '<span class="oh-catalog-source-badge" style="background:var(--success-subtle);color:var(--success);border-radius:var(--radius-sm);padding:2px 6px;font-size:10px;margin-left:8px;font-weight:600;display:inline-block;vertical-align:middle">Local</span>';
    } else if (source === "workflow") {
      return '<span class="oh-catalog-source-badge" style="background:var(--accent-subtle);color:var(--accent-primary);border-radius:var(--radius-sm);padding:2px 6px;font-size:10px;margin-left:8px;font-weight:600;display:inline-block;vertical-align:middle">Workflow</span>';
    } else {
      return '<span class="oh-catalog-source-badge" style="background:var(--bg-surface);color:var(--text-muted);border-radius:var(--radius-sm);padding:2px 6px;font-size:10px;margin-left:8px;font-weight:600;display:inline-block;vertical-align:middle">Direct</span>';
    }
  }

  function bindToggleAction(item, m) {
    item.addEventListener("click", function (e) {
      e.stopPropagation();
      var id = m.id;
      var cb = item.querySelector(".oh-catalog-checkbox");
      var idx = catalogState.selectedIds.indexOf(id);
      if (idx === -1) {
        catalogState.selectedIds.push(id);
        if (cb) cb.checked = true;
        item.classList.add("oh-catalog-item--selected");
      } else {
        catalogState.selectedIds.splice(idx, 1);
        if (cb) cb.checked = false;
        item.classList.remove("oh-catalog-item--selected");
      }
    });
  }

  // 1. Render Selected group at the top
  if (selectedGroup.length > 0) {
    var gDiv = document.createElement("div");
    gDiv.className = "oh-catalog-provider-group";
    gDiv.innerHTML =
      '<div class="oh-catalog-provider-header" style="color:var(--accent-primary)">' +
      escapeHtml(t("chat.catalog.group.selected")) +
      "</div>";
    selectedGroup.forEach(function (m) {
      var item = document.createElement("div");
      item.className = "oh-catalog-item oh-catalog-item--selected";
      item.innerHTML =
        '<div class="oh-catalog-item-info" data-model-id="' +
        escapeHtml(m.id) +
        '">' +
        '<div class="oh-catalog-item-name">' +
        escapeHtml(displayModelName(m.id)) +
        getSourceBadge(m.source) +
        "</div>" +
        '<div class="oh-catalog-item-id">' +
        escapeHtml(displayModelName(m.id)) +
        "</div>" +
        "</div>" +
        '<label class="oh-catalog-checkbox-container">' +
        '<input type="checkbox" class="oh-catalog-checkbox" checked>' +
        '<span class="oh-catalog-checkmark"></span>' +
        "</label>";
      bindToggleAction(item, m);
      gDiv.appendChild(item);
    });
    container.appendChild(gDiv);
  }

  // 2. Render other groups
  Object.keys(otherGroups)
    .sort()
    .forEach(function (p) {
      var gDiv = document.createElement("div");
      gDiv.className = "oh-catalog-provider-group";
      gDiv.innerHTML =
        '<div class="oh-catalog-provider-header">' + escapeHtml(p) + "</div>";
      otherGroups[p].forEach(function (m) {
        var item = document.createElement("div");
        item.className = "oh-catalog-item";
        item.innerHTML =
          '<div class="oh-catalog-item-info" data-model-id="' +
          escapeHtml(m.id) +
          '">' +
          '<div class="oh-catalog-item-name">' +
          escapeHtml(displayModelName(m.id)) +
          getSourceBadge(m.source) +
          "</div>" +
          '<div class="oh-catalog-item-id">' +
          escapeHtml(displayModelName(m.id)) +
          "</div>" +
          "</div>" +
          '<label class="oh-catalog-checkbox-container">' +
          '<input type="checkbox" class="oh-catalog-checkbox">' +
          '<span class="oh-catalog-checkmark"></span>' +
          "</label>";
        bindToggleAction(item, m);
        gDiv.appendChild(item);
      });
      container.appendChild(gDiv);
    });

  // 3. Show empty state for local models when none are discovered
  var localGroupLabel = t("chat.catalog.group.local");
  var hasLocalModels =
    filtered.some(function (m) {
      return m.source === "local";
    }) || !!otherGroups[localGroupLabel];
  if (!hasLocalModels && !q) {
    var gDiv = document.createElement("div");
    gDiv.className = "oh-catalog-provider-group";
    gDiv.innerHTML =
      '<div class="oh-catalog-provider-header">' + escapeHtml(localGroupLabel) + "</div>";
    var msg = document.createElement("div");
    msg.style.cssText =
      "padding:12px 16px;color:var(--text-muted);font-size:12px;line-height:1.5";
    if (window.openhub && window.openhub.ollamaCheckModels) {
      window.openhub
        .ollamaCheckModels()
        .then(function (status) {
          if (!status || !status.running) {
            msg.textContent = t("chat.catalog.ollamaStopped");
          } else {
            msg.textContent = t("chat.catalog.ollamaPull");
          }
        })
        .catch(function () {
          msg.textContent = t("chat.catalog.ollamaNone");
        });
    } else {
      msg.textContent = t("chat.catalog.ollamaNone");
    }
    gDiv.appendChild(msg);
    container.appendChild(gDiv);
  }

  if (filtered.length === 0 && !container.hasChildNodes())
    container.innerHTML =
      '<div style="padding:40px;text-align:center;color:var(--text-muted)">' +
      escapeHtml(t("chat.catalog.noModels")) +
      "</div>";
}

async function saveCatalogSelections() {
  var btn = $("btnSaveCatalog");
  btn.disabled = true;
  btn.textContent = t("chat.catalog.saving");
  if (!state.initReady || !state.proxyUrl) {
    alert(t("chat.catalog.initAlert"));
    btn.disabled = false;
    btn.textContent = t("chat.catalog.save");
    return;
  }
  try {
    var res = await fetch(state.proxyUrl + "/v1/models/selected", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + state.token,
      },
      body: JSON.stringify({ models: catalogState.selectedIds }),
    });
    if (!res.ok) throw new Error(t("chat.catalog.saveFailed"));
    await refreshModels();
    closeModal("modalCatalog");
  } catch (err) {
    alert(t("chat.catalog.saveError", { msg: err.message }));
  } finally {
    btn.disabled = false;
    btn.textContent = t("chat.catalog.save");
  }
}

/* ── Web search (interrupteur maître partagé avec Config « Recherche Internet ») ── */
function syncWebSearchUI() {
  var btn = $("ddWebSearch");
  btn.classList.toggle("more-dropdown-item--active", state.webSearchEnabled);
  btn.setAttribute("aria-pressed", state.webSearchEnabled.toString());
}
if (window.openhub.getWebSearchEnabled) {
  window.openhub.getWebSearchEnabled().then(function (e) {
    state.webSearchEnabled = !!e;
    syncWebSearchUI();
  });
}
$("ddWebSearch").addEventListener("click", function (e) {
  e.stopPropagation();
  state.webSearchEnabled = !state.webSearchEnabled;
  if (window.openhub.setWebSearchEnabled)
    window.openhub.setWebSearchEnabled(state.webSearchEnabled);
  syncWebSearchUI();
  $("btnInputMore").click();
});

/* Pré-jugement : un petit modèle rapide (« Tri des informations ») décide si une
   recherche web est nécessaire. Renvoie la requête à chercher, ou null si inutile.
   Fail-safe : toute erreur → null (on ne cherche pas, on ne bloque jamais la réponse). */
var WEB_SEARCH_DECISION_PROMPT =
  "Tu décides si répondre au message nécessite une recherche web. " +
  "Réponds par une recherche UNIQUEMENT si le message demande des informations récentes, des actualités, " +
  "des données factuelles qui changent (prix, météo, événements, versions, statistiques), ou des faits sur " +
  "des entités/pages précises que tu ne peux pas connaître de façon fiable. Pour du code, du raisonnement, " +
  "du créatif, de la reformulation ou des connaissances générales stables, NE cherche PAS. " +
  "Si une recherche est nécessaire, réponds UNIQUEMENT par la requête de recherche optimale (quelques mots-clés). " +
  "Sinon, réponds UNIQUEMENT par le mot : NON";

var _classifierModel = null;
async function getClassifierModel() {
  if (_classifierModel) return _classifierModel;
  if (window.openhub.getAiClassifierModel) {
    try {
      _classifierModel = await window.openhub.getAiClassifierModel();
    } catch (_) {
      /* ignore */
    }
  }
  return _classifierModel || "deepseek/deepseek-v4-flash";
}

async function decideWebSearch(text) {
  try {
    var model = await getClassifierModel();
    var resp = await fetch(state.proxyUrl + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + state.token,
      },
      body: JSON.stringify({
        model: model,
        stream: false,
        bypassInjection: true, // pas de mémoire/vision/extraction pour ce méta-appel
        temperature: 0,
        max_tokens: 60,
        messages: [
          { role: "system", content: WEB_SEARCH_DECISION_PROMPT },
          { role: "user", content: text.slice(0, 2000) },
        ],
      }),
    });
    if (!resp.ok) return null;
    var data = await resp.json();
    var out = (
      (data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : "") || ""
    ).trim();
    if (!out || /^non\b/i.test(out)) return null;
    var q = out.replace(/^["']|["']$/g, "").trim();
    if (q.length > 200) q = q.slice(0, 197) + "...";
    return q || null;
  } catch (_) {
    return null;
  }
}

/* ── UI events ── */
function switchSearchMode(enabled) {
  if (state.isStreaming) return;
  saveCurrentConversation();

  state.isSearchMode = enabled;
  document.body.classList.toggle("oh-search-mode", enabled);
  els.btnNavSearch.classList.toggle("active", enabled);
  els.btnNavNewChat.classList.toggle("active", !enabled);

  // Update sidebar title
  document.querySelector(".conv-sidebar-title").textContent = enabled
    ? t("chat.sidebar.searchesTitle")
    : t("chat.sidebar.conversationsTitle");

  // Update input placeholder
  els.input.placeholder = enabled
    ? t("chat.input.placeholderSearch")
    : t("chat.input.placeholderMessage");

  // Update empty state icon
  var emptyIcon = document.querySelector(".empty-state-icon");
  if (emptyIcon) {
    emptyIcon.innerHTML = enabled
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
  }

  // Le mode « Recherches » n'active plus la recherche de force : c'est l'interrupteur
  // maître « Recherche Internet » + le pré-jugement de l'IA qui décident (cf. decideWebSearch).

  // Load specific history
  loadConversations().then(function (convs) {
    conversations = convs || [];
    if (conversations.length > 0) {
      switchToConversation(conversations[0].id);
    } else {
      startNewConversation();
    }
    renderConvList();
  });
}

if (els.btnNavNewChat) {
  els.btnNavNewChat.addEventListener("click", function () {
    var btnHub = document.getElementById("btnNavProjects");
    if (btnHub) btnHub.classList.remove("active");
    els.btnNavNewChat.classList.add("active");
    if (els.btnNavSearch) els.btnNavSearch.classList.remove("active");

    window.switchMainView("chatView");

    if (state.isSearchMode) {
      switchSearchMode(false);
    } else {
      startNewConversation();
    }
  });
}

if (els.btnNavSearch) {
  els.btnNavSearch.addEventListener("click", function () {
    var btnHub = document.getElementById("btnNavProjects");
    if (btnHub) btnHub.classList.remove("active");
    els.btnNavNewChat.classList.remove("active");
    els.btnNavSearch.classList.add("active");

    window.switchMainView("chatView");

    if (!state.isSearchMode) {
      switchSearchMode(true);
    } else {
      startNewConversation();
    }
  });
}
els.convSearch.addEventListener("input", function () {
  renderConvList(this.value);
});
$("btnSidebarToggle").addEventListener("click", function (e) {
  e.stopPropagation();
  var sidebar = document.querySelector(".conv-sidebar");
  var isMobile = window.innerWidth <= 700;
  if (isMobile) {
    sidebar.classList.toggle("conv-sidebar--open");
  } else {
    sidebar.classList.toggle("hidden");
    var isHidden = sidebar.classList.contains("hidden");
    this.title = isHidden ? t("chat.sidebar.show") : t("chat.sidebar.hide");
    this.setAttribute("aria-label", this.title);
  }
});
els.messages.parentElement.addEventListener("click", function () {
  if (window.innerWidth <= 700) {
    document.querySelector(".conv-sidebar").classList.remove("conv-sidebar--open");
  }
});

/* "+" dropdown */
$("btnInputMore").addEventListener("click", function (e) {
  e.stopPropagation();
  var isOpen = $("moreDropdown").classList.toggle("more-dropdown--open");
  this.classList.toggle("btn-input-more--open", isOpen);
});
document.addEventListener("click", function () {
  $("moreDropdown").classList.remove("more-dropdown--open");
  $("btnInputMore").classList.remove("btn-input-more--open");
});
$("ddCatalog").addEventListener("click", function (e) {
  e.stopPropagation();
  $("btnInputMore").click();
  openCatalogModal();
});
$("ddAttach").addEventListener("click", function (e) {
  e.stopPropagation();
  $("btnInputMore").click();
  els.fileInput.click();
});
$("ddProject").addEventListener("click", function (e) {
  e.stopPropagation();
  $("btnInputMore").click();
  loadProjects().then(function () {
    window.switchMainView("projectsHubView");
    window.renderProjectsHub();
  });
});
$("ddSkills").addEventListener("click", function (e) {
  e.stopPropagation();
  $("btnInputMore").click();
  showModal("modalSkills");
  renderSkillsModal();
});
els.btnModelCtx.addEventListener("click", function (e) {
  e.stopPropagation();
  if ($("reasoningDropdown")) $("reasoningDropdown").style.display = "none";
  toggleModelDropdown();
});
if (els.btnReasoningCtx) {
  els.btnReasoningCtx.addEventListener("click", function (e) {
    e.stopPropagation();
    if ($("modelDropdown")) $("modelDropdown").style.display = "none";
    toggleReasoningDropdown();
  });
}

function updateReasoningUI() {
  if (!els.reasoningWrap) return;
  els.reasoningWrap.style.display = "none";
}

function toggleReasoningDropdown() {
  var dd = $("reasoningDropdown");
  if (!dd || !state.initReady) return;
  if (dd.style.display === "block") {
    dd.style.display = "none";
    return;
  }
  dd.innerHTML = "";
  var levels = getReasoningLevels(state.selectedModel);
  levels.forEach(function (itemData) {
    var currentEffort = getModelEffort(state.selectedModel);
    var active = itemData.id === currentEffort;
    var item = document.createElement("button");
    item.className = "dropdown-item" + (active ? " dropdown-item--active" : "");
    item.style.display = "flex";
    item.style.flexDirection = "column";
    item.style.alignItems = "flex-start";
    item.style.gap = "2px";
    item.style.padding = "6px 12px";
    item.innerHTML =
      '<div style="font-weight:600;font-size:12.5px">' +
      escapeHtml(itemData.name) +
      "</div>" +
      '<div style="font-size:10px;color:var(--text-muted)">' +
      escapeHtml(itemData.desc) +
      "</div>";

    item.addEventListener("click", function (e) {
      e.stopPropagation();
      setModelEffort(state.selectedModel, itemData.id);
      updateReasoningUI();
      dd.style.display = "none";
    });
    dd.appendChild(item);
  });
  dd.style.display = "block";
}

function toggleModelDropdown() {
  var dd = $("modelDropdown");
  if (!dd || !state.initReady) return;

  if (dd.style.display === "block") {
    dd.style.display = "none";
    return;
  }

  dd.innerHTML = "";

  if (state.models.length === 0) {
    dd.innerHTML =
      '<div class="oh-skel-list" style="padding:4px 0"><div class="oh-skel-row oh-skel-row--compact"><div class="oh-skel-fill"><div class="oh-skeleton oh-skel-line" style="width:62%;height:11px"></div></div><div class="oh-skel-badge oh-skeleton" style="width:40px;height:16px"></div></div><div class="oh-skel-row oh-skel-row--compact"><div class="oh-skel-fill"><div class="oh-skeleton oh-skel-line" style="width:75%;height:11px"></div></div><div class="oh-skel-badge oh-skeleton" style="width:56px;height:16px"></div></div><div class="oh-skel-row oh-skel-row--compact"><div class="oh-skel-fill"><div class="oh-skeleton oh-skel-line" style="width:55%;height:11px"></div></div><div class="oh-skel-badge oh-skeleton" style="width:40px;height:16px"></div></div></div>';
  }
  for (var i = 0; i < state.models.length; i++) {
    (function (m) {
      var active = m.id === state.selectedModel;
      var item = document.createElement("button");
      item.className = "dropdown-item" + (active ? " dropdown-item--active" : "");
      var badge = "";
      if (m.source === "openrouter") {
        badge =
          '<span style="background:var(--warning-subtle);color:var(--warning);border-radius:var(--radius-sm);padding:1px 5px;font-size:9.5px;margin-left:auto;font-weight:600">OpenRouter</span>';
      } else if (m.source === "local") {
        badge =
          '<span style="background:var(--success-subtle);color:var(--success);border-radius:var(--radius-sm);padding:1px 5px;font-size:9.5px;margin-left:auto;font-weight:600">Local</span>';
      } else if (m.source === "workflow") {
        badge =
          '<span style="background:var(--accent-subtle);color:var(--accent-primary);border-radius:var(--radius-sm);padding:1px 5px;font-size:9.5px;margin-left:auto;font-weight:600">Workflow</span>';
      } else {
        badge =
          '<span style="background:var(--bg-surface);color:var(--text-muted);border-radius:var(--radius-sm);padding:1px 5px;font-size:9.5px;margin-left:auto;font-weight:600">Direct</span>';
      }

      var showReasoning = modelSupportsReasoningEffort(m.id);
      var effortLabel = "";
      if (showReasoning) {
        var savedEffort = getModelEffort(m.id);
        var levels = getReasoningLevels(m.id);
        for (var li = 0; li < levels.length; li++) {
          if (levels[li].id === savedEffort) {
            effortLabel = levels[li].name;
            break;
          }
        }
        effortLabel = effortLabel || t("chat.reasoning.medium.name");
        badge +=
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;margin-left:4px;opacity:0.5;flex-shrink:0"><polyline points="9 18 15 12 9 6"></polyline></svg>';
      }

      item.innerHTML =
        '<div style="display:flex;align-items:center;width:100%">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' +
        escapeHtml(displayModelName(m.id)) +
        "</span>" +
        '<div style="display:flex;align-items:center;margin-left:8px">' +
        badge +
        "</div>" +
        "</div>";

      if (showReasoning) {
        item.title = t("chat.reasoning.titleWith", { label: effortLabel });
      }

      item.addEventListener("click", function (e) {
        e.stopPropagation();
        state.selectedModel = m.id;
        els.modelLabel.textContent = displayModelName(m.id);
        updateReasoningUI();
        dd.style.display = "none";
        updateSendButton();
      });
      dd.appendChild(item);
    })(state.models[i]);
  }

  var currentShowReasoning = modelSupportsReasoningEffort(state.selectedModel);
  if (currentShowReasoning) {
    var sepReasoning = document.createElement("div");
    sepReasoning.style.cssText =
      "height:1px;background:var(--border-subtle);margin:4px 8px";
    dd.appendChild(sepReasoning);

    var levelsForModel = getReasoningLevels(state.selectedModel);
    var levelsObj = {};
    levelsForModel.forEach(function (l) {
      levelsObj[l.id] = l.name;
    });
    var currentEffort = getModelEffort(state.selectedModel);
    var currentLevelName = levelsObj[currentEffort] || t("chat.reasoning.medium.name");

    var reasonBtn = document.createElement("button");
    reasonBtn.className = "dropdown-item";
    reasonBtn.style.display = "flex";
    reasonBtn.style.justifyContent = "space-between";
    reasonBtn.style.alignItems = "center";
    reasonBtn.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:flex-start;gap:2px">' +
      '<div style="font-weight:500;font-size:13px;color:var(--text-primary)">' +
      escapeHtml(t("chat.reasoning.menuTitle")) +
      "</div>" +
      '<div style="font-size:11px;color:var(--text-muted)">' +
      escapeHtml(currentLevelName) +
      "</div>" +
      "</div>" +
      '<svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" style="width:16px;height:16px;flex-shrink:0" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';

    reasonBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      showReasoningSubMenu();
    });
    dd.appendChild(reasonBtn);
  }

  var sep = document.createElement("div");
  sep.style.cssText = "height:1px;background:var(--border-subtle);margin:4px 8px";
  dd.appendChild(sep);
  var catBtn = document.createElement("button");
  catBtn.className = "dropdown-item";
  catBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8.56 2.75c4.37 6.03 6.02 9.42 8.03 17.72m2.54-15.38c-3.72 4.35-8.94 5.66-16.88 5.85m19.5 1.9c-3.5-.93-6.63-.82-8.94 0-2.58.92-4.01 2.86-4.01 4.7"></path></svg> ' +
    escapeHtml(t("chat.catalog.open"));
  catBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    dd.style.display = "none";
    openCatalogModal();
  });
  dd.appendChild(catBtn);
  dd.style.display = "block";
}
document.addEventListener("click", function () {
  var dd1 = $("modelDropdown");
  if (dd1) dd1.style.display = "none";
});

$("catalogSearch").addEventListener("input", function () {
  catalogState.search = this.value;
  renderCatalogList();
});
$("btnSaveCatalog").addEventListener("click", saveCatalogSelections);

function showReasoningSubMenu() {
  var dd = $("modelDropdown");
  if (!dd) return;

  dd.innerHTML = "";

  var levels = getReasoningLevels(state.selectedModel);
  var currentEffort = getModelEffort(state.selectedModel);

  levels.forEach(function (itemData) {
    var active = itemData.id === currentEffort;
    var item = document.createElement("button");
    item.className = "dropdown-item" + (active ? " dropdown-item--active" : "");
    item.style.display = "flex";
    item.style.flexDirection = "column";
    item.style.alignItems = "flex-start";
    item.style.gap = "2px";
    item.innerHTML =
      '<div style="font-weight:600;font-size:12.5px">' +
      escapeHtml(itemData.name) +
      "</div>" +
      '<div style="font-size:10px;color:var(--text-muted)">' +
      escapeHtml(itemData.desc) +
      "</div>";

    item.onclick = function (e) {
      e.stopPropagation();
      setModelEffort(state.selectedModel, itemData.id);
      dd.style.display = "none";
      toggleModelDropdown();
    };
    dd.appendChild(item);
  });

  // Back button
  var back = document.createElement("button");
  back.className = "dropdown-item";
  back.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-right:6px"><polyline points="15 18 9 12 15 6"/></svg><span>' +
    escapeHtml(t("chat.reasoning.back")) +
    "</span>";
  back.addEventListener("click", function (e) {
    e.stopPropagation();
    dd.innerHTML = "";
    dd.style.display = "none";
    toggleModelDropdown();
  });
  dd.appendChild(back);
}

/* Project modal */
function renderProjectModal() {
  var list = $("projectList");
  list.innerHTML = "";
  var noneItem = document.createElement("div");
  noneItem.className = "modal-item" + (projState.active ? "" : " modal-item--active");
  noneItem.innerHTML =
    '<div><div class="modal-item-name">' +
    escapeHtml(t("chat.project.modal.none")) +
    '</div><div class="modal-item-desc">' +
    escapeHtml(t("chat.project.modal.noneDesc")) +
    "</div></div>";
  noneItem.addEventListener("click", function () {
    activateProject(null);
    closeModal("modalProject");
  });
  list.appendChild(noneItem);
  projState.projects.forEach(function (p) {
    var item = document.createElement("div");
    item.className =
      "modal-item" +
      (projState.active && projState.active.id === p.id ? " modal-item--active" : "");
    item.innerHTML =
      '<div><div class="modal-item-name">' +
      escapeHtml(p.name) +
      '</div><div class="modal-item-desc">' +
      (p.instructions
        ? escapeHtml(
            p.instructions.slice(0, 80) + (p.instructions.length > 80 ? "…" : ""),
          )
        : t("chat.project.modal.noInstructions")) +
      "</div></div>";
    item.addEventListener("click", function () {
      activateProject(p.id);
      closeModal("modalProject");
    });
    list.appendChild(item);
  });
  var sep = document.createElement("div");
  sep.style.cssText = "border-top:1px solid var(--border-subtle);margin:8px 0";
  list.appendChild(sep);
  var newBtn = document.createElement("div");
  newBtn.className = "modal-item";
  newBtn.innerHTML =
    '<div><div class="modal-item-name" style="color:var(--accent-primary)">' +
    escapeHtml(t("chat.project.modal.new")) +
    "</div></div>";
  newBtn.addEventListener("click", function () {
    closeModal("modalProject");
    openProjModal(null);
  });
  list.appendChild(newBtn);
}
function openProjModal(proj) {
  closeProjModal();
  var isEdit = Boolean(proj);
  var overlay = document.createElement("div");
  overlay.id = "oh-proj-modal-overlay";
  overlay.className = "modal-overlay";
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) {
      overlay.remove();
    }
  });
  var modal = document.createElement("div");
  modal.className = "modal";
  var hdr = document.createElement("div");
  hdr.className = "oh-modal-hdr";
  hdr.innerHTML =
    "<h2>" +
    (isEdit
      ? escapeHtml(t("chat.project.modal.editTitle"))
      : escapeHtml(t("chat.project.modal.newTitle"))) +
    '</h2><button class="oh-modal-x">×</button>';
  hdr.querySelector("button").addEventListener("click", function () {
    overlay.remove();
  });
  var nameField = document.createElement("div");
  nameField.className = "oh-modal-field";
  nameField.innerHTML =
    "<label>" +
    escapeHtml(t("chat.project.field.name")) +
    '</label><input type="text" placeholder="' +
    escapeHtml(t("chat.project.field.namePlaceholder")) +
    '" value="' +
    (proj ? escapeHtml(proj.name) : "") +
    '">';
  var nameInput = nameField.querySelector("input");
  var colorField = document.createElement("div");
  colorField.className = "oh-modal-field";
  colorField.innerHTML =
    "<label>" +
    escapeHtml(t("chat.project.field.color")) +
    '</label><div class="oh-color-row"></div>';
  var colorRow = colorField.querySelector(".oh-color-row");
  var selectedColor = proj ? proj.color : PROJ_COLORS[0];
  PROJ_COLORS.forEach(function (c) {
    var sw = document.createElement("button");
    sw.className = "oh-color-swatch" + (c === selectedColor ? " oh-selected" : "");
    sw.style.background = c;
    sw.type = "button";
    sw.addEventListener("click", function () {
      selectedColor = c;
      colorRow.querySelectorAll(".oh-color-swatch").forEach(function (s) {
        s.classList.toggle("oh-selected", s.style.background === c);
      });
    });
    colorRow.appendChild(sw);
  });
  var instrField = document.createElement("div");
  instrField.className = "oh-modal-field oh-modal-field-grow";
  instrField.innerHTML =
    "<label>" +
    escapeHtml(t("chat.project.field.instructions")) +
    '</label><span class="oh-field-help">' +
    escapeHtml(t("chat.project.field.instructionsHelp")) +
    '</span><textarea placeholder="' +
    escapeHtml(t("chat.project.field.instructionsPlaceholder")) +
    '">' +
    (proj ? escapeHtml(proj.instructions) : "") +
    "</textarea>";
  var instrTA = instrField.querySelector("textarea");
  var ftr = document.createElement("div");
  ftr.className = "oh-modal-ftr";
  if (isEdit) {
    var delBtn = document.createElement("button");
    delBtn.className = "oh-btn oh-btn-danger";
    delBtn.textContent = t("chat.project.delete");
    delBtn.addEventListener("click", function () {
      removeProject(proj.id);
      overlay.remove();
    });
    ftr.appendChild(delBtn);
  }
  var spacer = document.createElement("div");
  spacer.style.flex = "1";
  ftr.appendChild(spacer);
  var cancelBtn = document.createElement("button");
  cancelBtn.className = "oh-btn oh-btn-ghost";
  cancelBtn.textContent = t("chat.project.cancel");
  cancelBtn.addEventListener("click", function () {
    overlay.remove();
  });
  ftr.appendChild(cancelBtn);
  var saveBtn = document.createElement("button");
  saveBtn.className = "oh-btn oh-btn-primary";
  saveBtn.textContent = isEdit ? t("chat.project.save") : t("chat.project.create");
  saveBtn.addEventListener("click", function () {
    var name = nameInput.value.trim();
    if (!name) {
      nameInput.style.borderColor = "var(--error)";
      return;
    }
    var data = { name: name, instructions: instrTA.value, color: selectedColor };
    if (isEdit) data.id = proj.id;
    saveProjectData(data).then(function (np) {
      overlay.remove();
      if (!isEdit && np) activateProject(np.id);
    });
  });
  ftr.appendChild(saveBtn);
  modal.appendChild(hdr);
  modal.appendChild(nameField);
  modal.appendChild(colorField);
  modal.appendChild(instrField);
  modal.appendChild(ftr);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  nameInput.focus();
}
function closeProjModal() {
  var el = document.getElementById("oh-proj-modal-overlay");
  if (el) el.remove();
}

/* Modal helpers */
function showModal(id) {
  var ids = ["modalCatalog", "modalReasoning", "modalProject", "modalSkills"];
  for (var i = 0; i < ids.length; i++) {
    var currentId = ids[i];
    if (currentId !== id) {
      closeModal(currentId);
    }
  }
  closeProjModal();
  closeSkillEditorModal();
  var el = $(id);
  if (el) el.classList.remove("hidden");
}
function closeModal(id) {
  closeProjModal();
  closeSkillEditorModal();
  var el = $(id);
  if (el) el.classList.add("hidden");
}
// Delegated close-modal buttons (CSP: no inline onclick).
document.addEventListener("click", function (e) {
  var btn = e.target.closest("[data-close-modal]");
  if (btn) closeModal(btn.dataset.closeModal);
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    var ids = ["modalCatalog", "modalReasoning", "modalProject", "modalSkills"];
    for (var i = 0; i < ids.length; i++) {
      closeModal(ids[i]);
    }
    closeProjModal();
    closeSkillEditorModal();
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      els.input.focus();
    }
  }
});

/* Skills modal & editor */
function renderSkillsModal() {
  var list = $("skillsList");
  list.innerHTML = "";
  var loading = document.createElement("div");
  loading.innerHTML =
    '<div class="oh-skel-list"><div class="oh-skel-row"><div class="oh-skel-box oh-skeleton" style="width:28px;height:28px;border-radius:var(--radius-sm,6px)"></div><div class="oh-skel-fill"><div class="oh-skeleton oh-skel-line" style="width:48%"></div><div class="oh-skeleton oh-skel-line" style="width:80%;height:10px"></div></div></div><div class="oh-skel-row"><div class="oh-skel-box oh-skeleton" style="width:28px;height:28px;border-radius:var(--radius-sm,6px)"></div><div class="oh-skel-fill"><div class="oh-skeleton oh-skel-line" style="width:60%"></div><div class="oh-skeleton oh-skel-line" style="width:70%;height:10px"></div></div></div><div class="oh-skel-row"><div class="oh-skel-box oh-skeleton" style="width:28px;height:28px;border-radius:var(--radius-sm,6px)"></div><div class="oh-skel-fill"><div class="oh-skeleton oh-skel-line" style="width:52%"></div><div class="oh-skeleton oh-skel-line" style="width:75%;height:10px"></div></div></div></div>';
  list.appendChild(loading);
  window.openhub
    .getSkills()
    .then(function (skills) {
      list.innerHTML = "";
      if (skills.length === 0) {
        var empty = document.createElement("div");
        empty.style.color = "var(--text-secondary)";
        empty.style.padding = "20px";
        empty.style.textAlign = "center";
        empty.textContent = t("chat.skills.empty");
        list.appendChild(empty);
      } else {
        skills.forEach(function (s) {
          var item = document.createElement("div");
          item.className = "modal-item";
          item.style.cursor = "pointer";
          item.innerHTML =
            '<div><div class="modal-item-name">' +
            escapeHtml(s.title) +
            '</div><div class="modal-item-desc" style="font-family:monospace;font-size:11px;white-space:pre-wrap;max-height:80px;overflow:hidden;margin-top:4px;">' +
            escapeHtml(s.content.slice(0, 150)) +
            "...</div></div>";
          item.addEventListener("click", function () {
            closeModal("modalSkills");
            openSkillEditorModal(s);
          });
          list.appendChild(item);
        });
      }
      var sep = document.createElement("div");
      sep.style.cssText = "border-top:1px solid var(--border-subtle);margin:8px 0";
      list.appendChild(sep);
      var newBtn = document.createElement("div");
      newBtn.className = "modal-item";
      newBtn.innerHTML =
        '<div><div class="modal-item-name" style="color:var(--accent-primary)">' +
        escapeHtml(t("chat.skills.new")) +
        "</div></div>";
      newBtn.addEventListener("click", function () {
        closeModal("modalSkills");
        openSkillEditorModal(null);
      });
      list.appendChild(newBtn);
    })
    .catch(function (err) {
      list.innerHTML = "";
      var error = document.createElement("div");
      error.style.color = "var(--error)";
      error.style.padding = "20px";
      error.textContent = t("chat.skills.error", { msg: String(err) });
      list.appendChild(error);
    });
}
function openSkillEditorModal(skill) {
  closeSkillEditorModal();
  var isEdit = Boolean(skill);
  var overlay = document.createElement("div");
  overlay.id = "oh-skill-modal-overlay";
  overlay.className = "modal-overlay";
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) overlay.remove();
  });
  var modal = document.createElement("div");
  modal.className = "modal";
  modal.style.maxWidth = "650px";
  modal.style.width = "90%";
  var hdr = document.createElement("div");
  hdr.className = "oh-modal-hdr";
  hdr.innerHTML =
    "<h2>" +
    (isEdit
      ? escapeHtml(t("chat.skills.editTitle"))
      : escapeHtml(t("chat.skills.newTitle"))) +
    '</h2><button class="oh-modal-x">×</button>';
  hdr.querySelector("button").addEventListener("click", function () {
    overlay.remove();
  });
  var titleField = document.createElement("div");
  titleField.className = "oh-modal-field";
  titleField.innerHTML =
    "<label>" +
    escapeHtml(t("chat.skills.field.title")) +
    '</label><input type="text" placeholder="' +
    escapeHtml(t("chat.skills.field.titlePlaceholder")) +
    '" value="' +
    (skill ? escapeHtml(skill.title) : "") +
    '">';
  var titleInput = titleField.querySelector("input");
  var contentField = document.createElement("div");
  contentField.className = "oh-modal-field oh-modal-field-grow";
  contentField.innerHTML =
    "<label>" +
    escapeHtml(t("chat.skills.field.content")) +
    '</label><textarea placeholder="' +
    escapeHtml(t("chat.skills.field.contentPlaceholder")) +
    '" style="height:250px;font-family:monospace;font-size:12px;resize:vertical;">' +
    (skill ? escapeHtml(skill.content) : "") +
    "</textarea>";
  var contentTA = contentField.querySelector("textarea");
  var ftr = document.createElement("div");
  ftr.className = "oh-modal-ftr";
  if (isEdit) {
    var delBtn = document.createElement("button");
    delBtn.className = "oh-btn oh-btn-danger";
    delBtn.textContent = t("chat.skills.delete");
    delBtn.addEventListener("click", function () {
      if (confirm(t("chat.skills.confirmDelete"))) {
        window.openhub.deleteSkill(skill.filename).then(function () {
          overlay.remove();
          showModal("modalSkills");
          renderSkillsModal();
        });
      }
    });
    ftr.appendChild(delBtn);
  }
  var spacer = document.createElement("div");
  spacer.style.flex = "1";
  ftr.appendChild(spacer);
  var cancelBtn = document.createElement("button");
  cancelBtn.className = "oh-btn oh-btn-ghost";
  cancelBtn.textContent = t("chat.skills.cancel");
  cancelBtn.addEventListener("click", function () {
    overlay.remove();
    showModal("modalSkills");
    renderSkillsModal();
  });
  ftr.appendChild(cancelBtn);
  var saveBtn = document.createElement("button");
  saveBtn.className = "oh-btn oh-btn-primary";
  saveBtn.textContent = isEdit ? t("chat.skills.save") : t("chat.skills.create");
  saveBtn.addEventListener("click", function () {
    var title = titleInput.value.trim();
    var content = contentTA.value.trim();
    if (!title) {
      titleInput.style.borderColor = "var(--error)";
      return;
    }
    if (!content) {
      contentTA.style.borderColor = "var(--error)";
      return;
    }
    window.openhub
      .saveSkill({ filename: skill ? skill.filename : undefined, title, content })
      .then(function () {
        overlay.remove();
        showModal("modalSkills");
        renderSkillsModal();
      })
      .catch(function (err) {
        alert(t("chat.skills.saveError", { msg: String(err) }));
      });
  });
  ftr.appendChild(saveBtn);
  modal.appendChild(hdr);
  modal.appendChild(titleField);
  modal.appendChild(contentField);
  modal.appendChild(ftr);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  titleInput.focus();
}
function closeSkillEditorModal() {
  var el = document.getElementById("oh-skill-modal-overlay");
  if (el) el.remove();
}

/* ── Attachments ── */
var nextAttachId = 0;
function addFiles(fileList) {
  for (var i = 0; i < fileList.length; i++) processFile(fileList[i]);
}
function processFile(file) {
  var isImage = IMAGE_TYPES.indexOf(file.type) !== -1;
  if (isImage && file.size > MAX_IMAGE_SIZE) return;
  if (!isImage && file.size > MAX_TEXT_SIZE) return;
  var attachment = {
    id: ++nextAttachId,
    file: file,
    type: isImage ? "image" : "file",
    dataUrl: null,
    textContent: null,
    mediaType: file.type || "application/octet-stream",
  };
  var reader = new FileReader();
  if (isImage) {
    reader.onload = function () {
      attachment.dataUrl = reader.result;
      state.attachments.push(attachment);
      renderAttachmentPreview();
      updateSendButton();
    };
    reader.readAsDataURL(file);
  } else {
    reader.onload = function () {
      attachment.textContent = reader.result;
      state.attachments.push(attachment);
      renderAttachmentPreview();
      updateSendButton();
    };
    reader.readAsText(file);
  }
}
function removeAttachment(id) {
  state.attachments = state.attachments.filter(function (a) {
    return a.id !== id;
  });
  renderAttachmentPreview();
  updateSendButton();
}
function clearAttachments() {
  state.attachments = [];
  renderAttachmentPreview();
}
function renderAttachmentPreview() {
  els.attachPreview.innerHTML = "";
  var hasItems = state.attachments.length > 0;
  els.attachPreview.classList.toggle("has-items", hasItems);
  for (var i = 0; i < state.attachments.length; i++) {
    var a = state.attachments[i];
    var item = document.createElement("div");
    item.className = "attach-item " + (a.type === "image" ? "is-image" : "is-file");
    if (a.type === "image" && a.dataUrl) {
      item.innerHTML =
        '<img src="' + a.dataUrl + '" alt="' + escapeHtml(a.file.name) + '">';
    } else {
      item.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;color:var(--text-muted)"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span class="attach-file-name">' +
        escapeHtml(a.file.name) +
        '</span><span class="attach-file-size">' +
        formatSize(a.file.size) +
        "</span>";
    }
    var rb = document.createElement("button");
    rb.className = "attach-remove";
    rb.textContent = "×";
    rb.dataset.id = a.id;
    rb.onclick = function () {
      removeAttachment(Number(this.dataset.id));
    };
    item.appendChild(rb);
    els.attachPreview.appendChild(item);
  }
}
function formatSize(bytes) {
  if (bytes < 1024) return t("chat.attach.bytes", { n: bytes });
  if (bytes < 1024 * 1024) return t("chat.attach.kb", { n: Math.round(bytes / 1024) });
  return t("chat.attach.mb", { n: (bytes / (1024 * 1024)).toFixed(1) });
}

els.fileInput.addEventListener("change", function () {
  if (this.files && this.files.length) {
    addFiles(this.files);
    this.value = "";
  }
});
var dragCounter = 0;
document.addEventListener("dragenter", function (e) {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) els.dropOverlay.classList.add("drop-overlay--active");
});
document.addEventListener("dragleave", function (e) {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    els.dropOverlay.classList.remove("drop-overlay--active");
  }
});
document.addEventListener("dragover", function (e) {
  e.preventDefault();
});
document.addEventListener("drop", function (e) {
  e.preventDefault();
  dragCounter = 0;
  els.dropOverlay.classList.remove("drop-overlay--active");
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
document.addEventListener("paste", function (e) {
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  var files = [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].kind === "file") {
      var f = items[i].getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) addFiles(files);
});

function buildApiContent(text, attachments, isAnthropic) {
  if (!attachments || attachments.length === 0) return text;
  var parts = [];
  for (var i = 0; i < attachments.length; i++) {
    var a = attachments[i];
    if (a.type === "image" && a.dataUrl) {
      if (isAnthropic) {
        var match = a.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (match)
          parts.push({
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          });
      } else parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
    } else if (a.type === "file" && a.textContent != null) {
      var ext = a.file.name.split(".").pop() || "";
      text =
        "[Fichier : " +
        a.file.name +
        "]\n```" +
        ext +
        "\n" +
        a.textContent +
        "\n```\n\n" +
        text;
    }
  }
  if (parts.length === 0) return text;
  parts.push({ type: "text", text: text });
  return parts;
}

/* ── Web Search widget ── */
function createSearchWidget(query) {
  var widget = document.createElement("div");
  widget.className = "search-widget";
  widget.innerHTML =
    '<div class="search-widget-container"><div class="search-widget-header"><div class="search-widget-title-area"><span class="search-widget-icon searching"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span><span class="search-widget-title">' +
    escapeHtml(t("chat.search.widget.title")) +
    "<em>" +
    escapeHtml(query) +
    '</em></span></div><span class="search-widget-status">' +
    escapeHtml(t("chat.search.widget.searching")) +
    '</span></div><div class="search-widget-content"></div></div>';
  els.messages.appendChild(widget);
  scrollToBottom(true);
  return widget;
}
function updateSearchWidget(widget, results, errorMsg) {
  var container = widget.querySelector(".search-widget-container");
  widget.querySelector(".search-widget-icon").classList.remove("searching");
  widget.querySelector(".search-widget-status").innerHTML = errorMsg
    ? escapeHtml(t("chat.search.widget.error")) +
      ' <span class="search-widget-chevron"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></span>'
    : escapeHtml(
        results.length > 1
          ? t("chat.search.widget.resultsPlural", { n: results.length })
          : t("chat.search.widget.results", { n: results.length }),
      ) +
      ' <span class="search-widget-chevron"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></span>';
  container.querySelector(".search-widget-header").addEventListener("click", function () {
    container.classList.toggle("open");
  });
  var contentDiv = widget.querySelector(".search-widget-content");
  if (errorMsg) {
    contentDiv.innerHTML =
      '<div style="color:var(--error);font-size:12px;padding:4px 8px">' +
      escapeHtml(errorMsg) +
      "</div>";
    container.classList.add("open");
    return;
  }
  if (results.length === 0) {
    contentDiv.innerHTML =
      '<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:12px 0">' +
      escapeHtml(t("chat.search.widget.noResults")) +
      "</div>";
  } else {
    var html = "";
    for (var i = 0; i < results.length; i++) {
      var r = results[i],
        domain = "";
      try {
        domain = new URL(r.url).hostname;
      } catch (_) {
        domain = r.url;
      }
      var safe = safeUrl(r.url);
      var inner =
        '<div class="search-result-header"><span class="search-result-title">' +
        escapeHtml(r.title) +
        '</span><span class="search-result-url">(' +
        escapeHtml(domain) +
        ')</span></div><div class="search-result-snippet">' +
        escapeHtml(r.snippet) +
        "</div>";
      // Only render a clickable link for safe schemes (untrusted search data).
      html += safe
        ? '<a class="search-result-item" href="' +
          escapeHtml(safe) +
          '" target="_blank" rel="noopener noreferrer">' +
          inner +
          "</a>"
        : '<div class="search-result-item">' + inner + "</div>";
    }
    contentDiv.innerHTML = html;
  }
}

/* ── Send ── */
async function sendMessage() {
  var text = els.input.value.trim();
  var hasAttachments = state.attachments.length > 0;
  if (
    (!text && !hasAttachments) ||
    state.isStreaming ||
    !state.selectedModel ||
    !state.initReady
  )
    return;
  if (!activeConvId) startNewConversation();
  els.emptyState.style.display = "none";
  document.body.classList.remove("oh-is-new-conv");
  var currentAttachments = state.attachments.slice();
  state.messages.push({
    role: "user",
    content: text || "",
    attachments: currentAttachments,
  });
  renderMessage("user", text || "", currentAttachments);
  var conv = conversations.find(function (c) {
    return c.id === activeConvId;
  });
  if (conv && !conv.customTitle) {
    conv.title = getConvTitle(state.messages);
    els.chatTitle.textContent = conv.title;
    renderConvList();
  }
  els.input.value = "";
  clearAttachments();
  resizeTextarea();
  state.messages.push({
    role: "assistant",
    content: "",
    model: state.selectedModel,
  });
  var assistantEls = renderMessage("assistant", "");
  showThinkingIndicator(assistantEls.bubble);
  state.isStreaming = true;
  state.abortController = new AbortController();
  updateSendButton();
  scrollToBottom(true);
  var searchContext = "";
  var searchQuery = null;
  // Recherche seulement si l'interrupteur maître est ON ET que l'IA juge ça nécessaire.
  if (state.webSearchEnabled && text) {
    searchQuery = await decideWebSearch(text);
  }
  if (searchQuery) {
    var searchWidget = createSearchWidget(searchQuery);
    try {
      var searchResults = await window.openhub.webSearch(searchQuery);
      updateSearchWidget(searchWidget, searchResults, null);
      if (searchResults && searchResults.length > 0) {
        searchContext =
          '\n\n[Contexte de recherche internet pour "' + searchQuery + '"]\n';
        for (var i = 0; i < searchResults.length; i++) {
          var r = searchResults[i];
          searchContext +=
            "Source [" +
            (i + 1) +
            "] : " +
            r.title +
            " (" +
            r.url +
            ")\nExtrait : " +
            r.snippet +
            "\n\n";
        }
        searchContext +=
          "[Fin du contexte de recherche. Répondez à la requête de l'utilisateur en vous basant sur ces informations si nécessaire. Citez vos sources avec [1], [2], etc.]\n";
      }
    } catch (err) {
      updateSearchWidget(
        searchWidget,
        [],
        err.message || t("chat.search.widget.searchError"),
      );
    }
  }
  var isAnthropic = state.selectedModel.startsWith("claude-");
  var fullContent = "";
  var fullReasoning = "";
  var responseStarted = false;
  try {
    var apiMessages = state.messages.slice(0, -1).map(function (m, idx) {
      var mc = m.content;
      if (idx === state.messages.length - 2 && searchContext) mc = mc + searchContext;
      var content = buildApiContent(mc, m.attachments, isAnthropic);
      return { role: m.role, content: content };
    });
    apiMessages.unshift({
      role: "system",
      content:
        "[CAPACITES ARTIFACTS]\nTu peux générer directement des fichiers en produisant un bloc de code avec le tag de langage approprié. L'interface utilisateur affichera un bouton Aperçu, un bouton PDF et un bouton Télécharger automatiquement. Voici les formats supportés :\n- HTML : ```html\n- Markdown : ```markdown\n- SVG : ```svg\n- CSV : ```csv\n- Texte brut : ```txt\nNe dis JAMAIS que tu ne peux pas générer ces fichiers. Produis simplement le bloc de code.",
    });
    var body = { model: state.selectedModel, stream: true, messages: apiMessages };
    if (isAnthropic) body.max_tokens = 4096;
    if (modelSupportsReasoningEffort(state.selectedModel))
      body.reasoning_effort = getModelEffort(state.selectedModel) || "medium";
    var response = await fetch(state.proxyUrl + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + state.token,
      },
      body: JSON.stringify(body),
      signal: state.abortController.signal,
    });
    if (!response.ok) {
      var errText = "";
      try {
        errText = await response.text();
      } catch (_) {}
      throw new Error("HTTP " + response.status + (errText ? ": " + errText : ""));
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    while (true) {
      var result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split("\n");
      buffer = lines.pop();
      for (var k = 0; k < lines.length; k++) {
        var line = lines[k].trim();
        if (!line || line.startsWith("event:")) continue;
        if (!line.startsWith("data:")) continue;
        var payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          var parsed = JSON.parse(payload);
          var delta = "";
          var reasoningDelta = "";
          if (parsed.type === "content_block_delta" && parsed.delta) {
            if (parsed.delta.type === "thinking_delta")
              reasoningDelta = parsed.delta.thinking || "";
            else delta = parsed.delta.text || "";
          } else if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) {
            delta = parsed.choices[0].delta.content || "";
            var rd =
              parsed.choices[0].delta.reasoning_content ||
              parsed.choices[0].delta.reasoning;
            if (typeof rd === "string") reasoningDelta = rd;
          }
          if (reasoningDelta) {
            if (!fullReasoning) removeThinkingIndicator(assistantEls.bubble);
            fullReasoning += reasoningDelta;
            updateReasoningPanel(assistantEls, fullReasoning, true);
            scrollToBottom(false);
          }
          if (delta) {
            if (!responseStarted && fullReasoning) {
              responseStarted = true;
              collapseReasoningPanel(assistantEls);
            }
            fullContent += delta;
            updateAssistantMessage(assistantEls, fullContent);
            scrollToBottom(false);
          }
        } catch (_) {}
      }
    }
    state.messages[state.messages.length - 1].content = fullContent;
    if (fullReasoning)
      state.messages[state.messages.length - 1].reasoning = fullReasoning;
  } catch (err) {
    if (err.name === "AbortError") {
      removeThinkingIndicator(assistantEls.bubble);
      state.messages[state.messages.length - 1].content = fullContent;
      if (fullReasoning) {
        state.messages[state.messages.length - 1].reasoning = fullReasoning;
        collapseReasoningPanel(assistantEls);
      }
    } else {
      updateAssistantMessage(assistantEls, "");
      assistantEls.bubble.classList.add("msg-bubble--streaming");
      assistantEls.bubble.querySelector(".msg-body").textContent = t("chat.msg.error", {
        msg: err.message,
      });
    }
  } finally {
    assistantEls.bubble.classList.remove("msg-bubble--streaming");
    state.isStreaming = false;
    state.abortController = null;
    updateSendButton();
    scrollToBottom(true);
    var activeConv = conversations.find(function (c) {
      return c.id === activeConvId;
    });
    if (activeConv) activeConv.updatedAt = Date.now();
    saveCurrentConversation();
    renderConvList();
  }
}
function stopStreaming() {
  if (state.abortController) state.abortController.abort();
}

/* ── Render messages ── */
function renderMessage(role, content, attachments, reasoning) {
  var isUser = role === "user";
  var group = document.createElement("div");
  group.className = "msg-group" + (isUser ? " msg-group--user" : "");
  var header = document.createElement("div");
  header.className = "msg-group-header";
  if (isUser) {
    header.innerHTML =
      '<span class="msg-role-name">' +
      escapeHtml(t("chat.msg.you")) +
      '</span><div class="msg-avatar msg-avatar--user" aria-hidden="true">V</div>';
  } else {
    header.innerHTML =
      '<div class="msg-avatar" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.5-3 5.7V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.3A7 7 0 0 1 5 9a7 7 0 0 1 7-7z"></path></svg></div><span class="msg-role-name">' +
      escapeHtml(t("chat.msg.assistant")) +
      "</span>";
  }
  group.appendChild(header);
  var bubbles = document.createElement("div");
  bubbles.className = "msg-bubbles";
  var bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  if (isUser && attachments && attachments.length > 0) {
    var images = [],
      files = [];
    for (var i = 0; i < attachments.length; i++) {
      if (attachments[i].type === "image") images.push(attachments[i]);
      else files.push(attachments[i]);
    }
    if (images.length > 0) {
      var imgC = document.createElement("div");
      imgC.className = "msg-images";
      for (var j = 0; j < images.length; j++) {
        var img = document.createElement("img");
        img.src = images[j].dataUrl;
        img.alt = images[j].file.name;
        imgC.appendChild(img);
      }
      bubble.appendChild(imgC);
    }
    if (files.length > 0) {
      var fc = document.createElement("div");
      for (var k = 0; k < files.length; k++) {
        var chip = document.createElement("span");
        chip.className = "msg-file-chip";
        chip.innerHTML =
          '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
          escapeHtml(files[k].file.name);
        fc.appendChild(chip);
      }
      bubble.appendChild(fc);
    }
  }
  var body = document.createElement("div");
  body.className = "msg-body";
  if (isUser) {
    if (content) body.textContent = content;
  } else {
    body.innerHTML = renderMarkdown(content);
    bindCopyButtons(body);
  }
  bubble.appendChild(body);
  if (!isUser && reasoning) {
    var elsObj = { bubble: bubble };
    updateReasoningPanel(elsObj, reasoning, false);
    collapseReasoningPanel(elsObj);
  }
  bubbles.appendChild(bubble);
  var copyBtn = document.createElement("button");
  copyBtn.className = "btn-copy-msg";
  copyBtn.title = t("chat.msg.copy");
  copyBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  copyBtn.onclick = function () {
    var msgBody = bubble.querySelector(".msg-body");
    var txt = (msgBody ? msgBody.textContent : bubble.textContent) || "";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt);
      copyBtn.style.color = "var(--success)";
      copyBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(function () {
        copyBtn.style.color = "";
        copyBtn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
      }, 2000);
    }
  };
  bubbles.appendChild(copyBtn);
  group.appendChild(bubbles);
  els.messages.appendChild(group);
  return { bubble: bubble, group: group };
}
function showThinkingIndicator(bubble) {
  var indicator = document.createElement("div");
  indicator.className = "msg-thinking";
  indicator.innerHTML =
    '<svg viewBox="0 0 512 512" fill="none"><g stroke="var(--accent-primary,#14B8A6)" stroke-width="76" stroke-linecap="round" opacity="0.25"><path d="M 311.4 103.8 A 162 162 0 0 1 415.5 284.1"/><path d="M 360.1 380.1 A 162 162 0 0 1 151.9 380.1"/><path d="M 96.5 284.1 A 162 162 0 0 1 200.6 103.8"/></g><g stroke="var(--accent-primary,#14B8A6)" stroke-width="76" stroke-linecap="round"><path d="M 311.4 103.8 A 162 162 0 0 1 415.5 284.1"/></g></svg>' +
    '<span class="msg-thinking-label">' +
    escapeHtml(t("chat.msg.thinking")) +
    "</span>";
  bubble.querySelector(".msg-body").appendChild(indicator);
}
function removeThinkingIndicator(bubble) {
  var indicator = bubble.querySelector(".msg-thinking");
  if (indicator) indicator.remove();
}
function updateReasoningPanel(elsObj, text, streaming) {
  var panel = elsObj.bubble.querySelector(".msg-reasoning");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "msg-reasoning";
    if (streaming) panel.classList.add("msg-reasoning--streaming");
    var header = document.createElement("div");
    header.className = "msg-reasoning-header";
    header.innerHTML =
      '<svg viewBox="0 0 512 512" fill="none"><g stroke="var(--accent-primary,#14B8A6)" stroke-width="76" stroke-linecap="round" opacity="0.25"><path d="M 311.4 103.8 A 162 162 0 0 1 415.5 284.1"/><path d="M 360.1 380.1 A 162 162 0 0 1 151.9 380.1"/><path d="M 96.5 284.1 A 162 162 0 0 1 200.6 103.8"/></g><g stroke="var(--accent-primary,#14B8A6)" stroke-width="76" stroke-linecap="round"><path d="M 311.4 103.8 A 162 162 0 0 1 415.5 284.1"/></g></svg>' +
      "<span>" +
      escapeHtml(t("chat.msg.reasoning")) +
      "</span>" +
      '<svg class="msg-reasoning-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    header.onclick = function () {
      panel.classList.toggle("msg-reasoning--collapsed");
    };
    var content = document.createElement("div");
    content.className = "msg-reasoning-content";
    panel.appendChild(header);
    panel.appendChild(content);
    elsObj.bubble.insertBefore(panel, elsObj.bubble.querySelector(".msg-body"));
  }
  var contentEl = panel.querySelector(".msg-reasoning-content");
  contentEl.textContent = text;
  if (streaming) {
    panel.classList.add("msg-reasoning--streaming");
    contentEl.scrollTop = contentEl.scrollHeight;
  } else {
    panel.classList.remove("msg-reasoning--streaming");
  }
}
function collapseReasoningPanel(elsObj) {
  var panel = elsObj.bubble.querySelector(".msg-reasoning");
  if (panel) {
    panel.classList.add("msg-reasoning--collapsed");
    panel.classList.remove("msg-reasoning--streaming");
  }
}
function updateAssistantMessage(elsObj, content) {
  removeThinkingIndicator(elsObj.bubble);
  var marker = elsObj.bubble.dataset.artifactMarker;
  if (marker) {
    var markerId = parseInt(marker);
    artifacts = artifacts.filter(function (a) {
      return a.id < markerId;
    });
  }
  elsObj.bubble.dataset.artifactMarker = String(nextArtifactId + 1);
  var body = elsObj.bubble.querySelector(".msg-body");
  body.innerHTML = renderMarkdown(content);
  bindCopyButtons(body);
}
function bindCopyButtons(container) {
  container.querySelectorAll(".btn-copy:not(.btn-artifact-action)").forEach(function (b) {
    b.onclick = function () {
      var pre = this.closest("pre");
      var code = pre ? pre.querySelector("code") : null;
      if (code) {
        navigator.clipboard.writeText(code.textContent).then(
          function () {
            var orig = this.textContent;
            this.textContent = t("chat.code.copied");
            this.classList.add("btn-copy--copied");
            var btn = this;
            setTimeout(function () {
              btn.textContent = orig;
              btn.classList.remove("btn-copy--copied");
            }, 1500);
          }.bind(this),
        );
      }
    };
  });
}

/* ── Artifacts ── */
function detectArtifact(lang, code) {
  var l = (lang || "").toLowerCase();
  if (
    l === "html" &&
    (code.indexOf("<html") !== -1 ||
      code.indexOf("<!DOCTYPE") !== -1 ||
      code.indexOf("<!doctype") !== -1 ||
      code.indexOf("<body") !== -1 ||
      (code.indexOf("<div") !== -1 && code.length > 200))
  )
    return {
      type: "html",
      ext: "html",
      label: "HTML",
      badge: "html",
      previewable: true,
      pdfable: true,
    };
  if (l === "svg" || (l === "xml" && code.indexOf("<svg") !== -1))
    return {
      type: "svg",
      ext: "svg",
      label: "SVG",
      badge: "svg",
      previewable: true,
      pdfable: true,
    };
  if (l === "csv")
    return {
      type: "csv",
      ext: "csv",
      label: "CSV",
      badge: "csv",
      previewable: true,
      pdfable: true,
    };
  if (l === "markdown" || l === "md")
    return {
      type: "markdown",
      ext: "md",
      label: "Markdown",
      badge: "md",
      previewable: true,
      pdfable: true,
    };
  if (l === "json" && code.length > 100)
    return {
      type: "json",
      ext: "json",
      label: "JSON",
      badge: "code",
      previewable: false,
      pdfable: false,
    };
  if (l === "txt" || l === "text" || l === "doc" || l === "docx")
    return {
      type: "text",
      ext: l === "docx" ? "docx" : "txt",
      label: l === "docx" ? "DOCX" : t("chat.artifact.text"),
      badge: "code",
      previewable: true,
      pdfable: true,
    };
  return null;
}
function buildArtifactHtml(id, info, code) {
  var escaped = escapeHtml(code.replace(/\n$/, ""));
  var actions = "";
  if (info.previewable)
    actions +=
      '<button class="btn-copy btn-artifact-action" style="font-size:12px" data-art-action="preview">' +
      escapeHtml(t("chat.artifact.preview")) +
      "</button>";
  if (info.pdfable)
    actions +=
      '<button class="btn-copy btn-artifact-action" style="font-size:12px" data-art-action="pdf">' +
      escapeHtml(t("chat.artifact.pdf")) +
      "</button>";
  actions +=
    '<button class="btn-copy btn-artifact-action" style="font-size:12px" data-art-action="download">' +
    escapeHtml(t("chat.artifact.download")) +
    "</button>";
  actions +=
    '<button class="btn-copy btn-artifact-action" style="font-size:12px" data-art-action="copy">' +
    escapeHtml(t("chat.artifact.copy")) +
    "</button>";
  return (
    '<div class="artifact-card" data-artifact-id="' +
    id +
    '" style="margin:12px 0">' +
    '<div class="artifact-header"><span class="artifact-label artifact-label--' +
    info.badge +
    '">' +
    info.label +
    "</span>" +
    '<span style="font-size:13px;font-weight:500;color:var(--text-primary);flex:1;margin:0 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">document.' +
    info.ext +
    "</span>" +
    '<div class="artifact-actions">' +
    actions +
    "</div></div>" +
    '<div class="artifact-body" id="artifact-body-' +
    id +
    '" style="padding:0;background:var(--bg-deepest)">' +
    '<div class="code-header"><span>' +
    escapeHtml(info.label) +
    "</span></div>" +
    '<pre style="margin:0;border-radius:0;border:none"><code>' +
    escaped +
    "</code></pre></div></div>"
  );
}
function toggleArtifactPreview(btn, id) {
  var el = $("artifact-body-" + id);
  if (!el) return;
  if (el.dataset.preview && el.dataset.preview === "1") {
    el.innerHTML = el.dataset.original;
    delete el.dataset.preview;
    delete el.dataset.original;
    if (btn) btn.textContent = t("chat.artifact.preview");
    return;
  }
  var a = artifacts.find(function (x) {
    return x.id === id;
  });
  if (!a) return;
  el.dataset.preview = "1";
  el.dataset.original = el.innerHTML;
  if (a.info.type === "html") {
    el.innerHTML =
      '<iframe sandbox="allow-scripts" srcdoc="' +
      escapeHtml(a.code).replace(/"/g, "&quot;") +
      '" style="width:100%;height:400px;border:none;background:#fff"></iframe>';
  } else if (a.info.type === "svg") {
    el.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bg-surface);min-height:200px"><img src="data:image/svg+xml;base64,' +
      btoa(unescape(encodeURIComponent(a.code))) +
      '" style="max-width:100%;max-height:360px"></div>';
  } else if (a.info.type === "csv") {
    var rows = parseCsv(a.code);
    if (rows.length === 0) return;
    var table =
      '<table style="width:100%;border-collapse:collapse;font-size:12px;font-family:var(--font-mono)"><thead><tr>';
    for (var h = 0; h < rows[0].length; h++)
      table +=
        '<th style="padding:6px 12px;border:1px solid var(--border-subtle);text-align:left;background:var(--bg-surface);color:var(--text-primary);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.04em">' +
        escapeHtml(rows[0][h]) +
        "</th>";
    table += "</tr></thead><tbody>";
    var maxR = Math.min(rows.length, 50);
    for (var r = 1; r < maxR; r++) {
      table += "<tr>";
      for (var c = 0; c < rows[r].length; c++)
        table +=
          '<td style="padding:6px 12px;border:1px solid var(--border-subtle);color:var(--text-primary)">' +
          escapeHtml(rows[r][c]) +
          "</td>";
      table += "</tr>";
    }
    table += "</tbody></table>";
    el.innerHTML = table;
  } else if (a.info.type === "markdown") {
    el.innerHTML =
      '<div style="padding:16px 20px;font-size:14px;line-height:1.65;color:var(--text-primary);max-height:400px;overflow-y:auto">' +
      renderMarkdown(a.code) +
      "</div>";
  } else if (a.info.type === "text") {
    el.innerHTML =
      '<div style="padding:16px 20px;font-family:var(--font-mono);font-size:13px;line-height:1.55;color:var(--text-primary);white-space:pre-wrap;max-height:400px;overflow-y:auto">' +
      escapeHtml(a.code) +
      "</div>";
  }
  if (btn) btn.textContent = t("chat.artifact.code");
}
function downloadArtifact(id) {
  var a = artifacts.find(function (x) {
    return x.id === id;
  });
  if (!a) return;
  var mimeMap = {
    html: "text/html",
    csv: "text/csv",
    markdown: "text/markdown",
    json: "application/json",
    svg: "image/svg+xml",
  };
  var mime = mimeMap[a.info.type] || "text/plain";
  var blob = new Blob([a.code], { type: mime + ";charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var link = document.createElement("a");
  link.href = url;
  link.download = "document." + a.info.ext;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
function copyArtifact(btn, id) {
  var a = artifacts.find(function (x) {
    return x.id === id;
  });
  if (!a) return;
  navigator.clipboard.writeText(a.code).then(function () {
    if (btn) {
      var orig = btn.textContent;
      btn.textContent = t("chat.artifact.copied");
      btn.classList.add("btn-copy--copied");
      setTimeout(function () {
        btn.textContent = orig;
        btn.classList.remove("btn-copy--copied");
      }, 1500);
    }
  });
}
function exportArtifactPdf(id) {
  var a = artifacts.find(function (x) {
    return x.id === id;
  });
  if (!a || !window.openhub.exportHtmlToPdf) return;
  var html;
  switch (a.info.type) {
    case "html":
      html = a.code;
      break;
    case "markdown":
      html = wrapInHtmlDoc("Document Markdown", renderMarkdown(a.code));
      break;
    case "svg":
      html = wrapInHtmlDoc(
        "Document SVG",
        '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff;padding:24px">' +
          a.code +
          "</div>",
      );
      break;
    case "csv":
      html = wrapInHtmlDoc("Document CSV", buildCsvHtml(a.code));
      break;
    case "text":
      html = wrapInHtmlDoc(
        "Document",
        '<pre style="white-space:pre-wrap;font-family:monospace;font-size:13px;line-height:1.6">' +
          escapeHtml(a.code) +
          "</pre>",
      );
      break;
    default:
      html = wrapInHtmlDoc(
        "Document",
        '<pre style="white-space:pre-wrap">' + escapeHtml(a.code) + "</pre>",
      );
  }
  window.openhub.exportHtmlToPdf(html);
}
// Delegated handler for artifact action buttons (CSP: no inline onclick).
document.addEventListener("click", function (e) {
  var btn = e.target.closest(".btn-artifact-action");
  if (!btn) return;
  var card = btn.closest("[data-artifact-id]");
  if (!card) return;
  var id = Number(card.dataset.artifactId);
  switch (btn.dataset.artAction) {
    case "preview":
      toggleArtifactPreview(btn, id);
      break;
    case "pdf":
      exportArtifactPdf(id);
      break;
    case "download":
      downloadArtifact(id);
      break;
    case "copy":
      copyArtifact(btn, id);
      break;
  }
});
function wrapInHtmlDoc(title, body) {
  return (
    '<!doctype html><html><head><meta charset="UTF-8"><title>' +
    escapeHtml(title) +
    "</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1a1a1a;padding:32px 40px;max-width:800px;margin:0 auto;line-height:1.65}h1,h2,h3{color:#111}pre{background:#f5f5f5;padding:16px;border-radius:6px;overflow-x:auto}code{background:#f5f5f5;padding:2px 6px;border-radius:4px;font-size:0.9em}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}th{background:#f0f0f0;font-weight:600}img{max-width:100%}</style></head><body>" +
    body +
    "</body></html>"
  );
}
function buildCsvHtml(text) {
  var rows = parseCsv(text);
  if (rows.length === 0) return "<p>" + escapeHtml(t("chat.csv.noData")) + "</p>";
  var html = "<table><thead><tr>";
  for (var h = 0; h < rows[0].length; h++)
    html += "<th>" + escapeHtml(rows[0][h]) + "</th>";
  html += "</tr></thead><tbody>";
  for (var r = 1; r < rows.length; r++) {
    html += "<tr>";
    for (var c = 0; c < rows[r].length; c++)
      html += "<td>" + escapeHtml(rows[r][c]) + "</td>";
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}
function parseCsv(text) {
  var rows = [],
    row = [],
    field = "",
    inQuotes = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        if (ch === "\r") i++;
      } else field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ── Markdown ── */
function renderMarkdown(text) {
  if (!text) return "";
  if (typeof text !== "string") {
    if (Array.isArray(text)) {
      text = text
        .map(function (p) {
          return p.text || "";
        })
        .join("\n");
    } else {
      text = String(text);
    }
  }
  var codeBlocks = [];
  var html = text.replace(/```(\w*)\n([\s\S]*?)```/g, function (_m, lang, code) {
    var idx = codeBlocks.length;
    var rawCode = code.replace(/\n$/, "");
    var info = detectArtifact(lang, rawCode);
    if (info) {
      var aid = ++nextArtifactId;
      artifacts.push({ id: aid, lang: lang, code: rawCode, info: info });
      codeBlocks.push(buildArtifactHtml(aid, info, rawCode));
    } else {
      var escaped = escapeHtml(rawCode);
      var header =
        '<div class="code-header"><span>' +
        escapeHtml(lang || "text") +
        '</span><button class="btn-copy">' +
        escapeHtml(t("chat.code.copy")) +
        "</button></div>";
      codeBlocks.push("<pre>" + header + "<code>" + escaped + "</code></pre>");
    }
    return "\x00CB" + idx + "\x00";
  });
  html = escapeHtml(html);
  for (var i = 0; i < codeBlocks.length; i++)
    html = html.replace("\x00CB" + i + "\x00", codeBlocks[i]);
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/_([^_\n]+)_/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_m, text, url) {
    // Only emit a live link for safe schemes; javascript:/data: become text.
    if (!safeUrl(url)) return text;
    return (
      '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + "</a>"
    );
  });
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/^---$/gm, "<hr>");
  html = processLists(html);
  html = html.replace(/\n{2,}/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  html = "<p>" + html + "</p>";
  html = html.replace(/<p>\s*(<h[1-3]>)/g, "$1").replace(/(<\/h[1-3]>)\s*<\/p>/g, "$1");
  html = html.replace(/<p>\s*(<pre>)/g, "$1").replace(/(<\/pre>)\s*<\/p>/g, "$1");
  html = html.replace(/<p>\s*(<ul>)/g, "$1").replace(/(<\/ul>)\s*<\/p>/g, "$1");
  html = html.replace(/<p>\s*(<ol>)/g, "$1").replace(/(<\/ol>)\s*<\/p>/g, "$1");
  html = html
    .replace(/<p>\s*(<blockquote>)/g, "$1")
    .replace(/(<\/blockquote>)\s*<\/p>/g, "$1");
  html = html.replace(/<p>\s*(<hr>)/g, "$1").replace(/(<hr>)\s*<\/p>/g, "$1");
  html = html.replace(/<p>\s*(<div class="artifact-card)/g, "$1");
  html = html.replace(
    /(<\/div>)\s*<\/p>(?=\s*(?:<p>|<div class="artifact-card|<h[1-3]>|<pre>|<ul>|<ol>|<blockquote>|<hr>|$))/g,
    "$1",
  );
  html = html.replace(/<p>\s*<\/p>/g, "");
  return html;
}
function processLists(html) {
  html = html.replace(/(^|\n)((?:[-*] .+\n?)+)/g, function (_m, pre, block) {
    var items = block
      .trim()
      .split("\n")
      .map(function (line) {
        return "<li>" + line.replace(/^[-*] /, "") + "</li>";
      })
      .join("");
    return pre + "<ul>" + items + "</ul>";
  });
  html = html.replace(/(^|\n)((?:\d+\. .+\n?)+)/g, function (_m, pre, block) {
    var items = block
      .trim()
      .split("\n")
      .map(function (line) {
        return "<li>" + line.replace(/^\d+\. /, "") + "</li>";
      })
      .join("");
    return pre + "<ol>" + items + "</ol>";
  });
  return html;
}
function displayModelName(id) {
  return id ? id.split("/").pop() || id : id;
}
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// Returns the URL only if it uses a safe scheme; null otherwise. Blocks
// javascript:/data:/etc. injected via LLM output or web-search results.
function safeUrl(url) {
  try {
    var u = new URL(String(url), location.href);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") {
      return u.href;
    }
  } catch (e) {}
  return null;
}

/* ── Textarea ── */
function resizeTextarea() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}
els.input.addEventListener("input", function () {
  resizeTextarea();
  updateSendButton();
});
els.input.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (state.isStreaming) return;
    sendMessage();
  }
});

function updateSendButton() {
  var hasText = els.input.value.trim().length > 0;
  var hasAttachments = state.attachments.length > 0;
  if (state.isStreaming) {
    els.btnSend.disabled = false;
    els.btnSend.innerHTML =
      '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/></svg>';
    els.btnSend.style.background = "var(--error)";
    els.btnSend.onclick = stopStreaming;
  } else {
    els.btnSend.disabled = (!hasText && !hasAttachments) || !state.selectedModel;
    els.btnSend.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
    els.btnSend.style.background = els.btnSend.disabled ? "" : "var(--accent-primary)";
    els.btnSend.onclick = null;
  }
}
els.btnSend.addEventListener("click", function () {
  if (state.isStreaming) stopStreaming();
  else sendMessage();
});

/* ── Scroll ── */
var userScrolledUp = false;
els.messages.parentElement.addEventListener("scroll", function () {
  var el = els.messages.parentElement;
  userScrolledUp = el.scrollHeight - el.scrollTop - el.clientHeight > 80;
});
els.messages.parentElement.addEventListener("mousedown", function () {
  userScrolledUp = true;
});
function scrollToBottom(force) {
  var el = els.messages.parentElement;
  if (force || !userScrolledUp) el.scrollTop = el.scrollHeight;
}

/* ── Key refresh ── */
if (window.openhub.onApiKeysUpdated) {
  window.openhub.onApiKeysUpdated(function () {
    refreshModels().then(function () {
      updateEmptyState();
      updateSendButton();
    });
  });
}

// ── Resizable conv-sidebar ──
(function initConvResize() {
  var sidebar = document.querySelector(".conv-sidebar");
  var handle = document.getElementById("convResizeHandle");
  var minW = 200,
    maxW = 500;
  var startX, startW;

  try {
    var saved = localStorage.getItem("oh-conv-sidebar-width");
    if (saved) {
      var w = parseInt(saved, 10);
      if (w >= minW && w <= maxW) {
        sidebar.style.setProperty("--conv-sidebar-width", w + "px");
      }
    }
  } catch (e) {}

  function onDragStart(e) {
    e.preventDefault();
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    handle.classList.add("active");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onDrag);
    document.addEventListener("mouseup", onDragEnd);
  }

  function onDrag(e) {
    var delta = e.clientX - startX;
    var newW = Math.min(maxW, Math.max(minW, startW - delta));
    sidebar.style.setProperty("--conv-sidebar-width", newW + "px");
  }

  function onDragEnd() {
    handle.classList.remove("active");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", onDrag);
    document.removeEventListener("mouseup", onDragEnd);
    var finalW = sidebar.getBoundingClientRect().width;
    try {
      localStorage.setItem("oh-conv-sidebar-width", Math.round(finalW));
    } catch (e) {}
  }

  handle.addEventListener("mousedown", onDragStart);
})();

/* ── Start ── */
/* ── Navigation Projets ── */
window.switchMainView = function (viewId) {
  var chat = document.getElementById("chatView");
  var hub = document.getElementById("projectsHubView");
  var details = document.getElementById("projectDetailsView");

  if (chat) chat.classList.add("hidden");
  if (hub) hub.classList.add("hidden");
  if (details) details.classList.add("hidden");

  var target = document.getElementById(viewId);
  if (target) {
    target.classList.remove("hidden");
  } else {
    console.error("[chat] Target view not found: " + viewId);
  }
};

/* ── Toast ── */
(function () {
  var wrap = document.createElement("div");
  wrap.className = "oh-toast-wrap";
  document.body.appendChild(wrap);
  window.showToast = function (msg, type) {
    var t = document.createElement("div");
    t.className =
      "oh-toast" +
      (type === "success"
        ? " oh-toast-success"
        : type === "error"
          ? " oh-toast-error"
          : "");
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(function () {
      t.classList.add("oh-toast-out");
      setTimeout(function () {
        t.remove();
      }, 200);
    }, 2500);
  };
})();

/* ── Hub state ── */
var hubFilter = "all";
var hubSort = "recent";
var hubSearchQuery = "";
var hubSearchTimer = null;
var hubGenOpen = false;
var hubArchivedOpen = false;
var hubFolderOpen = {};
var hubFolders = [];
var hubCtxTarget = null;
var hubCtxAnchor = null;
var hubSelectMode = false;
var hubSelectedIds = new Set();
var hubViewMode = "grid";

function hubTypeLabel(type) {
  var labels = {
    assistant: t("chat.hubType.assistant"),
    code: t("chat.hubType.code"),
    design: t("chat.hubType.design"),
    work: t("chat.hubType.work"),
    orchestrator: t("chat.hubType.orchestrator"),
    verifier: t("chat.hubType.verifier"),
    recherche: t("chat.hubType.recherche"),
  };
  return labels[type];
}
/* HUB_TYPE_COLORS retiré (v2 : accent unique + différenciation par icône via HUB_TYPE_ICONS) */
var HUB_TYPE_ICONS = {
  assistant: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
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
function hubFilterTypes() {
  return [
    { key: "all", label: t("chat.hubFilter.all") },
    { key: "assistant", label: t("chat.hubType.assistant"), dot: "#85B7EB" },
    { key: "orchestrator", label: t("chat.hubType.orchestrator"), dot: "#5DCAA5" },
    { key: "code", label: t("chat.hubType.code"), dot: "#97C459" },
    { key: "design", label: t("chat.hubType.design"), dot: "#ED93B1" },
    { key: "work", label: t("chat.hubType.work"), dot: "#F0997B" },
    { key: "recherche", label: t("chat.hubType.recherche"), dot: "#AFA9EC" },
    { key: "verifier", label: t("chat.hubType.verifier"), dot: "#FAC775" },
  ];
}

function hubRelativeDate(ts) {
  if (!ts) return "";
  var now = Date.now();
  var d = new Date(ts);
  var today = new Date(now);
  today.setHours(0, 0, 0, 0);
  var yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d >= today) return t("chat.date.today");
  if (d >= yesterday) return t("chat.date.yesterday");
  var locale = window.I18N && window.I18N.lang === "en" ? "en-US" : "fr-FR";
  return d.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

function hubGetProjectType(p) {
  return p.type || "assistant";
}

// Un projet "orchestrateur" (agent de workflow, nœud de canvas ou sous-agent généré)
// possède toujours une empreinte qu'un projet autonome de chat/Work n'a jamais :
// le flag generated, un type d'agent, ou des coordonnées de canvas.
function isOrchestratorProject(p) {
  return (
    p.generated === true ||
    (typeof p.type === "string" && p.type.length > 0) ||
    typeof p.x === "number"
  );
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
  var type = (
    hubTypeLabel(hubGetProjectType(p)) || t("chat.hubType.assistant")
  ).toLowerCase();
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

function hubCountChats(projectId) {
  if (!conversations || !conversations.length) return 0;
  var count = 0;
  for (var i = 0; i < conversations.length; i++) {
    if (conversations[i].projectId === projectId) count++;
  }
  return count;
}

function hubBuildCard(p, opts) {
  opts = opts || {};
  var type = hubGetProjectType(p);
  var typeLabel = hubTypeLabel(type) || t("chat.hubType.assistant");
  var typeColor = "#14b8a6";
  var iconSvg = HUB_TYPE_ICONS[type] || HUB_TYPE_ICONS.recherche;
  var bgAlpha = (p.color || typeColor).replace("#", "");
  var iconBg =
    "rgba(" +
    parseInt(bgAlpha.substring(0, 2), 16) +
    "," +
    parseInt(bgAlpha.substring(2, 4), 16) +
    "," +
    parseInt(bgAlpha.substring(4, 6), 16) +
    ",0.12)";
  var chatCount = hubCountChats(p.id);
  var dateStr = hubRelativeDate(p.updatedAt);
  var isSelected = hubSelectedIds.has(p.id);

  var card = document.createElement("div");
  card.className =
    "p-card" +
    (p.pinned ? " p-card-pinned" : "") +
    (opts.muted ? " p-card-muted" : "") +
    (isSelected ? " p-card-selected" : "");
  card.tabIndex = 0;
  if (hubSelectMode) {
    card.setAttribute("role", "checkbox");
    card.setAttribute("aria-checked", isSelected ? "true" : "false");
    card.setAttribute(
      "aria-label",
      (p.name || "") + (isSelected ? t("chat.card.selectedSuffix") : ""),
    );
  } else {
    card.setAttribute("role", "button");
  }
  card.setAttribute(
    "aria-label",
    t("chat.card.aria", { name: p.name || "", type: typeLabel, date: dateStr }),
  );
  card.dataset.projectId = p.id;

  var checkboxHtml = hubSelectMode
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
      (p.color || typeColor) +
      ';" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      iconSvg +
      "</svg>" +
      "</div>" +
      (!hubSelectMode
        ? '<button class="p-card-menu" aria-label="' +
          t("chat.card.menuAria", { name: escapeHtml(p.name) }) +
          '" aria-haspopup="menu" data-pid="' +
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
        ? '<span class="p-card-chats"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><span class="sr-only">' +
          chatCount +
          " " +
          escapeHtml(t("chat.card.conversations")) +
          "</span>" +
          chatCount +
          "</span>"
        : "") +
      "</div>" +
      "</div>";
  }

  card.addEventListener("click", function (e) {
    if (e.target.closest(".p-card-menu")) return;
    if (hubSelectMode) {
      hubToggleSelect(p.id);
      return;
    }
    openProjectDetails(p.id);
  });
  card.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (hubSelectMode) {
        hubToggleSelect(p.id);
        return;
      }
      openProjectDetails(p.id);
    }
  });

  var menuBtn = card.querySelector(".p-card-menu");
  if (menuBtn) {
    menuBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      hubShowCtxMenu(p, menuBtn);
    });
  }

  return card;
}

function hubShowCtxMenu(project, anchorEl) {
  var menu = document.getElementById("hubCtxMenu");
  if (!menu) return;
  hubCtxTarget = project;

  var isPinned = project.pinned;
  var isArchived = project.archived;

  var folderItems = "";
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
      t("chat.ctx.removeFolder") +
      "</button>";
  }
  folderItems +=
    '<div class="hub-ctx-sep"></div>' +
    '<button class="hub-ctx-item" data-action="new-folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>' +
    t("chat.ctx.newFolder") +
    "</button>";

  menu.innerHTML =
    '<button class="hub-ctx-item" data-action="open"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
    t("chat.ctx.open") +
    "</button>" +
    '<button class="hub-ctx-item" data-action="rename"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4Z"/></svg>' +
    t("chat.ctx.rename") +
    "</button>" +
    '<button class="hub-ctx-item" data-action="pin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 2h6l-1.5 5h-3z"/><path d="M6.5 7h11l-1 5H7.5z"/></svg>' +
    (isPinned ? t("chat.ctx.unpin") : t("chat.ctx.pin")) +
    "</button>" +
    '<div class="hub-ctx-sep"></div>' +
    '<div class="hub-ctx-sub"><button class="hub-ctx-item" data-action="toggle-move"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h16a2 2 0 002-2V8a2 2 0 00-2-2h-7.93a2 2 0 01-1.66-.9l-.82-1.2A2 2 0 007.93 3H4a2 2 0 00-2 2v13c0 1.1.9 2 2 2Z"/></svg>' +
    t("chat.ctx.moveTo") +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;margin-left:auto;"><polyline points="9 6 15 12 9 18"/></svg></button>' +
    '<div class="hub-ctx-submenu" id="hubCtxSubmenuMove">' +
    folderItems +
    "</div></div>" +
    '<button class="hub-ctx-item" data-action="archive"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8"/><path d="M10 12h4"/></svg>' +
    (isArchived ? t("chat.ctx.unarchive") : t("chat.ctx.archive")) +
    "</button>" +
    '<button class="hub-ctx-item" data-action="duplicate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>' +
    t("chat.ctx.duplicate") +
    "</button>" +
    '<div class="hub-ctx-sep"></div>' +
    '<button class="hub-ctx-item hub-ctx-item-danger" data-action="delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>' +
    t("chat.ctx.delete") +
    "</button>";

  menu.querySelectorAll(".hub-ctx-item").forEach(function (item) {
    item.setAttribute("role", "menuitem");
  });
  menu.querySelectorAll("svg").forEach(function (svg) {
    svg.setAttribute("aria-hidden", "true");
  });
  var submenu = document.getElementById("hubCtxSubmenuMove");
  if (submenu) submenu.setAttribute("role", "menu");

  hubCtxAnchor = anchorEl;
  var rect = anchorEl.getBoundingClientRect();
  var hubEl = document.getElementById("projectsHubView");
  var hubRect = hubEl ? hubEl.getBoundingClientRect() : { left: 0, top: 0, width: 800 };
  var left = Math.min(rect.left - hubRect.left, hubRect.width - 180);
  var top = rect.bottom - hubRect.top + 4;
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  menu.style.display = "block";

  var firstItem = menu.querySelector(".hub-ctx-item");
  if (firstItem)
    requestAnimationFrame(function () {
      firstItem.focus();
    });

  menu.onkeydown = function (e) {
    var items = Array.from(
      menu.querySelectorAll('.hub-ctx-item:not([style*="display:none"])'),
    );
    var idx = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      var next = idx < items.length - 1 ? idx + 1 : 0;
      items[next].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      var prev = idx > 0 ? idx - 1 : items.length - 1;
      items[prev].focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      hubHideCtxMenu();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1].focus();
    }
  };
}

function hubHideCtxMenu() {
  var menu = document.getElementById("hubCtxMenu");
  if (menu) {
    menu.style.display = "none";
    menu.onkeydown = null;
  }
  var anchor = hubCtxAnchor;
  hubCtxTarget = null;
  hubCtxAnchor = null;
  if (anchor && anchor.isConnected) {
    requestAnimationFrame(function () {
      anchor.focus();
    });
  }
}

function hubHandleCtxAction(action) {
  var p = hubCtxTarget;
  hubHideCtxMenu();
  if (!p) return;

  if (action === "open") {
    openProjectDetails(p.id);
  } else if (action === "rename") {
    var newName = prompt(t("chat.prompt.renameProject"), p.name);
    if (newName && newName.trim()) {
      window.openhub.saveProject({ id: p.id, name: newName.trim() }).then(function () {
        showToast(t("chat.toast.projectRenamed"), "success");
        loadProjects();
      });
    }
  } else if (action === "pin") {
    var wasPinned = p.pinned;
    window.openhub
      .saveProject({ id: p.id, name: p.name, pinned: !wasPinned })
      .then(function () {
        showToast(
          wasPinned ? t("chat.toast.projectUnpinned") : t("chat.toast.projectPinned"),
          "success",
        );
        loadProjects();
      });
  } else if (action === "duplicate") {
    window.openhub
      .saveProject({
        name: p.name + t("chat.project.copySuffix"),
        instructions: p.instructions || "",
        color: p.color || "",
        type: p.type,
      })
      .then(function () {
        showToast(t("chat.toast.projectDuplicated"), "success");
        loadProjects();
      });
  } else if (action === "archive") {
    var wasArchived = p.archived;
    window.openhub
      .saveProject({
        id: p.id,
        name: p.name,
        archived: !wasArchived,
        pinned: wasArchived ? p.pinned : false,
      })
      .then(function () {
        showToast(
          wasArchived
            ? t("chat.toast.projectUnarchived")
            : t("chat.toast.projectArchived"),
          "success",
        );
        loadProjects().then(function () {
          window.renderProjectsHub();
        });
      });
  } else if (action === "move-folder") {
    return;
  } else if (action === "remove-folder") {
    window.openhub.saveProject({ id: p.id, name: p.name, folder: "" }).then(function () {
      showToast(t("chat.toast.removedFromFolder"), "success");
      loadProjects().then(function () {
        window.renderProjectsHub();
      });
    });
  } else if (action === "new-folder") {
    var folderName = prompt(t("chat.prompt.newFolder"));
    if (folderName && folderName.trim()) {
      window.openhub
        .createFolder(folderName.trim())
        .then(function () {
          return window.openhub.saveProject({
            id: p.id,
            name: p.name,
            folder: folderName.trim(),
          });
        })
        .then(function () {
          showToast(t("chat.toast.movedTo", { name: folderName.trim() }), "success");
          loadProjects().then(function () {
            window.renderProjectsHub();
          });
        });
    }
  } else if (action === "delete") {
    if (confirm(t("chat.confirm.deleteProject", { name: p.name }))) {
      removeProject(p.id).then(function () {
        showToast(t("chat.toast.projectDeleted"), "success");
      });
    }
  }
}

function hubHandleMoveToFolder(folderName) {
  var p = hubCtxTarget;
  hubHideCtxMenu();
  if (!p) return;
  window.openhub
    .saveProject({ id: p.id, name: p.name, folder: folderName })
    .then(function () {
      showToast(t("chat.toast.movedTo", { name: folderName }), "success");
      loadProjects().then(function () {
        window.renderProjectsHub();
      });
    });
}

/* ── Select Mode ── */
function hubEnterSelectMode() {
  hubSelectMode = true;
  hubSelectedIds.clear();
  document.getElementById("hubSelectBar").classList.add("active");
  document.querySelector(".projects-hub-actions").style.display = "none";
  hubUpdateSelectCount();
  hubRenderContent();
}

function hubExitSelectMode() {
  hubSelectMode = false;
  hubSelectedIds.clear();
  document.getElementById("hubSelectBar").classList.remove("active");
  document.querySelector(".projects-hub-actions").style.display = "flex";
  hubRenderContent();
}

function hubToggleSelect(id) {
  if (hubSelectedIds.has(id)) {
    hubSelectedIds.delete(id);
  } else {
    hubSelectedIds.add(id);
  }
  hubUpdateSelectCount();
  hubRenderContent();
}

function hubUpdateSelectCount() {
  var n = hubSelectedIds.size;
  var countEl = document.getElementById("hubSelectCount");
  var delBtn = document.getElementById("btnDeleteSelected");
  if (countEl)
    countEl.textContent = t(n > 1 ? "chat.select.countPlural" : "chat.select.count", {
      n: n,
    });
  if (delBtn) {
    delBtn.textContent = t("chat.select.deleteCount", { n: n });
    delBtn.disabled = n === 0;
  }
}

function hubDeleteSelected() {
  var n = hubSelectedIds.size;
  if (n === 0) return;
  if (
    !confirm(
      t(n > 1 ? "chat.select.confirmDeletePlural" : "chat.select.confirmDelete", {
        n: n,
      }),
    )
  )
    return;
  var ids = Array.from(hubSelectedIds);
  var chain = Promise.resolve();
  ids.forEach(function (id) {
    chain = chain.then(function () {
      return window.openhub.deleteProject(id);
    });
  });
  chain.then(function () {
    showToast(
      t(n > 1 ? "chat.select.deletedPlural" : "chat.select.deleted", { n: n }),
      "success",
    );
    hubExitSelectMode();
    loadProjects();
  });
}

function hubAnnounce(msg) {
  var el = document.getElementById("hubAnnouncer");
  if (el) {
    el.textContent = "";
    requestAnimationFrame(function () {
      el.textContent = msg;
    });
  }
}

function hubRenderFilters() {
  var bar = document.getElementById("hubFilters");
  if (!bar) return;
  bar.innerHTML = "";
  hubFilterTypes().forEach(function (f) {
    var btn = document.createElement("button");
    btn.className = "hub-chip" + (hubFilter === f.key ? " hub-chip-active" : "");
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", hubFilter === f.key ? "true" : "false");
    btn.innerHTML = f.label;
    btn.addEventListener("click", function () {
      hubFilter = f.key;
      hubRenderFilters();
      hubRenderContent();
      hubAnnounce(t("chat.announce.filter", { label: f.label }));
    });
    bar.appendChild(btn);
  });
}

function hubRenderSection(container, label, iconSvg, projects, opts) {
  opts = opts || {};
  container.innerHTML = "";
  if (projects.length === 0 && !opts.showEmpty) return;

  var header = document.createElement("div");
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

  var grid = document.createElement("div");
  grid.className = "projects-grid";
  projects.forEach(function (p) {
    grid.appendChild(hubBuildCard(p, { muted: opts.muted }));
  });
  container.appendChild(grid);
  container.style.marginBottom = "20px";
}

function hubRenderContent() {
  var all = projState.projects || [];

  var filtered = all.filter(function (p) {
    return hubMatchesFilter(p, hubFilter) && hubMatchesSearch(p, hubSearchQuery);
  });
  var archived = filtered.filter(function (p) {
    return p.archived;
  });
  var active = filtered.filter(function (p) {
    return !p.archived;
  });
  var generated = active.filter(isOrchestratorProject);
  var userProjects = active.filter(function (p) {
    return !isOrchestratorProject(p);
  });

  var sorted = hubSortProjects(userProjects, hubSort);
  var pinned = sorted.filter(function (p) {
    return p.pinned;
  });
  var unpinned = sorted.filter(function (p) {
    return !p.pinned;
  });

  var folders = {};
  var noFolder = [];
  unpinned.forEach(function (p) {
    if (p.folder) {
      if (!folders[p.folder]) folders[p.folder] = [];
      folders[p.folder].push(p);
    } else {
      noFolder.push(p);
    }
  });

  var pinnedEl = document.getElementById("hubPinnedSection");
  var foldersEl = document.getElementById("hubFoldersSection");
  var allEl = document.getElementById("hubAllSection");
  var archivedEl = document.getElementById("hubArchivedSection");
  var genEl = document.getElementById("hubGeneratedSection");

  if (pinnedEl) {
    if (pinned.length > 0) {
      hubRenderSection(
        pinnedEl,
        t("chat.section.pinned"),
        '<path d="M12 17v5"/><path d="M9 2h6l-1.5 5h-3z"/><path d="M6.5 7h11l-1 5H7.5z"/>',
        pinned,
      );
    } else {
      pinnedEl.innerHTML = "";
    }
  }

  if (foldersEl) {
    foldersEl.innerHTML = "";
    var folderNames = Object.keys(folders).sort();
    folderNames.forEach(function (fname) {
      var section = document.createElement("div");
      section.style.marginBottom = "20px";
      var isOpen = hubFolderOpen[fname] !== false;

      var toggle = document.createElement("div");
      toggle.className = "hub-section-toggle";
      toggle.tabIndex = 0;
      toggle.setAttribute("role", "button");
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      toggle.setAttribute("aria-label", t("chat.section.folderAria", { name: fname }));
      var folderId = hubFolders.find(function (f) {
        return f.name === fname;
      });
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
        t("chat.folder.renameTitle") +
        '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4Z"/></svg></button>' +
        '<button class="hub-folder-btn hub-folder-btn-danger" data-folder-action="delete" title="' +
        t("chat.folder.deleteTitle") +
        '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>' +
        "</span>";
      toggle.addEventListener("click", function (e) {
        if (e.target.closest(".hub-folder-btn")) return;
        hubFolderOpen[fname] = !isOpen;
        hubRenderContent();
      });
      toggle.addEventListener("keydown", function (e) {
        if (e.target.closest(".hub-folder-btn")) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          hubFolderOpen[fname] = !isOpen;
          hubRenderContent();
        }
      });
      toggle.querySelectorAll(".hub-folder-btn").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          var act = btn.dataset.folderAction;
          if (act === "rename" && folderId) {
            var newName = prompt(t("chat.prompt.renameFolder"), fname);
            if (newName && newName.trim() && newName.trim() !== fname) {
              window.openhub.renameFolder(folderId.id, newName.trim()).then(function () {
                showToast(t("chat.toast.folderRenamed"), "success");
                loadProjects().then(function () {
                  window.renderProjectsHub();
                });
              });
            }
          } else if (act === "delete" && folderId) {
            if (confirm(t("chat.confirm.deleteFolder", { name: fname }))) {
              window.openhub.deleteFolder(folderId.id).then(function () {
                showToast(t("chat.toast.folderDeleted"), "success");
                loadProjects().then(function () {
                  window.renderProjectsHub();
                });
              });
            }
          }
        });
      });
      section.appendChild(toggle);

      if (isOpen) {
        var grid = document.createElement("div");
        grid.className = "projects-grid";
        folders[fname].forEach(function (p) {
          grid.appendChild(hubBuildCard(p));
        });
        section.appendChild(grid);
      }
      foldersEl.appendChild(section);
    });
  }

  if (allEl) {
    allEl.innerHTML = "";
    if (
      noFolder.length > 0 ||
      (pinned.length === 0 && Object.keys(folders).length === 0 && generated.length === 0)
    ) {
      var header = document.createElement("div");
      header.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;";
      var gridActive = hubViewMode === "grid" ? " hub-view-btn-active" : "";
      var listActive = hubViewMode === "list" ? " hub-view-btn-active" : "";
      header.innerHTML =
        '<div style="display:flex;align-items:center;gap:6px;">' +
        '<span class="hub-section-label">' +
        t("chat.section.allProjects") +
        "</span>" +
        '<span class="hub-section-count">' +
        noFolder.length +
        "</span>" +
        "</div>" +
        '<div class="hub-view-btns">' +
        '<button class="hub-view-btn' +
        gridActive +
        '" data-view="grid" aria-label="' +
        t("chat.view.gridAria") +
        '" title="' +
        t("chat.view.gridTitle") +
        '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>' +
        "</button>" +
        '<button class="hub-view-btn' +
        listActive +
        '" data-view="list" aria-label="' +
        t("chat.view.listAria") +
        '" title="' +
        t("chat.view.listTitle") +
        '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>' +
        "</button>" +
        "</div>";
      header.querySelectorAll(".hub-view-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          hubViewMode = btn.dataset.view;
          hubRenderContent();
        });
      });
      allEl.appendChild(header);

      if (noFolder.length === 0) {
        var empty = document.createElement("div");
        empty.style.cssText = "text-align:center;padding:48px;color:var(--text-muted);";
        empty.innerHTML = t("chat.hub.emptyCreate");
        allEl.appendChild(empty);
      } else {
        var grid = document.createElement("div");
        grid.className = hubViewMode === "list" ? "projects-list" : "projects-grid";
        noFolder.forEach(function (p) {
          grid.appendChild(hubBuildCard(p));
        });
        allEl.appendChild(grid);
      }
      allEl.style.marginBottom = "0";
    }
  }

  if (archivedEl) {
    archivedEl.innerHTML = "";
    if (archived.length > 0) {
      var archWrap = document.createElement("div");
      archWrap.className = "hub-gen-separator";

      var archToggle = document.createElement("div");
      archToggle.className = "hub-section-toggle";
      archToggle.tabIndex = 0;
      archToggle.setAttribute("role", "button");
      archToggle.setAttribute("aria-expanded", hubArchivedOpen ? "true" : "false");
      archToggle.setAttribute("aria-label", t("chat.hub.archivedAria"));
      archToggle.innerHTML =
        '<svg class="hub-section-chevron" style="transform:rotate(' +
        (hubArchivedOpen ? "0" : "-90") +
        'deg)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>' +
        '<svg class="hub-section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8"/><path d="M10 12h4"/></svg>' +
        '<span class="hub-section-label">' +
        t("chat.section.archived") +
        "</span>" +
        '<span class="hub-section-count">' +
        archived.length +
        "</span>";
      archToggle.addEventListener("click", function () {
        hubArchivedOpen = !hubArchivedOpen;
        hubRenderContent();
      });
      archToggle.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          hubArchivedOpen = !hubArchivedOpen;
          hubRenderContent();
        }
      });
      archWrap.appendChild(archToggle);

      if (hubArchivedOpen) {
        var archGrid = document.createElement("div");
        archGrid.className = "projects-grid";
        archived.forEach(function (p) {
          archGrid.appendChild(hubBuildCard(p, { muted: true }));
        });
        archWrap.appendChild(archGrid);
      }
      archivedEl.appendChild(archWrap);
    }
  }

  if (genEl) {
    genEl.innerHTML = "";
    if (generated.length > 0) {
      var wrap = document.createElement("div");
      wrap.className = "hub-gen-separator";

      var toggle = document.createElement("div");
      toggle.className = "hub-section-toggle";
      toggle.tabIndex = 0;
      toggle.setAttribute("role", "button");
      toggle.setAttribute("aria-expanded", hubGenOpen ? "true" : "false");
      toggle.setAttribute("aria-label", t("chat.hub.generatedAria"));
      toggle.innerHTML =
        '<svg class="hub-section-chevron" style="transform:rotate(' +
        (hubGenOpen ? "0" : "-90") +
        'deg)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>' +
        '<svg class="hub-section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="m2 14 6-6 6 6"/></svg>' +
        '<span class="hub-section-label">' +
        t("chat.section.generated") +
        "</span>" +
        '<span class="hub-section-count">' +
        generated.length +
        "</span>";
      toggle.addEventListener("click", function () {
        hubGenOpen = !hubGenOpen;
        hubRenderContent();
      });
      toggle.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          hubGenOpen = !hubGenOpen;
          hubRenderContent();
        }
      });
      wrap.appendChild(toggle);

      if (hubGenOpen) {
        var grid = document.createElement("div");
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

window.renderProjectsHub = function () {
  window.openhub
    .reloadProjectStore()
    .then(function () {
      return Promise.all([window.openhub.getProjects(), window.openhub.getFolders()]);
    })
    .then(function (results) {
      projState.projects = results[0] || [];
      hubFolders = results[1] || [];
      hubRenderFilters();
      hubRenderContent();
    });
};

function openProjectDetails(projectId) {
  window.openhub.getProjects().then(function (allProjects) {
    var p = allProjects.find(function (x) {
      return x.id === projectId;
    });
    if (!p) return;

    window.switchMainView("projectDetailsView");
    document.getElementById("detailProjectName").textContent = p.name;
    document.getElementById("projectInstructions").value = p.instructions || "";
    document.getElementById("projectDetailsView").dataset.activeProjectId = projectId;

    renderProjectConversations(projectId);
  });
}

function renderProjectConversations(projectId) {
  var list = document.getElementById("projectConvList");
  if (!list) return;
  list.innerHTML = "";

  var filtered = conversations.filter(function (c) {
    return c.projectId === projectId;
  });

  if (filtered.length === 0) {
    list.innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">' +
      escapeHtml(t("chat.detail.noChats")) +
      "</div>";
    return;
  }

  filtered.forEach(function (c) {
    var item = document.createElement("div");
    item.className = "conv-item";
    item.innerHTML =
      '<div class="conv-item-title">' +
      escapeHtml(c.title || t("chat.conv.untitled")) +
      "</div>";
    item.onclick = function () {
      switchToConversation(c.id);
      window.switchMainView("chatView");
    };
    list.appendChild(item);
  });
}

function initProjectsLogic() {
  var btnHub = document.getElementById("btnNavProjects");
  if (btnHub) {
    btnHub.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (els.btnNavNewChat) els.btnNavNewChat.classList.remove("active");
      btnHub.classList.add("active");
      loadProjects().then(function () {
        window.switchMainView("projectsHubView");
        window.renderProjectsHub();
      });
    });
  }

  var btnClose = document.getElementById("btnCloseHub");
  if (btnClose) {
    btnClose.onclick = function () {
      if (document.getElementById("btnNavProjects"))
        document.getElementById("btnNavProjects").classList.remove("active");
      if (els.btnNavNewChat) els.btnNavNewChat.classList.add("active");
      window.switchMainView("chatView");
    };
  }

  var btnBack = document.getElementById("btnBackToHub");
  if (btnBack) {
    btnBack.onclick = function () {
      window.switchMainView("projectsHubView");
      window.renderProjectsHub();
    };
  }

  var btnNew = document.getElementById("btnNewProjectHub");
  if (btnNew) {
    btnNew.onclick = function () {
      openProjModal(null);
    };
  }

  var btnSave = document.getElementById("btnSaveInstructions");
  if (btnSave) {
    btnSave.onclick = async function () {
      var id = document.getElementById("projectDetailsView").dataset.activeProjectId;
      var instructions = document.getElementById("projectInstructions").value;
      var p = projState.projects.find(function (x) {
        return x.id === id;
      });
      if (p) {
        await window.openhub.saveProject({
          id: p.id,
          name: p.name,
          instructions: instructions,
        });
        showToast(t("chat.toast.instructionsSaved"), "success");
        loadProjects();
      }
    };
  }

  var btnNewChat = document.getElementById("btnNewChatInProject");
  if (btnNewChat) {
    btnNewChat.onclick = function () {
      var id = document.getElementById("projectDetailsView").dataset.activeProjectId;
      activateProject(id);
      startNewConversation();
      window.switchMainView("chatView");
    };
  }

  var btnSelect = document.getElementById("btnSelectMode");
  if (btnSelect) {
    btnSelect.onclick = function () {
      hubEnterSelectMode();
    };
  }
  var btnCancelSelect = document.getElementById("btnCancelSelect");
  if (btnCancelSelect) {
    btnCancelSelect.onclick = function () {
      hubExitSelectMode();
    };
  }
  var btnDeleteSelected = document.getElementById("btnDeleteSelected");
  if (btnDeleteSelected) {
    btnDeleteSelected.onclick = function () {
      hubDeleteSelected();
    };
  }

  var btnDeleteDetail = document.getElementById("btnDeleteProjectDetail");
  if (btnDeleteDetail) {
    btnDeleteDetail.onclick = function () {
      var id = document.getElementById("projectDetailsView").dataset.activeProjectId;
      var p = projState.projects.find(function (x) {
        return x.id === id;
      });
      if (p && confirm(t("chat.confirm.deleteProject", { name: p.name }))) {
        removeProject(p.id).then(function () {
          showToast(t("chat.toast.projectDeleted"), "success");
          window.switchMainView("projectsHubView");
          window.renderProjectsHub();
        });
      }
    };
  }

  var searchInput = document.getElementById("projectSearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", function () {
      clearTimeout(hubSearchTimer);
      hubSearchTimer = setTimeout(function () {
        hubSearchQuery = searchInput.value.trim();
        hubRenderContent();
        var all = projState.projects || [];
        var visible = all.filter(function (p) {
          return (
            !p.archived &&
            hubMatchesFilter(p, hubFilter) &&
            hubMatchesSearch(p, hubSearchQuery) &&
            !isOrchestratorProject(p)
          );
        });
        hubAnnounce(
          t(visible.length > 1 ? "chat.announce.foundPlural" : "chat.announce.found", {
            n: visible.length,
          }),
        );
      }, 150);
    });
    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        searchInput.value = "";
        hubSearchQuery = "";
        hubRenderContent();
        searchInput.blur();
      }
    });
  }

  var sortSelect = document.getElementById("hubSortSelect");
  if (sortSelect) {
    sortSelect.addEventListener("change", function () {
      hubSort = sortSelect.value;
      hubRenderContent();
      var labels = {
        recent: t("chat.sort.recent"),
        az: t("chat.sort.az"),
        type: t("chat.sort.type"),
      };
      hubAnnounce(t("chat.announce.sort", { label: labels[hubSort] || hubSort }));
    });
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && hubSelectMode) {
      hubExitSelectMode();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      var hubView = document.getElementById("projectsHubView");
      if (hubView && !hubView.classList.contains("hidden") && searchInput) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    }

    var hubView = document.getElementById("projectsHubView");
    if (!hubView || hubView.classList.contains("hidden")) return;
    if (!document.activeElement || !document.activeElement.classList.contains("p-card"))
      return;
    if (
      e.key !== "ArrowRight" &&
      e.key !== "ArrowLeft" &&
      e.key !== "ArrowDown" &&
      e.key !== "ArrowUp"
    )
      return;

    var grid = document.activeElement.closest(".projects-grid");
    if (!grid) return;
    var cards = Array.from(grid.querySelectorAll(".p-card"));
    var idx = cards.indexOf(document.activeElement);
    if (idx === -1) return;

    var style = getComputedStyle(grid);
    var cols = style.getPropertyValue("grid-template-columns").split(" ").length;
    var next = -1;

    if (e.key === "ArrowRight") next = Math.min(idx + 1, cards.length - 1);
    else if (e.key === "ArrowLeft") next = Math.max(idx - 1, 0);
    else if (e.key === "ArrowDown") next = Math.min(idx + cols, cards.length - 1);
    else if (e.key === "ArrowUp") next = Math.max(idx - cols, 0);

    if (next !== -1 && next !== idx) {
      e.preventDefault();
      cards[next].focus();
    }
  });

  document.addEventListener("click", function (e) {
    var menu = document.getElementById("hubCtxMenu");
    if (menu && menu.style.display === "block") {
      var actionBtn = e.target.closest(".hub-ctx-item");
      if (actionBtn) {
        var act = actionBtn.dataset.action;
        if (act === "toggle-move") {
          var sub = document.getElementById("hubCtxSubmenuMove");
          if (sub) sub.classList.toggle("open");
          return;
        }
        e.stopPropagation();
        if (act === "move-folder" && actionBtn.dataset.folder) {
          hubHandleMoveToFolder(actionBtn.dataset.folder);
        } else {
          hubHandleCtxAction(act);
        }
        return;
      }
      if (!e.target.closest(".hub-ctx-menu")) {
        hubHideCtxMenu();
      }
    }

    if (e.target.id === "hubEmptyCreate") {
      openProjModal(null);
    }
  });
}

/* ── Start ── */
document.addEventListener("DOMContentLoaded", function () {
  initProjectsLogic();

  // Unblock UI instantly — never wait for init
  var layoutEl = document.querySelector(".app-layout");
  if (layoutEl) layoutEl.classList.remove("oh-init-pending");
  if (els && els.input) els.input.focus();

  // Fire init — everything runs in background, UI stays responsive
  init();
});

// Re-render JS-built chrome on live language change. The runtime auto-reapplies
// [data-i18n] markup; here we refresh only the labels our JS injects dynamically.
if (window.I18N && window.I18N.onChange) {
  window.I18N.onChange(function () {
    try {
      if (typeof renderConvList === "function") renderConvList();
      if (typeof updateEmptyState === "function") updateEmptyState();
      if (typeof updateReasoningUI === "function") updateReasoningUI();
      if (typeof renderProjectUI === "function") renderProjectUI();
      if (els && els.modelLabel && state && state.models) {
        els.modelLabel.textContent =
          state.models.length === 0
            ? t("chat.model.none")
            : displayModelName(state.selectedModel) || t("chat.model.ready");
      }
      var hubView = document.getElementById("projectsHubView");
      if (hubView && !hubView.classList.contains("hidden")) {
        if (typeof hubRenderFilters === "function") hubRenderFilters();
        if (typeof hubRenderContent === "function") hubRenderContent();
        if (typeof hubUpdateSelectCount === "function" && hubSelectMode)
          hubUpdateSelectCount();
      }
      var detailView = document.getElementById("projectDetailsView");
      if (detailView && !detailView.classList.contains("hidden")) {
        var pid = detailView.dataset.activeProjectId;
        if (pid && typeof renderProjectConversations === "function")
          renderProjectConversations(pid);
      }
    } catch (e) {
      /* a refresh failure must never break the language switch */
    }
  });
}
