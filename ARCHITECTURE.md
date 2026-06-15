**English** · [Français](ARCHITECTURE.fr.md)

# OpenHub — Architecture (frozen canonical spec)

> macOS desktop Super-Hub that brings together several open-source AI tools in a
> single interface inspired by the native Claude macOS app. Each tool keeps its
> source code intact; all customizations go through an injection layer (CSS/JS)
> and a central LLM proxy, so it stays compatible with upstream updates.

**Status:** V1 frozen — verified against the repositories' actual source code.
**Date:** 2026-06-03.

> [!NOTE]
> Le proxy (`electron/proxy/index.ts`) contient une zone sensible optimisée pour le
> **prefix caching** des providers (DeepSeek, Anthropic…). Sa structure de préfixe
> ne doit pas être réordonnée ou « nettoyée » à la légère sous peine de chute du
> cache hit rate. Les contraintes détaillées (et les consignes pour les agents IA
> qui contribuent au code) sont dans [AGENTS.md](AGENTS.md).

## 1. V1 scope

The sidebar ships **five slots** — **Chat**, **Code**, **Work**, **Design**, **Orchestrator** — plus a Config panel. The three slots in the table below are backed by an embedded upstream app; **Chat** and **Orchestrator** are OpenHub-native (no external app, no webview) and landed after this V1 spec was frozen.

| Slot   | Repository                                               | Embedded mode       | Port              |
| ------ | -------------------------------------------------------- | ------------------- | ----------------- |
| Work   | `different-ai/openwork` (`apps/app`, Vite SPA)           | static build served | `5173`            |
| Code   | `anomalyco/opencode` (`opencode serve` / `opencode web`) | HTTP server         | `4096`            |
| Design | `nexu-io/open-design` (Express daemon + build)           | local daemon        | captured at spawn |

Out of V1 scope: openwork's "den"/EE cloud stack (MySQL, better-auth), Docker.

---

## 2. Tech stack

| Component      | Choice                                            | Rationale                                                                                |
| -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Desktop shell  | **Electron** (not Tauri)                          | Mature multi-`WebContentsView`; openwork is already Tauri → Electron avoids the conflict |
| App views      | `WebContentsView` (1 per app, lazy, kept alive)   | State/sessions preserved when switching slots                                            |
| App runtime    | **Native only** (zero Docker)                     | The apps need filesystem access (they edit code/design)                                  |
| LLM proxy      | Express server embedded in main, `127.0.0.1:9999` | Single OpenAI-compatible gateway + holds the secrets                                     |
| Secrets        | **macOS Keychain** (`keytar` or `security`)       | Never on disk, never in the apps                                                         |
| Config cascade | `~/.config/opencode/opencode.json`                | A single file configures all 3 apps (they all drive opencode)                            |
| Customization  | Runtime CSS/JS injection (`insertCSS` / bridge)   | Independent of upstream updates                                                          |
| Updates        | `git pull` / `npm update` per folder              | Source code never modified                                                               |

---

## 3. Diagram

```
ELECTRON (shell + proxy + secrets) ─ seul détenteur des clés réelles
│
├─ Sidebar : [Chat] [Code] [Work] [Design] [Orchestrateur] [Config]
│
├─ 3 WebContentsView (lazy, état préservé, builds servis) :
│    Work   → openwork apps/app        :5173
│    Code   → opencode serve/web       :4096
│    Design → open-design daemon       :port capturé au spawn
│
├─ CASCADE DE CONFIG ("configurer une fois") :
│    OpenHub écrit ~/.config/opencode/opencode.json
│      provider "openhub" → baseURL http://localhost:9999/v1
│      hérité par Work + Code + Design (tous pilotent opencode)
│
├─ PROXY LLM :9999 (127.0.0.1, Bearer token requis, OpenAI-compatible)
│    détient les vraies clés (Keychain) · route Anthropic / OpenAI / Ollama
│    point d'injection : web-search, enrichissement de contexte
│
├─ SECRETS : Keychain → RAM du main → env vars au spawn des process
│
└─ OVERLAYS : CSS (thème uniforme) + JS via bridge isolé
     (masquer settings natifs, export PDF, web-search, ajout/suppression de features)
```

---

## 4. "Configure once" — confirmed mechanism

The 3 apps run on the **same opencode engine**:

- **opencode** _is_ the engine.
- **openwork** uses it via `@opencode-ai/sdk`.
- **open-design** detects and drives the installed code-agent CLI (→ opencode).

