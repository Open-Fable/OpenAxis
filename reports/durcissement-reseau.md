# Audit de durcissement réseau — OpenHub

**Date :** 2026-06-13
**Périmètre :** Proxy Express (`electron/proxy/`), isolation réseau inter-apps, exposition réseau.
**Stack :** Electron v32+, Express (127.0.0.1:9999), Work:5173, Code:4096, Design:port dynamique.

---

## 1. Synthèse

Le proxy Express présente une posture réseau globalement saine : binding strict sur
`127.0.0.1`, authentification Bearer obligatoire sur tous les endpoints de données,
TLS sortant validé par défaut (aucun `rejectUnauthorized:false` ni
`NODE_TLS_REJECT_UNAUTHORIZED=0`), et WebContentsView durcies
(`contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`).

**1 correctif appliqué** (headers de sécurité). **6 findings à vérifier manuellement**,
dont aucun n'est exploitable à distance (surface limitée à la loopback locale).

---

## 2. Matrice de sécurité réseau

| Aspect                         | Constat                                                                                                                                          | Statut        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Binding proxy                  | `app.listen(9999, "127.0.0.1")` — jamais 0.0.0.0                                                                                                 | ✅ CONFORME   |
| Auth Bearer                    | Middleware global (l.105) avant tous les endpoints data ; `PUBLIC_PATHS` = `/status`, `/health`, `/capabilities`, `/runtime/versions` uniquement | ✅ CONFORME   |
| Token statique `openhub-local` | Token Bearer en dur accepté sur tous les endpoints                                                                                               | ⚠️ À VÉRIFIER |
| CORS                           | Allow-list d'origines locales explicites + `file://` ; fallback `127.0.0.1:9999`                                                                 | ✅ CONFORME   |
| X-Content-Type-Options         | `nosniff`                                                                                                                                        | ✅ CONFORME   |
| X-Frame-Options                | `DENY`                                                                                                                                           | ✅ CONFORME   |
| Content-Security-Policy        | `frame-ancestors 'none'`                                                                                                                         | ✅ CORRIGÉ    |
| Referrer-Policy                | `no-referrer`                                                                                                                                    | ✅ CORRIGÉ    |
| TLS sortant                    | `fetch()` Node, validation certificats par défaut                                                                                                | ✅ CONFORME   |
| Secrets dans les logs          | Aucune Authorization/clé loggée ; les logs n'exposent que des corps d'erreur upstream                                                            | ✅ CONFORME   |
| Secret OAuth Gemini en dur     | `GEMINI_CLIENT_SECRET` en dur (override env possible)                                                                                            | ⚠️ À VÉRIFIER |
| Retry policy                   | `fetchWithRetry` borné (maxRetries=3, attente ≤60s) — pas de boucle infinie ; backoff linéaire + 1 tentative résiduelle                          | ⚠️ À VÉRIFIER |
| Rate limiting entrant          | Aucun, mais surface loopback uniquement                                                                                                          | ⚠️ À VÉRIFIER |
| SSRF vision proxy              | `describeImage` transmet l'URL image à Ollama local                                                                                              | ⚠️ À VÉRIFIER |
| Limite payload                 | `express.json({ limit: "10mb" })`                                                                                                                | ✅ CONFORME   |

---

## 3. Cartographie des ports et isolation inter-apps

| Slot                 | Port                       | Binding              | Auth                                   | Isolation                         |
| -------------------- | -------------------------- | -------------------- | -------------------------------------- | --------------------------------- |
| Work (openwork)      | 5173                       | local                | via proxy                              | WebContentsView, preload, sandbox |
| Code (opencode)      | 4096                       | local                | `OPENCODE_SERVER_PASSWORD` par session | WebContentsView, sandbox          |
| Design (open-design) | dynamique (capté au spawn) | local                | daemon `od`                            | WebContentsView, sandbox          |
| Proxy interne        | 9999                       | **127.0.0.1 strict** | Bearer obligatoire                     | —                                 |

**Isolation navigateur :** les 3 vues sont des `WebContentsView` durcies. La navigation
hors `http(s)://` est bloquée (`will-navigate`), et les liens externes sont délégués au
navigateur système (`setWindowOpenHandler` → `shell.openExternal`, action `deny`).

**Cross-origin entre apps :** une requête Work (5173) → Code (4096) est soumise à la
Same-Origin Policy du navigateur + au CORS propre d'opencode. Le proxy ne réexpose que
des origines locales connues. Aucune route du proxy ne ponte 5173 vers 4096 sans
passer par le préfixe authentifié `/workspace/:id/opencode/*`.

