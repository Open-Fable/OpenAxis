[English](CONTRIBUTING.md) · **Français**

# Contribuer à OpenAxis

Merci de vouloir contribuer ! Voici comment participer.

Ce projet suit un [Code de conduite](CODE_OF_CONDUCT.md) — en participant, tu es tenu de
le respecter.

## Prérequis

- macOS 14+
- Node.js 22+
- Git

## Setup local

```bash
git clone https://github.com/Open-Fable/OpenAxis.git
cd OpenAxis
bash scripts/setup.sh
npm run dev
```

## Workflow

1. **Fork** le repo et crée une branche depuis `main`
2. **Installe** les dépendances avec `bash scripts/setup.sh`
3. **Fais tes changements** — touche uniquement ce qui est nécessaire
4. **Vérifie** : `npm run typecheck && npm run lint && npm test`
5. **Teste** manuellement dans Electron (`npm run dev`)
6. **Ouvre une PR** avec une description claire

## Règles

- **Ne modifie jamais le code source des apps upstream** (`apps/`). Toute personnalisation passe par `electron/overrides/`.
- **Pas de secrets dans le code.** Les clés API sont stockées dans un fichier chiffré dans `~/Library/Application Support/openaxis/secrets.enc` (AES-256-GCM).
- **Commits conventionnels :** `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
- **TypeScript strict.** Pas de `any` sauf aux frontières de sérialisation.
- **Fichiers < 400 lignes, fonctions < 50 lignes.**

## Signaler un bug

Utilise le template [Bug Report](https://github.com/Open-Fable/OpenAxis/issues/new?template=bug_report.yml).

## Proposer une fonctionnalité

Utilise le template [Feature Request](https://github.com/Open-Fable/OpenAxis/issues/new?template=feature_request.yml).

## Licence

En contribuant, tu acceptes que tes contributions soient sous licence [MIT](../LICENSE).
