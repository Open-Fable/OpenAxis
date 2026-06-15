# Audit des permissions macOS — OpenHub

**Date de l'audit:** 2026-06-15
**Périmètre:** entitlements Electron, accès Keychain (keytar), accès réseau,
accès fichiers, processus enfants spawnés, `webPreferences` de chaque
`WebContentsView`/`BrowserWindow`, surface du `contextBridge`.

---

## 1. Synthèse

Le projet est globalement bien durci : entitlements minimaux et documentés, tous
les serveurs locaux liés à `127.0.0.1`, proxy protégé par `Authorization: Bearer`,
`contextBridge` exclusivement par canaux IPC sans paramètre de chemin disque, et
les trois drapeaux critiques (`contextIsolation`, `sandbox`, `nodeIntegration`)
correctement posés sur **toutes** les vues.

Un seul durcissement a été appliqué : rendre `webSecurity` et
`allowRunningInsecureContent` **explicites** sur la vue exposée à du contenu
distant tiers (`createSlotView`), pour qu'aucune régression future ne puisse
affaiblir silencieusement la same-origin policy.

---

## 2. Matrice des permissions

| Permission                                               | Nécessaire ?  | Actuel                              | Recommandé | Statut                  |
| -------------------------------------------------------- | ------------- | ----------------------------------- | ---------- | ----------------------- |
| `com.apple.security.cs.allow-jit`                        | Oui (V8/JIT)  | activé                              | activé     | CONFORME                |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Oui (V8)      | activé                              | activé     | CONFORME                |
| `cs.disable-library-validation`                          | Non           | **absent** (retiré)                 | absent     | CONFORME                |
| `cs.allow-dyld-environment-variables`                    | Non           | **absent** (retiré)                 | absent     | CONFORME                |
| `hardenedRuntime`                                        | Oui           | `true`                              | `true`     | CONFORME                |
| `gatekeeperAssess`                                       | —             | `false` (signé à part)              | `false`    | CONFORME                |
| Accès Keychain (keytar)                                  | Oui (secrets) | RAM uniquement, jamais disque       | idem       | CONFORME                |
| Réseau — proxy 9999                                      | Oui           | bind `127.0.0.1` + Bearer           | idem       | CONFORME                |
| Réseau — opencode 4096                                   | Oui           | `--hostname 127.0.0.1`              | idem       | CONFORME                |
| Réseau — openwork 5173                                   | Oui           | `localhost` (::1/127.0.0.1, dev)    | idem       | CONFORME                |
| Réseau — Design (port dynamique)                         | Oui           | capturé au spawn, `localhost`       | idem       | À VÉRIFIER MANUELLEMENT |
| Réseau — Ollama 11434                                    | Optionnel     | `127.0.0.1`                         | idem       | CONFORME                |
| Accès fichiers (renderer)                                | Non           | aucun fs exposé ; dialogs côté main | idem       | CONFORME                |
| Spawn processus enfants                                  | Oui           | env hérité contrôlé, stdio piped    | idem       | CONFORME                |

**Note Design :** le démon `od` est lancé avec `--no-open` et son port web est
capturé au spawn ; le binding exact de l'hôte dépend du binaire upstream (non
modifiable). À vérifier manuellement qu'il n'écoute pas sur `0.0.0.0`.

---

## 3. `webPreferences` par vue

| Vue (origine)                                         | nodeIntegration | contextIsolation | sandbox | webSecurity          | allowRunningInsecureContent | preload     |
| ----------------------------------------------------- | --------------- | ---------------- | ------- | -------------------- | --------------------------- | ----------- |
| Splash (local)                                        | false           | true             | true    | défaut (true)        | défaut (false)              | —           |
| Fenêtre principale (local)                            | false           | true             | true    | défaut (true)        | défaut (false)              | preload.cjs |
| **createSlotView — work/code/design (distant tiers)** | false           | true             | true    | **true (explicite)** | **false (explicite)**       | preload.cjs |
| Nav popup (local)                                     | false           | true             | true    | défaut (true)        | défaut (false)              | preload.cjs |
| Vue Chat (local `chat.html`)                          | false           | true             | true    | défaut (true)        | défaut (false)              | preload.cjs |
| Vue Projects (local `projects.html`)                  | false           | true             | true    | défaut (true)        | défaut (false)              | preload.cjs |
| Fenêtre PDF verrouillée (data: only)                  | false           | true             | true    | défaut (true)        | défaut (false)              | —           |

