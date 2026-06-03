# OpenHub — Session Handoff (2026-06-03)

> Ce document resume TOUTE la discussion et le travail effectue sur le projet OpenHub.
> Il sert de contexte complet pour reprendre dans une nouvelle conversation.

---

## 1. Le concept demande par l'utilisateur

**Objectif :** Creer un "Super-Hub" Desktop pour macOS (nom de code : OpenHub) inspire
de l'ergonomie de l'application native Claude macOS. L'objectif est de reunir 3 projets
open source existants dans une seule interface unifiee — une sidebar avec des boutons
qui switch entre les apps, chacune affichee dans une WebView separee.

**Principes cles exprimes par l'utilisateur :**
1. **Pas de fusion de code** — chaque app garde son code source intact
2. **Pas de Docker** — tout natif
3. **Une seule config API** — les cles API et modeles configures une fois, pas par fenetre
4. **Design uniforme** — masquer les sidebars natives des apps, injecter un theme commun
5. **Pouvoir ajouter/supprimer des fonctionnalites** — via injection CSS/JS runtime
6. **Resilience aux mises a jour** — `git pull` sur chaque app ne casse rien
7. **Pas de chat qui controle les autres** — chaque app est independante
8. **Pouvoir generer des PDF, faire de la recherche web** — via le proxy ou Electron natif
9. **Chat reporte en V2** — V1 = 3 slots seulement (Work, Code, Design)

---

## 2. Les 3 apps integrees

| Slot | Depot | Branch | Commande de lancement | Port |
|------|-------|--------|----------------------|------|
| **Work** | `different-ai/openwork` | `dev` | `pnpm dev:ui` (Vite SPA) | `:5173` |
| **Code** | `sst/opencode` | `main` | `opencode web --port 4096 --hostname 127.0.0.1` | `:4096` |
| **Design** | `nexu-io/open-design` | `main` | `./node_modules/.bin/od --no-open` | Dynamique (ex: `:7456`) |

**Decouverte cle :** Les 3 apps tournent sur le **meme moteur opencode**. openwork
utilise `@opencode-ai/sdk`, open-design detecte le code-agent CLI installe (opencode).
Donc un seul fichier `~/.config/opencode/opencode.json` cascade la config vers les 3.

---

## 3. Architecture choisie

```
ELECTRON (shell + proxy + secrets) — seul detenteur des cles reelles
|
|-- Sidebar : [Work] [Code] [Design] [Config]
|
|-- 3 WebContentsView (lazy, etat preserve)
|    Work   -> openwork apps/app (Vite SPA)       :5173
|    Code   -> opencode web                        :4096
|    Design -> open-design daemon + web frontend   :dynamique
|
|-- CASCADE DE CONFIG ("configurer une fois")
|    ~/.config/opencode/opencode.json
|    provider "openhub" -> baseURL http://localhost:9999/v1
|
|-- PROXY LLM :9999 (127.0.0.1, Bearer token, OpenAI-compatible)
|    Route Anthropic / OpenAI / Ollama
|
|-- SECRETS : macOS Keychain -> RAM -> env vars au spawn
|
|-- OVERLAYS : CSS/JS injection runtime (electron/overrides/)
```

**Decisions architecturales prises :**
- **Electron** (pas Tauri) — multi-WebContentsView mature, openwork utilise deja Tauri
- **Proxy Express integre** — sur `127.0.0.1:9999`, Bearer token par session
- **keytar** — macOS Keychain, jamais de secrets sur disque
- **Preload CommonJS** — le preload Electron DOIT etre CommonJS (pas ESM)
- **localhost** (pas `127.0.0.1`) — Vite/opencode bind sur `::1` (IPv6) sur macOS moderne

---

## 4. Structure des fichiers crees

