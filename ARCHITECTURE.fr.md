[English](ARCHITECTURE.md) · **Français**

# OpenAxis — Architecture (spec canonique figée)

> Super-Hub desktop macOS qui réunit plusieurs outils IA open-source dans une
> interface unique inspirée de l'app native Claude macOS. Chaque outil garde son
> code source intact ; toutes les personnalisations passent par une couche
> d'injection (CSS/JS) et un proxy LLM central, pour rester compatible avec les
> mises à jour upstream.

**Statut :** V1 figée — vérifiée sur le code source réel des dépôts.
**Date :** 2026-06-03.

> [!NOTE]
> Le proxy (`electron/proxy/index.ts`) contient une zone sensible optimisée pour le
> **prefix caching** des providers (DeepSeek, Anthropic…). Sa structure de préfixe
> ne doit pas être réordonnée ou « nettoyée » à la légère sous peine de chute du
> cache hit rate. Les contraintes détaillées (et les consignes pour les agents IA
> qui contribuent au code) sont dans [AGENTS.md](AGENTS.md).

## 1. Périmètre V1

La sidebar embarque **cinq slots** — **Chat**, **Code**, **Work**, **Design**, **Orchestrateur** — plus un panneau Config. Les trois slots du tableau ci-dessous sont adossés à une app upstream embarquée ; **Chat** et **Orchestrateur** sont natifs à OpenAxis (pas d'app externe, pas de webview) et ont atterri après le gel de cette spec V1.

| Slot   | Dépôt                                              | Mode embarqué        | Port             |
| ------ | -------------------------------------------------- | -------------------- | ---------------- |
| Work   | `different-ai/openwork` (`apps/app`, Vite SPA)     | build statique servi | `5173`           |
| Code   | `sst/opencode` (`opencode serve` / `opencode web`) | serveur HTTP         | `4096`           |
| Design | `nexu-io/open-design` (daemon Express + build)     | daemon local         | capturé au spawn |

Hors périmètre V1 : stack cloud « den »/EE d'openwork (MySQL, better-auth), Docker.

---

## 2. Stack technique

| Composant        | Choix                                                                              | Justification                                                                        |
| ---------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Shell desktop    | **Electron** (pas Tauri)                                                           | Multi-`WebContentsView` mature ; openwork est déjà Tauri → Electron évite le conflit |
| Vues apps        | `WebContentsView` (1 par app, lazy, gardée vivante)                                | État/sessions préservés en changeant de slot                                         |
| Runtime apps     | **Natif uniquement** (zéro Docker)                                                 | Les apps doivent accéder au filesystem (elles éditent code/design)                   |
| Proxy LLM        | Serveur Express intégré au main, `127.0.0.1:9999`                                  | Passerelle OpenAI-compatible unique + détention des secrets                          |
| Secrets          | Fichier chiffré AES-256-GCM à `~/Library/Application Support/openaxis/secrets.enc` | Jamais non chiffré sur disque, jamais dans les apps                                  |
| Config cascade   | `~/.config/opencode/opencode.json`                                                 | Un seul fichier configure les 3 apps (toutes pilotent opencode)                      |
| Personnalisation | Injection CSS/JS runtime (`insertCSS` / bridge)                                    | Indépendant des updates upstream                                                     |
| Updates          | `git pull` / `npm update` par dossier                                              | Code source jamais modifié                                                           |

---

## 3. Schéma

```
ELECTRON (shell + proxy + secrets) ─ seul détenteur des clés réelles
│
├─ Sidebar : [Chat] [Code] [Work] [Design] [Orchestrateur] [Config]
│
├─ 3 WebContentsView (lazy, état préservé, builds servis) :
│    Work   → openwork apps/app        :5173
│    Code   → opencode serve/web       :4096
│    Design → open-design daemon       :port capturé au spawn
│
├─ CASCADE DE CONFIG ("configurer une fois") :
│    OpenAxis écrit ~/.config/opencode/opencode.json
│      provider "openaxis" → baseURL http://localhost:9999/v1
│      hérité par Work + Code + Design (tous pilotent opencode)
│
├─ PROXY LLM :9999 (127.0.0.1, Bearer token requis, OpenAI-compatible)
│    détient les vraies clés (secrets.enc) · route Anthropic / OpenAI / Ollama
│    point d'injection : web-search, enrichissement de contexte
│
├─ SECRETS : secrets.enc → RAM du main → env vars au spawn des process
│
└─ OVERLAYS : CSS (thème uniforme) + JS via bridge isolé
     (masquer settings natifs, export PDF, web-search, ajout/suppression de features)
```

---

## 4. "Configurer une fois" — mécanisme confirmé

Les 3 apps tournent sur le **même moteur opencode** :

- **opencode** _est_ le moteur.
- **openwork** l'utilise via `@opencode-ai/sdk`.
- **open-design** détecte et pilote le code-agent CLI installé (→ opencode).

Donc un seul `opencode.json` cascade vers les 3. Provider OpenAI-compatible custom
(confirmé supporté par opencode) :

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openaxis": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenAxis Proxy",
      "options": {
        "baseURL": "http://localhost:9999/v1",
        "apiKey": "{env:OPENAXIS_TOKEN}"
      },
      "models": { "claude-sonnet-4-6": { "name": "Claude Sonnet 4.6" } }
    }
  }
}
```

Les apps ne reçoivent qu'un **faux jeton local** (`OPENAXIS_TOKEN`). Le proxy `:9999`
détient les vraies clés (Anthropic/OpenAI/OAuth) lues depuis le fichier secrets.enc.

---

## 5. Modèle de sécurité

| Verrou               | Détail                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Isolation webviews   | `contextIsolation:true` + `sandbox:true` + `nodeIntegration:false`                                                       |
| Bridge               | minuscule, validé, **sans chemin disque** (chemins choisis par `dialog` native)                                          |
| Joyau à protéger     | `opencode serve` exécute des commandes shell → bind `127.0.0.1` strict + `OPENCODE_SERVER_PASSWORD` généré, jamais loggé |
| Proxy                | `127.0.0.1` + `Authorization: Bearer` obligatoire (aucun autre process local ne crame ta clé)                            |
| Secrets réels        | Fichier chiffré AES-256-GCM → RAM du main → env au spawn ; jamais disque non chiffré/webview                             |
| JS injecté           | UI uniquement, aucun secret inline ; actions sensibles via bridge isolé                                                  |
| Stack den d'openwork | **désactivé** (sinon secrets faibles par défaut + MySQL)                                                                 |

---

## 6. Couche d'overrides (ajouter / supprimer / relooker)

```
electron/overrides/
├── index.json            # catalogue activable/désactivable par slot
├── global/
│   ├── theme.css         # palette, typo, arrondis — partout
│   └── layout.css        # masquage des sidebars/settings natifs
├── openwork/  *.css *.js
├── opencode/  *.css *.js
└── open-design/ *.css *.js
```

Règle : cibler les sélecteurs **sémantiques** (`data-*`, `aria-*`, `role`, `id`)
plutôt que les classes utilitaires. Réinjection sur `did-navigate` +
`MutationObserver` pour couvrir les SPA. Script de vérification post-update qui
signale les sélecteurs cassés.

Features prévues via cette couche : export PDF (`printToPDF` natif + markdown→PDF
côté proxy), recherche web (proxy enrichit le contexte), masquage des settings
natifs (centralisés dans le panel Config).

---

## 7. Traçabilité — 17 demandes initiales → toutes couvertes

| #   | Demande                                         | État                           |
| --- | ----------------------------------------------- | ------------------------------ |
| 1   | Ergonomie Claude macOS                          | ✅                             |
| 2   | Réunir sans fusionner les sources               | ✅                             |
| 3   | Wrapper Tauri/Electron                          | ✅ Electron                    |
| 4   | Démarrage auto des serveurs                     | ✅                             |
| 5   | Sidebar + webview + état indépendant            | ✅                             |
| 6   | Masquer sidebars + thème sombre unique          | ✅                             |
| 7   | Configurer API/modèles une fois (local+distant) | ✅✅ via opencode.json + proxy |
| 8   | OAuth/secrets en coffre, injectés au démarrage  | ✅ fichier secrets.enc chiffré |
| 9   | Résilience aux updates upstream                 | ✅                             |
| 10  | Pas de chat qui contrôle les autres             | ✅ apps indépendantes          |
| 11  | Une API sans la remettre par fenêtre            | ✅                             |
| 12  | Ajouter/supprimer des options                   | ✅ overrides                   |
| 13  | Web search dans OpenWork (pas natif)            | ✅ proxy                       |
| 14  | Supprimer settings des apps, centraliser        | ✅                             |
| 15  | Génération PDF comme Claude (pas natif)         | ✅                             |
| 16  | Mettre à jour chaque projet                     | ✅                             |
| 17  | Zéro Docker                                     | ✅                             |

Chat (4e pilule du brief initial) : **livré** — désormais un slot natif, aux côtés de l'Orchestrateur, tous deux ajoutés après le gel de cette spec V1.

---

## 8. Réglages d'intégration connus (non bloquants)

- Épingler la version Node par app (open-design exige Node ~24) dans le process-manager.
- Capturer le port d'open-design au spawn (le daemon l'imprime).
- Forcer open-design à détecter **opencode** comme code-agent CLI (sinon la cascade diverge).
- Vérifier le flux GitHub-auth d'opencode pour l'injection du token OAuth.
- Servir les **builds** (pas les serveurs `dev`) comme runtime.

---

## 9. Ordre de génération

1. Squelette Electron + process-manager (avec pin Node par app)
2. Proxy `:9999` + chiffrement du fichier secrets.enc
3. Générateur de `~/.config/opencode/opencode.json`
4. Sidebar + WebContentsView + couche d'injection
5. Panel Config (clés API, modèles, toggles d'overrides)
