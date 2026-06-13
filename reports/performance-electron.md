# Rapport d'audit performance — OpenHub (Electron)

**Date de l'audit :** 2026-06-13
**Périmètre :** mémoire, processus enfants, IPC/contextBridge, chargement des
WebContentsView, proxy Express.
**Stack :** Electron v32+, TypeScript, 3 WebContentsView, processus natifs.

---

## Résumé exécutif

L'audit confirme que l'architecture est globalement saine :

- **Chargement paresseux** des 3 vues Work/Code/Design (pas de chargement
  simultané au démarrage — déjà optimal).
- **Cycle de vie complet** : tous les chemins de sortie (`window-all-closed`,
  `before-quit`, `SIGTERM`/`SIGINT`) appellent `stopAll()`. **Aucun zombie
  détecté** : les 4 processus enfants (openwork, opencode, daemon `od`, web
  open-design) sont tous tués et leurs ports nettoyés.
- **Guards d'idempotence** : tous les overrides ré-injectés à chaque navigation
  (`did-navigate` / `did-navigate-in-page`) possèdent un drapeau
  `window.__OPENHUB_*_INJECTED__` qui empêche l'accumulation d'observers, de
  timers ou de listeners. **Les « fuites mémoire » initialement suspectées n'en
  sont pas** : observers et intervals vivent une seule fois par page.