```
OpenHub/
|-- ARCHITECTURE.md          # Spec canonique figee
|-- CLAUDE.md                # Instructions pour Claude Code
|-- AGENTS.md                # Definitions des agents
|-- README.md                # Documentation projet
|-- SESSION-HANDOFF.md       # CE FICHIER
|-- LICENSE                  # MIT
|-- package.json             # Electron + deps
|-- tsconfig.json            # TypeScript (ESM, exclut preload.ts)
|-- eslint.config.mjs        # ESLint flat config
|-- .prettierrc / .editorconfig / .prettierignore / commitlint.config.cjs
|-- .gitignore
|-- .env.example             # Documentation des vars (pas de vrais secrets)
|-- electron-builder.json    # Config packaging prod
|-- vitest.config.ts         # Tests unitaires
|-- playwright.config.ts     # Tests E2E
|
|-- .claude/
|   |-- settings.json        # Permissions + hooks Claude Code
|   |-- commands/            # Slash commands: dev, update-apps, add-override
|
|-- .husky/
|   |-- pre-commit           # lint-staged + typecheck
|   |-- commit-msg           # commitlint
|
|-- electron/
|   |-- main.ts              # Process principal Electron (fenetre, IPC, lifecycle)
|   |-- preload.ts           # Bridge window.openhub (COMMONJS, tsconfig separe)
|   |-- tsconfig.preload.json # Compile preload en CommonJS
|   |-- process-manager.ts   # Spawn des 3 apps + health check + port capture
|   |-- proxy/index.ts       # Proxy LLM Express :9999
|   |-- keychain.ts          # macOS Keychain via keytar
|   |-- config-generator.ts  # Genere ~/.config/opencode/opencode.json
|   |-- override-loader.ts   # Lit index.json + injecte CSS/JS dans les webviews
|   |-- sidebar.html         # UI sidebar style Claude macOS (HTML/CSS/JS inline)
|   |-- sidebar.ts           # Placeholder (logique dans sidebar.html)
|   |-- types.ts             # Types partages (SlotName, SlotConfig, etc.)
|   |-- overrides/
|   |   |-- index.json       # Catalogue d'overrides (toggle on/off)
|   |   |-- global/theme.css # Variables CSS du theme sombre
|   |   |-- global/layout.css # Masquage des sidebars natives (vide)
|   |   |-- openwork/        # (vide, pret pour des overrides)
|   |   |-- opencode/        # (vide)
|   |   |-- open-design/     # (vide)
|   |-- settings/            # (vide, panel Config futur)
|   |-- tests/e2e/.gitkeep
|
|-- apps/                    # Les 3 repos upstream, clones et intacts
|   |-- openwork/            # branch dev, pnpm install fait
|   |-- opencode/            # sst/opencode, CLI installee globalement
|   |-- open-design/         # pnpm install fait, daemon builde
|
|-- scripts/
    |-- dev.sh               # tsc + tsc preload + copy-assets + electron .
    |-- copy-assets.sh       # Copie sidebar.html + overrides/ dans dist/
    |-- setup.sh             # Clone les 3 repos + installe deps
    |-- update.sh            # git pull + rebuild par app
    |-- check-selectors.sh   # Verifie que les selecteurs CSS ciblent le DOM
    |-- graphify-update.sh   # Update quotidien du knowledge graph
```

---

## 5. Comment lancer

```bash
cd ~/Documents/Application/OpenHub
npm run dev
# Compile TS -> copie assets -> lance Electron
```

La fenetre s'ouvre avec la sidebar. Cliquer sur Work/Code/Design demarre le service
correspondant et charge la webview.

---

## 6. Ce qui fonctionne (teste)

| Composant | Etat | Notes |
|-----------|------|-------|
| Shell Electron + sidebar | FONCTIONNE | Style Claude macOS, boutons cliquables |
| Bouton Config (panel cles API) | FONCTIONNE | Popup s'ouvre/ferme |
| Proxy LLM :9999 | DEMARRE | `[proxy] listening on 127.0.0.1:9999` |
| Config cascade opencode.json | ECRIT | `[config] opencode.json -> ~/.config/opencode/opencode.json` |
| Slot **Work** (openwork) | CHARGE | Vite demarre sur :5173, webview affiche openwork |
| Slot **Code** (opencode) | CHARGE | `opencode web` sur :4096, webview affiche l'interface |
| Switch entre Work et Code | FONCTIONNE | Views gardees en memoire, z-order gere |
| Kill port orphelin au redemarrage | FONCTIONNE | `killPort()` avant chaque spawn |
| Logs complets dans le terminal | IMPLEMENTE | Chaque switchSlot logge toutes les etapes |

---

## 7. Ce qui NE fonctionne PAS encore (bugs ouverts)

### 7.1 Design slot — daemon crash immediat (BLOQUANT)

**Symptome :** Quand on clique sur Design, le daemon open-design (`od --no-open`)
charge les plugins puis exit(1) silencieusement. Aucune erreur visible.

**Logs :**
```
[design] spawning: .../node_modules/.bin/od --no-open
[design] [plugins] registered 401 bundled plugin(s)
[design] [plugins] seeded community registry source (3 plugin(s))
[design] [plugins] seeded official registry source (401 plugin(s))
[design] exited with code 1
Error: Process exited (code 1) before printing port
```

