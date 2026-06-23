/* chat.js — Assistant conversations, SSE streaming, action/question blocks */

var conversations = [];
var activeConvId = null;
var CONV_KEY = "openaxis-orch-convs";
var ACTIVE_CONV_KEY = "openaxis-last-conv";

function getConvKey() {
  return activeWorkflowId ? CONV_KEY + "-" + activeWorkflowId : CONV_KEY;
}

function getActiveConvKey() {
  return activeWorkflowId ? ACTIVE_CONV_KEY + "-" + activeWorkflowId : ACTIVE_CONV_KEY;
}

function loadConversations() {
  try {
    var raw = localStorage.getItem(getConvKey());
    if (raw) conversations = JSON.parse(raw);
    else conversations = [];
  } catch (e) {
    conversations = [];
  }
  if (conversations.length === 0) {
    activeConvId = null;
    renderOrchChatHistory();
    renderConvDropdown();
    return;
  }
  if (
    !activeConvId ||
    !conversations.find(function (c) {
      return c.id === activeConvId;
    })
  ) {
    var savedConvId = localStorage.getItem(getActiveConvKey());
    if (
      savedConvId &&
      conversations.find(function (c) {
        return c.id === savedConvId;
      })
    ) {
      activeConvId = savedConvId;
    } else {
      activeConvId = conversations[0].id;
    }
  }
  renderOrchChatHistory();
  renderConvDropdown();
}

function saveConversations() {
  try {
    localStorage.setItem(getConvKey(), JSON.stringify(conversations.slice(-20)));
  } catch (e) {}
  persistConvsToDisk();
}

function persistActiveConvId() {
  if (activeConvId && activeWorkflowId) {
    localStorage.setItem(getActiveConvKey(), activeConvId);
  }
}

var _convDiskTimer = null;
function persistConvsToDisk() {
  if (_convDiskTimer) clearTimeout(_convDiskTimer);
  _convDiskTimer = setTimeout(function () {
    _convDiskTimer = null;
    try {
      var allKeys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf(CONV_KEY) === 0) allKeys.push(key);
      }
      var dump = {};
      allKeys.forEach(function (k) {
        try {
          dump[k] = JSON.parse(localStorage.getItem(k));
        } catch (e) {}
      });
      if (window.openaxis && window.openaxis.writeOrchConversations) {
        window.openaxis.writeOrchConversations(JSON.stringify(dump));
      }
    } catch (e) {}
  }, 2000);
}

function getActiveConv() {
  return conversations.find(function (c) {
    return c.id === activeConvId;
  });
}

function getActiveConvMessages() {
  var conv = getActiveConv();
  return conv ? conv.messages : [];
}

