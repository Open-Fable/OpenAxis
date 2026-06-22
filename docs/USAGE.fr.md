[English](USAGE.md) · **Français**

# OpenHub — Guide d'usage

Ce guide explique comment se servir d'OpenHub au quotidien, une fois l'app
installée (voir [README](../README.fr.md#installation) pour l'installation).

> OpenHub est un shell : il emballe OpenWork, OpenCode et Open Design dans une seule
> fenêtre, ajoute un chat et un orchestrateur par-dessus, et route tout via un seul
> proxy LLM. Tu saisis tes clés API une fois et les cinq slots les partagent.

---

## 1. La sidebar

Toute la navigation passe par la barre latérale gauche. Chaque icône ouvre une vue
isolée dont l'état est conservé quand tu changes de slot.

| Slot              | Rôle                                                                | Raccourci |
| ----------------- | ------------------------------------------------------------------- | --------- |
| **Chat**          | Chat intégré façon Claude (modèles, historique, recherche web)      | ⌘1        |
| **Code**          | OpenCode — agent de code (lit/écrit des fichiers, exécute des cmds) | ⌘2        |
| **Work**          | OpenWork — orchestration et travail structuré                       | ⌘3        |
| **Design**        | Open Design — maquettes visuelles (HTML/CSS/SVG)                    | ⌘4        |
| **Orchestrateur** | Hub des projets + lancement des workflows multi-agents              | ⌘5        |
| **Config** ⚙️     | Clés API, modèles, mémoire, mises à jour, notifications, cache      | —         |

Sur petit écran, la barre d'onglets bascule automatiquement en menu déroulant
(réglable dans **Config → Updates → mode de navigation**).

---

## 2. Le chat intégré

Ouvre le slot **Chat** (⌘1).

- **Choisir un modèle** : clique sur la pastille de modèle en bas de la zone de
  saisie. Le menu liste les modèles disponibles via le proxy — cloud (Anthropic,
  OpenAI, OpenRouter), local (Ollama) et modèles de workflow.
- **Effort de raisonnement** : pour les modèles qui le supportent, l'effort
  (minimal → max) est mémorisé par modèle.
- **Pièces jointes** : bouton **+** → images (PNG/JPEG/GIF/WebP) ou fichiers texte.
- **Recherche web** : active la case **Web Search** dans le menu **+** ; le proxy
  enrichit alors le contexte avec des résultats de recherche.
- **Contexte projet** : depuis le menu **+**, lie un projet pour injecter ses
  instructions personnalisées dans la conversation.
- **Historique** : chaque conversation est sauvegardée automatiquement (et
  sauvegardée sur disque en plus du stockage local). Les conversations peuvent être
  épinglées pour rester en haut de la liste.

---

## 3. Projets

Un **projet** regroupe des instructions, un type, un modèle préféré et un contexte.
Les projets se gèrent depuis le slot **Orchestrateur**.

Deux familles de projets :

### Projets autonomes (`code`, `design`, `work`)

Liés à un seul outil (OpenCode / Open Design / OpenWork). Tu ouvres l'outil
correspondant et ses **instructions** sont injectées dans le contexte IA. Un projet
autonome peut aussi servir de brique dans un workflow d'orchestration.

### Projets orchestrateur (`orchestrator`)

Ils ne s'exécutent pas seuls : ils **coordonnent plusieurs agents**. Un projet
orchestrateur définit :

- une **tâche** (`task`) : l'objectif global, écrit en langage naturel ;
- des **dépendances** : les agents (projets) à enchaîner ;
- des **réglages** (`orchSettings`) : auto-distribution, vérification de cohérence,
  relance en cas d'erreur, adaptation aux modèles faibles.

Les projets sont stockés dans `~/.config/openhub/projects.json`. Les instructions
d'un projet sont préfixées au prompt système des appels concernés (sauf si la
mémoire est explicitement contournée pour ce projet).

---

## 4. L'orchestrateur multi-agents

Décompose un objectif en un DAG d'agents qui produisent ensemble un livrable (site,
rapport, ebook, librairie de code, slides...).

**Lancer un workflow :**

1. Ouvre le slot **Orchestrateur** (⌘5).
2. Crée/sélectionne un projet de type `orchestrator`.
3. Écris l'objectif dans le champ **tâche**, choisis les agents (dépendances) et les
   réglages.
4. Lance l'exécution.

**Ce qui se passe ensuite :**

- **Planification** — un modèle décompose la tâche en sous-étapes (plusieurs
  itérations de planification possibles).
- **Exécution** — chaque agent s'exécute via le bon backend selon son type :
  - `code` → OpenCode (vraies commandes CLI, accès fichiers),
  - `design` → Open Design (maquettes HTML/CSS/SVG),
  - `work` → OpenWork (données structurées, documents),
  - agent LLM pur → appel direct au modèle avec injection de contexte,
  - `verifier` / `recherche` → agents de contrôle qualité / recherche.
- **Ordre du DAG** — les agents déclarent leurs dépendances ; les résultats amont
  sont injectés comme contexte dans les agents aval.
- **Quality gate** — des contrôles déterministes vérifient les livrables et relancent
  les nœuds défaillants (selon le nombre de retries configuré).

Les agents écrivent leurs fichiers dans le workspace du run (un dossier sur disque)
via des blocs `filepath:` dans leur sortie. Ce dossier est ton livrable.

Pour la référence technique complète, voir [ORCHESTRATOR.fr.md](ORCHESTRATOR.fr.md).

---

## 5. Mémoire persistante

Réglable dans **Config → Mémoire**.

- **Profil** : un texte libre te décrivant (métier, préférences). Injecté dans les
  appels IA pour personnaliser les réponses.
- **Faits** : de courtes informations réutilisables (avec tags). Seuls les faits
  pertinents pour la requête sont injectés, dans une limite de tokens, pour ne pas
  gonfler le prompt.
- **Auto-extraction** : option pour laisser le modèle extraire automatiquement des
  faits depuis les conversations.
- **Désactivation** : un interrupteur global coupe toute injection mémoire ; un projet
  peut aussi la contourner individuellement.

Stockage : `~/.config/openhub/memory.json`.

---

## 6. Config (clés API & modèles)

Slot **Config** ⚙️. Tes clés sont stockées dans un fichier chiffré dans **`~/Library/Application Support/openhub/secrets.enc`** (AES-256-GCM),
jamais en clair ni dans le stockage local.

- **Clés API** : Anthropic, OpenAI, OpenRouter, Ollama (URL), GitHub, Brave Search.
- **Modèles** : modèle du classifieur mémoire, effort de raisonnement par défaut,
  proxy de vision, recherche web.
- **Mises à jour** : vérifier/mettre à jour les 3 apps upstream.
- **Notifications** : par source (Work / Code / Design).
- **Cache** : tableau de bord du prefix caching (taux de hit, tokens économisés).

---

## 7. Mettre à jour les apps upstream

OpenHub met à jour les outils intégrés automatiquement à chaque nouvelle version du
`.dmg`. Le code source des 3 apps n'est jamais modifié : toutes les personnalisations
vivent dans `electron/overrides/`, donc les mises à jour upstream ne cassent rien.

Pour les contributeurs qui compilent depuis les sources, voir
[CONTRIBUTING.md](CONTRIBUTING.md) pour le workflow de mise à jour et vérification
des sélecteurs.

---

Pour les questions fréquentes (coûts, données, macOS-only, dépannage), voir la
[FAQ](FAQ.fr.md).
