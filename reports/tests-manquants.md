# Audit des tests manquants — OpenHub

**Date de l'audit :** 2026-06-13
**Stack :** Electron v32+, TypeScript, Vitest (unitaire), Playwright Electron (e2e)
**Couverture cible :** 80 %+ (lignes) — seuil configuré dans `vitest.config.ts`

> Cet audit met à jour le rapport précédent du 2026-06-12.

---

## 1. Résumé exécutif

| Indicateur                     | Avant audit | Après audit |
| ------------------------------ | ----------- | ----------- |
| Fichiers de test (`electron/`) | 5           | 7           |
| Cas de test passants           | 90          | 139         |
| Nouveaux cas ajoutés           | —           | +49         |

Deux modules critiques de l'orchestrateur, jusqu'ici sans aucun test, sont
désormais couverts à ~100 % de leurs fonctions pures.

> **⚠️ BLOQUANT OUTILLAGE — couverture chiffrée indisponible**
> `vitest.config.ts` déclare `coverage.provider: "v8"` avec un seuil
> `thresholds: { lines: 80 }`, **mais le paquet `@vitest/coverage-v8` n'est pas
> installé**. La commande `npx vitest run --coverage` échoue donc silencieusement
> (aucun rapport généré). Les pourcentages ci-dessous sont **qualitatifs**
> (estimés par analyse statique des exports testés), pas mesurés.
> **Action requise (manuelle) :** `npm i -D @vitest/coverage-v8` puis
> `npm test -- --coverage` pour obtenir le chiffre réel et faire respecter le
> seuil de 80 %.

---

## 2. Matrice de couverture par module

Légende : ✅ couvert · 🟡 partiel · ❌ absent · ⛔ non testable simplement (effets de bord Electron / réseau / port)

| Module                                  | Unitaire         | Intégration | E2E | Couverture estimée                            |
| --------------------------------------- | ---------------- | ----------- | --- | --------------------------------------------- |
| `electron/keychain.ts`                  | ✅               | —           | ❌  | ~95 %                                         |
| `electron/project-store.ts`             | ✅               | —           | ❌  | élevée                                        |
| `electron/memory-store.ts`              | ✅               | —           | ❌  | élevée                                        |
| `electron/notifications.ts`             | ✅               | 🟡          | ❌  | élevée                                        |
| `electron/orchestrator-quality.ts`      | ✅               | —           | ❌  | élevée                                        |
| `electron/orchestrator-prompts.ts`      | ✅ **(nouveau)** | —           | ❌  | ~100 % (pures)                                |
| `electron/orchestrator-iterate.ts`      | 🟡 **(nouveau)** | —           | ❌  | `buildFixTask` 100 %, `planIterationFixes` ❌ |
| `electron/orchestrator-llm.ts`          | ❌               | ❌          | ❌  | 0 %                                           |
| `electron/orchestrator-runner.ts`       | ❌               | ❌          | ❌  | 0 %                                           |
| `electron/orchestrator-backends/*.ts`   | ❌               | ❌          | ❌  | 0 %                                           |
| `electron/proxy/index.ts` (auth Bearer) | ❌               | ❌          | ❌  | 0 %                                           |
| `electron/proxy/vision.ts`              | ❌               | ❌          | ❌  | 0 %                                           |
| `electron/proxy/routes/*`               | ❌               | ❌          | ❌  | 0 %                                           |
| `electron/main.ts`                      | ❌               | ❌          | ⛔  | 0 %                                           |
| `electron/preload.ts` (contextBridge)   | ❌               | ❌          | ⛔  | 0 %                                           |
| `electron/projects/*.js` (renderer)     | ❌               | ❌          | ❌  | 0 %                                           |

---

## 3. Tests ajoutés durant cet audit

### 3.1 `electron/orchestrator-prompts.test.ts` (44 cas)

Couvre **toutes les fonctions pures** du constructeur de prompts du pipeline
multi-agents — module qui génère les messages système/utilisateur envoyés aux LLM.

| Fonction testée                                 | Scénarios couverts                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `buildDependencyContext`                        | aucune dépendance, dépendances `undefined`, id non résolu, placeholder « pas encore exécuté », troncature 60k (design) / 24k (autres) |
| `buildPlanningSystemPrompt`                     | injection instructions perso, omission si vide, présence des 5 rôles                                                                  |
| `buildPlanningUserPrompt`                       | liste id/nom/type, résolution des ids de dépendances → noms                                                                           |
| `buildNodeSystemPrompt`                         | format code-fence par défaut vs outils fichiers, règles qualité design/code, fallback type inconnu, identité custom                   |
| `buildNodeUserPrompt`                           | contrat `expected_files`, sections workspace/dépendances optionnelles, fallback tâche manquante, rappel critique                      |
| `buildContinuationPrompt`                       | compteurs de tentative, troncature du tail à 500 chars                                                                                |
| `buildCompletenessCheckPrompt`                  | format JSON strict                                                                                                                    |
| `buildIterationPrompt`                          | compteurs d'itération, description du manque                                                                                          |
| `buildVerifyPromptsSystemPrompt` / `UserPrompt` | identité custom vs fallback, sérialisation map de prompts, checklist                                                                  |
| `buildVerifyOutputUserPrompt`                   | livrable court complet, excerpt head+tail (>6000), critères par type, fallback code                                                   |
| `buildBrandCompliance*`                         | grille d'évaluation, identité fallback                                                                                                |
| `buildWorkspaceIndex*`                          | prompt analyste, upper-case du type, troncature 3000 chars                                                                            |
| `buildDecompose*`                               | règles qualité + rôle, instruction 2-à-8 étapes                                                                                       |
| `buildSubStepUserPrompt`                        | numérotation 1-based, résultats précédents                                                                                            |
| `buildSynthesis*`                               | fusion, listing des sous-étapes                                                                                                       |
| `buildIterativePlanning*`                       | guidance `assign_task`/`expected_files`, comptage agents, `finish_planning`                                                           |

