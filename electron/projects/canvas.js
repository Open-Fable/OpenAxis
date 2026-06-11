/* canvas.js — Canvas rendering, nodes, connections, pan/zoom, drag */

var _projectListDirty = false;
var zoom = 1;
var panX = 0;
var panY = 0;
var minZoom = 0.3;
var maxZoom = 2;
var isPanning = false;
var startPan = { x: 0, y: 0 };
var dragStartMouse = { x: 0, y: 0 };
var dragStartNode = { x: 0, y: 0 };

function toggleZenMode() {
  var body = document.body;
  var isZen = body.classList.toggle("zen-mode");
  if (isZen) {
    document.getElementById("orchestrationDetail").style.display = "none";
  }
  setTimeout(renderCanvas, 350);
}

function toggleLayoutMode() {
  var body = document.body;
  var btn = document.getElementById("btnToggleLayout");
  layoutMode = layoutMode === "vertical" ? "horizontal" : "vertical";
  body.classList.toggle("layout-horizontal", layoutMode === "horizontal");
  btn.querySelector(".icon-v").style.display = layoutMode === "vertical" ? "" : "none";
  btn.querySelector(".icon-h").style.display = layoutMode === "horizontal" ? "" : "none";
  drawConnections();
}

function selectOrchestrator(id) {
  zoom = 1;
  panX = 0;
  panY = 0;
  applyTransform();
  selectedOrchestratorId = id;
  selectedNodeId = null;
  window.openhub.setActiveProject(id);
  renderCanvas();
  updateTaskCard();
}

function renderCanvas() {
  var canvas = document.getElementById("orchestrationCanvas");
  var canvasInner = document.getElementById("canvasInner");
  var canvasEmpty = document.getElementById("canvasEmpty");
  var svg = document.getElementById("canvasSvg");
  document.querySelectorAll(".node-card").forEach(function (n) {
    n.remove();
  });
  svg.innerHTML = "";
  var activeOrch = projects.find(function (p) {
    return p.id === selectedOrchestratorId;
  });
  if (!activeOrch || activeOrch.type !== "orchestrator") {
    canvasEmpty.style.display = "flex";
    return;
  }
  canvasEmpty.style.display = "none";
  updateTaskCard();
  var activeWf = workflows.find(function (w) {
    return w.id === activeWorkflowId;
  });
  var conv = typeof getActiveConv === "function" ? getActiveConv() : null;
  var convProjectIds =
    conv && conv.projectIds && conv.projectIds.length > 0 ? conv.projectIds : null;
  var linkedIds = convProjectIds
    ? convProjectIds
    : activeWf
      ? activeWf.linkedProjectIds || []
      : activeOrch.linked || [];
  var linkedNodes = projects.filter(function (p) {
    return linkedIds.includes(p.id) || p.id === activeOrch.id;
  });
  linkedNodes.forEach(function (node, i) {
    var card = document.createElement("div");
    card.className =
      "node-card " + (node.id === selectedNodeId ? "node-card--selected" : "");
    if (node.status) card.classList.add("node-card--" + node.status);
    card.dataset.id = node.id;
    var posX = node.x != null ? node.x : node.id === activeOrch.id ? 100 : 450;
    var posY = node.y != null ? node.y : node.id === activeOrch.id ? 250 : 100 + i * 180;
    card.style.left = posX + "px";
    card.style.top = posY + "px";
    var typeLabel = "Agent";
    var typeClass = "node-card-type--project";
    if (node.type === "orchestrator") {
      typeLabel = "Orchestrateur";
      typeClass = "node-card-type--orch";
    } else if (node.type === "verifier") {
      typeLabel = "Vérificateur";
      typeClass = "node-card-type--verifier";
    } else if (node.type === "code") {
      typeLabel = "OpenCode";
    } else if (node.type === "design") {
      typeLabel = "Open Design";
    } else if (node.type === "work") {
      typeLabel = "OpenWork";
    } else if (node.type === "recherche") {
      typeLabel = "Recherche";
    }
    var statusLabel = "En attente";
    var statusClass = "status-dot--idle";
    if (node.status === "running") {
      statusLabel = "En cours";
      statusClass = "status-dot--running";
    } else if (node.status === "done") {
      statusLabel = "Terminé";
      statusClass = "status-dot--done";
    } else if (node.status === "error") {
      statusLabel = "Erreur";
      statusClass = "status-dot--error";
    } else if (node.status === "warning") {
      statusLabel = "Attention";
      statusClass = "status-dot--warning";
    } else if (node.status === "skipped") {
      statusLabel = "Ignoré";
      statusClass = "status-dot--skipped";
    }
    card.innerHTML =
      '<div class="node-card-type ' +
      typeClass +
      '">' +
      typeLabel +
      "</div>" +
      '<div class="node-card-name">' +
      escapeHtml(node.name) +
      "</div>" +
      '<div class="node-card-status"><span class="status-dot ' +
      statusClass +
      '"></span><span>' +
      statusLabel +
      "</span></div>" +
      '<div class="node-link-handle" data-id="' +
      node.id +
      '" title="Relier à un autre agent">+</div>';
    var handle = card.querySelector(".node-link-handle");
    if (handle) {
      handle.addEventListener("mousedown", function (e) {
        e.stopPropagation();
        e.preventDefault();
        linkStartNode = node.id;
      });
    }
    card.addEventListener("mousedown", function (e) {
      if (
        e.target.closest("button") ||
        e.target.closest("textarea") ||
        e.target.closest("select")
      )
        return;
      dragNode = node.id;
      selectedNodeId = node.id;
      if (node.type === "orchestrator") {
        openDetailWorkflow();
      } else {
        openDetailAgent(node.id);
      }
      document.querySelectorAll(".node-card").forEach(function (c) {
        c.classList.remove("node-card--selected");
      });
      card.classList.add("node-card--selected");
      dragStartMouse = { x: e.clientX, y: e.clientY };
      dragStartNode = {
        x: node.x != null ? node.x : node.id === activeOrch.id ? 100 : 450,
        y: node.y != null ? node.y : node.id === activeOrch.id ? 250 : 100 + i * 180,
      };
      e.preventDefault();
      e.stopPropagation();
    });
    canvasInner.appendChild(card);
  });
  drawConnections();
}