function ensureConversation() {
  if (activeConvId && getActiveConv()) return getActiveConv();
  var title = t("proj.chat.discussionPrefix") + (conversations.length + 1);
  var conv = {
    id: "conv-" + Date.now(),
    workflowId: activeWorkflowId,
    title: title,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  conversations.unshift(conv);
  activeConvId = conv.id;
  persistActiveConvId();
  saveConversations();
  renderConvDropdown();
  return conv;
}

function toggleConvDropdown(e) {
  e.stopPropagation();
  var dd = document.getElementById("convDropdown");
  dd.classList.toggle("open");
}

function renderConvDropdown() {
  var dd = document.getElementById("convDropdown");
  if (!dd) return;
  dd.innerHTML = "";
  conversations.forEach(function (c) {
    var item = document.createElement("div");
    item.className = "conv-dropdown-item" + (c.id === activeConvId ? " active" : "");
    item.textContent = c.title;
    item.onclick = function () {
      selectConversation(c.id);
    };
    dd.appendChild(item);
  });
  if (conversations.length > 0) {
    var div = document.createElement("div");
    div.className = "conv-dropdown-divider";
    dd.appendChild(div);
  }
  var newItem = document.createElement("div");
  newItem.className = "conv-dropdown-new";
  newItem.textContent = t("proj.chat.newConversationItem");
  newItem.onclick = function () {
    newConversation();
    dd.classList.remove("open");
  };
  dd.appendChild(newItem);
}

function selectConversation(id) {
  activeConvId = id;
  persistActiveConvId();
  document.getElementById("convDropdown").classList.remove("open");
  renderOrchChatHistory();
  renderConvDropdown();
}

// A conversation keeps an auto-generated placeholder title until the first user
// message renames it. Recognize both languages' placeholders (and titles created
// before a language switch) so auto-renaming keeps working across locales.
function isPlaceholderConvTitle(title) {
  if (!title) return true;
  if (
    title === "Nouvelle conversation" ||
    title === "New conversation" ||
    title === "Discussion " ||
    title.startsWith("Discussion ")
  )
    return true;
  return false;
}

function newConversation() {
  activeConvId = null;
  conversations.unshift({
    id: "conv-" + Date.now(),
    workflowId: activeWorkflowId,
    title: t("proj.chat.newConversation"),
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  activeConvId = conversations[0].id;
  persistActiveConvId();
  saveConversations();
  renderOrchChatHistory();
  renderConvDropdown();
}

function updateConvTitle(title) {
  var conv = getActiveConv();
  if (!conv) return;
  if (!isPlaceholderConvTitle(conv.title)) return;
  conv.title = title.length > 40 ? title.substring(0, 40) + "…" : title;
  saveConversations();
  renderConvDropdown();
}

function makeCopyButton(bubble) {
  var copyBtn = document.createElement("button");
  copyBtn.className = "chat-copy-btn";
  copyBtn.title = t("proj.chat.copy");
  copyBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  copyBtn.onclick = function (e) {
    e.stopPropagation();
    var txt = bubble.textContent || "";
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
  return copyBtn;
}

function renderOrchChatHistory() {
  var container = document.getElementById("chatMessages");
  if (!container) return;
  container.innerHTML = "";
  var titleEl = document.getElementById("convTitle");
  var conv = getActiveConv();

  if (conv) {
    titleEl.textContent = conv.title;
  } else {
    titleEl.textContent = t("proj.chat.newConversation");
  }

  if (!conv || conv.messages.length === 0) {
    container.innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">' +
      escapeHtml(t("proj.chat.welcome")) +
      "</div>";
    return;
  }

  conv.messages.forEach(function (msg) {
    var div = document.createElement("div");
    div.className =
      "cm " +
      (msg.role === "user"
        ? "cm user"
        : msg.role === "assistant"
          ? "cm assistant"
          : "cm system");
    var bubble = document.createElement("div");
    bubble.className = "bub";
    bubble.textContent =
      msg.role === "assistant" ? stripBlocks(msg.content) : msg.content;
    div.appendChild(bubble);

    if (msg.role === "assistant" && msg.reasoning) {
      updateReasoningPanel(bubble, msg.reasoning, false);
      collapseReasoningPanel(bubble);
    }

    if (msg.role === "user" || msg.role === "assistant") {
      div.appendChild(makeCopyButton(bubble));
    }

    container.appendChild(div);
  });
  container.scrollTop = container.scrollHeight;
}

function addChatMessage(role, text) {
  var container = document.getElementById("chatMessages");
  if (!container) return;
  var empty = container.querySelector('[style*="padding:20px"]');
  if (empty) empty.remove();
  var msg = document.createElement("div");
  msg.className =
    "cm " +
    (role === "user" ? "cm user" : role === "assistant" ? "cm assistant" : "cm system");
  var bubble = document.createElement("div");
  bubble.className = "bub";
  if (text) bubble.textContent = text;
  msg.appendChild(bubble);
  if (role === "user" || role === "assistant") {
    msg.appendChild(makeCopyButton(bubble));
  }
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

function addMessageToConv(role, content, reasoning) {
  var conv = ensureConversation();
  if (role === "user" && conv.messages.length === 0) {
    var title = content.substring(0, 40);
    if (content.length > 40) title += "…";
    conv.title = title;
    document.getElementById("convTitle").textContent = title;
    renderConvDropdown();
  }
  var msg = { role: role, content: content, timestamp: Date.now() };
  if (reasoning) {
    msg.reasoning = reasoning;
  }
  conv.messages.push(msg);
  conv.updatedAt = Date.now();
  saveConversations();
}

var THINKING_SVG =
  '<svg viewBox="0 0 512 512" fill="none"><g stroke="var(--accent-primary,#14B8A6)" stroke-width="76" stroke-linecap="round" opacity="0.25"><path d="M 311.4 103.8 A 162 162 0 0 1 415.5 284.1"/><path d="M 360.1 380.1 A 162 162 0 0 1 151.9 380.1"/><path d="M 96.5 284.1 A 162 162 0 0 1 200.6 103.8"/></g><g stroke="var(--accent-primary,#14B8A6)" stroke-width="76" stroke-linecap="round"><path d="M 311.4 103.8 A 162 162 0 0 1 415.5 284.1"/></g></svg>';

function showThinkingIndicator(bubble) {
  var indicator = document.createElement("div");
  indicator.className = "msg-thinking";
  indicator.innerHTML =
    THINKING_SVG +
    '<span class="msg-thinking-label">' +
    escapeHtml(t("proj.chat.thinking")) +
    "</span>";
  bubble.appendChild(indicator);
}

function removeThinkingIndicator(bubble) {
  var el = bubble.querySelector(".msg-thinking");
  if (el) el.remove();
}

function updateReasoningPanel(bubble, text, streaming) {
  var parent = bubble.parentElement;
  if (!parent) return;
  var panel = parent.querySelector(".msg-reasoning");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "msg-reasoning";
    if (streaming) panel.classList.add("msg-reasoning--streaming");
    var header = document.createElement("div");
    header.className = "msg-reasoning-header";
    header.innerHTML =
      '<svg viewBox="0 0 512 512" fill="none"><g stroke="var(--accent-primary,#14B8A6)" stroke-width="76" stroke-linecap="round" opacity="0.25"><path d="M 311.4 103.8 A 162 162 0 0 1 415.5 284.1"/><path d="M 360.1 380.1 A 162 162 0 0 1 151.9 380.1"/><path d="M 96.5 284.1 A 162 162 0 0 1 200.6 103.8"/></g><g stroke="var(--accent-primary,#14B8A6)" stroke-width="76" stroke-linecap="round"><path d="M 311.4 103.8 A 162 162 0 0 1 415.5 284.1"/></g></svg>' +
      "<span>" +
      escapeHtml(t("proj.chat.reasoning")) +
      "</span>" +
      '<svg class="msg-reasoning-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    header.onclick = function () {
      panel.classList.toggle("msg-reasoning--collapsed");
    };
    var content = document.createElement("div");
    content.className = "msg-reasoning-content";
    panel.appendChild(header);
    panel.appendChild(content);
    parent.insertBefore(panel, bubble);
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

function collapseReasoningPanel(bubble) {
  var parent = bubble.parentElement;
  if (!parent) return;
  var panel = parent.querySelector(".msg-reasoning");
  if (panel) {
    panel.classList.add("msg-reasoning--collapsed");
    panel.classList.remove("msg-reasoning--streaming");
  }
}

function stripBlocks(text) {
  return text
    .replace(/```action\n[\s\S]*?\n```/g, "")
    .replace(/```questions\n[\s\S]*?\n```/g, "")
    .replace(/```action[\s\S]*$/, "")
    .replace(/```questions[\s\S]*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

var _chatSending = false;

function sendChat() {
  if (_chatSending) return;
  var input = document.getElementById("chatInput");
  var text = input.value.trim();
  if (!text) return;

  _chatSending = true;
  var sendBtn = document.getElementById("btnSendChat");
  if (sendBtn) sendBtn.disabled = true;
  input.value = "";

  addChatMessage("user", text);
  addMessageToConv("user", text);

  var bubble = addChatMessage("assistant", "");
  showThinkingIndicator(bubble);
  var fullText = "";
  var fullReasoning = "";
  var responseStarted = false;

  var model = document.getElementById("assistantModelSelect").value;
  var proxyUrl = "http://127.0.0.1:9999/v1/orch/assistant";
  var msgs = getActiveConvMessages();

  var questionRounds = msgs.filter(function (m) {
    return m.role === "assistant" && /```questions\n[\s\S]*?\n```/.test(m.content);
  }).length;

  getProxyToken()
    .then(function (__token) {
      return fetch(proxyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + __token,
        },
        body: JSON.stringify({
          messages: msgs.map(function (m) {
            return { role: m.role, content: m.content };
          }),
          context: {
            projects: projects.map(function (p) {
              return {
                id: p.id,
                name: p.name,
                type: p.type,
                model: p.model,
                instructions: p.instructions,
                task: p.task,
              };
            }),
            workflows: workflows,
            activeWorkflowId: activeWorkflowId,
            availableModels: models.map(function (m) {
              return m.id;
            }),
          },
          questionRounds: questionRounds,
          model: model,
        }),
      });
    })
    .then(async function (res) {
      if (!res.ok) {
        removeThinkingIndicator(bubble);
        bubble.textContent = t("proj.chat.httpError", {
          status: res.status,
          body: (
            await res.text().catch(function () {
              return "";
            })
          ).substring(0, 200),
        });
        return;
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder("utf-8");
      var buffer = "";

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (var i = 0; i < lines.length; i++) {
          var trimmed = lines[i].trim();
          if (trimmed.startsWith("data:") && trimmed !== "data: [DONE]") {
            try {
              var parsed = JSON.parse(trimmed.slice(5));
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
              if (parsed.error) {
                fullText += t("proj.chat.streamError", { error: parsed.error });
                continue;
              }
              if (reasoningDelta) {
                if (!fullReasoning) removeThinkingIndicator(bubble);
                fullReasoning += reasoningDelta;
                updateReasoningPanel(bubble, fullReasoning, true);
                var container = document.getElementById("chatMessages");
                if (container) container.scrollTop = container.scrollHeight;
              }
              if (delta) {
                if (!responseStarted && fullReasoning) {
                  responseStarted = true;
                  collapseReasoningPanel(bubble);
                }
                fullText += delta;
                removeThinkingIndicator(bubble);
                bubble.textContent = stripBlocks(fullText);
                var container = document.getElementById("chatMessages");
                if (container) container.scrollTop = container.scrollHeight;
              }
            } catch (e) {}
          }
        }
      }

      bubble.textContent = stripBlocks(fullText);

      var prevWorkflowId = activeWorkflowId;
      var prevConvId = activeConvId;

      await processActions(bubble, fullText);
      processQuestions(bubble, fullText);

      // If workflow changed during auto-actions, transfer the conversation
      if (activeWorkflowId !== prevWorkflowId && prevConvId) {
        var oldKey = CONV_KEY + "-" + prevWorkflowId;
        try {
          var rawOld = localStorage.getItem(oldKey);
          if (rawOld) {
            var oldConvs = JSON.parse(rawOld);
            var found = oldConvs.find(function (c) {
              return c.id === prevConvId;
            });
            if (found) {
              oldConvs = oldConvs.filter(function (c) {
                return c.id !== prevConvId;
              });
              localStorage.setItem(oldKey, JSON.stringify(oldConvs));
              found.workflowId = activeWorkflowId;
              conversations = [found];
              activeConvId = found.id;
              saveConversations();
            }
          }
        } catch (e) {}
      }

      if (fullReasoning) {
        collapseReasoningPanel(bubble);
      }
      addMessageToConv("assistant", fullText, fullReasoning);

      if (window.openaxis && window.openaxis.notifyTaskDone) {
        window.openaxis.notifyTaskDone("chat");
      }

      if (activeWorkflowId !== prevWorkflowId) {
        renderOrchChatHistory();
        renderConvDropdown();
      }
    })
    .catch(function (err) {
      removeThinkingIndicator(bubble);
      if (fullReasoning) {
        collapseReasoningPanel(bubble);
      }
      bubble.textContent = t("proj.chat.connError", {
        msg: err.message || t("proj.common.unknown"),
      });
    })
    .finally(function () {
      _chatSending = false;
      var sendBtn = document.getElementById("btnSendChat");
      if (sendBtn) sendBtn.disabled = false;
      document.getElementById("chatInput").disabled = false;
    });
}

function describeAction(action) {
  switch (action.type) {
    case "create_workflow":
      return t("proj.action.createWorkflow", { name: action.name });
    case "create_project":
      return (
        t("proj.action.createProject", { name: action.name }) +
        (action.linkToWf ? t("proj.action.linkedToActiveWf") : "")
      );
    case "link_project":
      return t("proj.action.linkProject");
    case "set_model":
      if (action.target === "all") {
        return t("proj.action.setModelAll", { model: action.model });
      }
      return t("proj.action.setModel", { model: action.model });
    case "set_task":
      return t("proj.action.setTask");
    default:
      return t("proj.action.generic", { type: action.type });
  }
}

async function processActions(bubbleEl, fullText) {
  var regex = /```action\n([\s\S]*?)\n```/g;
  var match;
  var actions = [];
  while ((match = regex.exec(fullText)) !== null) {
    try {
      actions.push(JSON.parse(match[1].trim()));
    } catch (e) {}
  }

  if (actions.length === 0) return;

  bubbleEl.textContent = fullText.replace(/```action\n[\s\S]*?\n```/g, "").trim();

  var autoActions = actions.filter(function (a) {
    return a.auto === true;
  });
  var manualActions = actions.filter(function (a) {
    return a.auto !== true;
  });

  if (autoActions.length > 0) {
    var wfName = null;
    var agentNames = [];
    for (var i = 0; i < autoActions.length; i++) {
      if (autoActions[i].type === "create_workflow") wfName = autoActions[i].name;
      if (autoActions[i].type === "create_project") agentNames.push(autoActions[i].name);
      await confirmAction(JSON.stringify(autoActions[i]), true);
    }
    await resolveBatchDependencies(autoActions);
    await linkRootAgentsToOrchestrator();
    await loadProjects();
    renderManagement();

    var summary = "";
    var agentWord =
      agentNames.length > 1
        ? t("proj.summary.agentPlural")
        : t("proj.summary.agentSingular");
    if (wfName && agentNames.length > 0) {
      summary = t("proj.summary.wfWithAgents", {
        wf: wfName,
        count: agentNames.length,
        agentWord: agentWord,
        names: agentNames.join(", "),
      });
    } else if (wfName) {
      summary = t("proj.summary.wfOnly", { wf: wfName });
    } else if (agentNames.length > 0) {
      summary = t("proj.summary.agentsOnly", {
        count: agentNames.length,
        agentWord: agentWord,
        names: agentNames.join(", "),
      });
    } else {
      summary = t("proj.summary.applied");
    }
    addChatMessage("assistant", summary);
    addMessageToConv("assistant", summary);
  }

  manualActions.forEach(function (action) {
    var card = document.createElement("div");
    card.className = "chat-actions-card";
    var desc = document.createElement("span");
    desc.className = "action-desc";
    desc.textContent = describeAction(action);
    var btns = document.createElement("div");
    btns.className = "action-btns";
    var confirmBtn = document.createElement("button");
    confirmBtn.className = "action-btn confirm";
    confirmBtn.textContent = t("proj.chat.confirm");
    confirmBtn.onclick = function () {
      confirmAction(JSON.stringify(action));
      card.remove();
    };
    var dismissBtn = document.createElement("button");
    dismissBtn.className = "action-btn dismiss";
    dismissBtn.textContent = t("proj.chat.dismiss");
    dismissBtn.onclick = function () {
      card.remove();
    };
    btns.appendChild(confirmBtn);
    btns.appendChild(dismissBtn);
    card.appendChild(desc);
    card.appendChild(btns);
    bubbleEl.parentNode.appendChild(card);
  });
}

function processQuestions(bubbleEl, fullText) {
  var regex = /```questions\n([\s\S]*?)\n```/g;
  var match = regex.exec(fullText);
  if (!match) return;
  try {
    var parsed = JSON.parse(match[1].trim());
    var qs = parsed.questions || (parsed.text ? [parsed] : []);
    if (qs.length === 0) return;
    bubbleEl.textContent = fullText.replace(/```questions\n[\s\S]*?\n```/g, "").trim();

    var answers = {};
    var allCards = [];

    var confirmWrapper = document.createElement("div");
    confirmWrapper.className = "question-confirm-wrapper";
    var confirmBtn = document.createElement("button");
    confirmBtn.className = "question-confirm-btn";
    confirmBtn.textContent = t("proj.chat.confirmAnswers", {
      count: 0,
      total: qs.length,
    });
    confirmBtn.disabled = true;
    confirmWrapper.appendChild(confirmBtn);

    function updateConfirmState() {
      var count = Object.keys(answers).length;
      confirmBtn.textContent = t("proj.chat.confirmAnswers", {
        count: count,
        total: qs.length,
      });
      confirmBtn.disabled = count < qs.length;
    }

    confirmBtn.onclick = function () {
      var combinedText = qs
        .map(function (q, i) {
          return "• " + q.text + " → " + (answers[i] || "");
        })
        .join("\n");
      allCards.forEach(function (c) {
        c.remove();
      });
      confirmWrapper.remove();
      addChatMessage("user", combinedText);
      addMessageToConv("user", combinedText);
      sendChatWithText(combinedText);
    };

    qs.forEach(function (q, idx) {
      var card = document.createElement("div");
      card.className = "question-card";
      allCards.push(card);
      var label = document.createElement("div");
      label.className = "question-label";
      label.textContent = q.text;
      card.appendChild(label);
      var optWrap = document.createElement("div");
      optWrap.className = "question-options";

      function selectOption(value, activeBtn) {
        answers[idx] = value;
        optWrap.querySelectorAll(".question-opt-btn").forEach(function (b) {
          b.classList.remove("selected");
        });
        if (activeBtn) activeBtn.classList.add("selected");
        label.classList.add("question-answered");
        updateConfirmState();
      }

      (q.options || []).forEach(function (opt) {
        var btn = document.createElement("button");
        btn.className = "question-opt-btn";
        btn.textContent = opt;
        btn.onclick = function () {
          selectOption(opt, btn);
        };
        optWrap.appendChild(btn);
      });
      if (q.allowCustom) {
        var customInput = document.createElement("input");
        customInput.className = "question-custom-input";
        customInput.placeholder = t("proj.chat.customAnswer");
        customInput.oninput = function () {
          if (customInput.value.trim()) {
            selectOption(customInput.value.trim(), null);
          } else {
            delete answers[idx];
            label.classList.remove("question-answered");
            updateConfirmState();
          }
        };
        customInput.onkeydown = function (e) {
          if (e.key === "Enter" && customInput.value.trim()) {
            selectOption(customInput.value.trim(), null);
          }
        };
        optWrap.appendChild(customInput);
      }
      card.appendChild(optWrap);
      bubbleEl.parentNode.appendChild(card);
    });

    bubbleEl.parentNode.appendChild(confirmWrapper);
  } catch (e) {}
}

function answerQuestion(question, answer, idx) {
  var text = t("proj.chat.questionPrefix", { question: question, answer: answer });
  addChatMessage("user", text);
  addMessageToConv("user", text);
  sendChatWithText(t("proj.chat.answerPrefix", { question: question, answer: answer }));
}

function sendChatWithText(text) {
  document.getElementById("chatInput").value = text;
  sendChat();
}

/* Résout un nom/id de dépendance en cherchant d'abord parmi les agents
   du workflow actuel pour éviter les faux matchs sur des homonymes anciens. */
function getActiveLinkedIds() {
  var activeWf = workflows.find(function (w) {
    return w.id === activeWorkflowId;
  });
  if (activeWf && activeWf.linkedProjectIds) return activeWf.linkedProjectIds;
  var activeOrch = projects.find(function (p) {
    return p.id === selectedOrchestratorId;
  });
  return activeOrch ? activeOrch.linked || [] : [];
}

function resolveDepRef(dep) {
  var wfIds = getActiveLinkedIds();
  var inWf = projects.find(function (pp) {
    return wfIds.includes(pp.id) && (pp.id === dep || pp.name === dep);
  });
  if (inWf) return inWf.id;
  var global = projects.find(function (pp) {
    return pp.id === dep || pp.name === dep;
  });
  return global ? global.id : null;
}

/* Relie les agents sans dépendances à l'orchestrateur (racines du DAG). */
async function linkRootAgentsToOrchestrator() {
  if (!selectedOrchestratorId) return;
  var linked = getActiveLinkedIds();
  for (var i = 0; i < linked.length; i++) {
    var agent = projects.find(function (p) {
      return p.id === linked[i];
    });
    if (!agent) continue;
    var deps = agent.dependencies || [];
    if (deps.length === 0) {
      agent.dependencies = [selectedOrchestratorId];
      await window.openaxis.saveProject(agent);
    }
  }
}

/* Seconde passe : résout les dépendances par nom une fois TOUS les agents
   du batch créés (gère les références à des agents créés plus loin dans la réponse). */
async function resolveBatchDependencies(actions) {
  for (var i = 0; i < actions.length; i++) {
    var action = actions[i];
    if (
      action.type !== "create_project" ||
      !Array.isArray(action.dependencies) ||
      action.dependencies.length === 0
    )
      continue;
    var proj = projects.find(function (pp) {
      return pp.name === action.name;
    });
    if (!proj) continue;
    var depIds = action.dependencies
      .map(function (dep) {
        var id = resolveDepRef(dep);
        return id && id !== proj.id ? id : null;
      })
      .filter(Boolean);
    var current = proj.dependencies || [];
    var missing = depIds.filter(function (id) {
      return !current.includes(id);
    });
    if (missing.length > 0) {
      proj.dependencies = current.concat(missing);
      await window.openaxis.saveProject(proj);
    }
  }
}

async function confirmAction(actionJson, silent) {
  try {
    var action = JSON.parse(actionJson);
    switch (action.type) {
      case "create_workflow":
        await createWorkflowFromAssistant(action.name, silent);
        break;
      case "create_project":
        var activeWf = workflows.find(function (w) {
          return w.id === activeWorkflowId;
        });
        var linkedCount = activeWf ? (activeWf.linkedProjectIds || []).length : 0;
        var col = Math.floor(linkedCount / 6);
        var row = linkedCount % 6;
        var projData = {
          name: action.name,
          instructions: action.instructions || "Tu es un expert.",
          color: "#0d9488",
          x: 400 + col * 280,
          y: 80 + row * 140,
        };
        if (action.agentType) projData.type = action.agentType;
        if (action.model) projData.model = action.model;
        if (action.task) projData.task = action.task;
        if (Array.isArray(action.dependencies) && action.dependencies.length > 0) {
          var depIds = action.dependencies.map(resolveDepRef).filter(Boolean);
          if (depIds.length > 0) projData.dependencies = depIds;
        }
        var p = await window.openaxis.saveProject(projData);
        projects.push(p);
        if (action.linkToWf && activeWorkflowId && activeWf) {
          if (!activeWf.linkedProjectIds) activeWf.linkedProjectIds = [];
          if (!activeWf.linkedProjectIds.includes(p.id)) {
            activeWf.linkedProjectIds = [].concat(activeWf.linkedProjectIds, [p.id]);
            await window.openaxis.saveWorkflow(activeWf);
          }
          var activeOrch = projects.find(function (pp) {
            return pp.id === selectedOrchestratorId;
          });
          if (activeOrch) {
            if (!activeOrch.linked) activeOrch.linked = [];
            if (!activeOrch.linked.includes(p.id)) {
              activeOrch.linked.push(p.id);
              await window.openaxis.saveProject(activeOrch);
            }
          }
        }
        break;
      case "link_project":
        var linkWfId = action.workflowId || activeWorkflowId;
        if (linkWfId && action.projectId) {
          await linkProjectToWf(linkWfId, action.projectId);
        }
        break;
      case "set_model":
        var modelId = action.model || "";
        if (!modelId) break;
        if (action.target === "all") {
          var linkedIdsSM = getActiveLinkedIds();
          for (var si = 0; si < projects.length; si++) {
            if (linkedIdsSM.includes(projects[si].id)) {
              var updatedProj = Object.assign({}, projects[si], { model: modelId });
              await window.openaxis.saveProject(updatedProj);
              projects[si] = updatedProj;
            }
          }
        } else if (action.projectId) {
          var targetIdx = projects.findIndex(function (pp) {
            return pp.id === action.projectId;
          });
          if (targetIdx !== -1) {
            var updatedTarget = Object.assign({}, projects[targetIdx], {
              model: modelId,
            });
            await window.openaxis.saveProject(updatedTarget);
            projects[targetIdx] = updatedTarget;
          }
        } else if (action.projectName) {
          var targetIdxByName = projects.findIndex(function (pp) {
            return pp.name === action.projectName;
          });
          if (targetIdxByName !== -1) {
            var updatedByName = Object.assign({}, projects[targetIdxByName], {
              model: modelId,
            });
            await window.openaxis.saveProject(updatedByName);
            projects[targetIdxByName] = updatedByName;
          }
        }
        break;
      case "set_task":
        var taskText = action.task || "";
        if (!taskText) break;
        var orchForTask = projects.find(function (pp) {
          return pp.id === selectedOrchestratorId;
        });
        if (orchForTask) {
          orchForTask.task = taskText;
          await window.openaxis.saveProject(orchForTask);
          var sharedTaskEl = document.getElementById("sharedTaskText");
          if (sharedTaskEl) sharedTaskEl.value = taskText;
        }
        break;
    }
    if (!silent) {
      renderManagement();
      renderCanvas();
      updateTaskCard();
      addChatMessage(
        "system",
        t("proj.chat.actionExecuted", { desc: describeAction(action) }),
      );
    }
  } catch (err) {
    if (!silent)
      addChatMessage(
        "system",
        t("proj.chat.actionError", { msg: err.message || t("proj.common.unknown") }),
      );
  }
}

async function createWorkflowFromAssistant(name, batch) {
  if (!name) return;

  var oldWorkflowId = activeWorkflowId;
  var oldConvId = activeConvId;

  var orch = await window.openaxis.saveProject({
    name: t("proj.node.typeOrchestrator"),
    instructions:
      "Tu es un coordinateur d'agents. Distribue les tâches et assure la cohérence globale.",
    color: "#0d9488",
    type: "orchestrator",
    linked: [],
    orchSettings: { autoDistribute: true, checkCoherence: true, relaunchOnError: true },
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
  projects.push(orch);
  selectedOrchestratorId = orch.id;
  workflows.push(wf);
  activeWorkflowId = wf.id;
  renderWorkflowSelector();
  if (!batch) {
    await switchWorkflow(wf.id);
    // Transfer conversation from old workflow via direct localStorage access
    if (oldWorkflowId && oldConvId) {
      var oldKey = CONV_KEY + "-" + oldWorkflowId;
      try {
        var rawOld = localStorage.getItem(oldKey);
        if (rawOld) {
          var oldConvs = JSON.parse(rawOld);
          var found = oldConvs.find(function (c) {
            return c.id === oldConvId;
          });
          if (found && found.messages.length > 0) {
            oldConvs = oldConvs.filter(function (c) {
              return c.id !== oldConvId;
            });
            localStorage.setItem(oldKey, JSON.stringify(oldConvs));
            found.workflowId = wf.id;
            conversations = [found];
            activeConvId = found.id;
            saveConversations();
            renderOrchChatHistory();
            renderConvDropdown();
          }
        }
      } catch (e) {}
    }
    renderManagement();
  }
}

function suggestChat(text) {
  document.getElementById("chatInput").value = text;
  sendChat();
}

async function restoreConvsFromDisk() {
  if (!window.openaxis || !window.openaxis.readOrchConversations) return;
  try {
    var raw = await window.openaxis.readOrchConversations();
    if (!raw) return;
    var dump = JSON.parse(raw);
    var keys = Object.keys(dump);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.indexOf(CONV_KEY) !== 0) continue;
      if (!localStorage.getItem(key) && dump[key]) {
        localStorage.setItem(key, JSON.stringify(dump[key]));
      }
    }
  } catch (e) {}
}

function initChat() {
  document.getElementById("chatInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  document.getElementById("btnSendChat").onclick = sendChat;
}