Les optimisations réellement applicables concernent donc le **coût CPU récurrent**
(callbacks d'observers sur le hot path de mutation DOM) et la **latence du proxy**,
pas des fuites mémoire. Trois optimisations ont été appliquées sur deux commits.

---

## 1. Mémoire

| Goulot                                                                                                                                                     | Fichier:ligne                                            | Impact                                                                                                                | Statut                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| MutationObserver `subtree:true` exécutant `injectInlineButton()` + `refreshModelSupport()` à **chaque** mutation (rafales pendant le streaming des tokens) | `electron/overrides/opencode/reasoning-indicator.js:258` | CPU élevé sur thread renderer pendant le chat                                                                         | **OPTIMISÉ** (coalescence rAF)                                           |
| MutationObserver `subtree:true` exécutant `ensureInjected()` à chaque mutation                                                                             | `electron/overrides/openwork/projects.js:204`            | CPU moyen pendant re-renders SolidJS                                                                                  | **OPTIMISÉ** (coalescence rAF)                                           |
| MutationObserver `subtree:true` détection de dialogs (`scheduleDialogCheck`)                                                                               | `electron/overrides/opencode/bridge.js:110`              | Faible — filtre déjà sur `data-component='dialog'` et débounce via `scheduleDialogCheck`                              | À BENCHMARKER (déjà raisonnablement gardé, non touché)                   |
| MutationObserver thème (`documentElement` + `body`, `attributeFilter`)                                                                                     | `electron/overrides/global/theme.js:97`                  | Faible — filtré sur `class`/`data-theme` uniquement, pas `subtree`                                                    | OK (filtrage attributaire suffisant)                                     |
| MutationObserver `hideTrigger()`                                                                                                                           | `electron/overrides/open-design/bridge.js:28`            | Faible                                                                                                                | À BENCHMARKER                                                            |
| `setInterval(…, 3000)` polling localStorage pour sync inter-fenêtres                                                                                       | `electron/overrides/opencode/reasoning-indicator.js:274` | Très faible (1 lecture localStorage/3s), gardé par `__OPENHUB_REASONING_INJECTED_V2__` donc un seul timer             | À BENCHMARKER (redondant avec l'event `storage` ligne 266 — supprimable) |
| `setInterval(…, 1500)` détecteur de fin de tâche                                                                                                           | `electron/overrides/global/task-done.js:23`              | Très faible, gardé par `__OPENHUB_TASK_DONE_INJECTED__` (un seul timer)                                               | OK (non-fuite, polling léger nécessaire)                                 |
| Listeners canvas ré-attachés à chaque `renderCanvas()`/`drawConnections()`                                                                                 | `electron/projects/canvas.js:147+`                       | Faible — les anciens nœuds sont `.remove()` avant recréation (lignes 50-52) donc GC les collecte avec leurs listeners | OK (pas de fuite réelle)                                                 |
| Listener `mousedown` outside-click ajouté via `setTimeout(0)`                                                                                              | `electron/projects/canvas.js:620`                        | Négligeable — `removeEventListener` présent                                                                           | OK                                                                       |

### Détail des optimisations mémoire/CPU appliquées

**Coalescence rAF des observers (commit `perf: coalescer les MutationObservers…`)**
Les deux observers les plus coûteux observaient `document.body` en
`{ childList: true, subtree: true }` et relançaient leur travail d'injection
(querySelector sur tout l'arbre) à **chaque** mutation. Pendant le streaming des
tokens opencode, le body mute des centaines de fois par seconde.
→ Les mutations d'une même frame sont désormais fusionnées en un seul appel via
`requestAnimationFrame` + drapeau `rafScheduled`. Les fonctions d'injection
restent idempotentes : comportement préservé, timing décalé de < 16 ms.

---

## 2. Processus enfants

| Goulot                                                                           | Fichier:ligne                        | Impact                                     | Statut                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------ | ------------------------------------------------------ |
| `execSync("lsof -ti:PORT")` **bloquant** sur le thread principal lors de l'arrêt | `electron/process-manager.ts:190`    | Peut figer la fermeture si `lsof` est lent | À BENCHMARKER (volontairement laissé — voir note)      |
| `killPort(7456)` appelé pour le slot design en plus du port web                  | `process-manager.ts:146,161-163`     | Négligeable                                | OK (daemon `od` sur port distinct, nettoyage légitime) |
| Spawn openwork/opencode/design stockés dans `RunningApp.processes[]`             | `process-manager.ts:251,274,311-315` | —                                          | OK (tous tués par `stopAll()`)                         |
| Handlers `ready`/`activate`/`window-all-closed`/`before-quit`/`SIGTERM`/`SIGINT` | `electron/main.ts:1896-1949`         | —                                          | OK (couverture complète)                               |

**Note `execSync` (À BENCHMARKER, non modifié) :** `killPort()` utilise `execSync`
au moment de l'arrêt. C'est un choix **délibérément conservateur** : le caractère
synchrone garantit que `lsof` + l'envoi des SIGTERM se terminent **avant** que
l'app ne sorte. Le passer en asynchrone risquerait de laisser l'app quitter
avant la fin du kill, recréant le risque de zombies que ce code prévient. Une
migration vers `exec` asynchrone changerait le séquencement d'arrêt → à valider
au banc avant toute modification. **Recommandation de mesure :** chronométrer
`stopAll()` (ajouter `console.time`) sur un arrêt réel ; n'optimiser que si le
blocage dépasse ~200 ms de façon reproductible.

---

## 3. IPC et communication

| Goulot                                                                         | Fichier:ligne                 | Impact                                                           | Statut                                                    |
| ------------------------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| Endpoint `/workspace/:id/sessions` en `void (async () => …)()` fire-and-forget | `electron/proxy/index.ts:314` | Faible — réponse envoyée dans le callback async, pattern correct | OK                                                        |
| Surface `contextBridge` (preload)                                              | `electron/preload.ts`         | —                                                                | OK (invoke ponctuels, pas de polling IPC haute fréquence) |

Aucune optimisation IPC nécessaire : la surface du bridge est ponctuelle
(invoke/handle), pas de sérialisation lourde dans le preload.

---

## 4. Chargement

| Goulot                                                                               | Fichier:ligne              | Impact                                                                  | Statut |
| ------------------------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------- | ------ |
| 3 WebContentsView Work/Code/Design **créées paresseusement** au premier `switchSlot` | `electron/main.ts:458-480` | Optimal — pas de coût mémoire au démarrage                              | OK     |
| opencode démarré en arrière-plan (non bloquant) au `whenReady`                       | `main.ts:1924`             | Optimal                                                                 | OK     |
| `loadViewUrl` retry 6× avec délai 1 s sur `ERR_CONNECTION_REFUSED`                   | `main.ts:257-274`          | Acceptable (attente service)                                            | OK     |
| Overrides injectés sur `did-navigate` ET `did-navigate-in-page`                      | `main.ts:214-215`          | Ré-injection à chaque route SPA, mais gardée par drapeaux d'idempotence | OK     |

Le chargement est déjà bien optimisé : rien à modifier. Les vues ne sont pas
chargées simultanément ; seul le moteur opencode (nécessaire au slot Work)
préchauffe en arrière-plan sans bloquer l'UI.

---

## 5. Proxy Express

| Goulot                                                                         | Fichier:ligne                          | Impact                                             | Statut                                                |
| ------------------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| Descriptions d'images **séquentielles** (await en boucle) sur le hot path chat | `electron/proxy/index.ts:1129` (avant) | N images = N × latence Ollama (plusieurs secondes) | **OPTIMISÉ** (Promise.all)                            |
| Élagage de contexte : double itération O(n) sur tous les messages              | `electron/proxy/index.ts:1163-1191`    | Faible sauf conversations très longues (500+ msgs) | À BENCHMARKER (non bloquant, négligeable en pratique) |
| Assemblage du system prompt : `.filter()`/spread multiples                     | `electron/proxy/index.ts:1245-1272`    | Négligeable (tableau de ~6 éléments)               | OK                                                    |

**Optimisation proxy appliquée (commit `perf: paralléliser les descriptions…`) :**
la boucle `for...of` séquentielle avec `await describeImage()` a été remplacée
par `parts.map(async …)` + `Promise.all`. Les descriptions étant indépendantes,
elles s'exécutent en parallèle ; l'ordre des parties est préservé par
l'indexation du tableau. Gain ≈ Nx pour N images dans un même message.

---

## Recommandations de mesure (validation des gains)

1. **Observers coalescés** — Profiler (DevTools → Performance) une session de
   chat opencode pendant le streaming, avant/après : comparer le temps cumulé
   passé dans les callbacks `MutationObserver`. Attendu : forte baisse du nombre
   d'appels et du temps script sur le thread renderer.
2. **Proxy vision parallèle** — Envoyer un message contenant 3 images, mesurer
   le temps de la requête `POST /v1/chat/completions` (log `console.time` autour
   du bloc vision) avant/après. Attendu : ≈ temps de l'image la plus lente au
   lieu de la somme.
3. **`execSync` arrêt** — Instrumenter `stopAll()` avec `console.time` sur un
   arrêt réel pour décider si la migration async vaut le risque de séquencement.
4. **Mémoire globale** — `app.getAppMetrics()` / Activity Monitor sur les
   processus renderer après 30 min d'usage actif : vérifier l'absence de
   croissance monotone (confirme l'absence de fuite, déjà attendue grâce aux
   guards d'idempotence).

---

## Optimisations appliquées (résumé des commits)

1. `perf: coalescer les MutationObservers d'overrides via requestAnimationFrame`
   — reasoning-indicator.js + projects.js.
2. `perf: paralléliser les descriptions d'images dans le proxy vision`
   — proxy/index.ts.

Les autres points sont soit déjà optimaux (OK), soit volontairement laissés en
**À BENCHMARKER** car les modifier changerait un comportement observable
(séquencement d'arrêt) sans bénéfice mesuré.
