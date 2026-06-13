# Rapport de dette technique — OpenHub

**Date:** 2026-06-13
**Rapport précédent:** 2026-06-12

## Score global

| Catégorie                               | Findings | Critiques | Δ vs 2026-06-12 |
| --------------------------------------- | -------- | --------- | --------------- |
| Fichiers surdimensionnés (>400 lignes)  | 14       | 3         | +4              |
| Fonctions surdimensionnées (>50 lignes) | ~5       | 2         | ≈               |
| Nesting excessif (>4 niveaux)           | 3        | 3         | =               |
| Exports inutilisés (à réévaluer)        | ~11      | —         | ≈               |
| Usage de `any`                          | **0**    | 0         | -1 ✅           |
| TODO/FIXME                              | 1        | 0         | =               |
| Duplications                            | 2        | —         | =               |
| **Refactors appliqués**                 | **1**    | —         | +1 ✅           |

---

## Contexte d'exécution

L'arbre de travail reste **fortement modifié** : 18 fichiers `M` (feature
orchestrateur/projects en cours) et de nombreux fichiers/dossiers non trackés
(`electron/orchestrator-backends/`, `electron/orchestrator-llm.ts`,
`electron/notifications.ts`, dossiers racine `fi/`, `interface/`, `oui/`…).

Conformément au rapport précédent, **les fichiers en cours de modification ne
sont PAS refactorés** ce cycle pour éviter de mélanger du nettoyage de dette
avec du travail de feature non commité (risque de conflits/régressions). Seuls
les **fichiers non modifiés** ont été ciblés pour des refactors isolés.

---

## ✅ Refactor appliqué ce cycle

### `main.ts` → extraction de `electron/semver-utils.ts`

- **Commit:** `refactor: extraire la logique semver de main.ts vers electron/semver-utils.ts`
- **Problème:** `main.ts` (1958 lignes) mélangeait l'amorçage Electron avec une
  logique pure de versions (`Semver`, `parseSemver`, `compareSemver`,
  `findLatestTag`), non testée.
- **Action:** déplacement des 3 fonctions pures + interface vers un nouveau
  module de ~85 lignes ; `main.ts` ramené à **1880 lignes** (-78).
- **Tests:** ajout de `electron/semver-utils.test.ts` — **12 cas verts**
  (couverture passée de 0 % à ~100 % sur ce module).
- **Vérif:** `tsc --noEmit` OK, vitest OK, hooks pre-commit (eslint+prettier) OK.

---

## 1. Fichiers surdimensionnés (>400 lignes, seuil projet)

| Fichier                                              | Lignes | Statut                    |
| ---------------------------------------------------- | ------ | ------------------------- |
| `electron/proxy/index.ts`                            | 2323   | À REFACTORER MANUELLEMENT |
| `electron/orchestrator-runner.ts`                    | 2045   | À REFACTORER (en cours)   |
| `electron/main.ts`                                   | 1880   | À REFACTORER MANUELLEMENT |
| `electron/projects/chat.js`                          | 989    | À REFACTORER (en cours)   |
| `electron/orchestrator-prompts.ts`                   | 838    | À REFACTORER (en cours)   |
| `electron/projects/execution.js`                     | 780    | À REFACTORER (en cours)   |
| `electron/projects/canvas.js`                        | 681    | À REFACTORER (en cours)   |
| `electron/projects/management.js`                    | 633    | À REFACTORER (en cours)   |
| `electron/projects/modals.js`                        | 544    | À REFACTORER (en cours)   |
| `electron/project-store.ts`                          | 505    | À REFACTORER (en cours)   |
| `electron/orchestrator-backends/design-backend.ts`   | 472    | À REFACTORER MANUELLEMENT |
| `electron/preload.ts`                                | 448    | À REFACTORER (en cours)   |
| `electron/proxy/vision.ts`                           | 432    | À REFACTORER MANUELLEMENT |
| `electron/orchestrator-backends/opencode-backend.ts` | 426    | À REFACTORER MANUELLEMENT |

**Plan (fichiers non modifiés, refactorables sans conflit) :**

- `proxy/index.ts` (2323) — PRIORITÉ 1. Découper par responsabilité : routage
  OpenAI-compat, gestion des clés, logique vision (déjà partiellement dans
  `vision.ts`), middleware d'auth Bearer. Nesting jusqu'à 9 niveaux.
- `main.ts` (1880) — PRIORITÉ 2. Extraire la gestion des slots
  (`stopSlot`/`switchSlot`) en `slot-lifecycle.ts`, et la config des IPC handlers
  en `ipc-handlers.ts`. La logique semver vient d'être extraite ✅.
- `proxy/vision.ts` (432) / backends (472, 426) — légèrement au-dessus du seuil,
  découpage de faible priorité.

