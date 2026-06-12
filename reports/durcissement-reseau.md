# Rapport d'audit — Durcissement réseau OpenHub

**Date :** 2026-06-12
**Périmètre :** Proxy Express, isolation réseau inter-apps, exposition réseau

---

## 1. Matrice de sécurité — Proxy Express (127.0.0.1:9999)

| Contrôle                                    | Statut   | Détail                                                                                                      |
| ------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| Binding 127.0.0.1 uniquement                | CONFORME | `PROXY_HOST = "127.0.0.1"` (proxy/index.ts:24)                                                              |
| Authorization: Bearer sur endpoints données | CONFORME | Middleware global (lignes 97-113), PUBLIC_PATHS limité à /status, /health, /capabilities, /runtime/versions |
| CORS restrictif                             | CONFORME | Set fixe de 6 origines locales + file:// (lignes 60-67)                                                     |
| X-Content-Type-Options: nosniff             | CORRIGÉ  | Middleware ajouté — empêche le MIME sniffing                                                                |
| X-Frame-Options: DENY                       | CORRIGÉ  | Middleware ajouté — empêche le clickjacking                                                                 |
| Vary: Origin                                | CORRIGÉ  | Ajouté aux réponses CORS — prévient le cache poisoning                                                      |
| TLS sortant (appels API)                    | CONFORME | Node.js vérifie les certificats par défaut (fetch/https)                                                    |
| Pas de fuite tokens dans les logs           | CONFORME | Les logs affichent les paths, jamais les tokens Bearer                                                      |
| Retry policy bornée                         | CONFORME | `fetchWithRetry` : max 3 tentatives, backoff capé à 60s (lignes 1648-1666)                                  |
| Rate limiting                               | N/A      | Proxy localhost uniquement, pas exposé au réseau — rate limiting non nécessaire                             |
| CSP header                                  | N/A      | Le proxy sert des réponses JSON/SSE, pas du HTML — CSP non applicable                                       |

## 2. Isolation réseau entre les 3 apps

| Contrôle                                     | Statut   | Détail                                                                              |
| -------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| WebContentsView isolation                    | CONFORME | `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false` sur tous les slots |
| Navigation bloquée vers protocoles dangereux | CONFORME | `will-navigate` bloque tout sauf http:// et https:// (main.ts:211-216)              |
| Popups bloqués                               | CONFORME | `setWindowOpenHandler` redirige vers le navigateur système (main.ts:219-224)        |
| Work (5173) ↔ Code (4096) isolation          | CONFORME | Pas de communication directe — tout passe par le proxy 9999 avec auth Bearer        |
| Design (port dynamique) isolation            | CONFORME | Port capturé au spawn, pas de cross-origin autorisé                                 |

## 3. Exposition réseau

| Contrôle                              | Statut   | Détail                                                                                                                                           |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ports ouverts sur 0.0.0.0             | CONFORME | Proxy bind 127.0.0.1 uniquement. opencode et openwork bindent aussi en local                                                                     |
| URLs internes dans les erreurs client | CONFORME | Les erreurs retournent des messages génériques ("opencode not reachable", "Bad gateway")                                                         |
| SSE sécurisé                          | CONFORME | Les endpoints SSE requièrent auth Bearer, pas de timeout infini côté serveur (socket.setTimeout(0) désactive le timeout Node, standard pour SSE) |
| WebSocket                             | N/A      | Aucun WebSocket utilisé — communication via SSE et HTTP                                                                                          |

## 4. Observations supplémentaires

### Google OAuth client_secret en dur (proxy/index.ts:1697)

`GEMINI_CLIENT_SECRET` est codé en dur dans le source. C'est **conforme** pour un flux OAuth "installed app" (public client) — Google le documente ainsi. Le secret n'est pas réellement secret dans ce contexte. Aucune action requise.

### Token "openhub-local" statique (proxy/index.ts:90)

Le token fixe `openhub-local` est accepté en plus du session token aléatoire. C'est nécessaire pour le WebView OpenWork qui ne peut pas recevoir le token de session. Le risque est mitigé par le binding 127.0.0.1 — seuls les processus locaux peuvent atteindre le proxy.

### Endpoints sans auth : /v1/cache/metrics, /v1/reasoning/\*

Ces endpoints sont placés APRÈS le middleware auth, donc ils requièrent bien un Bearer token. Le commentaire "no auth" sur la ligne 441 est trompeur mais le code est correct.

## 5. Résumé des corrections

| #   | Finding                                  | Sévérité | Statut                                                               |
| --- | ---------------------------------------- | -------- | -------------------------------------------------------------------- |
| 1   | X-Content-Type-Options manquant          | MEDIUM   | CORRIGÉ                                                              |
| 2   | X-Frame-Options manquant                 | MEDIUM   | CORRIGÉ                                                              |
| 3   | Vary: Origin manquant sur CORS           | LOW      | CORRIGÉ                                                              |
| 4   | Token openhub-local statique             | LOW      | À VÉRIFIER MANUELLEMENT — nécessaire pour le fonctionnement OpenWork |
| 5   | Commentaire trompeur "no auth" ligne 441 | INFO     | Cosmétique, code correct                                             |
