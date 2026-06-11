/* chat.js — Assistant conversations, SSE streaming, action/question blocks */

var conversations = [];
var activeConvId = null;
var CONV_KEY = "openhub-orch-convs";

function getConvKey() {
  return activeWorkflowId ? CONV_KEY + "-" + activeWorkflowId : CONV_KEY;
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
    activeConvId = conversations[0].id;
  }
  renderOrchChatHistory();
  renderConvDropdown();
}

function saveConversations() {
  try {
    localStorage.setItem(getConvKey(), JSON.stringify(conversations.slice(-20)));
  } catch (e) {}
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
  var title = "Discussion " + (conversations.length + 1);
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
  newItem.textContent = "＋ Nouvelle conversation";
  newItem.onclick = function () {
    newConversation();
    dd.classList.remove("open");
  };
  dd.appendChild(newItem);
}

function selectConversation(id) {
  activeConvId = id;
  document.getElementById("convDropdown").classList.remove("open");
  renderOrchChatHistory();
  renderConvDropdown();
}

function newConversation() {
  activeConvId = null;
  conversations.unshift({
    id: "conv-" + Date.now(),
    workflowId: activeWorkflowId,
    title: "Nouvelle conversation",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  activeConvId = conversations[0].id;
  saveConversations();
  renderOrchChatHistory();
  renderConvDropdown();
}

function updateConvTitle(title) {
  var conv = getActiveConv();
  if (!conv) return;
  if (
    conv.title !== "Nouvelle conversation" &&
    conv.title !== "Discussion " &&
    !conv.title.startsWith("Discussion")
  )
    return;
  conv.title = title.length > 40 ? title.substring(0, 40) + "…" : title;
  saveConversations();
  renderConvDropdown();
}

function makeCopyButton(bubble) {
  var copyBtn = document.createElement("button");
  copyBtn.className = "chat-copy-btn";
  copyBtn.title = "Copier";
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
    titleEl.textContent = "Nouvelle conversation";
  }

  if (!conv || conv.messages.length === 0) {
    container.innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">Posez une question ou décrivez votre projet. Je vous aiderai à créer et gérer vos workflows.</div>';
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

function addMessageToConv(role, content) {
  var conv = ensureConversation();
  if (role === "user" && conv.messages.length === 0) {
    var title = content.substring(0, 40);
    if (content.length > 40) title += "…";
    conv.title = title;
    document.getElementById("convTitle").textContent = title;
    renderConvDropdown();
  }
  conv.messages.push({ role: role, content: content, timestamp: Date.now() });
  conv.updatedAt = Date.now();
  saveConversations();
}

var THINKING_SVG =
  '<svg viewBox="0 0 512 512" fill="none"><g stroke="var(--accent-primary,#14B8A6)" stroke-width="76" stroke-linecap="round" opacity="0.25"><path d="M 311.4 103.8 A 162 162 0 0 1 415.5 284.1"/><path d="M 360.1 380.1 A 162 162 0 0 1 151.9 380.1"/><path d="M 96.5 284.1 A 162 162 0 0 1 200.6 103.8"/></g><g stroke="var(--accent-primary,#14B8A6)" stroke-width="76" stroke-linecap="round"><path d="M 311.4 103.8 A 162 162 0 0 1 415.5 284.1"/></g></svg>';

function showThinkingIndicator(bubble) {
  var indicator = document.createElement("div");
  indicator.className = "msg-thinking";
  indicator.innerHTML =
    THINKING_SVG + '<span class="msg-thinking-label">Réflexion…</span>';
  bubble.appendChild(indicator);
}

function removeThinkingIndicator(bubble) {
  var el = bubble.querySelector(".msg-thinking");
  if (el) el.remove();
}

function stripBlocks(text) {
  return text
    .replace(/```action\n[\s\S]*?\n```/g, "")
    .replace(/```questions\n[\s\S]*?\n```/g, "")
    .replace(/```action[\s\S]*$/, "")
    .replace(/```questions[\s\S]*$/, "")
    .trim();
}

function sendChat() {
  var input = document.getElementById("chatInput");
  var text = input.value.trim();
  if (!text) return;
  input.value = "";

  addChatMessage("user", text);
  addMessageToConv("user", text);

  var bubble = addChatMessage("assistant", "");
  showThinkingIndicator(bubble);
  var fullText = "";

  var model = document.getElementById("assistantModelSelect").value;
  var proxyUrl = "http://127.0.0.1:9999/v1/orch/assistant";
  var msgs = getActiveConvMessages();

  var questionRounds = msgs.filter(function (m) {
    return m.role === "assistant" && /```questions\n[\s\S]*?\n```/.test(m.content);
  }).length;

  fetch(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer openhub-local",
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
      },
      questionRounds: questionRounds,
      model: model,
    }),
  })
    .then(async function (res) {
      if (!res.ok) {
        removeThinkingIndicator(bubble);
        bubble.textContent =
          "❌ Erreur " +
          res.status +
          " : " +
          (
            await res.text().catch(function () {
              return "";
            })
          ).substring(0, 200);
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
              var delta =
                parsed.choices && parsed.choices[0] && parsed.choices[0].delta
                  ? parsed.choices[0].delta.content || ""
                  : "";
              if (parsed.error) {
                fullText += "\n[Erreur: " + parsed.error + "]";
                continue;
              }
              fullText += delta;
              removeThinkingIndicator(bubble);
              bubble.textContent = stripBlocks(fullText);
            } catch (e) {}
          }
        }
      }

      bubble.textContent = stripBlocks(fullText);
      processActions(bubble, fullText);
      processQuestions(bubble, fullText);
      addMessageToConv("assistant", fullText);
    })
    .catch(function (err) {
      removeThinkingIndicator(bubble);
      bubble.textContent = "❌ Erreur de connexion : " + (err.message || "inconnue");
    });
}