function drawConnections() {
  closeLinkPopover();
  var svg = document.getElementById("canvasSvg");
  svg.innerHTML = "";
  var defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML =
    '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker>';
  svg.appendChild(defs);
  var activeOrch = projects.find(function (p) {
    return p.id === selectedOrchestratorId;
  });
  if (!activeOrch) return;
  var hitWidth = Math.max(40, 40 / zoom);
  var activeWf = workflows.find(function (w) {
    return w.id === activeWorkflowId;
  });
  var linkedIds = activeWf ? activeWf.linkedProjectIds || [] : activeOrch.linked || [];
  var nodes = projects.filter(function (p) {
    return linkedIds.includes(p.id) || p.id === activeOrch.id;
  });
  nodes.forEach(function (node) {
    var nodeEl = document.querySelector('.node-card[data-id="' + node.id + '"]');
    if (!nodeEl) return;
    var deps = node.dependencies || [];
    deps.forEach(function (parentId) {
      var parentNode = projects.find(function (p) {
        return p.id === parentId;
      });
      var parentEl = document.querySelector('.node-card[data-id="' + parentId + '"]');
      if (!parentNode || !parentEl) return;
      var pX, pY, cX, cY, controlOffset, d;
      if (layoutMode === "horizontal") {
        pX = parentEl.offsetLeft + parentEl.offsetWidth;
        pY = parentEl.offsetTop + parentEl.offsetHeight / 2;
        cX = nodeEl.offsetLeft;
        cY = nodeEl.offsetTop + nodeEl.offsetHeight / 2;
        controlOffset = Math.abs(cX - pX) * 0.5;
        d =
          "M " +
          pX +
          " " +
          pY +
          " C " +
          (pX + controlOffset) +
          " " +
          pY +
          ", " +
          (cX - controlOffset) +
          " " +
          cY +
          ", " +
          cX +
          " " +
          cY;
      } else {
        pX = parentEl.offsetLeft + parentEl.offsetWidth / 2;
        pY = parentEl.offsetTop + parentEl.offsetHeight;
        cX = nodeEl.offsetLeft + nodeEl.offsetWidth / 2;
        cY = nodeEl.offsetTop;
        controlOffset = Math.abs(cY - pY) * 0.5;
        d =
          "M " +
          pX +
          " " +
          pY +
          " C " +
          pX +
          " " +
          (pY + controlOffset) +
          ", " +
          cX +
          " " +
          (cY - controlOffset) +
          ", " +
          cX +
          " " +
          cY;
      }
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      var strokeColor = "var(--border-strong)";
      if (parentNode.status === "done") strokeColor = "var(--success)";
      else if (parentNode.status === "running") strokeColor = "var(--accent-primary)";
      else if (parentNode.status === "error") strokeColor = "var(--error)";
      else if (parentNode.status === "skipped") strokeColor = "var(--text-disabled)";
      path.setAttribute("marker-end", "url(#arrow)");
      path.setAttribute("stroke", strokeColor);
      path.setAttribute("stroke-width", Math.max(3, 3 / zoom));
      var hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hitPath.setAttribute("d", d);
      hitPath.setAttribute("fill", "none");
      hitPath.setAttribute("stroke", "transparent");
      hitPath.setAttribute("stroke-width", hitWidth);
      hitPath.style.cursor = "pointer";
      hitPath.style.pointerEvents = "auto";
      hitPath.addEventListener("mouseenter", function () {
        path.setAttribute("stroke-width", Math.max(4, 4 / zoom));
        path.setAttribute("stroke", "var(--accent-primary)");
      });
      hitPath.addEventListener("mouseleave", function () {
        if (!linkStartNode) {
          path.setAttribute("stroke-width", Math.max(3, 3 / zoom));
          var sc = "var(--border-strong)";
          if (parentNode.status === "done") sc = "var(--success)";
          else if (parentNode.status === "running") sc = "var(--accent-primary)";
          else if (parentNode.status === "error") sc = "var(--error)";
          else if (parentNode.status === "skipped") sc = "var(--text-disabled)";
          path.setAttribute("stroke", sc);
        }
      });
      hitPath.style.cursor = "pointer";
      hitPath.addEventListener("click", function (e) {
        e.stopPropagation();
        showLinkPopover(e, node, parentId);
      });
      path.style.cursor = "pointer";
      path.style.pointerEvents = "auto";
      path.addEventListener("click", function (e) {
        e.stopPropagation();
        showLinkPopover(e, node, parentId);
      });
      path.addEventListener("dblclick", async function (e) {
        e.stopPropagation();
        closeLinkPopover();
        if (!confirm("Supprimer cette dépendance ?")) return;
        node.dependencies = node.dependencies.filter(function (id) {
          return id !== parentId;
        });
        await window.openhub.saveProject(node);
        drawConnections();
        showToast("Dépendance supprimée", "success");
      });
      svg.appendChild(path);
      svg.appendChild(hitPath);
    });
    if (
      node.id !== activeOrch.id &&
      (!node.dependencies || node.dependencies.length === 0)
    ) {
      var parentEl = document.querySelector(
        '.node-card[data-id="' + activeOrch.id + '"]',
      );
      if (!parentEl) return;
      var pX2, pY2, cX2, cY2, controlOffset2, d2;
      if (layoutMode === "horizontal") {
        pX2 = parentEl.offsetLeft + parentEl.offsetWidth;
        pY2 = parentEl.offsetTop + parentEl.offsetHeight / 2;
        cX2 = nodeEl.offsetLeft;
        cY2 = nodeEl.offsetTop + nodeEl.offsetHeight / 2;
        controlOffset2 = Math.abs(cX2 - pX2) * 0.5;
        d2 =
          "M " +
          pX2 +
          " " +
          pY2 +
          " C " +
          (pX2 + controlOffset2) +
          " " +
          pY2 +
          ", " +
          (cX2 - controlOffset2) +
          " " +
          cY2 +
          ", " +
          cX2 +
          " " +
          cY2;
      } else {
        pX2 = parentEl.offsetLeft + parentEl.offsetWidth / 2;
        pY2 = parentEl.offsetTop + parentEl.offsetHeight;
        cX2 = nodeEl.offsetLeft + nodeEl.offsetWidth / 2;
        cY2 = nodeEl.offsetTop;
        controlOffset2 = Math.abs(cY2 - pY2) * 0.5;
        d2 =
          "M " +
          pX2 +
          " " +
          pY2 +
          " C " +
          pX2 +
          " " +
          (pY2 + controlOffset2) +
          ", " +
          cX2 +
          " " +
          (cY2 - controlOffset2) +
          ", " +
          cX2 +
          " " +
          cY2;
      }
      var path2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path2.setAttribute("d", d2);
      path2.setAttribute("fill", "none");
      path2.setAttribute("stroke", "var(--accent-subtle)");
      path2.setAttribute("stroke-dasharray", "4,4");
      path2.setAttribute("stroke-width", Math.max(2.5, 2.5 / zoom));
      var hitPath2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hitPath2.setAttribute("d", d2);
      hitPath2.setAttribute("fill", "none");
      hitPath2.setAttribute("stroke", "transparent");
      hitPath2.setAttribute("stroke-width", hitWidth);
      hitPath2.style.cursor = "grab";
      hitPath2.style.pointerEvents = "auto";
      hitPath2.addEventListener("mousedown", function (e) {
        e.stopPropagation();
        e.preventDefault();
        linkStartNode = activeOrch.id;
        drawConnections();
        var moveEvent = new MouseEvent("mousemove", {
          clientX: e.clientX,
          clientY: e.clientY,
          bubbles: true,
        });
        document.dispatchEvent(moveEvent);
      });
      svg.appendChild(path2);
      svg.appendChild(hitPath2);
    }
  });
}