### 3.2 `electron/orchestrator-iterate.test.ts` (5 cas)

Couvre `buildFixTask` — composition de la tâche corrective lors d'une boucle
d'itération déclenchée par feedback utilisateur.

- Intégration feedback + correctif
- Bloc « résultat précédent » présent / absent
- Troncature à 4000 chars (`PREVIOUS_RESULT_MAX_CHARS`)
- Présence systématique des règles critiques (« MODIFIE les fichiers existants »)

---

## 4. Tests restants à écrire (À AJOUTER MANUELLEMENT)

### Priorité HAUTE — sécurité & cœur métier

1. **Proxy Express — middleware d'authentification Bearer** (`proxy/index.ts:110-118`)
   - _Difficulté :_ la logique d'auth est interne à `startProxy()` ; ni le
     middleware ni l'app Express ne sont exportés, et `startProxy()` lie un port
     réel (9999) et démarre des sous-processus.
   - _Action recommandée :_ **refactoring de testabilité** — extraire la
     fonction middleware `requireBearer(sessionToken)` dans un module à part
     (`proxy/auth.ts`) exporté, puis tests unitaires :
     - rejet 401 sans header `Authorization`
     - rejet 401 si pas de préfixe `Bearer `
     - rejet 401 si token ≠ token de session ET ≠ `openhub-local`
     - acceptation du token de session
     - acceptation du token `openhub-local` (webview OpenWork)
     - en-têtes CORS exposés corrects
   - _Intégration (supertest) :_ requête → auth → forward → réponse. Nécessite
     `npm i -D supertest`.

2. **`orchestrator-iterate.ts` — `planIterationFixes`** (boucle de triage LLM)
   - Mocker `callLLMWithTools` ; vérifier : assignation de fix via `assign_fix`,
     épuisement de la boucle (`MAX_TRIAGE_ITERATIONS=10`) → fallback
     `fallbackAllNonSkipped`, troncature des contextes.

3. **`orchestrator-llm.ts`** — `callLLM`, `callLLMWithTools`, `callLLMStreaming`
   - Mocker `fetch` ; tester : succès, erreur HTTP, parsing des tool calls,
     agrégation du streaming, gestion réseau coupé (timeout / abort).

### Priorité MOYENNE

4. **`orchestrator-runner.ts`** (classe `OrchestratorRunner`)
   - Injecter des dépendances mockées (backends, LLM, store) ; tester
     l'orchestration : ordre de dépendances, relances, propagation d'`AbortSignal`.

5. **`orchestrator-backends/*`** — `opencode-backend.ts`, `design-backend.ts`
   - Mocker les processus enfants / HTTP ; vérifier spawn, communication, parsing.

6. **Notifications — intégration** (`notifications.ts`)
   - `createNotifier` avec `NotifierDeps` mockés : déclenchement selon `NotifyMode`
     (`always`, `never`, `background`, `other-tab`, `same-tab`) et `NotifySources`.

7. **Config cascade** (`config/templates/openhub-settings.json`)
   - Tests de parsing/validation du template et de propagation vers
     `~/.config/opencode/opencode.json`. _(Aucune fonction de parsing exportée
     identifiée — à isoler côté code si la logique n'est pas déjà extraite.)_

### Priorité — Intégration / E2E (Playwright Electron)

8. **Injection d'overrides CSS/JS** dans les WebContentsView (`insertCSS` / `executeJavaScript`).
9. **IPC main/renderer via contextBridge** (`preload.ts`) — surface minimale, pas de chemins disque.
10. **Cycle de vie e2e :** lancement → sidebar → navigation Work/Code/Design.
11. **Processus enfants :** spawn, communication, cleanup à la fermeture.
12. **Settings :** ajout/modification/suppression de clés API (via Keychain).
13. **Projets :** création, édition, exécution, chat.

### Edge cases à couvrir

- App qui ne démarre pas : **port 9999 / 4096 / 5173 occupé**, processus zombie.
- **Keychain inaccessible** (keytar rejette) — vérifier dégradation propre.
- **Réseau coupé** pendant une requête proxy (abort / timeout).
- **Override JS ciblant un sélecteur disparu** — `npm run check:selectors` +
  test que le `MutationObserver` ne crashe pas si la cible est absente.

---

## 5. Bugs détectés

Aucun bug fonctionnel détecté dans le code testé : les 49 nouveaux cas passent
sans modification du code source.

**Point d'attention outillage (non bloquant pour les tests, bloquant pour le
seuil) :** le provider de couverture `@vitest/coverage-v8` est absent alors que
`vitest.config.ts` l'exige — le seuil de 80 % n'est donc actuellement **jamais
vérifié en CI**. Voir l'encadré §1.

---

## 6. Commandes de vérification

```bash
npm test                                               # 139 cas passants
npx vitest run electron/orchestrator-prompts.test.ts   # 44 cas
npx vitest run electron/orchestrator-iterate.test.ts   # 5 cas
npm i -D @vitest/coverage-v8 && npm test -- --coverage  # (à faire) couverture réelle
```