function describeAction(action) {
  switch (action.type) {
    case "create_workflow":
      return "Créer le workflow « " + action.name + " »";
    case "create_project":
      return (
        "Créer l'agent « " +
        action.name +
        " »" +
        (action.linkToWf ? " (lié au workflow actif)" : "")
      );
    case "link_project":
      return "Lier un agent au workflow";
    default:
      return "Action : " + action.type;
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
    for (var i = 0; i < autoActions.length; i++) {
      var label =
        describeAction(autoActions[i]) + " (" + (i + 1) + "/" + autoActions.length + ")";
      addChatMessage("system", "⚡ " + label);
      await confirmAction(JSON.stringify(autoActions[i]), true);
    }
    await loadProjects();
    renderManagement();
    var count = autoActions.length;
    addChatMessage(
      "system",
      "✅ " +
        count +
        " élément" +
        (count > 1 ? "s" : "") +
        " créé" +
        (count > 1 ? "s" : "") +
        ".",
    );
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
    confirmBtn.textContent = "Confirmer";
    confirmBtn.onclick = function () {
      confirmAction(JSON.stringify(action));
      card.remove();
    };
    var dismissBtn = document.createElement("button");
    dismissBtn.className = "action-btn dismiss";
    dismissBtn.textContent = "✕ Ignorer";
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
    confirmBtn.textContent = "Confirmer les réponses (0/" + qs.length + ")";
    confirmBtn.disabled = true;
    confirmWrapper.appendChild(confirmBtn);

    function updateConfirmState() {
      var count = Object.keys(answers).length;
      confirmBtn.textContent = "Confirmer les réponses (" + count + "/" + qs.length + ")";
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
        customInput.placeholder = "Autre réponse…";
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
  var text = "Question : " + question + "\nMa réponse : " + answer;
  addChatMessage("user", text);
  addMessageToConv("user", text);
  sendChatWithText("Pour ma réponse à « " + question + " » : " + answer);
}

function sendChatWithText(text) {
  document.getElementById("chatInput").value = text;
  sendChat();
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
        var p = await window.openhub.saveProject(projData);
        projects.push(p);
        if (action.linkToWf && activeWorkflowId && activeWf) {
          if (!activeWf.linkedProjectIds) activeWf.linkedProjectIds = [];
          if (!activeWf.linkedProjectIds.includes(p.id)) {
            activeWf.linkedProjectIds = [].concat(activeWf.linkedProjectIds, [p.id]);
            await window.openhub.saveWorkflow(activeWf);
          }
        }
        break;
      case "link_project":
        var linkWfId = action.workflowId || activeWorkflowId;
        if (linkWfId && action.projectId) {
          await linkProjectToWf(linkWfId, action.projectId);
        }
        break;
    }
    if (!silent) {
      renderManagement();
      renderCanvas();
      updateTaskCard();
      addChatMessage("system", "✅ Action exécutée : " + describeAction(action));
    }
  } catch (err) {
    if (!silent) addChatMessage("system", "❌ Erreur : " + (err.message || "inconnue"));
  }
}

async function createWorkflowFromAssistant(name, batch) {
  if (!name) return;
  var orch = await window.openhub.saveProject({
    name: "Orchestrateur",
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
  if (!batch) {
    await switchWorkflow(wf.id);
    renderManagement();
  }
}

function suggestChat(text) {
  document.getElementById("chatInput").value = text;
  sendChat();
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