So a single `opencode.json` cascades to all 3. Custom OpenAI-compatible provider
(confirmed supported by opencode):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openhub": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenHub Proxy",
      "options": {
        "baseURL": "http://localhost:9999/v1",
        "apiKey": "{env:OPENHUB_TOKEN}"
      },
      "models": { "claude-sonnet-4-6": { "name": "Claude Sonnet 4.6" } }
    }
  }
}
```

The apps only receive a **fake local token** (`OPENHUB_TOKEN`). The proxy `:9999`
holds the real keys (Anthropic/OpenAI/OAuth) read from the Keychain.

---

## 5. Security model

| Lock                 | Detail                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Webview isolation    | `contextIsolation:true` + `sandbox:true` + `nodeIntegration:false`                                                  |
| Bridge               | tiny, validated, **no disk path** (paths chosen via native `dialog`)                                                |
| Crown jewel to guard | `opencode serve` runs shell commands → strict `127.0.0.1` bind + generated `OPENCODE_SERVER_PASSWORD`, never logged |
| Proxy                | `127.0.0.1` + mandatory `Authorization: Bearer` (no other local process burns your key)                             |
| Real secrets         | Keychain → main RAM → env at spawn; never disk/localStorage/webview                                                 |
| Injected JS          | UI only, no inline secret; sensitive actions via the isolated bridge                                                |
| openwork den stack   | **disabled** (otherwise weak default secrets + MySQL)                                                               |

---

## 6. Overrides layer (add / remove / restyle)

```
electron/overrides/
├── index.json            # catalogue activable/désactivable par slot
├── global/
│   ├── theme.css         # palette, typo, arrondis — partout
│   └── layout.css        # masquage des sidebars/settings natifs
├── openwork/  *.css *.js
├── opencode/  *.css *.js
└── open-design/ *.css *.js
```

Rule: target **semantic** selectors (`data-*`, `aria-*`, `role`, `id`) rather
than utility classes. Re-injection on `did-navigate` + `MutationObserver` to
cover SPAs. Post-update verification script that flags broken selectors.

Features planned via this layer: PDF export (native `printToPDF` + markdown→PDF
on the proxy side), web search (the proxy enriches the context), hiding native
settings (centralized in the Config panel).

---

## 7. Traceability — 17 initial requests → all covered

| #   | Request                                       | Status                         |
| --- | --------------------------------------------- | ------------------------------ |
| 1   | Claude macOS ergonomics                       | ✅                             |
| 2   | Bring together without merging the sources    | ✅                             |
| 3   | Tauri/Electron wrapper                        | ✅ Electron                    |
| 4   | Auto-start the servers                        | ✅                             |
| 5   | Sidebar + webview + independent state         | ✅                             |
| 6   | Hide sidebars + single dark theme             | ✅                             |
| 7   | Configure API/models once (local+remote)      | ✅✅ via opencode.json + proxy |
| 8   | OAuth/secrets in a vault, injected at startup | ✅ Keychain                    |
| 9   | Resilience to upstream updates                | ✅                             |
| 10  | No chat controlling the others                | ✅ independent apps            |
| 11  | One API without re-entering it per window     | ✅                             |
| 12  | Add/remove options                            | ✅ overrides                   |
| 13  | Web search in OpenWork (not native)           | ✅ proxy                       |
| 14  | Remove the apps' settings, centralize them    | ✅                             |
| 15  | PDF generation like Claude (not native)       | ✅                             |
| 16  | Update each project                           | ✅                             |
| 17  | Zero Docker                                   | ✅                             |

Chat (4th pill of the initial brief): **shipped** — now a native slot, alongside the Orchestrator, both added after this V1 spec was frozen.

---

## 8. Known integration tweaks (non-blocking)

- Pin the Node version per app (open-design requires Node ~24) in the process-manager.
- Capture open-design's port at spawn (the daemon prints it).
- Force open-design to detect **opencode** as the code-agent CLI (otherwise the cascade diverges).
- Verify opencode's GitHub-auth flow for OAuth token injection.
- Serve the **builds** (not the `dev` servers) as the runtime.

---

## 9. Build order

1. Electron skeleton + process-manager (with per-app Node pin)
2. Proxy `:9999` + Keychain integration
3. `~/.config/opencode/opencode.json` generator
4. Sidebar + WebContentsView + injection layer
5. Config panel (API keys, models, override toggles)
