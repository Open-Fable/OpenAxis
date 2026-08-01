# Orchestrateur V2 — Roadmap « agent de mission autonome »

> Objectif : pouvoir donner à l'orchestrateur un objectif + un dossier cible
> (vierge **ou** base de code existante), partir 1 à 2 heures, et revenir sur un
> résultat vérifié — sans intervention, sans hallucination construite sur du
> faux, sans erreur silencieuse. Et pouvoir lui déléguer des tâches de code
> en confiance.

Document de conception validé le 2026-07-04. Référence de l'existant :
[ORCHESTRATOR.md](ORCHESTRATOR.md).

---

## 1. Principes de conception

Ces principes s'appliquent à **tous** les chantiers. Toute correction qui les
viole est à refuser en review.

1. **Corrections générales, jamais au cas par cas.** On construit des
   mécanismes (exécuter les checks du projet, contrats déclarés, mutation de
   plan), pas des détecteurs de bugs déjà rencontrés. La quality gate actuelle
   est une accumulation d'heuristiques spécifiques (placeholders, hotlinks…) —
   elles restent utiles en greenfield web, mais la V2 cesse d'en dépendre. Ce
   qui doit être spécifique reste de la **donnée** (ex : table stack →
   commandes), jamais du code de branchement.
2. **La vérité terrain avant le jugement LLM.** Principe existant (« le LLM
   n'a jamais le dernier mot »), étendu : la meilleure gate n'est pas une
   heuristique statique mais l'exécution réelle (tests, build, typecheck du
   projet cible). Un LLM ne « pense » jamais qu'une correction est bonne — il
   la prouve.
3. **L'agent ne choisit pas ses privilèges.** Pas de bash libre pour les
   agents. Les commandes exécutables sont découvertes en Phase 0 ou déclarées
   par l'utilisateur, whitelistées, et exécutées par le **moteur**, pas par
   l'agent.
4. **Jamais sur le code de l'utilisateur directement.** Tout run brownfield
   travaille sur une branche/worktree git dédiée. Échec → on jette. Succès →
   l'utilisateur merge.
5. **Savoir s'arrêter est une compétence.** Plafonds de tentatives partout ;
   au-delà, escalade avec une question précise plutôt que boucle infinie ou
   hallucination pour « continuer quand même ».

---

## 2. Les verrous actuels

| #   | Verrou                                                                                                                                           | Où dans le code                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| V1  | Le planner est aveugle : aucune exploration du dossier avant planification (`WORKSPACE_INDEX.md` démarre vide)                                   | `orchestrator-runner.ts` → `generatePlanningIterative`          |
| V2  | Aucun agent ne peut exécuter tests/build/lint : gate 100 % statique                                                                              | `orchestrator-backends/opencode-backend.ts` (bash exclu, voulu) |
| V3  | Pas de replanning en cours de run ; les cycles correctifs ne peuvent que relancer des agents existants                                           | `orchestrator-iterate.ts` (seul outil : `assign_fix`)           |
| V4  | Vérification seulement en fin de run (+ 3 boucles) : une erreur en phase 2 contamine les phases suivantes                                        | `runAutoQualityLoop`                                            |
| V5  | Itération humaine indirecte : feedback réinterprété par triage ; fallback = relancer **tous** les agents ; impossible de créer/modifier un agent | `orchestrator-iterate.ts` → `fallbackAllNonSkipped`             |
| V6  | Pas de reprise sur incident : un crash à la phase 7/10 coûte tout le run                                                                         | —                                                               |
| V7  | Sans agent `verifier`, aucune autocorrection (warning seulement)                                                                                 | `warnOnBrokenAssets`                                            |

Acquis à préserver (déjà dans le code) : workspace sur dossier existant non
vide (`resolveWorkspaceDir`), création dynamique de sous-agents au planning
(`create_sub_agent`, max 15), isolation git-worktree des backends parallèles
(`orchestrator-worktree.ts`), ownership des fichiers par agent, extraction de
fichiers robuste, module-graph gate.

---

## 3. Les chantiers

### Vague 1 — Voir et prouver _(déverrouille la délégation de code)_

**C1. Phase 0 : Reconnaissance.** Avant la planification, un node **moteur**
(pas un agent du plan) scanne le dossier cible et produit `MISSION_CONTEXT.md` :
arbre de fichiers, stack détecté, conventions observées, commandes de
vérification disponibles (scripts npm, Makefile, cargo…), état de l'existant
vis-à-vis de l'objectif. Injecté dans `generatePlanningIterative`. Effets :
`expected_files` réels au lieu d'hallucinés ; distinction
greenfield/brownfield automatique ; alimente C2.

**C2. Gate d'exécution réelle.** Canal de commandes **déclarées** (whitelist
issue de C1 ou de l'utilisateur ; jamais choisies par un agent). Le moteur les
exécute dans le workspace après chaque agent `code` et en gate finale ; run
vert ⇔ typecheck + lint + tests + build passent. Sorties d'erreur routées vers
l'agent propriétaire comme les défauts statiques actuels. La table
stack → commandes est de la donnée extensible, pas du code.

**C7. Tests comme contrat.** Le planner déclare pour chaque agent `code` un
contrat de comportement : la feature livre ses tests, C2 les exécute. Étend le
mécanisme `expected_files`/`checks` existant — même forme (déclaré au plan,
vérifié déterministiquement), nouvelle dimension.

### Vague 2 — Tenir la durée _(déverrouille le run de 2 h sans surveillance)_