**Fichiers « en cours »** : tous modifiés/non trackés (feature active). À
découper **après stabilisation et merge** pour éviter les conflits.

---

## 2. Fonctions surdimensionnées (>50 lignes)

Concentrées dans les gros fichiers non refactorés (`proxy/index.ts`, `main.ts`).
Candidats prioritaires dans `main.ts` (non modifié) :

| Fichier            | Fonction       | Statut                    |
| ------------------ | -------------- | ------------------------- |
| `electron/main.ts` | `stopSlot`     | À REFACTORER MANUELLEMENT |
| `electron/main.ts` | `switchSlot`   | À REFACTORER MANUELLEMENT |
| `electron/main.ts` | `createWindow` | À REFACTORER MANUELLEMENT |

> Note : la fonction `cleanSearchQuery` signalée à « 301 lignes » dans le rapport
> précédent ne fait en réalité que **38 lignes** (les numéros de ligne du rapport
> 2026-06-12 étaient périmés). Finding retiré.

---

## 3. Nesting excessif (>4 niveaux)

| Fichier                           | Profondeur max | Statut                    |
| --------------------------------- | -------------- | ------------------------- |
| `electron/proxy/index.ts`         | ~9 niveaux     | À REFACTORER MANUELLEMENT |
| `electron/orchestrator-runner.ts` | ~9 niveaux     | À REFACTORER (en cours)   |
| `electron/main.ts`                | ~7 niveaux     | À REFACTORER MANUELLEMENT |

**Recommandation :** early returns + extraction de blocs imbriqués en fonctions
nommées.

---

## 4. Exports inutilisés

La majorité des exports « inutilisés » signalés au cycle précédent vivent dans
des **modules non trackés en développement actif** (`orchestrator-backends/`,
`orchestrator-llm.ts`, `notifications.ts`) — consommés par du code non commité.
**À réévaluer après merge de la feature.** Plusieurs étaient en fait des
faux positifs (ex. `keychain.writeSecret` est bien utilisé par le handler
`save-api-keys`).

**Statut : À RÉÉVALUER (non actionnable sans risque ce cycle).**

---

## 5. Usage de `any`

**0 occurrence** dans le code de production (hors tests). L'unique occurrence du
cycle précédent (`ollama-manager.ts`) a disparu. **Conformité parfaite. ✅**

---

## 6. TODO/FIXME

| Fichier                   | Ligne | Contenu                                                     | Statut        |
| ------------------------- | ----- | ----------------------------------------------------------- | ------------- |
| `electron/proxy/index.ts` | 2304  | `// TODO: Implémenter la logique d'extraction intelligente` | À IMPLÉMENTER |

Feature incomplète (extraction mémoire post-conversation, gardée derrière
`process.env.DEBUG_MAINTENANCE`). Hors périmètre d'un refactor de dette — relève
du développement de la feature.

---

## 7. Duplications

- **`task-done.js`** (factory `global/` + 3 configs par app) — pattern
  factory+config correct, pas de duplication réelle.
- **`bridge.js`** (3 apps) — logiques distinctes, non extractibles.
- **`theme.css`** — duplication potentielle de variables CSS entre `global/` et
  les 3 fichiers par app. **À VÉRIFIER** (audit CSS dédié).

Statut : aucune duplication actionnable sans risque ce cycle.

---

## 8. Organisation

- **Dossiers racine non trackés** (`fi/`, `interface/`, `oui/`, `pokjh/`,
  `Portfolio_d_Art/`, `interface-chat/`) — apparaissent dans `git status`. À
  clarifier : artefacts temporaires à `.gitignore` ou à supprimer s'ils ne font
  pas partie du projet. **À TRIER MANUELLEMENT.**
- **Mélange UI/business** dans `electron/projects/*.js` — état, DOM et logique
  métier dans les mêmes fichiers. Séparation model/view recommandée **après
  stabilisation**.

---

## Résumé exécutif

La dette dominante reste la **taille des fichiers** : 3 fichiers >1800 lignes
(`proxy/index.ts` 2323, `orchestrator-runner.ts` 2045, `main.ts` 1880). Le
nombre de fichiers >400 lignes est passé de 10 à **14**, principalement à cause
de la feature orchestrateur en cours (nouveaux backends, runner agrandi).

**Progrès ce cycle :**

1. ✅ Premier refactor appliqué et testé : extraction `semver-utils.ts`.
2. ✅ Usage de `any` ramené à 0.

**Prochaines étapes (par priorité) :**

1. Découper `proxy/index.ts` (non modifié, refactorable maintenant).
2. Poursuivre l'allègement de `main.ts` (slots, IPC handlers).
3. Après merge de la feature : découper `projects/*.js` et nettoyer les exports.
4. Trier les dossiers racine non trackés (gitignore ou suppression).
5. Implémenter ou retirer le TODO `proxy/index.ts:2304`.