**Point d'attention :** les 3 slots partagent `partition: "persist:chat"`
(cookies/localStorage/cache de session communs). Voir finding N-2.

---

## 4. Findings détaillés

### CORRIGÉ

**N-1 — Headers de sécurité incomplets (MEDIUM)** ✅ CORRIGÉ
Le middleware ne posait que `X-Content-Type-Options` et `X-Frame-Options`.
Ajout de `Content-Security-Policy: frame-ancestors 'none'` (anti-clickjacking,
défense en profondeur vs navigateurs ignorant X-Frame-Options) et
`Referrer-Policy: no-referrer` (évite la fuite de l'URL interne 127.0.0.1:9999
dans le header Referer). Sans impact sur la consommation JSON/SSE par les apps.
Commit : `fix(network): ajouter headers Referrer-Policy et CSP frame-ancestors`.

### À VÉRIFIER MANUELLEMENT

**N-2 — Partition de session partagée entre les 3 apps (MEDIUM)**
`electron/main.ts` : tous les `createSlotView` utilisent `partition: "persist:chat"`.
Work, Code et Design partagent donc cookies, localStorage et cache. Une app
compromise pourrait lire les données de session des autres. Cloisonner via des
partitions distinctes (`persist:work`, `persist:code`, `persist:design`)
renforcerait l'isolation, **mais risque de casser les flux OAuth/session
existants** — à valider manuellement avant changement.

**N-3 — Secret OAuth Gemini en dur (LOW)**
`electron/proxy/index.ts` : `GEMINI_CLIENT_SECRET` est codé en dur (avec override
`process.env.GEMINI_CLIENT_SECRET`). Il s'agit des credentials publics "installed
app" du Gemini CLI upstream, non secrets au sens OAuth des apps natives. Le retirer
casserait l'auth Gemini hors-env. Recommandation : documenter explicitement son
caractère public ou exiger la variable d'environnement. Ne pas supprimer sans
fournir une alternative de configuration.

**N-4 — Token Bearer statique `openhub-local` (LOW)**
Un token en dur est accepté sur tous les endpoints en plus du token de session
aléatoire. Nécessaire pour la webview OpenWork qui n'a pas accès au token de
session. Surface limitée à la loopback (127.0.0.1). Envisager de remplacer par
un token de session injecté dans la webview via le preload — à valider car
peut casser l'accès OpenWork.

**N-5 — Pas de rate limiting entrant sur le proxy (LOW)**
Aucune limite de débit sur `/v1/chat/completions` ni `/v1/orch/assistant`.
Risque faible car le proxy n'écoute que sur la loopback (pas d'attaquant distant).
Un rate limit local protégerait contre une boucle runaway d'une app compromise.

**N-6 — Retry / backoff (LOW)**
`fetchWithRetry` est borné (maxRetries=3, attente plafonnée à 60s) : **pas de boucle
infinie**. Cependant le backoff est linéaire (`5*(attempt+1)`) plutôt qu'exponentiel,
et une tentative résiduelle est exécutée après la boucle (`return fetch(...)` final,
soit jusqu'à 4 appels). Passage à un backoff exponentiel avec jitter et suppression
de la tentative résiduelle recommandés — non bloquant.

**N-7 — SSRF potentiel via le vision proxy (LOW)**
`describeImage` (`electron/proxy/vision.ts`) transmet l'URL d'image fournie dans la
requête de chat vers le serveur Ollama local. Si une URL `http(s)://` interne est
fournie, c'est Ollama (non le proxy) qui la récupère. Risque faible (entrée provenant
du chat de l'utilisateur lui-même, destination Ollama local). Valider qu'Ollama
n'effectue pas de requêtes vers des cibles internes non désirées.

---

## 5. Recommandations priorisées

1. **N-2** (partition de session) : tester un cloisonnement par partition dans un
   environnement de dev avant adoption (risque OAuth).
2. **N-5** (rate limiting) : ajouter une limite locale légère sur les endpoints LLM.
3. **N-6** (backoff exponentiel) : amélioration de robustesse, non sécuritaire.
4. **N-3 / N-4** : documenter le modèle de confiance loopback dans `ARCHITECTURE.md`.

Aucun finding n'est exploitable à distance : toute la surface réseau est liée à
`127.0.0.1`. Les risques résiduels supposent une app locale déjà compromise.

---

## 6. Évolution vs audit précédent (2026-06-12)

- N-1 (headers) : reste corrigé et complété ce jour (CSP `frame-ancestors` +
  `Referrer-Policy`).
- Aucune régression réseau détectée depuis le dernier passage.