**C5. Mode mission (UX + sécurité git).** Entrée : objectif + dossier cible +
niveau d'autonomie. Brownfield ⇒ branche `orch/<mission>` obligatoire
(machinerie `ensureGitBaseline`/worktrees existante). **Commit automatique
après chaque phase verte** (checkpoint). Sortie : rapport de mission = diff
complet + commandes passées/échouées + rapport de gate.

**C10. Reprise sur incident.** Grâce aux checkpoints C5 + statuts de nodes en
base : « reprendre le run » relance depuis le dernier node vert au lieu de
tout refaire. Condition nécessaire pour lancer des runs longs sereinement.

**C11. Watchdog + escalade.** (a) Node sans écriture de fichier ni sortie
depuis N minutes → kill + retry (remplace le seul timeout fixe de 15 min).
(b) Run bloqué après épuisement des tentatives → notification macOS avec
question précise et état des tentatives, au lieu d'un échec silencieux.

**C12. Verifier obligatoire en mode mission.** Si le plan n'a pas d'agent
`verifier`, le moteur l'injecte. L'autocorrection ne doit pas dépendre d'un
oubli de planning.

**C6+C4 (fusionnés). Moteur unique de mutation du plan.** Un seul mécanisme,
deux déclencheurs :

- _automatique_ — une phase épuise ses tentatives de correction, ou un agent
  remonte que le plan est invalide ;
- _humain_ — feedback d'itération.

Trois outils pour le triage/replanner (au lieu du seul `assign_fix`) :

| Outil          | Rôle                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------- |
| `assign_fix`   | Tâche corrective sur un agent existant (comportement actuel)                                  |
| `modify_agent` | Modifier la tâche / le contrat / les dépendances d'un agent existant                          |
| `create_agent` | Nouvel agent avec son propre contrat (`expected_files` + `checks`), comme au planning initial |

Règles associées : budget de mutations par run (ex. 2 replans auto) ; un agent
créé par mutation peut réclamer de nouveaux chemins (assouplissement ciblé de
la garde « no new free paths », l'ownership reste) ; **suppression du fallback
« relancer tous les agents »** — si le triage ne sait pas cibler, il demande.
Côté UI : ciblage direct (cliquer un node/fichier → le feedback devient la
`fix_task` verbatim, triage court-circuité) ; décision de triage affichée
**avant** exécution ; le DAG montre les nodes ajoutés/modifiés en cours de run.

### Vague 3 — Exceller _(vitesse, coût, dernier niveau de fiabilité)_

**C3. Gates en cascade (par phase).** Mini-gate après chaque node, avant de
débloquer ses dépendants : contrats + checks + module-graph sur les fichiers
touchés + typecheck rapide si code. 2-3 tentatives puis phase bloquée →
escalade C11. Les boucles globales actuelles restent en filet final.

**C8. Revue de diff avant livraison.** Pass LLM de code-review sur **le diff
du run** (pas le repo entier) : logique, cas limites, cohérence avec le code
environnant. Rapport routé vers les agents propriétaires.

**C9. Contrats d'interface en amont.** Le planner déclare les interfaces
partagées (signatures, types, schémas) dans un fichier contrat que chaque
agent `code` reçoit comme contrainte. On passe de « détecter le désaccord »
(module-graph, a posteriori) à « le rendre impossible » (a priori).

**C13. Modèle par rôle.** Défauts intelligents : meilleur modèle pour
planning/triage/vérification, modèle rapide pour l'exécution mécanique.
S'appuie sur l'existant (`adaptToWeakModel`, modèle par agent).

**C14. Cache + parallélisme.** Stabiliser les préfixes de prompts du runner
(~80 % de cache hit aujourd'hui vs ~99 % ailleurs). Worktrees systématiques
(C5) ⇒ agents `code` parallèles par défaut au lieu du lane-split sériel.

---

## 4. Ordre d'exécution recommandé

```
C1 (Reconnaissance)
 → C2 (Gate d'exécution)
  → C5 (Mode mission / checkpoints git)
   → C6+C4 (Mutation du plan : itération + replanning)
    → C7 (Tests comme contrat)
     → C10, C11, C12 (Resume, watchdog, verifier obligatoire)
      → C3, C8, C9, C13, C14 (au jugé, après retour d'usage)
```

C1 + C2 portent ~80 % de la valeur : un planner qui voit le projet et une gate
qui exécute les vrais tests suffisent à transformer « je n'ose pas lui
déléguer du code » en « je lui donne un plan en 10 étapes et je pars ».
La vague 3 n'est engagée **que** si l'usage réel des vagues 1-2 le justifie
(YAGNI).

---

## 5. Critères d'acceptation globaux

- [ ] Un run brownfield sur un repo TypeScript réel : Phase 0 détecte stack et
      commandes, le plan référence des fichiers existants réels, la gate
      exécute les tests du repo, le run livre sur une branche `orch/*`.
- [ ] Tuer l'app à mi-run puis « reprendre » : le run repart du dernier
      checkpoint sans refaire les phases vertes.
- [ ] Feedback « ajoute une fonctionnalité absente du plan initial » : le
      moteur de mutation **crée** un agent, ne force pas la tâche dans un
      agent existant, et n'a jamais relancé tous les agents.
- [ ] Une phase qui échoue 3 fois produit une notification avec question
      précise — pas de boucle infinie, pas d'échec silencieux.
- [ ] Aucun nouveau détecteur au cas par cas ajouté pour faire passer un test.
