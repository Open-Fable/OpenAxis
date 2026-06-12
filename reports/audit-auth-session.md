# Audit d'authentification — OpenHub

**Date :** 2026-06-12
**Auditeur :** Agent automatisé (scheduled task `audit-auth-session`)
**Scope :** Flux d'auth complet — proxy Express, Keychain, sessions WebContentsView, CORS

---

## Cartographie du flux d'authentification

### Architecture

```
┌─────────────────────────────────────────────────┐
│  Electron Main Process                          │
│  ┌──────────────┐   ┌────────────────────────┐  │
│  │ ProcessManager│   │ startProxy()           │  │
│  │ (spawns apps) │   │ Express :9999          │  │
│  │ opencodePass  │   │ sessionToken (random)  │  │
│  │ = random(24B) │   │ + "openhub-local"      │  │
│  └──────┬───────┘   └──────────┬─────────────┘  │
│         │                       │                │
│    env vars                CORS + Bearer         │
│         │                       │                │
│  ┌──────▼───────┐   ┌──────────▼─────────────┐  │
│  │ opencode     │   │ WebContentsView x3      │  │
│  │ :4096        │   │ Work(:5173) Code(:4096) │  │
│  │              │   │ Design(:dynamic)        │  │
│  └──────────────┘   └────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### Fichiers impliqués

| Fichier                        | Rôle                                                          |
| ------------------------------ | ------------------------------------------------------------- |
| `electron/proxy/index.ts`      | Proxy Express — auth middleware, CORS, reverse proxy opencode |
| `electron/main.ts`             | IPC bridge, token distribution, WebContentsView creation      |
| `electron/preload.ts`          | contextBridge — surface API exposée aux renderers             |
| `electron/keychain.ts`         | Lecture/écriture secrets via macOS Keychain (keytar)          |
| `electron/config-generator.ts` | Génère `opencode.json` avec le proxyToken                     |
| `electron/process-manager.ts`  | Spawn des apps, gestion OPENCODE_SERVER_PASSWORD              |

### Flux de génération des tokens

1. `startProxy()` génère `sessionToken = randomBytes(32).toString("hex")` (64 hex chars)
2. `ProcessManager` génère `opencodePassword = randomBytes(24).toString("hex")` (48 hex chars)
3. `sessionToken` est passé à `generateOpenCodeConfig()` → écrit dans `~/.config/opencode/opencode.json` comme `apiKey`
4. `sessionToken` est stocké dans `proxyToken` (variable module-level dans `main.ts`)
5. Le token `"openhub-local"` (hardcodé) est envoyé aux WebContentsViews via IPC `openworkServerInfo`

---

## Findings

### 1. CORS wildcard `Access-Control-Allow-Origin: *` — CRITIQUE

**Sévérité :** CRITIQUE
**Statut :** ✅ CORRIGÉ (commit `3ffa4e4`)
**Fichier :** `electron/proxy/index.ts:63`

**Bypass possible :** N'importe quelle page web visitée par l'utilisateur pouvait envoyer des requêtes `fetch()` au proxy `127.0.0.1:9999` avec les credentials. Un site malveillant pouvait :

- Lister les workspaces
- Envoyer des requêtes LLM via les clés API de l'utilisateur
- Exécuter du code via le reverse proxy opencode

**Correctif :** Whitelist d'origines connues : `localhost:5173`, `:4096`, `:9999`, et `file://` (Electron).

---

### 2. Endpoints sans authentification — CRITIQUE

**Sévérité :** CRITIQUE
**Statut :** ✅ CORRIGÉ (commit `3ffa4e4`)
**Fichier :** `electron/proxy/index.ts:77-459`

**Bypass possible :** Le middleware `Authorization: Bearer` était placé à la ligne ~837, APRÈS l'enregistrement de nombreux endpoints :

- `GET/POST/PUT/DELETE /workspaces/*` — CRUD workspaces sans token
- `ALL /workspace/:id/opencode/*` — reverse proxy vers opencode (exécution de code, lecture de sessions) sans token
- `GET /workspace/:id/sessions` — lecture de sessions sans token
- `GET/POST /v1/cache/metrics` — métriques de cache sans token
- `GET /v1/reasoning/*` — infos modèle sans token
- `POST /v1/orch/assistant` — appels LLM complets via l'orchestrateur sans token

**Scénario d'exploitation :** Un processus local ou une page web (via CORS `*`) pouvait accéder directement au reverse proxy opencode et exécuter des commandes via les sessions opencode.

**Correctif :** Middleware auth déplacé immédiatement après CORS, avant tous les endpoints data. Seuls `/status`, `/health`, `/capabilities`, `/runtime/versions` restent publics (informations non sensibles).

---

### 3. Token statique `openhub-local` — MOYEN

**Sévérité :** MOYENNE
**Statut :** ⚠️ À VÉRIFIER MANUELLEMENT

**Constat :** Le token `"openhub-local"` est une chaîne statique connue, acceptée comme token d'auth valide. Elle est :

- Hardcodée dans `proxy/index.ts`
- Envoyée aux WebContentsViews via IPC (`main.ts:586-588`)

**Risque :** Tout processus local connaissant cette chaîne peut accéder au proxy. Le risque est atténué par :