function initPanZoom() {
  var canvas = document.getElementById("orchestrationCanvas");
  canvas.addEventListener(
    "wheel",
    function (e) {
      if (e.target.closest(".canvas-empty")) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        var zoomFactor = 1.05;
        var nextZoom = e.deltaY < 0 ? zoom * zoomFactor : zoom / zoomFactor;
        nextZoom = Math.max(minZoom, Math.min(maxZoom, nextZoom));
        var rect = canvas.getBoundingClientRect();
        var mouseX = e.clientX - rect.left;
        var mouseY = e.clientY - rect.top;
        var innerMouseX = (mouseX - panX) / zoom;
        var innerMouseY = (mouseY - panY) / zoom;
        zoom = nextZoom;
        panX = mouseX - innerMouseX * zoom;
        panY = mouseY - innerMouseY * zoom;
        applyTransform();
      } else {
        panX -= e.deltaX;
        panY -= e.deltaY;
        applyTransform();
      }
    },
    { passive: false },
  );
  canvas.addEventListener("mousedown", function (e) {
    if (
      e.target.closest(".node-card") ||
      e.target.closest(".canvas-controls") ||
      e.target.closest(".canvas-empty")
    )
      return;
    isPanning = true;
    startPan.x = e.clientX - panX;
    startPan.y = e.clientY - panY;
    canvas.style.cursor = "grabbing";
    e.preventDefault();
  });
  document.getElementById("btnZoomIn").onclick = function () {
    var nz = Math.min(maxZoom, zoom * 1.2);
    zoomTo(nz);
  };
  document.getElementById("btnZoomOut").onclick = function () {
    var nz = Math.max(minZoom, zoom / 1.2);
    zoomTo(nz);
  };
  document.getElementById("btnZoomReset").onclick = toggleZenMode;
  document.getElementById("btnToggleLayout").onclick = toggleLayoutMode;
}

