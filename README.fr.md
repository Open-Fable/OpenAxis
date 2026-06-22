<div align="center">

# OpenHub

**Tout ton workflow IA dans une seule fenêtre macOS.**

Un espace de travail IA local : discute avec n'importe quel modèle, orchestre une équipe d'agents qui produit un vrai livrable, et bascule entre trois outils intégrés — [OpenWork](https://github.com/different-ai/openwork), [OpenCode](https://github.com/sst/opencode) et [Open Design](https://github.com/nexu-io/open-design). Un seul proxy LLM, une mémoire persistante, zéro Docker.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/platform-macOS_14+-black?logo=apple)](https://www.apple.com/macos)
[![Electron](https://img.shields.io/badge/Electron-42+-47848F?logo=electron&logoColor=white)](https://www.electronjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![tests](https://img.shields.io/github/actions/workflow/status/Open-Fable/OpenHub/test.yml?label=tests&style=flat)](https://github.com/Open-Fable/OpenHub/actions/workflows/test.yml)

[English](README.md) · **Français**

[Installation](#installation) | [Usage](docs/USAGE.fr.md) | [Orchestrateur](docs/ORCHESTRATOR.fr.md) | [FAQ](docs/FAQ.fr.md) | [Architecture](#architecture) | [Contribuer](docs/CONTRIBUTING.fr.md)

</div>

<p align="center">
  <img src="screen_github/onglet_chat.png" alt="Aperçu de l'interface OpenHub" width="800">
</p>

---

## Pourquoi OpenHub ?

Les outils IA sont des silos. Ils tournent dans des apps séparées avec leurs propres clés et mémoire. Rien ne suit quand tu changes de fenêtre. OpenHub met cinq outils dans une seule fenêtre macOS avec mémoire partagée, contexte projet partagé et un seul proxy LLM. Les clés sont chiffrées dans `~/Library/Application Support/openhub/secrets.enc` une fois. C'est tout.

**Cinq slots dans la sidebar :** Chat · Code · Work · Design · Orchestrateur (plus un panneau Config).

## Fonctionnalités

L'**orchestrateur multi-agents** est la vedette. C'est un assistant interactif : décris ce que tu veux en langage courant — « crée une landing page pour ma startup » ou « audite mon API et génère une spec OpenAPI » — et il planifie le travail sous forme de DAG visuel (un organigramme d'agents que tu peux inspecter). Chaque agent exécute son rôle de manière autonome : recherche, rédaction, maquettes, code, vérification qualité. Tu suis la progression en direct, et quand quelque chose échoue, le système s'auto-corrige sans que tu aies à intervenir. C'est ce qui rend le travail multi-agents complexe accessible à tout le monde, pas seulement aux ingénieurs. [Guide détaillé ici.](docs/ORCHESTRATOR.fr.md)

Le **chat** marche avec Anthropic, OpenAI, OpenRouter, Ollama, Google Gemini et tout fournisseur compatible OpenAI. Historique des sessions, pièces jointes, recherche Brave automatique, contrôle du raisonnement. Choisis ton modèle et c'est parti.

Trois **outils upstream** côtoient les slots natifs Chat et Orchestrateur : OpenCode (agent de code), OpenWork (espace de travail structuré) et Open Design (maquettes visuelles). Bascule entre les cinq librement — l'état d'exécution et la mémoire de session restent intacts.

En coulisses, un **proxy LLM** unique sur `127.0.0.1:9999` route tout via un seul endpoint compatible OpenAI. Il gère le cache prompt DeepSeek/Anthropic avec une stratégie de préfixe stable et normalise les schémas d'outils — les apps ne se marchent pas dessus.

Ton **profil et tes faits clés** suivent d'une session à l'autre _(en maintenance — bientôt disponible)_. Le système les extrait automatiquement après chaque chat avec des modèles Ollama locaux (Qwen) et une déduplication sémantique de Jaccard.

**Sécurité :** les clés API sont chiffrées dans `~/Library/Application Support/openhub/secrets.enc` (AES-256-GCM). Les WebViews sont sandboxées avec auth Bearer localhost.

### Captures d'écran

<details>
<summary>À quoi ressemble le chat</summary>
<br>
<p align="center">
  <img src="screen_github/onglet_chat.png" alt="Onglet Chat" width="750">
</p>
<p align="center">
  <img src="screen_github/projet_dans_chat.png" alt="Contexte projet dans le chat" width="750">
</p>
</details>

<details>
<summary>L'orchestrateur en action — planifier, construire, vérifier</summary>
<br>
<p align="center">
  <img src="screen_github/onglet_orchestrateur.png" alt="Onglet Orchestrateur" width="750">
</p>
<p align="center">
  <img src="screen_github/agent_de_workflow_dans_orchestrateur.png" alt="Projet actif dans l'orchestrateur" width="750">
</p>
<p align="center">
  <img src="screen_github/workflow.png" alt="Schéma du workflow d'orchestration" width="750">
</p>
</details>

<details>
<summary>Agent de code (OpenCode)</summary>
<br>
<p align="center">
  <img src="screen_github/onglet_code.png" alt="Onglet Code" width="750">
</p>
</details>

<details>
<summary>Espace de travail OpenWork et hub projets</summary>
<br>
<p align="center">
  <img src="screen_github/onglet_work.png" alt="Onglet Work" width="750">
</p>
</details>

<details>
<summary>Maquettes visuelles dans Open Design</summary>
<br>
<p align="center">
  <img src="screen_github/onglet_Design.png" alt="Onglet Design" width="750">
</p>
</details>

<details>
<summary>Panneau Config et gestion des clés API</summary>
<br>
<p align="center">
  <img src="screen_github/parametre.png" alt="Panneau Config" width="750">
</p>
</details>

---

## Installation

**Prérequis :** macOS 14+ (Apple Silicon)

Attrape le dernier `.dmg` depuis les [GitHub Releases](https://github.com/Open-Fable/OpenHub/releases), ouvre-le et glisse OpenHub dans ton dossier Applications.

> [!IMPORTANT]
> Le `.dmg` n'est pas signé avec un certificat Apple Developer (build open-source). macOS Gatekeeper le bloquera au premier lancement. Pour l'ouvrir :
>
> - **Clic droit** sur `OpenHub.app` → **Ouvrir** → confirmer, **ou**
> - supprimer le flag de quarantaine :
>   ```bash
>   xattr -cr /Applications/OpenHub.app
>   ```

### Premier lancement

1. Ouvre le panneau **Config** (icône engrenage dans la sidebar)
2. Ajoute tes clés API (Anthropic, OpenAI, OpenRouter, Google AI, Brave Search) — chiffrées dans `~/Library/Application Support/openhub/secrets.enc`
3. Choisis tes modèles

Voir le [guide d'usage](docs/USAGE.fr.md) pour le quotidien.

---

## Architecture

```
WebView (OpenWork / OpenCode / Open Design)
    │
    ├── overrides CSS/JS  ←──  electron/overrides/
    │
    └── appels LLM  ──→  Proxy :9999  ──→  Anthropic / OpenAI / OpenRouter / Ollama / Gemini
                             │
                             ├── injection de contexte (projet, mémoire)
                             └── extraction mémoire en arrière-plan *(en maintenance)*
```

Spec complète — ports, modèle de sécurité, cascade de config, système d'overlays — dans [ARCHITECTURE.fr.md](ARCHITECTURE.fr.md). Moteur de l'orchestrateur dans [docs/ORCHESTRATOR.fr.md](docs/ORCHESTRATOR.fr.md).

---

## Contribuer

Compiler depuis les sources, corriger un bug, ajouter une fonctionnalité — voir [docs/CONTRIBUTING.fr.md](docs/CONTRIBUTING.fr.md).

---

## Sécurité

- Les clés sont chiffrées dans `~/Library/Application Support/openhub/secrets.enc` (AES-256-GCM).
- Le proxy tourne sur `127.0.0.1:9999` avec auth Bearer par session.
- Les WebViews sont sandboxées : `contextIsolation`, `sandbox`, sans `nodeIntegration`.
- Les overrides sont CSS/JS uniquement — le code upstream reste inchangé.

Politique complète et comment signaler une vulnérabilité : [docs/SECURITY.fr.md](docs/SECURITY.fr.md).

---

## Remerciements

OpenHub est un shell, pas un fork. L'outillage IA appartient à
[OpenCode](https://github.com/sst/opencode) (sst),
[OpenWork](https://github.com/different-ai/openwork) (different-ai) et
[Open Design](https://github.com/nexu-io/open-design) (nexu-io) — chacun cloné à
l'installation, exécuté sans modification. Voir [docs/ACKNOWLEDGEMENTS.fr.md](docs/ACKNOWLEDGEMENTS.fr.md).

## Licence

MIT — voir [LICENSE](LICENSE). Couvre le code propre d'OpenHub uniquement ; les
outils wrappés gardent leurs propres licences.

---

**[Ouvrir une issue](https://github.com/Open-Fable/OpenHub/issues) · [Usage](docs/USAGE.fr.md) · [Orchestrateur](docs/ORCHESTRATOR.fr.md) · [FAQ](docs/FAQ.fr.md) · [Architecture](ARCHITECTURE.fr.md) · [Remerciements](docs/ACKNOWLEDGEMENTS.fr.md) · [Contribuer](docs/CONTRIBUTING.fr.md)**

---