- Le proxy écoute uniquement sur `127.0.0.1` (pas d'accès réseau)
- Le CORS est maintenant restreint (post-fix)

**Recommandation :** Remplacer par un token de session aléatoire transmis via IPC, similaire à `sessionToken`. Mais cela nécessiterait de modifier le flow de boot d'OpenWork — à planifier.

---

### 4. Gemini OAuth client secret dans le code source — MOYEN

**Sévérité :** MOYENNE
**Statut :** ⚠️ À VÉRIFIER MANUELLEMENT
**Fichier :** `electron/proxy/index.ts:1668`

**Constat :** Le `GEMINI_CLIENT_SECRET` (`GOCSPX-...`) est hardcodé dans le source. Ce secret est utilisé pour le refresh de tokens OAuth Google.

**Atténuation :** Pour les applications desktop/CLI, Google considère que le client secret n'est pas véritablement secret (les apps desktop sont des "public clients"). C'est le même pattern que Gemini CLI. Le risque réel est limité car le refresh token est toujours nécessaire.

**Recommandation :** Pas d'action immédiate requise — pattern standard pour les OAuth desktop apps.

---

### 5. proxyToken persisté sur disque — BAS

**Sévérité :** BASSE
**Statut :** ⚠️ À VÉRIFIER MANUELLEMENT
**Fichier :** `electron/config-generator.ts:95`

**Constat :** Le `sessionToken` (Bearer token du proxy) est écrit dans `~/.config/opencode/opencode.json` en clair. Ce fichier a les permissions par défaut de l'utilisateur.

**Atténuation :** Le token est régénéré à chaque lancement d'OpenHub. Le fichier n'est lisible que par l'utilisateur courant.

**Recommandation :** Acceptable — même pattern que les tokens de session des IDE.

---

### 6. `console.log` au lieu de `console.warn` pour le refresh token — BAS

**Sévérité :** BASSE
**Statut :** ✅ CORRIGÉ (commit `3ffa4e4`)
**Fichier :** `electron/proxy/index.ts:1817`

**Constat :** Le message de refresh token utilisait `console.log` (stdout) au lieu de `console.warn` (stderr). En cas de pipe stdout, cette info pouvait fuir.

---

### 7. Isolation des WebContentsViews — OK

**Statut :** ✅ CONFORME

Les 3 WebContentsViews sont correctement isolées :

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- Navigation bloquée vers les protocoles non-HTTP (`will-navigate`)
- Ouverture de popups bloquée (`setWindowOpenHandler`)
- Partition partagée `persist:chat` — acceptable car les 3 apps sont de confiance

---

### 8. Gestion du OPENCODE_SERVER_PASSWORD — OK

**Statut :** ✅ CONFORME
**Fichier :** `electron/process-manager.ts:33`

- Généré avec `randomBytes(24).toString("hex")` — entropie suffisante
- Stocké uniquement en mémoire (propriété privée `ProcessManager`)
- Jamais loggé (aucun `console.*` ne référence la valeur)
- Passé aux processus enfants via env vars (non visible dans `/proc`)

---

### 9. Sessions après fermeture — OK

**Statut :** ✅ CONFORME

- `app.on("window-all-closed")` appelle `processManager.stopAll()` → kill tous les processus
- Le `sessionToken` est en mémoire → disparaît avec le processus
- Le fichier `opencode.json` garde l'ancien token mais il est invalide (le proxy n'écoute plus)

---

## Résumé

| #   | Finding                        | Sévérité | Statut                          |
| --- | ------------------------------ | -------- | ------------------------------- |
| 1   | CORS wildcard `*`              | CRITIQUE | ✅ CORRIGÉ                      |
| 2   | Endpoints sans auth middleware | CRITIQUE | ✅ CORRIGÉ                      |
| 3   | Token statique `openhub-local` | MOYENNE  | ⚠️ À PLANIFIER                  |
| 4   | Gemini client secret hardcodé  | MOYENNE  | ⚠️ ACCEPTABLE (pattern desktop) |
| 5   | proxyToken sur disque          | BASSE    | ⚠️ ACCEPTABLE                   |
| 6   | console.log pour token refresh | BASSE    | ✅ CORRIGÉ                      |
| 7   | Isolation WebContentsViews     | INFO     | ✅ CONFORME                     |
| 8   | OPENCODE_SERVER_PASSWORD       | INFO     | ✅ CONFORME                     |
| 9   | Sessions post-fermeture        | INFO     | ✅ CONFORME                     |

## Tests recommandés

1. **Vérifier que les endpoints nécessitent l'auth :**

   ```bash
   # Sans token — doit retourner 401
   curl -s http://127.0.0.1:9999/workspaces
   curl -s http://127.0.0.1:9999/v1/models
   curl -s -X POST http://127.0.0.1:9999/v1/orch/assistant

   # Endpoints publics — doivent retourner 200
   curl -s http://127.0.0.1:9999/status
   curl -s http://127.0.0.1:9999/health
   ```

2. **Vérifier le CORS restrictif :**

   ```bash
   # Origine autorisée
   curl -s -H "Origin: http://localhost:5173" -I http://127.0.0.1:9999/status | grep Allow-Origin

   # Origine non autorisée — doit retourner l'origine par défaut
   curl -s -H "Origin: http://evil.com" -I http://127.0.0.1:9999/status | grep Allow-Origin
   ```

3. **Test de régression OpenWork :**
   - Lancer OpenHub, vérifier que le slot Work se charge correctement
   - Créer/modifier un workspace via l'interface
   - Vérifier que les sessions opencode restent accessibles via le slot Work
   - Tester l'orchestrateur assistant

4. **Test d'isolation :**
   - Ouvrir les 3 slots (Work, Code, Design)
   - Vérifier qu'aucun slot ne peut accéder aux données d'un autre via JS console