**Ce qu'on a essaye :**
- `od --no-open` -> exit 1 (pas d'erreur visible)
- `od --no-open --port 7456` -> pareil
- `node apps/daemon/bin/od.mjs` -> exit 0 immediat ("Cannot GET /" si on atteint le port)
- `NODE_DEBUG=* od --no-open` -> trop de bruit, pas d'erreur visible
- Le daemon a un `apps/web/` (Next.js) -> process-manager.ts a ete modifie pour
  lancer le daemon + le frontend web separement, mais le daemon crash avant

**Hypotheses non testees :**
- Le daemon a besoin d'un code-agent CLI actif (il "detecte" le CLI installe)
- Il crash parce qu'opencode n'est pas en cours d'execution
- Il manque une config ou un fichier d'etat
- Il faut lancer `opencode serve` d'abord, puis `od --no-open`
- Verifier `~/.config/open-design/` pour un fichier de config attendu
- Regarder `daemon-startup.js` dans le dist pour comprendre le exit

### 7.2 Code slot — s'affiche une fois puis parfois page blanche

**Symptome :** `opencode web` charge bien la premiere fois, mais en switchant
Work -> Code -> Work -> Code, parfois la webview est blanche.

**Cause probable :** z-ordering des WebContentsViews. Fix partiel applique
(`addChildView` pour remettre au premier plan) mais pas confirme stable.

### 7.3 Config panel — non teste fonctionnellement

Le panel Config s'ouvre et se ferme, mais les cles API n'ont jamais ete
reellement sauvegardees dans le Keychain (keytar) ni relues. A tester.

### 7.4 Injection CSS/JS — non testee

Le theme `global/theme.css` definit des variables CSS mais elles ne sont pas
encore appliquees visiblement sur les apps. A tester.

---

## 8. Bugs corriges pendant la session

| Bug | Cause | Fix |
|-----|-------|-----|
| Electron ne charge pas `.ts` | `tsx/esm` ne fonctionne pas dans Electron | Compile via `tsc` puis `electron .` sur le JS |
| TypeScript errors proxy | `res.end()` return type + `app.listen` callback | Wrapper `{ res.end(); }` + `() => resolve()` |
| Boutons sidebar morts | preload compile en ESM au lieu de CommonJS | `tsconfig.preload.json` separe avec `"module": "CommonJS"` |
| `Identifier 'openhub' already declared` | `const openhub = window.openhub` re-declare la globale du preload | Remplace par `window.openhub.xxx` partout |
| Port 5173 deja occupe | Vite orphelin d'une session precedente | `killPort()` avec `lsof -ti:PORT \| xargs kill -9` |
| ERR_CONNECTION_REFUSED | Webview tente loadURL avant que Vite soit pret | `loadViewUrl()` avec retry 6x a 1s d'intervalle |
| `opencode serve --password` invalide | `--password` n'est pas un flag d'opencode | Retire, utilise `OPENCODE_SERVER_PASSWORD` env var |
| `od` = octal dump Unix | PATH collision avec le daemon open-design | Utilise `node_modules/.bin/od` (chemin absolu) |
| WebContentsView cachee derriere une autre | Electron empile les vues dans l'ordre d'ajout | `addChildView(view)` pour re-mettre au premier plan |
| Health checks echouent sur `127.0.0.1` | Vite bind sur `::1` (IPv6) sur macOS moderne | Tous les health checks et URLs utilisent `localhost` |

---

## 9. Decisions de design prises

| Question | Decision | Pourquoi |
|----------|----------|----------|
| Tauri vs Electron | **Electron** | Multi-WebContentsView mature, openwork deja Tauri |
| Docker vs natif | **Natif** | L'utilisateur ne veut pas de Docker |
| Chat en V1 | **Non** (V2) | Decision utilisateur |
| OpenWebUI / LobeChat | **Retires** | Trop complexe, Docker, pas necessaire |
| Preload ESM vs CJS | **CommonJS** | Electron preload DOIT etre CJS |
| 127.0.0.1 vs localhost | **localhost** | IPv6 (::1) sur macOS moderne |
| opencode serve vs web | **opencode web** | `serve` = API JSON seule, `web` = API + frontend |
| Config cascade | **opencode.json** | Un fichier cascade vers les 3 apps |
| Secrets storage | **macOS Keychain** | Jamais sur disque |

---

## 10. Prochaines etapes (priorite)

1. **Resoudre le crash du daemon open-design** — c'est le seul slot casse
2. **Tester le Keychain** — saisir/relire des cles API via le panel Config
3. **Stabiliser le switch Code <-> Work** — confirmer que le z-ordering est fiable
4. **CSS injection** — appliquer le theme sombre et masquer les sidebars natives
5. **Tester le proxy LLM** — envoyer une vraie requete via une des apps
6. **Export PDF** — tester `printToPDF` natif Electron
7. **Cleanup logs** — retirer les `console.warn` de debug une fois stable

---

## 11. Commandes utiles

```bash
# Lancer l'app
cd ~/Documents/Application/OpenHub && npm run dev

# Compiler sans lancer
npx tsc && npx tsc -p electron/tsconfig.preload.json && bash scripts/copy-assets.sh

# Verifier les types
npm run typecheck

# Tuer les process orphelins
lsof -ti:5173,4096,7456,9999 | xargs kill -9 2>/dev/null; true

# Mettre a jour les apps upstream
npm run update:apps

# Tester open-design daemon manuellement
cd apps/open-design && ./node_modules/.bin/od --no-open 2>&1
```

---

## 12. Fichiers cles a lire en priorite

Pour reprendre le contexte rapidement, lire dans cet ordre :
1. `ARCHITECTURE.md` — la spec canonique
2. `electron/main.ts` — le process principal
3. `electron/process-manager.ts` — le spawn des 3 apps
4. `electron/preload.ts` — le bridge (DOIT rester CommonJS)
5. `electron/sidebar.html` — l'UI de la sidebar
6. Ce fichier (`SESSION-HANDOFF.md`) — le contexte complet
