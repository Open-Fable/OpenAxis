/**
 * OpenWork desktop bridge polyfill
 *
 * 1. Sets window.__OPENWORK_ELECTRON__ so isDesktopRuntime() returns true
 * 2. Intercepts fetch() to fake OpenWork server endpoints that opencode
 *    serve does not provide (/workspaces/*, /status, etc.)
 */
(function () {
  "use strict";
  if (window.__OPENWORK_ELECTRON__) return;

  // ── Desktop bridge ──
  window.__OPENWORK_ELECTRON__ = {
    invokeDesktop: function (command) {
      var args = Array.prototype.slice.call(arguments, 1);
      return window.openhub.openworkDesktopInvoke.apply(null, [command].concat(args));
    },
    shell: {
      openExternal: function (url) {
        window.open(url, "_blank", "noopener,noreferrer");
        return Promise.resolve();
      },
    },
    meta: {
      platform: "darwin",
      version: "openhub",
    },
  };

  // ── Fetch interceptor for OpenWork server API ──
  var realFetch = window.fetch;
  var SERVER_BASE = "http://127.0.0.1:4096";

  function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function makeWorkspaceList(wsPath, wsName) {
    var id = "openhub-" + Date.now();
    return {
      selectedId: id,
      activeId: id,
      workspaces: [
        {
          id: id,
          name: wsName || wsPath.split("/").pop() || "workspace",
          path: wsPath,
          preset: "default",
          workspaceType: "local",
          displayName: wsName || wsPath.split("/").pop() || "workspace",
        },
      ],
    };
  }

  window.fetch = function (input, init) {
    var url = typeof input === "string"
      ? input
      : input instanceof Request ? input.url : String(input);

    if (url.indexOf(SERVER_BASE) !== 0) {
      return realFetch.apply(this, arguments);
    }

    var path = url.slice(SERVER_BASE.length).split("?")[0];
    var method = (init && init.method) ? init.method.toUpperCase() : "GET";

    // POST /workspaces/local
    if (path === "/workspaces/local" && method === "POST") {
      try {
        var body = init && init.body ? JSON.parse(init.body) : {};
        return Promise.resolve(jsonResponse(
          makeWorkspaceList(body.folderPath || "/", body.name)
        ));
      } catch (e) {
        return Promise.resolve(jsonResponse(makeWorkspaceList("/")));
      }
    }

    // GET /workspaces
    if (path === "/workspaces" && method === "GET") {
      return Promise.resolve(jsonResponse({
        selectedId: "openhub-default",
        activeId: "openhub-default",
        workspaces: [],
      }));
    }

    // POST /workspaces/remote
    if (path === "/workspaces/remote" && method === "POST") {
      try {
        var remoteBody = init && init.body ? JSON.parse(init.body) : {};
        return Promise.resolve(jsonResponse(
          makeWorkspaceList(remoteBody.baseUrl || "/", remoteBody.name)
        ));
      } catch (e) {
        return Promise.resolve(jsonResponse(makeWorkspaceList("/")));
      }
    }

    // PUT /workspaces/*/display-name
    if (/^\/workspaces\/[^/]+\/display-name$/.test(path) && method === "PUT") {
      return Promise.resolve(jsonResponse({ ok: true }));
    }

    // POST /workspaces/*/activate
    if (/^\/workspaces\/[^/]+\/activate/.test(path) && method === "POST") {
      return Promise.resolve(jsonResponse({ ok: true }));
    }

    // DELETE /workspaces/*
    if (/^\/workspaces\/[^/]+$/.test(path) && method === "DELETE") {
      return Promise.resolve(jsonResponse({ ok: true }));
    }

    // GET /status or /health
    if (path === "/status" || path === "/health") {
      return Promise.resolve(jsonResponse({ running: true, version: "openhub" }));
    }

    // Everything else — pass through to opencode serve
    return realFetch.apply(this, arguments);
  };
})();
