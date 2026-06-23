[English](CHANGELOG.md) · **Français**

# Changelog

Toutes les modifications notables de ce projet sont documentées ici.

Le format s'inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le
projet suit le [versionnage sémantique](https://semver.org/lang/fr/).

## [0.1.0] — 2026-06-15

Première version publique. Shell desktop macOS unifiant trois outils IA open-source.

### Ajouté

- **Shell Electron** avec sidebar à 3 slots (Work, Code, Design) + Chat,
  Orchestrateur et Config, chaque vue isolée dans un `WebContentsView` à l'état
  préservé.
- **Proxy LLM unifié** sur `127.0.0.1:9999` (OpenAI-compatible, Bearer obligatoire)
  routant vers Anthropic, OpenAI, OpenRouter, Ollama et Google Gemini.
- **Stockage des secrets dans un fichier chiffré** dans `~/Library/Application Support/openaxis/secrets.enc` (AES-256-GCM) — jamais en clair ;
  les apps ne reçoivent qu'un faux jeton local.
- **Chat intégré** : sélecteur de modèles, effort de raisonnement par modèle,
  historique sauvegardé, recherche web, pièces jointes, contexte projet.
- **Orchestrateur multi-agents** : planification itérative, exécution d'un DAG
  d'agents (code / design / work / LLM pur / vérification), quality gates
  déterministes et relance sur erreur.
- **Gestion de projets** : projets autonomes et projets orchestrateur, instructions
  personnalisées injectées dans le contexte IA.
- **Mémoire persistante** : profil, faits taggés, auto-extraction et budget de tokens.
- **Couche d'overrides** CSS/JS par app — le code source upstream n'est jamais
  modifié, ce qui préserve la compatibilité avec les mises à jour.
- **Optimisation du prefix caching** dans le proxy pour réduire coûts et latence.
- **Outillage** : setup automatisé, vérification des sélecteurs, tests Vitest +
  Playwright, CI lint & typecheck.

### Sécurité

- WebViews verrouillées (`contextIsolation`, `sandbox`, sans `nodeIntegration`).
- `opencode serve` lié à `127.0.0.1` strict avec mot de passe de session généré,
  jamais loggé.
- Bridge `contextBridge` minimal, sans paramètre de chemin disque.

[0.1.0]: https://github.com/Open-Fable/OpenAxis/releases/tag/v0.1.0