function zoomTo(nextZoom) {
  var canvas = document.getElementById("orchestrationCanvas");
  var rect = canvas.getBoundingClientRect();
  var midX = rect.width / 2;
  var midY = rect.height / 2;
  var innerMidX = (midX - panX) / zoom;
  var innerMidY = (midY - panY) / zoom;
  zoom = nextZoom;
  panX = midX - innerMidX * zoom;
  panY = midY - innerMidY * zoom;
  applyTransform();
}

function applyTransform() {
  var canvasInner = document.getElementById("canvasInner");
  canvasInner.style.transform =
    "translate(" + panX + "px, " + panY + "px) scale(" + zoom + ")";
}

document.addEventListener("mousemove", function (e) {
  if (linkStartNode) {
    var parentEl = document.querySelector('.node-card[data-id="' + linkStartNode + '"]');
    if (!parentEl) return;
    var svg = document.getElementById("canvasSvg");
    var canvasInner = document.getElementById("canvasInner");
    var rect = canvasInner.getBoundingClientRect();
    var pX, pY, cX, cY, controlOffset, d;
    if (layoutMode === "horizontal") {
      pX = parentEl.offsetLeft + parentEl.offsetWidth;
      pY = parentEl.offsetTop + parentEl.offsetHeight / 2;
      cX = (e.clientX - rect.left) / zoom;
      cY = (e.clientY - rect.top) / zoom;
      controlOffset = Math.abs(cX - pX) * 0.5;
      d =
        "M " +
        pX +
        " " +
        pY +
        " C " +
        (pX + controlOffset) +
        " " +
        pY +
        ", " +
        (cX - controlOffset) +
        " " +
        cY +
        ", " +
        cX +
        " " +
        cY;
    } else {
      pX = parentEl.offsetLeft + parentEl.offsetWidth / 2;
      pY = parentEl.offsetTop + parentEl.offsetHeight;
      cX = (e.clientX - rect.left) / zoom;
      cY = (e.clientY - rect.top) / zoom;
      controlOffset = Math.abs(cY - pY) * 0.5;
      d =
        "M " +
        pX +
        " " +
        pY +
        " C " +
        pX +
        " " +
        (pY + controlOffset) +
        ", " +
        cX +
        " " +
        (cY - controlOffset) +
        ", " +
        cX +
        " " +
        cY;
    }
    var ghostPath = document.getElementById("ghostPath");
    if (!ghostPath) {
      ghostPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      ghostPath.id = "ghostPath";
      ghostPath.setAttribute("fill", "none");
      ghostPath.setAttribute("stroke", "var(--accent-primary)");
      ghostPath.setAttribute("stroke-width", Math.max(5, 5 / zoom));
      ghostPath.setAttribute("stroke-dasharray", 8 / zoom + "," + 8 / zoom);
      ghostPath.setAttribute("marker-end", "url(#arrow)");
      ghostPath.style.pointerEvents = "none";
      svg.appendChild(ghostPath);
    }
    ghostPath.setAttribute("d", d);
  } else if (dragNode) {
    var nodeEl = document.querySelector('.node-card[data-id="' + dragNode + '"]');
    if (nodeEl) {
      var dx = (e.clientX - dragStartMouse.x) / zoom;
      var dy = (e.clientY - dragStartMouse.y) / zoom;
      var x = dragStartNode.x + dx;
      var y = dragStartNode.y + dy;
      nodeEl.style.left = x + "px";
      nodeEl.style.top = y + "px";
      if (!window._dragSaveTimer) {
        window._dragSaveTimer = setTimeout(async function () {
          window._dragSaveTimer = null;
          var p = projects.find(function (proj) {
            return proj.id === dragNode;
          });
          if (p) {
            p.x = nodeEl.offsetLeft;
            p.y = nodeEl.offsetTop;
            await window.openhub.saveProject(p);
          }
        }, 1000);
      }
      drawConnections();
    }
  } else if (isPanning) {
    panX = e.clientX - startPan.x;
    panY = e.clientY - startPan.y;
    applyTransform();
  }
});

