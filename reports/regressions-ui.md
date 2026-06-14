# Rapport d'audit régressions UI — 2026-06-14

## Résumé

Second passage d'audit du code UI d'OpenHub (shell Electron, panneau projets,
overrides CSS/JS). Le premier audit (2026-06-12) avait corrigé 4 points et
documenté le reste. Ce passage a vérifié l'état actuel et corrigé **1 nouvelle
régression réelle** (tokens CSS non définis). Les autres findings restent
classés comme intentionnels ou à risque visuel.

## Corrections appliquées ce passage

### 1. Tokens CSS non définis dans le panneau projets (CORRIGÉ)

- **Fichier:** `electron/projects/projects.css`
- **Occurrences:**
  - `--text-tertiary` — ligne 803 (`.console-copy-btn`)
  - `--bg-hover` — ligne 816 (`.console-copy-btn:hover`)
  - `--accent` — lignes 819, 3440, 3455, 3456 (bouton copié, focus textarea
    d'itération, badge d'historique)
- **Problème:** Ces 3 custom properties étaient référencées via `var()` sans
  valeur de repli alors qu'aucune n'est définie dans `:root`. La déclaration
  CSS devient invalide → la propriété est ignorée et la valeur héritée du
  parent s'applique (anneau de focus absent, fond de survol manquant, couleur
  d'accent inerte). Bug silencieux : aucune erreur console.
- **Cause:** fautes de frappe par rapport au design system de `:root`. La
  palette n'a jamais eu de niveau « tertiary » ni d'alias court « accent ».
- **Correction:** `--text-tertiary` → `--text-muted`, `--bg-hover` →
  `--bg-elevated`, `--accent` → `--accent-primary` (tokens réellement définis).
- **Statut:** CORRIGÉ — À VÉRIFIER VISUELLEMENT (l'apparence passe de « couleur
  héritée » vers la couleur de token prévue).

---

## Vérifications effectuées (sans régression nouvelle)

### Sélecteurs des overrides (apps tierces)

Les overrides JS ciblent majoritairement des sélecteurs sémantiques
(`data-component`, `data-action`, `data-slot`, `id`, `role`, `aria-*`) — bonne
pratique respectée. Les rares sélecteurs de classe utilitaire restants sont des
**fallbacks documentés** :

- `opencode/reasoning-indicator.js:1231` — `span.truncate` (fallback DOM si
  localStorage vide, après `[data-action="prompt-model"]`).
- `opencode/graphify.js` — `div.shrink-0.flex-col.items-center` n'est plus
  utilisé qu'en fallback derrière `[data-component="sidebar-bottom"]` (corrigé
  au passage précédent).

### Sélecteurs de classe dans `electron/projects/*.js`

Les `querySelector('.node-card')`, `.msg-thinking`, `.status-dot`, etc. ciblent
le **markup propre à OpenHub** (panneau projets entièrement maison :
`projects.html` + `projects.css`). La règle « préférer data-\* aux classes
utilitaires » ne s'applique pas ici : ce sont des noms de classe sémantiques de
l'application elle-même, pas des classes d'un framework tiers susceptibles de
changer. Aucune correction nécessaire.

### MutationObservers

| Fichier                           | disconnect ? | Verdict                                                |
| --------------------------------- | ------------ | ------------------------------------------------------ |
| `opencode/graphify.js`            | Oui          | Se déconnecte dès que le bouton est injecté — correct  |
| `global/theme.js`                 | Non          | Intentionnel : doit re-synchroniser à chaque re-render |
| `open-design/bridge.js`           | Non          | Intentionnel : ré-injection sur SPA re-render          |
| `opencode/bridge.js`              | Non          | Intentionnel : détection continue des dialogs          |
| `opencode/reasoning-indicator.js` | Non          | Intentionnel : ré-injection sur re-render SolidJS      |
| `openwork/projects.js`            | Non          | Intentionnel : ré-injection du bouton « Projets »      |

Les observers persistants sont coalescés via `requestAnimationFrame`
(`projects.js`, `reasoning-indicator.js`) pour éviter de tourner à chaque
mutation pendant le streaming. Ils vivent le temps de la WebContentsView et sont
détruits avec elle — pas de fuite réelle. Aucun changement.

### `!important`

| Fichier                 | `!important` |
| ----------------------- | ------------ |
| `open-design/theme.css` | 144          |
| `opencode/theme.css`    | 111          |
| `openwork/theme.css`    | 38           |
| `global/theme.css`      | 13           |

Tous concentrés dans les fichiers `theme.css` d'**override d'apps tierces**, où
les styles upstream sont chargés en premier et ne peuvent être surchargés
autrement de façon fiable. `projects-hub.css`, `projects.css` (overrides) et le
panneau projets maison n'utilisent **aucun** `!important`. Réduction non
recommandée sans refonte (risque visuel élevé).

### Duplication

Aucune nouvelle duplication détectée. La factorisation de `task-done.js`
(`global/task-done.js` + appels d'une ligne par app) et de `ALL_LABELS`
(`reduce` sur `FALLBACK_LEVELS`) du passage précédent tient toujours.

### États (loading / error / empty)

- `openwork/projects-hub.js` : empty state (grille vide), loading (« Chargement…
  »), error (« Erreur lors du chargement des fichiers ») présents — OK.
- `opencode/graphify.js` : états spinner / success / error présents — OK.
- Reste documenté du passage précédent (skeleton historique dans
  `execution.js`, loader premier chunk SSE dans `chat.js`) : amélioration UX
  non bloquante, non traitée.

---

## Résultat check:selectors

```
=== Selector check complete ===
No automated errors detected. Verify selectors manually in the running apps.
```

Aucune erreur automatisée. Vérification visuelle recommandée pour le point
corrigé (tokens CSS) et les sélecteurs d'override des apps tierces.
