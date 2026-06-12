(function () {
  if (!window.openhub) return;
  if (window.__OPENHUB_GRAPHIFY_INJECTED__) return;
  window.__OPENHUB_GRAPHIFY_INJECTED__ = true;

  const ICONS = {
    // 4-node square graph (network/knowledge graph icon — distinctly NOT a share button)
    graph:
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="7" r="2.5"/><circle cx="7" cy="17" r="2.5"/><circle cx="17" cy="17" r="2.5"/><line x1="9.5" y1="7" x2="14.5" y2="7"/><line x1="7" y1="9.5" x2="7" y2="14.5"/><line x1="17" y1="9.5" x2="17" y2="14.5"/><line x1="9.5" y1="17" x2="14.5" y2="17"/></svg>',
    spinner:
      '<svg class="oh-spin" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    success:
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error:
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };

  function injectButton() {
    const rail = document.querySelector('[data-component="sidebar-rail"]');
    if (!rail || document.querySelector(".oh-graphify-btn")) return;

    const btn = document.createElement("button");
    btn.className = "oh-graphify-btn";
    btn.setAttribute("data-component", "icon-button"); // Inherit some base styles
    btn.innerHTML = ICONS.graph;

    // Custom Tooltip
    const tooltipText = "Mettre à jour Graphify";
    btn.onmouseenter = () => {
      const rect = btn.getBoundingClientRect();
      const tooltip = document.createElement("div");
      tooltip.className = "oh-custom-tooltip";
      tooltip.textContent = tooltipText;
      tooltip.style.left = rect.right + 10 + "px";
      tooltip.style.top = rect.top + rect.height / 2 + "px";
      document.body.appendChild(tooltip);
      btn._tooltip = tooltip;
    };
    btn.onmouseleave = () => {
      if (btn._tooltip) {
        btn._tooltip.remove();
        btn._tooltip = null;
      }
    };
    btn.onmousedown = () => {
      if (btn._tooltip) {
        btn._tooltip.remove();
        btn._tooltip = null;
      }
    };

    let running = false;
    btn.onclick = async () => {
      if (running) return;
      running = true;
      btn.classList.add("loading");
      btn.innerHTML = ICONS.spinner;

      // Read the current project directory from OpenCode's localStorage
      var worktree = "";
      try {
        var raw = localStorage.getItem("opencode.global.dat:server");
        if (raw) {
          var data = JSON.parse(raw);
          var projects = data.projects;
          if (projects) {
            var serverKey = Object.keys(projects)[0];
            if (serverKey) {
              var list = projects[serverKey];
              if (Array.isArray(list) && list.length > 0) {
                // The most recent project is at index 0 (unshift)
                worktree = list[0].worktree || "";
              }
            }
          }
        }
      } catch {
        // localStorage read failed, will use proxy fallback
      }

      try {
        const res = await window.openhub.runGraphifyUpdate(worktree);
        if (res && res.ok) {
          btn.innerHTML = ICONS.success;
          setTimeout(() => {
            btn.innerHTML = ICONS.graph;
            btn.classList.remove("loading");
            running = false;
          }, 3000);
        } else {
          throw new Error(res?.error || "Unknown error");
        }
      } catch (err) {
        console.error("[graphify-btn] Update failed:", err);
        btn.innerHTML = ICONS.error;
        btn.setAttribute("title", "Erreur : " + err.message);
        setTimeout(() => {
          btn.innerHTML = ICONS.graph;
          btn.setAttribute("title", "Mettre à jour la cartographie Graphify");
          btn.classList.remove("loading");
          running = false;
        }, 5000);
      }
    };

    // Style elements
    if (!document.getElementById("oh-graphify-style")) {
      const style = document.createElement("style");
      style.id = "oh-graphify-style";
      style.textContent = `
        .oh-graphify-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          margin: 0 auto;
          background: transparent;
          border: none;
          border-radius: 8px;
          color: var(--text-base, #999999);
          cursor: pointer;
          flex-shrink: 0;
          opacity: 0.85;
        }
        .oh-graphify-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          color: var(--text-strong, #ffffff);
          opacity: 1;
        }
        .oh-graphify-btn.loading {
          cursor: wait;
          color: var(--v2-blue-500, #9180f5);
          opacity: 1;
        }
        .oh-spin {
          animation: oh-spin 1s linear infinite;
        }
        @keyframes oh-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .oh-custom-tooltip {
          position: fixed;
          z-index: 9999;
          background: #1e1e2c;
          color: white;
          padding: 6px 10px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 500;
          pointer-events: none;
          transform: translateY(-50%);
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          border: 1px solid rgba(255,255,255,0.1);
          white-space: nowrap;
        }
      `;
      document.head.appendChild(style);
    }

    // Target the bottom container (which contains settings/help)
    // In sidebar-shell.tsx, this is the second direct child of the rail
    const bottomContainer =
      rail.querySelector('[data-component="sidebar-bottom"]') ||
      rail.querySelector("div.shrink-0.flex-col.items-center");

    if (bottomContainer) {
      // If already present, don't re-inject
      if (bottomContainer.querySelector(".oh-graphify-btn")) return;

      // Append to the bottom container to be part of the same flex group (gap-2)
      bottomContainer.appendChild(btn);
    } else {
      // Fallback: original logic if structure differs
      const bottomBtns = [
        rail.querySelector(
          '[title*="Help" i], [title*="Aide" i], [aria-label*="help" i], [aria-label*="aide" i]',
        ),
        rail.querySelector(
          '[data-icon="help"], [data-icon="settings"], [data-icon="user"]',
        ),
        rail.querySelector('[title*="Paramètre" i], [title*="Settings" i]'),
        rail.querySelector('[data-component="icon-button"]:last-of-type'),
      ];
      const target = bottomBtns.find(function (el) {
        return el && el.parentElement === rail;
      });
      if (target) {
        rail.insertBefore(btn, target);
      } else {
        rail.appendChild(btn);
      }
    }
  }

  const observer = new MutationObserver(() => injectButton());
  observer.observe(document.body, { childList: true, subtree: true });
  injectButton();
})();