function closeLinkPopover() {
  var existing = document.querySelector(".link-popover");
  if (existing) existing.remove();
}

function showLinkPopover(e, childNode, parentId) {
  closeLinkPopover();
  var canvasInner = document.getElementById("canvasInner");
  var rect = canvasInner.getBoundingClientRect();
  var x = (e.clientX - rect.left) / zoom;
  var y = (e.clientY - rect.top) / zoom;
  var popover = document.createElement("div");
  popover.className = "link-popover";
  popover.style.left = x + "px";
  popover.style.top = y + "px";
  var btn = document.createElement("button");
  btn.className = "link-popover-btn";
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Supprimer le lien';
  btn.onclick = async function (ev) {
    ev.stopPropagation();
    closeLinkPopover();
    childNode.dependencies = childNode.dependencies.filter(function (id) {
      return id !== parentId;
    });
    await window.openhub.saveProject(childNode);
    drawConnections();
    showToast("Lien supprimé", "success");
  };
  popover.appendChild(btn);
  canvasInner.appendChild(popover);
  var closeOnOutside = function (ev) {
    if (!popover.contains(ev.target)) {
      closeLinkPopover();
      document.removeEventListener("mousedown", closeOnOutside);
    }
  };
  setTimeout(function () {
    document.addEventListener("mousedown", closeOnOutside);
  }, 0);
}

document.addEventListener("mouseup", async function (e) {
  var ghostPath = document.getElementById("ghostPath");
  if (ghostPath) ghostPath.remove();
  if (linkStartNode) {
    var dropTarget = e.target.closest(".node-card");
    if (dropTarget) {
      var dropNodeId = dropTarget.dataset.id;
      if (dropNodeId && dropNodeId !== linkStartNode) {
        var childProject = projects.find(function (p) {
          return p.id === dropNodeId;
        });
        var parentProject = projects.find(function (p) {
          return p.id === linkStartNode;
        });
        if (childProject && parentProject) {
          if (childProject.type !== "orchestrator") {
            if (!childProject.dependencies) childProject.dependencies = [];
            if (!childProject.dependencies.includes(linkStartNode)) {
              if (
                !confirm(
                  'Lier "' + parentProject.name + '" → "' + childProject.name + '" ?',
                )
              ) {
                linkStartNode = null;
                drawConnections();
                return;
              }
              childProject.dependencies.push(linkStartNode);
              await window.openhub.saveProject(childProject);
              showToast("Agents liés avec succès", "success");
            }
          }
        }
      }
    }
    linkStartNode = null;
    drawConnections();
  }
  if (dragNode) {
    var nodeEl = document.querySelector('.node-card[data-id="' + dragNode + '"]');
    if (nodeEl) {
      var p = projects.find(function (proj) {
        return proj.id === dragNode;
      });
      if (p) {
        p.x = nodeEl.offsetLeft;
        p.y = nodeEl.offsetTop;
        await window.openhub.saveProject(p);
      }
    }
    dragNode = null;
  }
  if (isPanning) {
    isPanning = false;
    document.getElementById("orchestrationCanvas").style.cursor = "default";
  }
});
