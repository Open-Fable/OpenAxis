[English](ORCHESTRATOR.md) · **Français**

# OpenAxis — L'orchestrateur multi-agents

> L'orchestrateur est un **assistant interactif** qui transforme un objectif en
> langage courant en un workflow multi-agents. Tu décris ce que tu veux — il
> planifie le travail sous forme de DAG visuel, assigne les agents, les exécute,
> vérifie le résultat et s'auto-corrige. Tu gardes le contrôle sans avoir à
> comprendre le moteur en dessous.

> Référence technique ci-dessous. Comment un objectif devient un graphe d'agents
> IA qui produisent un livrable (site web, librairie de code, rapport, ebook,
> slides...), et comment le système attrape les défauts structurels au lieu de
> faire confiance au modèle.

Ce document s'adresse aux contributeurs et utilisateurs avancés. Pour l'usage quotidien, voir
comprendre le moteur. Pour l'usage quotidien, voir
[USAGE](USAGE.fr.md#4-lorchestrateur-multi-agents). Le code vit dans
`electron/orchestrator-runner.ts` (moteur), `electron/orchestrator-quality.ts`
(quality gate déterministe), `electron/orchestrator-prompts.ts` (prompts & règles),
`electron/orchestrator-backends/` (backends natifs) et
`electron/orchestrator-iterate.ts` (triage correctif).

---

## 1. Modèle mental

L'orchestrateur est un **DAG d'agents**. Chaque agent est un `Project` avec un rôle
(`type`), une tâche et une liste de dépendances. Un projet coordinateur de type
`orchestrator` les relie. Un run :

1. **planifie** — décompose l'objectif global en tâches par agent, en créant au besoin
   des sous-agents et en déclarant un contrat de fichiers pour chacun ;
2. **exécute** — lance chaque agent dans l'ordre des dépendances, injecte les résultats
   amont en aval, écrit les fichiers dans un **workspace** partagé ;
3. **vérifie** — lance un quality gate déterministe (aucun LLM nécessaire pour attraper
   les défauts structurels) plus un vérificateur LLM optionnel ;
4. **s'auto-corrige** — quand le gate échoue, il relance uniquement les agents
   propriétaires des livrables cassés, puis ré-audite.

Le principe directeur : **le LLM n'a jamais le dernier mot sur la correction du
livrable.** Les défauts structurels (imports cassés, fichiers manquants, code mort,
liens d'assets cassés, prix incohérents, pages non stylées…) sont détectés par du code
déterministe et forcent un échec, quoi qu'en dise le modèle vérificateur.

---

## 2. Types et rôles d'agents

Six valeurs de `type` existent (`project-store.ts`). Chacune mappe vers un backend et
un jeu de règles qualité (`orchestrator-prompts.ts`) :

| Type           | Backend            | Rôle                                                                                                                                                 |
| -------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recherche`    | aucun (LLM pur)    | Investigation, collecte de données, état de l'art, documents/plans/recommandations de synthèse.                                                      |
| `work`         | aucun (LLM pur)    | Contenu & assets : rédaction, données structurées (.md/.json/.csv), **et le design system / palette / typographie / charte graphique** d'un site.    |
| `design`       | daemon Open Design | Maquettes web visuelles (HTML/CSS) **uniquement**, et seulement si le livrable a une UI. Il _reçoit_ le design system de work — il ne l'invente pas. |
| `code`         | serveur OpenCode   | Le livrable fonctionnel : app, librairie, API, CLI, scripts. Reproduit fidèlement les maquettes quand elles existent.                                |
| `verifier`     | aucun (LLM pur)    | QA / tests. **Rapport seulement** — ne réécrit jamais les fichiers d'un autre agent ; l'orchestrateur route les corrections vers le propriétaire.    |
| `orchestrator` | —                  | Le nœud coordinateur lui-même. Lance les prompts de planification ; pas un agent exécutable.                                                         |

« LLM pur » est un **chemin d'exécution**, pas un type : tout nœud sans backend à
outils (`work`, `recherche`, `verifier`) passe par le chemin LLM direct et n'a pas
d'accès disque propre — le moteur injecte donc le contenu réel sur disque de ses
dépendances comme preuve (voir §7). Les types inconnus retombent sur les règles `code`.

---

## 3. Le modèle de données projet / nœud

Les nœuds orchestrateur et les agents partagent un seul type `Project`
(`project-store.ts`). Les champs pertinents pour l'orchestration :

| Champ          | Signification                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `type`         | Rôle de l'agent (voir §2). Pilote le backend, les règles qualité, les mandats de dépendance.    |
| `instructions` | Le persona / en-tête système de l'agent.                                                        |
| `task`         | Le texte concret de la tâche, injecté comme `TÂCHE:` dans le prompt du nœud.                    |
| `steps`        | Sous-étapes définies manuellement (utilisées si ≥ 2).                                           |
| `autoSteps`    | Décompose automatiquement la tâche en sous-étapes au runtime.                                   |
| `dependencies` | Ids des nœuds amont — les arêtes du DAG. Pilote l'ordre d'exécution et l'injection de contexte. |
| `linked`       | Pour un orchestrateur : les ids des agents qu'il coordonne.                                     |
| `orchSettings` | `{ autoDistribute, checkCoherence, relaunchOnError, adaptToWeakModel? }` (ci-dessous).          |
| `bypassMemory` | Ne pas injecter la mémoire pour ce nœud.                                                        |
| `maxRetries`   | Budget de retries du nœud (borné — voir §10).                                                   |
| `model`        | Override de modèle pour ce nœud.                                                                |
| `generated`    | Marque un sous-agent auto-créé.                                                                 |

**`orchSettings` :**

- `autoDistribute` — lance le planificateur itératif pour auto-assigner les tâches
  (§5). Si désactivé, la `task` pré-configurée de chaque agent est utilisée telle quelle.
- `checkCoherence` — active le vérificateur de prompts pré-exécution (consultatif) et la
  vérification finale marque/spec (consultative).
- `relaunchOnError` — flag historique ; la boucle qualité automatique tourne désormais
  dès qu'un agent vérificateur existe, indépendamment de ce flag.
- `adaptToWeakModel` — sélectionne le profil **tier faible** (plus d'itérations,
  décomposition forcée, prompts compacts) pour les modèles moins capables.

Les projets sont stockés dans `~/.config/openaxis/projects.json` (écriture atomique +
verrou d'écriture). L'historique des runs vit dans `~/.config/openaxis/orch-history.json`,
plafonné à 50 runs.

---

## 4. Cycle de vie d'un run

Point d'entrée : `OrchestratorRunner.run(orchestratorId, task, workDir?, workflowName?)`.
Il refuse les runs concurrents, met en place un `AbortController`, et nettoie toujours
son état dans un `finally`. Les phases, dans l'ordre :

**Phase 0 — Setup & validation.** Charger les projets, confirmer que la cible est un
`orchestrator`, résoudre le **workspace** (premier candidat absolu _et sûr_ parmi
`workDir` → `orchestrator.path` → workspace actif ; sinon `~/_orch/<nom>`).
`isSafeWorkspaceDir` bloque `/`, `$HOME`, les préfixes système et les sous-dossiers home
sensibles. Seeder `WORKSPACE_INDEX.md`. Résoudre le modèle de repli (**échec immédiat si
aucun modèle n'est configuré nulle part**) et le profil de tier.

**Phase 1 — Planification.** Si `autoDistribute`, lancer `generatePlanningIterative`
(§5), persister les tâches/sous-agents générés sur disque. Sinon, utiliser la tâche
existante de chaque agent.

**Phase 2 — Vérificateur de prompts (consultatif).** Si `checkCoherence` et qu'un
vérificateur existe, `verifyPrompts` examine la qualité des tâches. Ne bloque jamais —
émet seulement des avertissements.

**Phase 3 — Résolution du DAG.** `resolveDAG` calcule un ordre topologique (DFS avec
détection de cycle ; lève une erreur sur dépendance circulaire).

**Phase 4 — Exécution.** `executeNodesSequence` (le chemin actif) exécute les nœuds un
par un dans l'ordre du DAG, en sautant tout nœud dont une dépendance a échoué ou été
sautée.

**Phase 5 — Vérification marque/spec (consultative).** Si aucune erreur et
`checkCoherence`, `verifyBrandCompliance` tourne. Non bloquant.

**Phase 6 — Boucle qualité ou avertissement sans-vérificateur.** Si aucune erreur
d'exécution : avec un agent vérificateur → `runAutoQualityLoop` (§9) ; sans →
`warnOnBrokenAssets` (§11).

**Phase 7 — Statut final.** Recalculer à partir des statuts par nœud, émettre `done` ou
`error`.

Un second point d'entrée, `iterate(orchestratorId, feedback, previousRun, …)`, gère les
relances sur feedback humain en résolvant le workspace existant et en déléguant à
`runCorrectiveCycle` (§10).

---

## 5. Planification itérative

`generatePlanningIterative` est une **boucle agentique à appels d'outils** (jusqu'à
`MAX_PLANNING_ITERATIONS = 20` tours), pas un one-shot. Le modèle planificateur dispose
de trois outils :

- **`assign_task`** — assigne une tâche à un agent, avec :
  - `steps[]` — sous-étapes optionnelles (acceptées seulement si ≥ 2, plafonnées à
    `MAX_SUBSTEPS = 8`) ;
  - `depends_on[]` — arêtes du DAG (résolues par id, par nom, ou par match flou
    préfixé du parent, puis persistées sur disque) ;
  - **`expected_files[]`** — le **contrat de livrables** (voir ci-dessous) ;
  - **`checks{}`** — contraintes par fichier vérifiables par machine (voir ci-dessous).
- **`create_sub_agent`** — crée un nouvel agent (`work|code|recherche|design`) sous un
  parent, plafonné à `MAX_SUB_AGENTS = 15`. Persisté comme projet généré nommé
  `"<parent> › <sous-agent>"`.
- **`finish_planning`** — termine la planification (refusé tant qu'un agent lié n'a pas
  de tâche).

Si le modèle répond en prose au lieu d'appeler des outils au premier tour, un repli JSON
parse `{agentId|name: task}` ; en dernier recours, la tâche globale est assignée à chaque
agent. Après la boucle, tout agent encore non assigné reçoit la tâche globale.

Il n'y a **aucun déclencheur de re-planification séparé** — le raffinement se fait via le
cycle correctif (§10), pas en relançant le planificateur.

### Les deux contrats déclarés par le planificateur

**`expected_files`** — le contrat de fichiers strict. Un fichier déclaré mais manquant à
la fin = tâche échouée = relance automatique. Les chemins sont assainis (≤ 50 entrées,
≤ 200 caractères, pas d'absolu/`..`/dotfile/octet nul). Un chemin canonique par livrable
logique ; les fichiers partagés sont produits une fois et référencés via `depends_on`,
jamais copiés.

**`checks`** — contraintes par fichier vérifiables par machine, indexées par chemin
relatif au workspace :

| Contrainte           | Signification                                                           |
| -------------------- | ----------------------------------------------------------------------- |
| `minWords`           | Nombre de mots minimum.                                                 |
| `minItems`           | Longueur de tableau minimum (JSON top-level ou `.items`).               |
| `minSections`        | Nombre de titres `##`/`###` minimum.                                    |
| `requiredSubstrings` | Sous-chaînes devant apparaître (insensible à la casse).                 |
| `format`             | `json` (doit parser) / `csv` (colonnes cohérentes) / `md` (a un titre). |

Elles sont **appliquées de façon déterministe — le LLM ne les juge jamais.** Les entrées
sont assainies et bornées (ex. `minWords` ≤ 100000), et les clés passent par le même
assainisseur de chemins pour qu'une clé hallucinée ne devienne jamais un oracle de
système de fichiers.

---

## 6. Exécution d'un nœud

`runOneNode` enveloppe chaque nœud : il dérive les fichiers attendus du nœud et un
« plancher » de checks par fichier (les livrables prose `.md`/`.txt` reçoivent un
`minWords` plancher par défaut de `PROSE_FLOOR_WORDS = 400` sauf déclaration contraire),
installe un **filtre de chemins** qui scope chaque écriture à ce nœud (§8), puis appelle
`executeNode`.

`executeNode` choisit la stratégie :

- **Dispatch backend.** Si le nœud a un backend (`code` → OpenCode, `design` →
  Open Design), il s'assure que le process tourne et appelle le backend. Sur
  `BackendUnavailableError` (port éteint) ou toute erreur non-abort, il **retombe sur le
  chemin LLM** avec un avertissement.
- **Chemin LLM pur** (`work`/`recherche`/`verifier`, et tout repli). Routage, par ordre
  de priorité :
  1. `steps` prédéfinies (≥ 2) → exécution étape par étape ;
  2. `autoSteps` → décomposition LLM au runtime en étapes ;
  3. tier faible + grosse tâche → décomposition forcée ;
  4. types multi-tours (`work`, `code`) → `executeMultiTurn` ;
  5. sinon → un appel unique (avec retries limités).

**Exécution multi-tours** (`executeMultiTurn`). Un « tour » est un appel LLM en streaming
plus un appel séparé de vérification de complétude. Après chaque tour, les fichiers émis
sont écrits. La boucle s'arrête quand la vérification de complétude renvoie `complete`
**et** que le nombre de mots atteint le `minWords` déclaré — un **gate de volume**
maintient l'agent en train de développer le contenu même si le modèle se déclare fini
prématurément. Plafond dur de tours selon le tier : **6 (fort) / 10 (faible)**.

**Sous-étapes.** Quand une tâche est décomposée, les types producteurs (`work`/`code`)
exécutent chaque étape en multi-tours sans synthèse ; les types non-producteurs
exécutent chaque étape une fois, puis une **passe de synthèse** fusionne les étapes en un
livrable. La décomposition demande au modèle un tableau JSON de 2 à 8 étapes, avec repli
sur une seule étape en cas d'échec de parsing.

**Tiers.** `adaptToWeakModel` sélectionne `WEAK_TIER` vs `STRONG_TIER`, contrôlant les
prompts compacts, le max d'itérations (6 vs 10), le max d'itérations de sous-étape (4 vs 6) et la décomposition forcée. En tier faible, les appels backend reçoivent une directive
supplémentaire puisqu'un backend fait un seul `execute()` (l'axe itératif ne s'applique
pas à lui).

---

## 7. Backends

Les deux backends implémentent `ExecutionBackend` (`orchestrator-backends/types.ts`) : un
`slot`, un `apiPort`, `isAvailable()`, et `execute(ctx)`. Le contexte porte le nœud, le
workspace, les prompts, le modèle, le signal d'abort, un callback de progression, et
**`otherOwnedPaths`** — les chemins possédés par d'autres agents, à interdire en
écriture. Le résultat rapporte `resultText`, `filesWritten` et les vrais `writtenPaths` —
ainsi un nœud qui a écrit de vrais fichiers mais renvoyé un résumé laconique
(« Créé 6 fichiers ») n'est **pas** jugé trivial ni relancé via le LLM, ce qui écraserait
les fichiers écrits par les outils.

**Backend OpenCode** (slot `code`/`work` → `127.0.0.1:4096`). Il prend un instantané des
mtimes des fichiers du workspace, ouvre une session avec un **jeu de permissions**, envoie
le prompt (timeout 15 min), puis diffe l'instantané pour savoir ce qui a été écrit.
Conception des permissions : un **deny** attrape-tout en premier, puis des allows
`write`/`read`/`edit` scopés au workspace, puis des **denies par chemin pour chaque
fichier possédé par un autre agent** (l'ordre last-match-wins applique l'ownership).
**`bash` est volontairement exclu** — write/edit suffisent et le shell laisserait le
modèle lancer des commandes arbitraires. Un **garde-fou plan-only** détecte les réponses
« voici mon plan » qui n'ont écrit aucun fichier et pousse jusqu'à 2 relances
« arrête de planifier, produis maintenant ».

**Backend Open Design** (slot `design` → daemon sur `127.0.0.1:7456`). Il trouve/crée un
projet, puis lance une **boucle de raffinement itératif** (jusqu'à 3 itérations, avec des
budgets de temps premier-run / raffinement / total). Après chaque run il exporte les
artefacts dans `workspace/design/<id>/`, **en ignorant les symlinks** par sécurité, et
raffine quand le contenu est trop maigre ou contient des placeholders. Les maquettes sont
à la fois écrites sur disque **et** inlinées dans `resultText` comme blocs `filepath:`,
pour que les agents aval puissent les lire directement.

---

## 8. Contexte de dépendances & ownership des fichiers

### Injection des résultats amont en aval

`buildDependencyContext` passe les résultats des agents précédents à un nœud aval. Pour
chaque dépendance il émet `Agent "<nom>" (<type>) — Tâche — Résultat`. Budgets : les
dépendances design reçoivent 60 000 caractères, les autres 24 000, avec un plafond global
de 96 000 ; une fois le budget épuisé, les dépendances restantes sont seulement nommées.
Les dépendances pas encore exécutées affichent `(pas encore exécuté)`.

Pour le chemin LLM pur, le moteur injecte aussi des **preuves disque** — le contenu réel
sur disque des `expected_files` de chaque dépendance, marqué comme _faisant autorité_ —
car ces nœuds n'ont pas d'outils pour lire le workspace eux-mêmes.

Des **mandats de fidélité** ne sont ajoutés que lorsque le nœud _reproduit_ le travail
amont (`code`/`work`) :

- si une dépendance est un agent `design` ou a produit du `.html`/`.css` → un **mandat
  web** strict : reproduire chaque maquette au pixel près, coder toutes les pages, zéro
  lien mort, noms de classes et images identiques, garder le nom de fichier CSS ;
- sinon si une dépendance est `design`/`work`/`recherche` → un **mandat neutre** :
  réutiliser fidèlement les contrats/schémas/noms/données amont, résoudre les
  contradictions vers une seule version.

Une **politique d'assets** partagée est intégrée dans les règles code/design/work — le
plus gros correctif pour les rendus cassés : **interdire les URLs d'images externes**
(unsplash/picsum 404 au déploiement → utiliser du SVG inline), exactement un `styles.css`
dans le même dossier que les pages, chaque `href`/`src` local doit pointer vers un vrai
fichier.

### Le modèle d'ownership (verrou d'écriture par agent)

Chaque écriture passe par un **filtre de chemins** par nœud :

- Les **chemins partagés** (`WORKSPACE_INDEX.md`, `reports/*`) sont toujours
  inscriptibles.
- Les **`expected_files` déclarés** propres au nœud sont toujours inscriptibles.
- Un chemin **possédé par un autre nœud est refusé** — le premier nœud à écrire un chemin
  non partagé le réclame (map `fileOwner`). Ça empêche les agents du cycle correctif
  (surtout recherche/design) d'écraser les livrables des autres.
- Un chemin libre, non possédé, n'est inscriptible **qu'au premier run**. À une relance,
  un nœud peut réécrire ses propres fichiers mais **ne peut pas créer de nouveaux chemins
  libres** — ça empêche les sites `public/` parasites d'apparaître pendant les
  corrections.

Les backends reçoivent en plus les chemins possédés par chaque autre agent comme règles
`deny` strictes, et rapportent leurs `writtenPaths` pour que l'extracteur de fichiers les
saute au lieu de les écraser.

### Extraction de fichiers

Les agents sur le chemin LLM émettent les fichiers comme blocs clôturés avec un marqueur
**`filepath:` obligatoire** :

````
```python filepath: src/api/auth.py
<contenu du fichier>
```
````

`extractAndWriteFiles` lance trois parsers (la forme primaire `filepath:`, une forme
`**Fichier: `chemin`**`, et des commentaires inline `// filepath:`), dédupliqués pour que
les formats mélangés ne soient pas perdus. La clôture est trouvée en scannant **en
arrière** depuis l'ouvreur suivant, donc un fichier dont le contenu contient ses propres

```(ex. un README avec des exemples de code) n'est **pas tronqué**. Les écritures sont
plafonnées (`MAX_WRITTEN_FILES = 200`, `MAX_FILE_BYTES = 5 Mio`), validées en chemin, et
contenues lexicalement + symlink dans le workspace avant d'atteindre le disque.

---

## 9. Le quality gate

`runQualityGate` est une passe d'audit qui combine des **détecteurs déterministes** (sans
LLM) avec un **vérificateur LLM**, et les fusionne **fail-closed** :

```

pass = llmVerdict !== null && llmVerdict.pass === true && deterministicIssues.length === 0

```

Donc : un verdict LLM non parsable **bloque** (avant il passait), et tout défaut
déterministe force un échec **quel que soit le jugement du modèle**. Les problèmes sont
attribués à l'**agent propriétaire** (via la map `expected_files`) pour que les
corrections aillent vers qui a produit le fichier cassé. La liste fusionnée est plafonnée
à 30.

### Détecteurs déterministes (force-fail)

Tous tournent en analyse statique pure dans le process principal — aucun code n'est
exécuté :

- **Refs d'assets cassées** — `src`/`href`/`url()` pointant vers des fichiers inexistants ;
  hotlinks placeholder (unsplash, picsum, placehold.co…) marqués cassés.
- **Maquettes non codées** — une page `mockups/` sans contrepartie codée ailleurs.
- **Problèmes de site servi** — placeholders gris `data:image/svg+xml` ; refs/imports en
  `../` qui sortent de la racine servie (cassés au déploiement).
- **Cohérence CSS** — plusieurs pages ne partageant aucune feuille de style commune.
- **JSON invalide** — chaque `.json` (sauf `*.artifact.json`) doit parser.
- **Colonnes CSV** — chaque ligne doit correspondre au nombre de colonnes de l'en-tête.
- **Livrables placeholder** — `lorem ipsum`, `[à compléter]`, `coming soon`, `todo:`
  (avec garde de densité pour épargner une mention isolée dans un long doc).
- **Rétrécissement de consolidation** — un fichier « final/complet » plus court que 80 %
  de son contenu source (résumé au lieu de consolidé).
- **Classes non stylées** — pages où ≥ 3 classes et ≥ 30 % des classes utilisées n'ont
  aucune règle CSS (pages à framework CDN exceptées).
- **Placeholders HTML servis** — texte de remplissage visible ou conteneurs
  `class="...placeholder..."` (pas l'attribut légitime `<input placeholder>`).
- **Incohérence de données structurées** — un `price` JSON-LD absent du texte visible de
  la page (avec gardes de frontière de nombre pour que `14` ne matche pas dans `114`).
- **Feuilles/scripts orphelins** — assets sous une racine servie qu'aucun HTML ne
  référence, directement ou via une chaîne d'`@import`.
- **Validation des checks déclarés** — applique le contrat `checks` du planificateur (§5).
- **Gate du graphe de modules** — voir ci-dessous.

Un second jeu de détecteurs **avertissement seulement** (modules non référencés,
duplicatas divergents/dispersés, scaffolding web indésirable, artefacts design inutiles,
problèmes de rendu headless) tourne **uniquement** dans le chemin sans-vérificateur
(§11), car ils ont un taux de faux positifs plus élevé et ne doivent pas faire échouer un
run.

### Le gate du graphe de modules

`findModuleGraphProblems` cible le mode d'échec multi-agent n°1 : **des API qui ne
s'alignent pas entre fichiers écrits par différents agents** — invisible pour un LLM qui
juge du texte et pour les checks par fichier. Il parse statiquement Python et TS/JS en un
graphe de modules d'exports et d'imports (sans exécution), résout les arêtes d'import
local, et signale :

- **API inter-agents incohérente** — le fichier A importe `sort_data` depuis le module B,
  mais B n'exporte que `DataSorter`. Le livrable ne s'importera même pas → force-fail.
  (Les ré-exports wildcard suppriment le check, car l'ensemble des noms exportés est
  indémontrable.)
- **Code orphelin / mort** — un module qui exporte des symboles mais n'est jamais importé
  par aucun autre fichier = une sortie d'agent jamais intégrée. Conservateur : ne tourne
  qu'à partir de ≥ 3 fichiers, et saute les points d'entrée
  (`index`/`main`/`app`/`server`/`cli`…), les tests et `dist`/`build`.

C'est ce qui attrape le classique « deux agents, deux API incompatibles, livré cassé »
qu'un vérificateur optimiste laisserait passer.

### Fail-closed partout

L'extracteur JSON renvoie `null` (→ blocage) plutôt que de deviner quand il n'y a pas
d'objet valide ; les fichiers illisibles sont sautés ; les gardes de containment refusent
même de `stat` les chemins qui sortent du workspace. Les plafonds de détecteurs ne
tronquent que la *liste des problèmes rapportés* — une liste plafonnée et non vide
force-fail toujours ; atteindre un plafond n'est jamais confondu avec « tout va bien ».

---

## 10. Cycle correctif & retries

`runAutoQualityLoop` tourne jusqu'à `MAX_AUTO_QUALITY_LOOPS = 2` cycles. Chaque cycle
appelle `runQualityGate` ; sur un pass il retourne. Sur un échec il formate les problèmes
en `- [agent] problème → correctif`, construit un run synthétique, et appelle
`runCorrectiveCycle` :

- `planIterationFixes` (triage LLM) mappe le feedback vers des ids d'agents précis ; s'il
  ne cible personne, il lève une erreur.
- Chaque agent ciblé reçoit une tâche de correction réécrite et est ré-exécuté **à
  travers le DAG** (uniquement le sous-ensemble ciblé), avec les résultats précédents
  pré-chargés pour que les nœuds non ciblés gardent leur sortie.
- Les résultats fusionnent en retour, et la boucle ré-audite.

Le même `runCorrectiveCycle` alimente le point d'entrée `iterate()` à feedback humain.

**Sémantique des retries & bornes :**

- Retries LLM par nœud : `clampRetries(n) = min(max(n ?? 3, 1), MAX_NODE_RETRIES = 5)`,
  ne relançant que sur timeout de watchdog.
- Retries d'enforcement de livrables : `min(max(maxRetries ?? 2, 1), 5)` — relance avec un
  prompt fichiers-manquants / contenu-insuffisant / résultat-trivial selon l'échec.
- L'enforcement est **non bloquant sauf si le résultat initial était trivial**
  (`< MIN_RESULT_CHARS = 200`) : un fichier manquant devient normalement un avertissement,
  mais un résultat trivial lève une erreur (nœud → error).

---

## 11. Le chemin sans-vérificateur

Si l'orchestration n'a pas d'agent `verifier`, le run ne peut pas s'auto-corriger — donc
au lieu d'une boucle de correction, `warnOnBrokenAssets` lance la suite **complète** de
détecteurs (y compris ceux en avertissement-seulement et un check de rendu headless
optionnel) et fait remonter un **unique avertissement non bloquant** résumant ce qui est
cassé. Il ne fait jamais échouer le run et ne déclenche jamais de relance — il s'assure
juste qu'un build silencieusement cassé n'ait pas l'air d'un succès. Ajoute un agent
vérificateur pour transformer ça en vraie boucle auto-corrective.

---

## 12. Référence des constantes

| Constante                         | Valeur  | Signification                                            |
| --------------------------------- | ------- | ------------------------------------------------------- |
| `MAX_PLANNING_ITERATIONS`         | 20      | Tours d'appels d'outils pendant la planification.        |
| `MAX_SUB_AGENTS`                  | 15      | Sous-agents créés par le planificateur.                  |
| `MAX_SUBSTEPS`                    | 8       | Sous-étapes par nœud.                                    |
| `MAX_PARALLEL_NODES`              | 1       | Concurrence — actuellement strictement séquentiel.       |
| Itérations `STRONG_TIER`          | 6 / 4   | Itérations multi-tours / sous-étape (modèles capables).  |
| Itérations `WEAK_TIER`            | 10 / 6  | Itérations multi-tours / sous-étape (modèles faibles).   |
| `MAX_NODE_RETRIES`                | 5       | Plafond dur des retries LLM par nœud (défaut 3).         |
| `MAX_RETRIES_CEILING` (enforce)   | 5       | Plafond des retries d'enforcement (défaut 2).            |
| `MAX_AUTO_QUALITY_LOOPS`          | 2       | Cycles d'auto-correction.                                |
| `MAX_WRITTEN_FILES`               | 200     | Fichiers par appel d'extraction.                         |
| `MAX_FILE_BYTES`                  | 5 Mio   | Plafond d'écriture par fichier.                          |
| `PROSE_FLOOR_WORDS`               | 400     | Plancher `minWords` par défaut pour livrables prose.     |
| `MIN_RESULT_CHARS`                | 200     | Seuil de trivialité.                                     |
| Plafonds de contexte dépendances  | 24k / 60k / 96k | Par-dépendance (autre / design) et budget global. |

> Note : avec `MAX_PARALLEL_NODES = 1`, l'exécuteur parallèle « par vagues » et son tri
> topologique de Kahn existent dans le code mais sont dormants — l'exécution est
> séquentielle en pratique.

---

## 13. Exemple concret — les projets seed

Une installation fraîche seed une orchestration de démo (« Refonte onboarding »,
`project-seed.ts`) :

- **p1** `code` — API Auth (OAuth2 + refresh tokens)
- **p2** `design` — Design system (boutons & inputs)
- **p3** `work` — Pipeline CI/CD
- **p4** `orchestrator` — coordinateur, `linked: [p1,p2,p3,p5]`,
  `orchSettings: { autoDistribute, checkCoherence, relaunchOnError }`
- **p5** `code` — Tests E2E Playwright, `dependencies: [p1]`
- **p6** `verifier` — QA globale, `dependencies: [p1,p2,p3,p5]`, `bypassMemory`

C'est un DAG concret : un coordinateur au-dessus d'un backend code, d'un backend design,
d'un agent work/LLM-pur, d'un agent code dépendant (p5 → p1) et d'un vérificateur en
fan-in (p6 au-dessus de tous les producteurs). C'est le moyen le plus rapide de voir le
cycle complet planifier → exécuter → vérifier → auto-corriger en action.

---

Voir aussi : [Architecture](../ARCHITECTURE.fr.md) · [Usage](USAGE.fr.md) · [FAQ](FAQ.fr.md)
```
