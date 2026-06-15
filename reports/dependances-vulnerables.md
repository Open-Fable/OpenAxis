# Rapport d'audit des dépendances — OpenHub

**Date de l'audit :** 2026-06-15
**Branche :** main
**Outil :** `npm audit` + `npm outdated` (npm sur Node 24.14.0 ; runtime cible Electron 42 = Node 22)

---

## 1. Résumé exécutif

| Indicateur                           | Résultat                                               |
| ------------------------------------ | ------------------------------------------------------ |
| Vulnérabilités `npm audit`           | **0** (aucune, tous niveaux confondus)                 |
| Mises à jour patch/minor disponibles | **0** (toutes les deps sont déjà au niveau « Wanted ») |
| Mises à jour majeures disponibles    | 5 (toutes en `devDependencies`)                        |
| Dépendances runtime à risque         | 1 (keytar — non vulnérable mais projet archivé)        |
| Commits de mise à jour produits      | **0** (aucun correctif sûr à appliquer)                |

`npm update` est un no-op : chaque paquet est déjà à la version maximale autorisée par les plages du `package.json`. Les seules évolutions possibles sont des **majeures breaking**, donc non appliquées automatiquement conformément aux consignes.

---

## 2. Résultat brut de `npm audit`

```
found 0 vulnerabilities
```

`npm update --dry-run` :

```
up to date in 14s
159 packages are looking for funding
```

---

## 3. Dépendances critiques (runtime)

| Paquet     | Version installée | Dernière                | CVE connue                                        | Risque                                                    | Statut       |
| ---------- | ----------------- | ----------------------- | ------------------------------------------------- | --------------------------------------------------------- | ------------ |
| `electron` | 42.4.0            | 42.x (majeure courante) | Aucune                                            | Faible                                                    | À JOUR       |
| `express`  | 5.2.1             | 5.2.1                   | Aucune (la branche 5.x corrige les CVE de la 4.x) | Faible                                                    | À JOUR       |
| `keytar`   | 7.9.0             | 7.9.0                   | Aucune CVE active                                 | **Moyen** (projet archivé/non maintenu par l'équipe Atom) | À SURVEILLER |

### Note keytar

`keytar` est techniquement à jour (7.9.0 est la dernière) et **sans vulnérabilité connue**, mais le dépôt upstream (atom/node-keytar) est **archivé**. C'est un module natif (node-gyp) ; il reste fonctionnel sous Electron 42 / Node 22 mais ne recevra plus de correctifs. Aucune action urgente, à garder en veille pour une migration future (ex. `@napi-rs/keyring`) si une faille apparaît. Ne pas migrer maintenant — pas de déclencheur sécurité.

---

## 4. Dépendances obsolètes (majeures en retard)

Toutes en `devDependencies` (aucune n'affecte le binaire livré). **À METTRE À JOUR MANUELLEMENT** car potentiellement breaking.

| Paquet        | Actuelle | Recommandée | Risque rupture                                                                                           | Statut                       |
| ------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `@types/node` | 22.19.21 | 25.9.3      | **Volontairement bloqué** : doit rester aligné sur le Node d'Electron (Node 22). Ne PAS monter en 24/25. | NE PAS METTRE À JOUR         |
| `eslint`      | 9.39.4   | 10.5.0      | Moyen (changements de config/règles flat-config)                                                         | À METTRE À JOUR MANUELLEMENT |
| `globals`     | 16.5.0   | 17.6.0      | Faible                                                                                                   | À METTRE À JOUR MANUELLEMENT |
| `lint-staged` | 15.5.2   | 17.0.7      | Faible/Moyen (changements CLI/options)                                                                   | À METTRE À JOUR MANUELLEMENT |
| `typescript`  | 5.9.3    | 6.0.3       | Moyen (TS 6 peut introduire de nouvelles erreurs strict)                                                 | À METTRE À JOUR MANUELLEMENT |

---

## 5. Compatibilité Electron v42 / Node 22

- **`@types/node` 22.x** : à conserver volontairement à la majeure 22 pour matcher le runtime Node d'Electron 42. Monter en 24/25 introduirait des types d'API absentes à l'exécution.
- **`keytar`** : module natif compilé via node-gyp ; ABI compatible Electron 42 (l'app démarre). Surveiller lors des prochaines montées d'Electron — un module natif archivé est le maillon le plus fragile lors d'un bump d'ABI.
- Aucune dépendance n'utilise d'API Electron dépréciée détectée.

---

## 6. Sous-dépendances (transitives)

`npm audit` parcourt l'arbre transitif complet (159 paquets) : **aucune** sous-dépendance vulnérable. Rien à signaler.

---

## 7. Plan de mise à jour par étapes (majeures, à faire manuellement)

Faire un commit + `npm test`/`typecheck`/`lint` après **chaque** étape :

1. **`globals` 16 → 17** (faible risque) : `npm i -D globals@17` puis `npm run lint`.
2. **`lint-staged` 15 → 17** : lire le CHANGELOG (options CLI), `npm i -D lint-staged@17`, tester un commit Husky.
3. **`eslint` 9 → 10** : vérifier la compat de `typescript-eslint` et `eslint.config.mjs` (flat config), `npm i -D eslint@10 typescript-eslint@latest`, `npm run lint`.
4. **`typescript` 5.9 → 6.0** : `npm i -D typescript@6` puis `npm run typecheck` ; corriger les nouvelles erreurs strict avant de committer.
5. **`@types/node`** : NE PAS toucher tant qu'Electron reste sur Node 22.

`keytar` : pas de migration tant qu'aucune CVE n'est publiée ; si déclencheur, évaluer `@napi-rs/keyring`.

---

## 8. Conclusion

Posture de sécurité des dépendances **saine** : zéro vulnérabilité, runtime à jour. Aucun correctif sûr à appliquer (d'où aucun commit `fix(deps)`). Les seules dettes sont des majeures de tooling dev, sans impact sécurité, listées ci-dessus pour traitement manuel planifié.