**Constats :**

- `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true` sur **toutes** les vues. CONFORME.
- `webSecurity` / `allowRunningInsecureContent` jamais surchargés ailleurs (défauts sûrs). CONFORME.
- `experimentalFeatures`, `webviewTag`, `enableRemoteModule` : absents. CONFORME.
- **createSlotView** : seule vue chargeant du HTTP tiers — `webSecurity`/`allowRunningInsecureContent` désormais explicites. **CORRIGÉ.**

**Défenses complémentaires observées :**

- `will-navigate` bloque toute navigation hors `http(s)://` (slots) ou hors `file://` (chat/projects).
- `setWindowOpenHandler` renvoie `deny` et ouvre les liens externes via `shell.openExternal`.
- Fenêtre PDF : partition jetable + `onBeforeRequest` n'autorisant que `data:`/`about:`.

---

## 4. Surface du `contextBridge` (electron/preload.ts)

Deux objets exposés : `window.openhub` et `window.__od__`.

**Caractéristiques de sécurité :**

- 100 % par canaux IPC (`invoke`/`send`/`on`) — aucune fonction `fs`/`path`/`child_process` exposée. CONFORME.
- **Aucun paramètre de chemin disque** depuis le renderer : la sélection de dossier passe par `pickProjectPath`/`pick-and-import` (dialog natif côté main) ; `od-shell:open-path` reçoit un `projectId`, pas un chemin. CONFORME (règle CLAUDE.md « NO disk path parameters »).
- Les listeners renvoient une fonction de désabonnement (pas de fuite de handler).

**APIs exposées (résumé par domaine) :**

- Navigation/slots : `switchSlot`, `showSlotContextMenu`, `getSlotStatus`, `onSlotChanged`, `showNavMenu`, `navPopupSelect`, `getNavMode`/`setNavMode`.
- Secrets/clés : `getApiKeys`, `saveApiKeys` (→ Keychain côté main), `geminiLogin`, `geminiAuthStatus`.
- Projets/dossiers/workflows : CRUD via IPC, `pickProjectPath` (dialog natif).
- Orchestration : `executeOrchestration`, `iterateOrchestration`, `cancelOrchestration`, statut streamé.
- Mémoire/skills, notifications, mises à jour apps, recherche web, vision proxy, modèles IA.
- PDF : `exportPdf`, `exportHtmlToPdf` (rendu isolé côté main).
- `__od__` : `shell.openExternal`/`openPath`, `project.pickAndImport`, `pdf.print`, `updater.*` — tous validés/normalisés côté preload.

**Évaluation :** surface large en nombre de canaux mais minimale en capacités —
aucune primitive dangereuse (fs brut, eval, exécution arbitraire). CONFORME.

---

## 5. Findings et statuts

| #   | Finding                                                                           | Sévérité                    | Statut                                                           |
| --- | --------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| 1   | `webSecurity`/`allowRunningInsecureContent` implicites sur la vue tierce distante | LOW (défense en profondeur) | **CORRIGÉ** (commit `fix(permissions): expliciter webSecurity…`) |
| 2   | Binding réseau du démon Design (`od`) non contrôlable côté shell                  | INFO                        | À VÉRIFIER MANUELLEMENT                                          |
| 3   | Entitlements réduits aux 2 strictement requis par V8                              | —                           | CONFORME (déjà durci)                                            |
| 4   | `contextBridge` sans paramètre de chemin disque                                   | —                           | CONFORME                                                         |
| 5   | Tous les serveurs locaux liés à `127.0.0.1`/`localhost`                           | —                           | CONFORME                                                         |
| 6   | Proxy 9999 protégé par `Authorization: Bearer` + allowlist CORS                   | —                           | CONFORME                                                         |

---

## 6. Recommandations résiduelles (manuel)

1. **Design daemon** — vérifier au runtime (`lsof -i -P | grep od`) que le port
   capturé écoute bien sur loopback et non sur `0.0.0.0`. Le binaire étant
   upstream non modifiable, ce contrôle ne peut pas être forcé côté shell.
2. **Revue périodique** — re-exécuter cet audit après chaque `npm run update:apps`
   au cas où un binaire upstream changerait son comportement réseau.
