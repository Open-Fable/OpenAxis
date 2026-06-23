[English](SECURITY.md) · **Français**

# Sécurité

## Modèle de menace

OpenAxis est une application desktop macOS locale. Elle s'exécute entièrement sur votre machine — pas de backend cloud, pas de télémétrie.

### Ce qui est protégé

| Surface                | Comment                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Clés API**           | Stockées dans un fichier chiffré dans `~/Library/Application Support/openaxis/secrets.enc` (AES-256-GCM) — jamais écrites dans des variables d'environnement |
| **Proxy LLM**          | Lié à `127.0.0.1:9999` uniquement — inaccessible depuis d'autres machines. Requiert un jeton Bearer par session                                              |
| **WebViews**           | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` — les apps upstream ne peuvent pas accéder aux API Node.js                               |
| **Overrides injectés** | CSS/JS uniquement — aucun secret n'est jamais inséré dans les fichiers d'override                                                                            |
| **Jeton du proxy LLM** | Jeton par session (`randomBytes(32)`), requis sur chaque route ; pas de jeton statique/partagé ; comparé en temps constant                                   |
| **Serveur opencode**   | Lié à `127.0.0.1` uniquement — inaccessible depuis d'autres machines                                                                                         |

### Hors périmètre

| Catégorie                                         | Justification                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Vulnérabilités des apps upstream**              | OpenWork, OpenCode, Open Design sont des projets indépendants — signalez-les directement à ces projets      |
| **Traitement des données par le fournisseur LLM** | Régi par les politiques propres au fournisseur (Anthropic, OpenAI, etc.)                                    |
| **Fichiers de config malveillants**               | Les utilisateurs contrôlent leur propre `~/.config/openaxis/` — le modifier n'est pas un vecteur d'attaque  |
| **Accès physique à la machine**                   | Si un attaquant a un accès local à votre machine, le fichier de secrets chiffré est protégé par AES-256-GCM |

## Signaler une vulnérabilité

**N'ouvrez pas d'issue GitHub publique pour les vulnérabilités de sécurité.**

Utilisez l'onglet GitHub Security Advisory : [Signaler une vulnérabilité](https://github.com/Open-Fable/OpenAxis/security/advisories/new)

Réponse sous 5 jours ouvrés. Après la première réponse, vous serez tenu informé de l'avancement vers un correctif.

> [!NOTE]
> Nous n'acceptons pas les rapports de sécurité générés par IA. Ils seront fermés sans examen.
