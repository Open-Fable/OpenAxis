[English](ACKNOWLEDGEMENTS.md) · **Français**

# Remerciements

OpenAxis est un **shell**, pas un fork. Il ne contient pas, ne modifie pas et ne
redistribue pas le code source des outils qu'il unifie — ces projets sont **clonés à
l'installation** par `scripts/setup.sh` dans le dossier `apps/` (ignoré par git) et
tournent comme des process natifs indépendants. Tout le mérite de l'outillage IA
revient à leurs auteurs.

## Les outils unifiés par OpenAxis

| Outil                                                 | Auteur       | Licence         | Rôle dans OpenAxis          |
| ----------------------------------------------------- | ------------ | --------------- | --------------------------- |
| [OpenCode](https://github.com/sst/opencode)           | sst          | MIT             | Agent de code (slot Code)   |
| [OpenWork](https://github.com/different-ai/openwork)  | different-ai | voir upstream\* | Orchestration (slot Work)   |
| [Open Design](https://github.com/nexu-io/open-design) | nexu-io      | Apache-2.0      | Design visuel (slot Design) |

\* À l'heure où ces lignes sont écrites, OpenWork n'expose pas de licence SPDX standard
sur GitHub. Vérifie son dépôt pour connaître les conditions en vigueur avant de t'en
servir. OpenAxis ne redistribue pas le code d'OpenWork — il le clone depuis le dépôt
upstream sur ta machine.

Comme OpenAxis récupère ces projets au runtime au lieu de les empaqueter, il n'impose
aucune condition de licence supplémentaire : chaque outil reste régi uniquement par sa
propre licence. Si tu redistribues toi-même l'un de ces outils, respecte les exigences
de sa licence (ex. Apache-2.0 impose de préserver le fichier `NOTICE` et l'attribution).

## Qu'est-ce qui est le code propre d'OpenAxis ?

Tout ce qui est sous `electron/`, `scripts/`, `config/`, `docs/` et la configuration du
dépôt — le shell Electron, le proxy LLM, le système d'overrides, l'orchestrateur
multi-agents et la documentation — est le travail propre d'OpenAxis, publié sous
[licence MIT](../LICENSE).

## Également construit avec

- [Electron](https://www.electronjs.org) — runtime desktop
- [Express](https://expressjs.com) — le proxy LLM local
- [keytar](https://github.com/atom/node-keytar) — stockage chiffré de secrets (AES-256-GCM)
- [Vitest](https://vitest.dev) et [Playwright](https://playwright.dev) — tests

Merci aux mainteneurs de ces projets.
