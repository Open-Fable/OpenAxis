# Rapport de dette technique — OpenHub

**Date:** 2026-06-15
**Rapport précédent:** 2026-06-13

## Score global

| Catégorie                               | Findings | Critiques | Δ vs 2026-06-13 |
| --------------------------------------- | -------- | --------- | --------------- |
| Fichiers surdimensionnés (>400 lignes)  | 19       | 5         | +5              |
| Fonctions surdimensionnées (>50 lignes) | ~6       | 2         | ≈               |
| Nesting excessif (>4 niveaux)           | 3        | 3         | =               |
| Code mort / exports inutilisés          | ~11      | —         | ≈ (à réévaluer) |
| Usage de `any`                          | **0**    | 0         | = ✅            |
| TODO/FIXME                              | 1        | 0         | =               |
| Duplications                            | 2        | —         | =               |
| Organisation (dossiers non trackés)     | 5        | —         | +5              |
| **Refactors appliqués**                 | **1**    | —         | +1 ✅           |

---

## Contexte d'exécution

L'arbre de travail reste **fortement modifié** : 14 fichiers `M` (feature
orchestrateur/projects toujours en cours) et plusieurs dossiers racine non
trackés (`code-pure/`, `csv/`, `saas/`, `saas-screen/`, `svc-screen/`).

Comme aux cycles précédents, **les fichiers en cours de modification ne sont PAS
refactorés** ce cycle : mélanger du nettoyage de dette avec du travail de feature
non commité crée des conflits et masque les régressions. Seuls les **fichiers non
modifiés** sont ciblés pour des refactors isolés et testés.

Les fichiers critiques ont **grossi** depuis la feature orchestrateur :
`orchestrator-runner.ts` 2045 → **3541** (+1496), `main.ts` 1880 → **2168**,
`proxy/index.ts` 2323 → 2510. Leur découpage reste **bloqué jusqu'au merge**.

---

## ✅ Refactor appliqué ce cycle

### `project-store.ts` → extraction de `electron/project-seed.ts`

- **Commit:** `refactor: extraire les projets de démonstration de project-store.ts vers project-seed.ts`
- **Problème:** `project-store.ts` (555 lignes, >400) contenait ~100 lignes de
  données éditoriales pures (`INITIAL_PROJECTS` : 6 projets de démo avec prompts
  système verbeux) noyant la logique de persistance (load/save/write-lock/CRUD).
- **Action:** nouveau module `project-seed.ts` (107 lignes) exportant
  `INITIAL_PROJECTS`, typé via `import type { Project }` (aucun cycle runtime).
  `project-store.ts` ramené de **555 → 455 lignes** (-100).
- **Vérif:** `tsc --noEmit` OK ; `vitest project-store` **10/10 verts** ;
  prettier appliqué. Comportement runtime inchangé.

> Choix autonome : un seul refactor sûr et testé ce cycle (comme `semver-utils`
> au cycle 06-13), faute de pouvoir toucher aux gros fichiers en cours de feature.

---

## 1. Fichiers surdimensionnés (>400 lignes, seuil projet)

| Fichier                                              | Lignes | Statut                    |
| ---------------------------------------------------- | ------ | ------------------------- |
| `electron/chat.js`                                   | 4109   | À REFACTORER MANUELLEMENT |
| `electron/orchestrator-runner.ts`                    | 3541   | À REFACTORER (en cours)   |
| `electron/proxy/index.ts`                            | 2510   | À REFACTORER (en cours)   |
| `electron/orchestrator-quality.ts`                   | 2180   | À REFACTORER MANUELLEMENT |
| `electron/main.ts`                                   | 2168   | À REFACTORER (en cours)   |
| `electron/sidebar-ui.js`                             | 1426   | À REFACTORER MANUELLEMENT |
| `electron/orchestrator-prompts.ts`                   | 1077   | À REFACTORER (en cours)   |
| `electron/projects/chat.js`                          | 994    | À REFACTORER MANUELLEMENT |
| `electron/projects/execution.js`                     | 842    | À REFACTORER MANUELLEMENT |
| `electron/projects/canvas.js`                        | 681    | À REFACTORER MANUELLEMENT |
| `electron/projects/management.js`                    | 636    | À REFACTORER (en cours)   |
| `electron/projects/modals.js`                        | 575    | À REFACTORER MANUELLEMENT |
| `electron/orchestrator-backends/design-backend.ts`   | 573    | À REFACTORER (en cours)   |
| `electron/orchestrator-backends/opencode-backend.ts` | 496    | À REFACTORER (en cours)   |
| `electron/preload.ts`                                | 463    | À REFACTORER MANUELLEMENT |
| `electron/project-store.ts`                          | 455    | ✅ ALLÉGÉ ce cycle (-100) |
| `electron/proxy/vision.ts`                           | 448    | À REFACTORER MANUELLEMENT |
| `electron/gemini-oauth.ts`                           | 425    | À REFACTORER MANUELLEMENT |
| `electron/process-manager.ts`                        | 406    | À REFACTORER MANUELLEMENT |

**Plan priorisé (fichiers non modifiés, refactorables sans conflit) :**

- `chat.js` (4109) — **PRIORITÉ 1**. Plus gros fichier du repo. Découper par
  responsabilité : rendu des messages, gestion du streaming, état de
  conversation, gestion des pièces jointes. Risque élevé (UI vivante) → prévoir
  des tests de fumée avant découpe.
- `orchestrator-quality.ts` (2180) — PRIORITÉ 2 (non modifié). Séparer les
  prompts de vérification (texte) de la logique de scoring/parse.
