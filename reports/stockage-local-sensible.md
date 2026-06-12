# Audit stockage local sensible — OpenHub

**Date :** 2026-06-12  
**Scope :** `electron/`, `config/`, overrides JS  
**Résultat global :** ✅ Pas de vulnérabilité critique

---

## Cartographie du stockage

| Donnée                                                     | Méthode actuelle                                                | Statut                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------- |
| API keys (Anthropic, OpenAI, OpenRouter, Google AI, Brave) | macOS Keychain via `keytar`                                     | ✅ OK                                        |
| GitHub token                                               | macOS Keychain via `keytar`                                     | ✅ OK                                        |
| Ollama URL                                                 | macOS Keychain via `keytar`                                     | ✅ OK                                        |
| Google OAuth access/refresh tokens                         | `~/.local/share/opencode/auth.json` (fichier opencode upstream) | ⚠️ Voir F-02                                 |
| Gemini OAuth client_id / client_secret                     | Hardcodé dans `proxy/index.ts:1695-1697`                        | ℹ️ Voir F-01                                 |
| OPENCODE_SERVER_PASSWORD                                   | Env var à l'exécution uniquement                                | ✅ OK — pas loggé                            |
| Thème UI (dark/light)                                      | localStorage (WebContentsView)                                  | ✅ OK — pas sensible                         |
| Reasoning effort level                                     | localStorage (WebContentsView)                                  | ✅ OK — pas sensible                         |
| Historique conversations projets                           | localStorage (WebContentsView)                                  | ✅ OK — pas sensible                         |
| Derniers workflows                                         | localStorage (WebContentsView)                                  | ✅ OK — pas sensible                         |
| Memory/profil utilisateur                                  | `~/.config/openhub/memory.json`                                 | ✅ OK — pas de secrets                       |
| Projets (workflows, agents)                                | `~/.config/openhub/projects.json`                               | ✅ OK — pas de secrets                       |
| Config settings                                            | `config/templates/openhub-settings.json`                        | ✅ OK — modèles et préférences UI uniquement |
| Cache métriques                                            | `~/.config/openhub/cache-metrics.json`                          | ✅ OK — métriques de performance             |

---

## Findings

### F-01 — Gemini OAuth client_secret hardcodé (INFO)

**Fichier :** `electron/proxy/index.ts:1695-1697`  
**Sévérité :** INFO (pas un vrai secret)

```typescript
const GEMINI_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_CLIENT_SECRET = "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";
```

Ce client_secret provient d'opencode upstream. Pour les apps OAuth2 de type "installed/desktop", Google considère le client_secret comme **public** ([documentation Google](https://developers.google.com/identity/protocols/oauth2/native-app)). Il n'y a pas de risque de sécurité réel, car la protection repose sur le code d'autorisation et le PKCE, pas sur le secret client.

**Statut :** ACCEPTABLE — pas de correction nécessaire.

### F-02 — Google OAuth tokens sur disque (opencode upstream)

**Fichier :** `~/.local/share/opencode/auth.json`  
**Sévérité :** LOW

Les tokens Google OAuth (access + refresh) sont stockés dans le fichier auth.json d'opencode. C'est le comportement natif d'opencode — OpenHub ne fait que lire ce fichier pour le proxy Gemini. La migration vers keytar nécessiterait de modifier opencode en amont.

**Statut :** À MIGRER MANUELLEMENT (upstream opencode) — OpenHub ne peut pas changer ce comportement sans modifier le code source de l'app.

### F-03 — Logs proxy ne leakent pas de secrets (OK)

Les `console.warn` du proxy mentionnent "token refresh" comme événement mais ne loggent jamais les valeurs des tokens. Vérifié :

- `console.warn("[proxy] Google token refresh failed (${resp.status}): ${errText}")` — log le statut HTTP et le message d'erreur Google, pas le token
- `console.warn("[proxy] Google OAuth token refreshed")` — message informatif seulement
- `console.error("[proxy] Google token refresh error:", err)` — log l'erreur, mais `err` est un objet Error, pas un token

**Statut :** OK — aucune fuite.

### F-04 — WebContentsView sécurisées (OK)

Toutes les WebContentsView utilisent :

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`

Les overrides JS injectées via `executeJavaScript()` n'ont accès qu'au DOM — pas au système de fichiers ni à Node.js.

**Statut :** OK.

### F-05 — localStorage ne contient que des préférences UI (OK)

Toutes les utilisations de localStorage dans les overrides :

- `openwork.react.settings.theme-mode` — thème dark/light
- `open-design:config` — config thème open-design
- `opencode.global.dat:server` — URL du serveur opencode (pas un secret)
- `opencode_reasoning_effort` — niveau de raisonnement
- Historique de conversations des projets (messages texte, pas de tokens)

**Statut :** OK — aucun secret en localStorage.

---

## Résumé

| Catégorie                   | Résultat                                       |
| --------------------------- | ---------------------------------------------- |
| Keychain (keytar)           | ✅ Correctement utilisé pour tous les API keys |
| localStorage/sessionStorage | ✅ Préférences UI uniquement, aucun secret     |
| Config JSON sur disque      | ✅ Modèles et préférences, pas de secrets      |
| Variables d'environnement   | ✅ Pas de fuite dans les logs                  |
| WebContentsView isolation   | ✅ Isolation stricte activée partout           |
| Fichiers temporaires        | ✅ Pas de secrets dans les fichiers écrits     |

**Corrections appliquées :** Aucune — pas de vulnérabilité nécessitant un correctif.  
**À surveiller :** F-02 (tokens Google sur disque, responsabilité upstream opencode).
