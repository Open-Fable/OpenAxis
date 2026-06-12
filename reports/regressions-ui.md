# Rapport d'audit régressions UI — 2026-06-12

## Résumé

Audit automatisé du code UI d'OpenHub : shell Electron, panneau projets, et overrides CSS/JS.
4 corrections appliquées, findings restants documentés ci-dessous.

## Corrections appliquées

### 1. Duplication task-done.js (CORRIGÉ)

- **Fichiers:** `electron/overrides/openwork/task-done.js`, `opencode/task-done.js`, `open-design/task-done.js`
- **Problème:** 100% de code dupliqué entre les 3 fichiers (polling, détection idle/running, cooldown)
- **Correction:** Extraction dans `global/task-done.js` exposant `window.__openhubTaskDone(selector, source)`. Chaque app n'a plus qu'un appel d'une ligne.

### 2. Duplication ALL_LABELS (CORRIGÉ)

- **Fichier:** `electron/overrides/opencode/reasoning-indicator.js:20-28`
- **Problème:** `ALL_LABELS` dupliquait les données de `FALLBACK_LEVELS` avec une incohérence ("Max" vs "Maximum")
- **Correction:** Dérivé via `reduce()` depuis `FALLBACK_LEVELS`

### 3. Variable inutilisée dragOffset (CORRIGÉ)

- **Fichier:** `electron/projects/state.js:14`
- **Problème:** `dragOffset` déclarée mais jamais utilisée dans le panneau projets
- **Correction:** Suppression

### 4. Sélecteur fragile graphify.js (CORRIGÉ)

- **Fichier:** `electron/overrides/opencode/graphify.js:164`
- **Problème:** `div.shrink-0.flex-col.items-center` cible des classes Tailwind fragiles
- **Correction:** Ajout de `[data-component="sidebar-bottom"]` en priorité avec fallback

---

## Findings non corrigés

### Sélecteurs CSS fragiles (classes utilitaires)

| Fichier              | Ligne   | Sélecteur                                         | Statut                                                            |
| -------------------- | ------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| `opencode/theme.css` | 271     | `.hidden.xl\:flex:has(button)`                    | À VÉRIFIER VISUELLEMENT — pas d'alternative sémantique disponible |
| `opencode/theme.css` | 276     | `div.hidden.xl\:flex`                             | À VÉRIFIER VISUELLEMENT — idem                                    |
| `opencode/theme.css` | 298-301 | `.xl\:hidden:has(...)`                            | À VÉRIFIER VISUELLEMENT — nécessaire pour masquer sidebar mobile  |
| `opencode/theme.css` | 306     | `.hidden.xl\:block[class*="pointer-events-none"]` | À VÉRIFIER VISUELLEMENT                                           |
| `opencode/theme.css` | 293     | `~ div.z-20`                                      | Fragile — dépend de la structure DOM                              |

### MutationObservers sans disconnect()

| Fichier                           | Ligne   | Détail                                      |
| --------------------------------- | ------- | ------------------------------------------- |
| `global/theme.js`                 | 97-119  | Observer sur html + body, jamais déconnecté |
| `open-design/bridge.js`           | 28-38   | Observer sur body, jamais déconnecté        |
| `opencode/bridge.js`              | 110-177 | Observer sur body, jamais déconnecté        |
| `opencode/graphify.js`            | 195-196 | Observer sur body, jamais déconnecté        |
| `opencode/reasoning-indicator.js` | 263-268 | Observer sur body, jamais déconnecté        |
| `openwork/projects.js`            | 204-215 | Observer sur body, jamais déconnecté        |

**Note:** Ces observers tournent dans des WebContentsView Electron à durée de vie longue. L'absence de `disconnect()` n'est pas critique car la view est détruite avec la fenêtre, mais ce n'est pas idéal pour la propreté du code.

### setInterval sans clearInterval

| Fichier                           | Ligne   | Intervalle                                          |
| --------------------------------- | ------- | --------------------------------------------------- |
| `opencode/reasoning-indicator.js` | 279-287 | 3s — polling localStorage en double avec l'observer |
| `openwork/projects.js`            | 217     | 3s — `ensureInjected()` en double avec l'observer   |

### !important excessif

| Fichier                 | Nombre approximatif |
| ----------------------- | ------------------- |
| `global/theme.css`      | ~40                 |
| `opencode/theme.css`    | ~150                |
| `openwork/theme.css`    | ~25                 |
| `open-design/theme.css` | ~80                 |

**Total:** ~295 déclarations `!important`. Nécessaire dans le contexte d'override (les apps ont leurs propres styles chargés en premier), mais pourrait être réduit en utilisant des sélecteurs plus spécifiques. À VÉRIFIER VISUELLEMENT si on en retire.

### Duplication variables CSS thème

Les palettes de couleurs sont définies 4 fois (global, opencode, openwork, open-design) sans cascade. Chaque app a ses propres tokens car les systèmes de design internes diffèrent. Unification risquée sans refonte complète.

### États manquants dans le panneau projets

| Fichier        | Ligne   | État manquant                                                  |
| -------------- | ------- | -------------------------------------------------------------- |
| `execution.js` | 239     | Pas de skeleton loading pendant le chargement de l'historique  |
| `chat.js`      | 180-184 | Pas de loader entre l'envoi du message et le premier chunk SSE |

### Incohérences CSS mineures

| Fichier        | Ligne        | Détail                                                    |
| -------------- | ------------ | --------------------------------------------------------- |
| `projects.css` | 2246         | `gap: 6px` hardcodé au lieu de variable CSS               |
| `projects.css` | 1040         | `gap: 3px` hardcodé au lieu de variable CSS               |
| `projects.css` | 756          | `--text-tertiary` utilisé mais jamais défini dans `:root` |
| `projects.css` | 1098 vs 2184 | `.btn` et `.mgmt-btn` ont des padding/height différents   |

---

## Résultat check:selectors

```
No automated errors detected. Verify selectors manually in the running apps.
```

Aucune erreur automatisée. Vérification manuelle recommandée pour les sélecteurs marqués "À VÉRIFIER VISUELLEMENT".
