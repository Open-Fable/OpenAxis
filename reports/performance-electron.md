# Audit Performance Electron — OpenHub

**Date:** 2026-06-12
**Scope:** Mémoire, processus, IPC, chargement, proxy

---

## Résumé

3 commits d'optimisation appliqués couvrant les goulots les plus impactants.
Les points « À BENCHMARKER » nécessitent des mesures en conditions réelles.

---

## 1. Mémoire

| #   | Fichier:ligne                                                | Goulot                                                                                                          | Impact | Statut                                                      |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| 1.1 | `electron/overrides/opencode/reasoning-indicator.js:258-282` | MutationObserver(body, subtree:true) + setInterval(3s) dupliquent refreshModelSupport() et injectInlineButton() | Moyen  | **OPTIMISÉ** — setInterval réduit au sync localStorage      |
| 1.2 | `electron/overrides/openwork/projects.js:204-217`            | MutationObserver + setInterval(3s) dupliquent ensureInjected()                                                  | Moyen  | **OPTIMISÉ** — setInterval supprimé                         |
| 1.3 | `electron/overrides/opencode/graphify.js:197-198`            | MutationObserver jamais déconnecté après injection réussie                                                      | Moyen  | **OPTIMISÉ** — disconnect() après injection                 |
| 1.4 | `electron/overrides/opencode/bridge.js:110-120`              | Observer body/subtree déclenche scheduleDialogCheck sur chaque mutation                                         | Moyen  | **OPTIMISÉ** — filtre pré-check sur data-component='dialog' |
| 1.5 | `electron/overrides/open-design/bridge.js:28-38`             | Observer body/subtree pour hideTrigger() — callbacks fréquents mais légers                                      | Bas    | Non traité — coût acceptable                                |
| 1.6 | `electron/preload.ts:14-46`                                  | 4 listeners IPC sans cleanup (onSlotChanged, onShowConfig, onApiKeysUpdated, onNavModeChanged)                  | Moyen  | **OPTIMISÉ** — retournent cleanup functions                 |

## 2. Processus

| #   | Fichier:ligne                         | Goulot                                                                                 | Impact | Statut                                                                                   |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| 2.1 | `electron/main.ts:1861-1863`          | stopAll() appelé puis app.quit() immédiatement — cleanup async potentiellement tronqué | Moyen  | **OPTIMISÉ** — ajout before-quit + SIGTERM/SIGINT handlers                               |
| 2.2 | `electron/process-manager.ts:209-228` | killPort fire-and-forget — SIGKILL fallback non attendu dans stopAll()                 | Moyen  | À BENCHMARKER — nécessite vérification que les processus enfants se terminent proprement |

## 3. IPC et communication

| #   | Fichier:ligne                                            | Goulot                                                                                              | Impact | Statut                                                |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| 3.1 | `electron/overrides/opencode/reasoning-indicator.js:274` | Polling réseau toutes les 3s vers /v1/reasoning/levels même quand l'onglet opencode n'est pas actif | Moyen  | **OPTIMISÉ** — polling réseau supprimé du setInterval |
| 3.2 | `electron/overrides/global/task-done.js:23`              | setInterval(1500ms) dans chaque WebContentsView pour détecter fin de tâche                          | Bas    | Non traité — DOM query simple, acceptable             |

## 4. Chargement

| #   | Fichier:ligne                | Goulot                                                                      | Impact | Statut                                                                           |
| --- | ---------------------------- | --------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| 4.1 | `electron/main.ts:1838-1841` | 4 readSecret() séquentiels au démarrage (~50-100ms chacun)                  | Moyen  | **OPTIMISÉ** — Promise.all()                                                     |
| 4.2 | `electron/main.ts:1351-1432` | check-app-updates vérifie 3 apps séquentiellement (git fetch × 3)           | Moyen  | **OPTIMISÉ** — Promise.all() sur APP_NAMES                                       |
| 4.3 | `electron/main.ts:207-209`   | CSS re-injecté via insertCSS() à chaque did-navigate-in-page — accumulation | Moyen  | À BENCHMARKER — nécessite mesure d'impact mémoire après navigation SPA prolongée |

## 5. Proxy Express

| #   | Fichier:ligne                       | Goulot                                                                                   | Impact | Statut                                                          |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------- |
| 5.1 | Proxy /v1/chat/completions          | Chaque requête LLM re-lit le projet actif, mémoire, et rapport Graphify depuis le disque | Haut   | À BENCHMARKER — cache mémoire avec TTL recommandé               |
| 5.2 | `electron/project-store.ts:303-307` | setActiveProject fait load()+save() à chaque nœud d'orchestration (2N écritures disque)  | Moyen  | À BENCHMARKER — flag in-memory recommandé pendant orchestration |

---

## Recommandations de mesure

1. **Démarrage:** Mesurer `app.whenReady()` → `mainWindow.show()` avant/après Promise.all (objectif: -200ms)
2. **CPU idle:** Profiler DevTools Performance pendant 30s sans interaction — vérifier que les observers optimisés réduisent le nombre de callbacks
3. **Processus orphelins:** Fermer l'app, vérifier `ps aux | grep -E 'opencode|node|od'` — aucun processus orphelin
4. **Proxy latence:** Ajouter timing dans le handler /v1/chat/completions et comparer avant/après cache
5. **Mémoire SPA:** Naviguer 20+ fois dans opencode, mesurer heap via `process.memoryUsage()` sur le WebContentsView