- `sidebar-ui.js` (1426) — extraire la logique de navigation des slots de la
  construction du DOM.
- `process-manager.ts` (406) / `gemini-oauth.ts` (425) / `proxy/vision.ts` (448)
  — légèrement au-dessus du seuil, découpage de faible priorité, sans tests
  existants → risque de régression non couverte.

**Fichiers « en cours » :** tous modifiés/non trackés (feature active). À
découper **après stabilisation et merge**.

---

## 2. Fonctions surdimensionnées (>50 lignes)

Concentrées dans les gros fichiers non refactorables (`proxy/index.ts`,
`main.ts`, `orchestrator-runner.ts`). Candidats prioritaires sur fichiers
**non modifiés** :

| Fichier                            | Zone                  | Statut                    |
| ---------------------------------- | --------------------- | ------------------------- |
| `electron/orchestrator-quality.ts` | logique de scoring    | À REFACTORER MANUELLEMENT |
| `electron/chat.js`                 | handlers de streaming | À REFACTORER MANUELLEMENT |

---

## 3. Nesting excessif (>4 niveaux)

| Fichier                           | Profondeur max | Statut                  |
| --------------------------------- | -------------- | ----------------------- |
| `electron/proxy/index.ts`         | ~9 niveaux     | À REFACTORER (en cours) |
| `electron/orchestrator-runner.ts` | ~9 niveaux     | À REFACTORER (en cours) |
| `electron/main.ts`                | ~7 niveaux     | À REFACTORER (en cours) |

**Recommandation :** early returns + extraction de blocs imbriqués en fonctions
nommées.

---

## 4. Code mort / exports inutilisés

La majorité des exports « inutilisés » vivent dans des **modules en
développement actif** (`orchestrator-backends/`, `orchestrator-llm.ts`,
`notifications.ts`), consommés par du code non commité. **À réévaluer après
merge.** Plusieurs candidats du passé étaient des faux positifs (consommés via
handlers IPC dynamiques).

- Aucun import/variable inutilisé détecté dans les fichiers stables (eslint
  `no-unused-vars` passe au pre-commit).
- Pas d'override CSS/JS orphelin détecté (tous référencés dans
  `overrides/index.json`).

**Statut : À RÉÉVALUER (non actionnable sans risque ce cycle).**

---

## 5. Usage de `any`

**0 occurrence** problématique dans le code de production.

- `main.ts:374` `type IpcArgs = any[]` — **toléré** : boundary de sérialisation
  IPC (autorisé explicitement par les standards projet).
- `orchestrator-runner.ts:3298` — simple commentaire contenant le mot « any ».

**Conformité parfaite. ✅**

---

## 6. TODO/FIXME

| Fichier                   | Ligne | Contenu                                                     | Statut        |
| ------------------------- | ----- | ----------------------------------------------------------- | ------------- |
| `electron/proxy/index.ts` | 2491  | `// TODO: Implémenter la logique d'extraction intelligente` | À IMPLÉMENTER |

Feature incomplète (extraction mémoire post-conversation, gardée derrière
`process.env.DEBUG_MAINTENANCE`). Hors périmètre d'un refactor de dette — relève
du développement de la feature. (Inchangé depuis 06-13, ligne décalée 2304→2491.)

---

## 7. Duplications

- **`task-done.js`** (factory `global/` + 3 configs par app) — pattern
  factory+config correct, pas de duplication réelle.
- **`bridge.js`** (3 apps) — logiques distinctes, non extractibles.
- **`theme.js`** — duplication potentielle de variables CSS entre `global/` et
  les overrides par app. **À VÉRIFIER** (audit CSS dédié).

Statut : aucune duplication actionnable sans risque ce cycle.

---

## 8. Organisation

- **Dossiers racine non trackés** (`code-pure/`, `csv/`, `saas/`, `saas-screen/`,
  `svc-screen/`) — apparaissent dans `git status`. Ce sont des **artefacts de
  sortie de l'orchestrateur** (livrables générés + captures d'écran), PAS du code
  source. **Recommandation : les ajouter au `.gitignore`** (ex. un dossier
  `out/` dédié aux livrables générés) ou les déplacer hors du repo. Non supprimés
  autonomement (travail utilisateur potentiel). **À TRIER MANUELLEMENT.**
- **Mélange UI/business** dans `electron/projects/*.js` — état, DOM et logique
  métier dans les mêmes fichiers. Séparation model/view recommandée **après
  stabilisation**.

---

## Résumé exécutif

La dette dominante reste la **taille des fichiers** : le nombre de fichiers

> 400 lignes est passé de 14 à **19**, et 5 fichiers dépassent désormais 2000
> lignes (`chat.js` 4109, `orchestrator-runner.ts` 3541, `proxy/index.ts` 2510,
> `orchestrator-quality.ts` 2180, `main.ts` 2168). Cette croissance vient de la
> feature orchestrateur en cours.

**Progrès ce cycle :**

1. ✅ Refactor appliqué et testé : extraction `project-seed.ts` (-100 lignes sur
   `project-store.ts`).
2. ✅ Usage de `any` maintenu à 0.

**Prochaines étapes (par priorité) :**

1. Découper `chat.js` (4109, non modifié) — priorité absolue, prévoir tests de
   fumée d'abord.
2. Après merge de la feature : découper `orchestrator-runner.ts`, `proxy/index.ts`,
   `main.ts` et nettoyer les exports.
3. Ajouter les dossiers de livrables générés au `.gitignore`.
4. Implémenter ou retirer le TODO `proxy/index.ts:2491`.
5. Séparer model/view dans `projects/*.js` après stabilisation.
