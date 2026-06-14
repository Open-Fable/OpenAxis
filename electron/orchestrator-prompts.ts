import { promises as fs } from "fs";
import path from "path";
import type { Project } from "./project-store.js";

// ── Helpers de contexte ──────────────────────────────────────────────────────

export async function buildWorkspaceContext(workspaceDir: string): Promise<string> {
  const indexPath = path.join(workspaceDir, "WORKSPACE_INDEX.md");
  try {
    const content = await fs.readFile(indexPath, "utf-8");
    const trimmed = content.substring(0, 24000);
    return `[ÉTAT DU WORKSPACE]\n${trimmed}`;
  } catch {
    return "[ÉTAT DU WORKSPACE]\nAucun fichier indexé. Le workspace est vide ou non initialisé.";
  }
}

export function buildDependencyContext(
  node: Project,
  allProjects: readonly Project[],
  executionResults: ReadonlyMap<string, string>,
): string {
  const deps = node.dependencies ?? [];
  if (deps.length === 0) return "";

  const blocks: string[] = [];
  let hasAuthoritativeSource = false;
  let hasWebArtifacts = false;
  for (const depId of deps) {
    const depProject = allProjects.find((p) => p.id === depId);
    const result = executionResults.get(depId);
    if (!depProject) continue;
    if (
      depProject.type === "design" ||
      depProject.type === "work" ||
      depProject.type === "recherche"
    ) {
      hasAuthoritativeSource = true;
    }
    // Web artifacts = the design backend (always produces HTML/CSS mockups) OR a
    // dependency whose output actually contains an .html/.css file. Only then does
    // the mockup-specific fidelity mandate apply — otherwise it pollutes non-web
    // pipelines (a code library depending on a research spec, a data report, …).
    if (
      depProject.type === "design" ||
      (result && /filepath:\s*[^\n]*\.(html?|css)\b/i.test(result))
    ) {
      hasWebArtifacts = true;
    }

    const maxLen = depProject.type === "design" ? 60_000 : 24_000;
    const resultSummary = result ? result.substring(0, maxLen) : "(pas encore exécuté)";

    blocks.push(
      `--- Agent "${depProject.name}" (${depProject.type ?? "inconnu"}) ---\nTâche : ${depProject.task ?? "non définie"}\nRésultat :\n${resultSummary}`,
    );
  }

  if (blocks.length === 0) return "";

  const reproduces = node.type === "code" || node.type === "work";
  // Neutral mandate for non-web pipelines: reuse the upstream contracts/data/
  // decisions faithfully, without any mockup/page/CSS vocabulary.
  const neutralMandate = `\n\n⚠️ MANDAT DE FIDÉLITÉ — NON NÉGOCIABLE :
Les résultats des agents ci-dessus font AUTORITÉ. Tu dois les RÉUTILISER FIDÈLEMENT — pas t'en "inspirer", pas réinventer.
- Reprends EXACTEMENT les décisions, contrats, schémas, noms, structures et données déjà produits (ex: schéma de données → couche d'accès ; spécification → implémentation ; contenu → mise en forme).
- N'invente AUCUN nouveau nom/identité ni nouvelle structure si une source en définit déjà ; ne contredis pas les données amont.
- Si les sources se CONTREDISENT, choisis-en UNE seule, applique-la partout, signale la contradiction en commentaire — ne crée JAMAIS une troisième version.`;
  const webMandate = `\n\n⚠️ MANDAT DE FIDÉLITÉ — NON NÉGOCIABLE :
Les résultats ci-dessus (maquettes, design system, charte, contenu) font AUTORITÉ. Tu dois les REPRODUIRE À L'IDENTIQUE — pas t'en "inspirer", pas redessiner.
- COUVERTURE COMPLÈTE — CODE TOUTES LES PAGES : il doit exister une page servie pour CHAQUE fichier mockups/*.html (sauf components.html qui est une galerie de démo). Si la maquette contient 15 pages, le site servi doit en contenir 15. Ne code PAS qu'un sous-ensemble (index/catalog/product) : about_us, contact, cart, checkout, confirmation, product_detail, admin… doivent TOUTES exister.
- PARS DES FICHIERS MAQUETTE, NE LES RÉÉCRIS PAS : pour chaque page, prends le mockups/<page>.html existant comme base et copie-le tel quel dans le dossier servi. N'écris pas un nouveau HTML depuis zéro.
- NAVIGATION COHÉRENTE — ZÉRO LIEN MORT : chaque <a href="X.html"> doit pointer vers une page qui EXISTE réellement dans le dossier servi. N'invente pas de liens (vision.html, etc.). Câble le tunnel d'achat : panier (cart.html) → checkout.html → confirmation.html, et rends checkout/confirmation ATTEIGNABLES depuis la navigation (pas des pages orphelines accessibles uniquement par URL directe).
- TOKENS CSS SERVIS : si une feuille fait @import d'un tokens.css, copie ce tokens.css DANS le dossier servi et corrige le chemin pour qu'il soit relatif au dossier servi (jamais ../design/… qui sort de la racine du site). Toutes les variables var(--…) doivent être résolues.
- CSS — RÉUTILISE LE CSS DE LA MAQUETTE TEL QUEL : copie le(s) fichier(s) CSS de la maquette dans le MÊME dossier que les pages et garde EXACTEMENT le même <link> que la maquette (si elle lie "styles.css", lie "styles.css" — ne lie pas tokens.css/layout.css en direct, ne re-découpe pas, ne renomme pas en style.css/main.css).
- NOMS DE CLASSES IDENTIQUES : garde STRICTEMENT les mêmes class="..." que la maquette. N'invente AUCUNE nouvelle classe (ex: ne remplace pas .product-card par .feature-card). Chaque classe utilisée dans le HTML DOIT avoir sa règle CSS dans le CSS lié — sinon la page est non stylée et les images apparaissent dans des conteneurs vides.
- Couleurs / tokens : reprends EXACTEMENT les mêmes variables CSS et valeurs hex. N'invente AUCUNE nouvelle couleur, AUCUN nouveau thème (pas de sombre si la maquette est claire, etc.).
- Structure / layout de chaque page : reproduis la mise en page des maquettes (header, sections, grille, footer).
- Identité / marque : reprends le MÊME nom (artiste, produit, marque) et le MÊME contenu (bio, textes) que les sources. N'invente AUCUN nouveau nom ni nouvelle identité.
- IMAGES : garde EXACTEMENT les mêmes balises <img> / src que la maquette (mêmes URLs ou mêmes chemins). Ne supprime pas d'images, n'en change pas les chemins. N'utilise JAMAIS de placeholder SVG gris (data:image/svg+xml avec un rectangle + texte) à la place d'une vraie image de la maquette.
- Ton rôle = rendre la maquette FONCTIONNELLE (JS, panier, navigation) PAR-DESSUS, sans toucher au rendu visuel.
- Si les sources se CONTREDISENT (ex: deux noms d'artiste différents), choisis-en UNE seule, applique-la partout, et signale la contradiction en commentaire — ne crée JAMAIS une troisième version.
INTERDIT : repartir d'une page blanche, réécrire le HTML, renommer des classes CSS, re-découper/renommer le CSS, changer la palette, renommer l'identité, supprimer des images.`;
  const fidelityMandate = !reproduces
    ? ""
    : hasWebArtifacts
      ? webMandate
      : hasAuthoritativeSource
        ? neutralMandate
        : "";

  return `[RÉSULTATS DES AGENTS PRÉCÉDENTS]\nLes agents suivants ont déjà terminé leur travail. Utilise leurs résultats comme base.\n\n${blocks.join("\n\n")}${fidelityMandate}`;
}

// ── Règles par type d'agent ──────────────────────────────────────────────────

// Politique CSS & images partagée — cause n°1 des rendus cassés (pages sans CSS,
// images qui ne s'affichent jamais). Injectée dans chaque type d'agent produisant
// du HTML pour garantir un rendu autonome et hors-ligne.
const ASSET_POLICY = `RÈGLES CSS & IMAGES (CAUSE N°1 DES RENDUS CASSÉS — STRICT) :
- IMAGES — INTERDIT ABSOLU d'utiliser une URL d'image externe (unsplash.com, images.unsplash.com, picsum.photos, placeholder.com, loremflickr, source.unsplash…). Ces identifiants sont INVENTÉS, renvoient 404, et l'image ne s'affiche JAMAIS. À la place, pour toute illustration sans fichier image réel dans le workspace : insère un SVG INLINE (<svg viewBox> avec un fond aux couleurs de la marque, une forme/icône simple et un court label). Un SVG inline s'affiche TOUJOURS, hors-ligne, sans dépendance. N'écris une balise <img src="chemin"> QUE si ce fichier existe réellement dans le workspace, avec un chemin relatif correct.
- CSS — chaque page doit rester stylée même ouverte seule. UN SEUL fichier CSS d'entrée nommé "styles.css", dans le MÊME dossier que les pages HTML. Chaque page le lie par EXACTEMENT <link rel="stylesheet" href="styles.css">. Si tu découpes le CSS (tokens, layout…), c'est "styles.css" qui les rassemble via @import (chemins relatifs au même dossier) — les pages ne lient JAMAIS tokens.css/layout.css en direct. Un seul nom de fichier, un seul dossier : jamais "style.css" ici et "styles.css" là, jamais "css/" et "assets/css/" en parallèle.
- VÉRIFICATION FINALE : chaque href/src local pointe vers un fichier réellement présent (ou un SVG inline). Zéro lien cassé, zéro page sans CSS.`;

const QUALITY_RULES: Record<string, string> = {
  code: `RÈGLES DE QUALITÉ :
- Code COMPLET, PRODUCTION-READY — pas de placeholders, pas de "// TODO", pas de "...", pas de raccourcis
- TypeScript strict, pas de \`any\` sauf aux frontières de sérialisation
- Fonctions < 50 lignes, fichiers < 400 lignes
- Gestion d'erreurs explicite à chaque niveau
- Pas de secrets en dur — utiliser les variables d'environnement
- Inclure TOUS les imports nécessaires
- Écrire les tests unitaires correspondants
- PROFONDEUR : chaque fichier doit être complet et fonctionnel — pas de fonction vide, pas de "à compléter"
- VOLUME : si la tâche demande N fichiers, produis-les TOUS intégralement
- Chaque composant doit être branché, importé et utilisable sans modification

SI TU PRODUIS DES PAGES HTML (livrable web) :
- SEO OBLIGATOIRE par page : <title> unique ≤60 chars, <meta name="description"> 120-160 chars, Open Graph complet (og:title, og:description, og:image), JSON-LD schema.org adapté, attribut lang sur <html>, attributs alt sur toutes les images
- sitemap.xml et robots.txt si le site a plusieurs pages

SI TU PRODUIS UNE LIBRAIRIE / CLI / API / DES DONNÉES (PAS un site web) — IGNORE les règles HTML/CSS/SEO ci-dessus :
- LIBRAIRIE : API publique claire et documentée, tests unitaires réels (qui vérifient un comportement, pas des stubs vides), README avec exemples d'usage, fichier de packaging (package.json / pyproject.toml…).
- CLI : un point d'entrée exécutable, parsing d'arguments, messages d'aide (--help), codes de sortie, exemples dans le README.
- API : endpoints implémentés ET fonctionnels (pas juste décrits), validation des entrées, gestion d'erreurs, exemples de requêtes/réponses.
- DONNÉES : fichiers .json/.csv VALIDES (JSON qui parse, colonnes CSV cohérentes), schéma documenté, script de génération reproductible si pertinent.
- Le frontend/consommateur doit RÉELLEMENT utiliser ce que tu produis (importer le module, lire les données) — pas de code mort jamais référencé.

SI DES MAQUETTES OU UN DESIGN SYSTEM EXISTENT DÉJÀ (dépendances design/work OU fichiers du workspace) :
- LIS d'abord les fichiers de design existants (tokens.css, design_system/*, mockups/*.html, mockups/*.css, content/*.md) AVANT d'écrire la moindre ligne. Ils font AUTORITÉ.
- REPRODUIS-les fidèlement : mêmes variables CSS et mêmes valeurs hex, même typographie, même layout, même identité/marque. Ne redessine PAS, n'invente PAS un nouveau thème ni une nouvelle palette.
- N'invente JAMAIS un nouveau nom d'artiste/marque ni un nouveau contenu : reprends ceux des sources. En cas de contradiction entre sources, choisis-en UNE, applique-la partout, signale-la en commentaire.
- COLOCATION DES ASSETS : place le HTML, le CSS, le JS ET les images/SVG dans le MÊME dossier servi. Si une maquette lie "styles.css", reprends ce MÊME nom et le MÊME dossier — ne renomme pas, ne disperse pas dans css/ + assets/css/.

INTÉGRATION — LE FRONTEND DOIT CONSOMMER CE QUI A ÉTÉ PRODUIT (pas de code mort) :
- Branche réellement le JS produit : les pages servies doivent CHARGER la logique écrite (panier, paiement, stocks) et les données (ex: content/products.json, data/*.json) — n'affiche pas des produits codés en dur si un fichier de données existe.
- NE RÉIMPLÉMENTE PAS une logique déjà écrite dans un autre fichier (ex: ne refais pas un mini-panier dans app.js si cart_logic.js existe) : importe/réutilise le module existant, et SERS-le (place-le dans le dossier servi ou référence-le correctement).
- Si un backend a été produit (API, modèles, schéma), le frontend doit l'appeler (fetch vers les endpoints) OU, pour un site statique, lire les fichiers de données correspondants. Ne laisse JAMAIS un backend ou un module JS écrit mais jamais référencé par aucune page.

${ASSET_POLICY}`,

  design: `RÈGLES DE QUALITÉ — MAQUETTES VISUELLES (RÔLE CRITIQUE) :
Tu es le SEUL agent qui crée les maquettes visuelles. L'agent "code" va ensuite coder EXACTEMENT ce que tu produis. Si ta maquette est incomplète ou bâclée, le site final le sera aussi.

EXIGENCES NON NÉGOCIABLES :
- Code HTML/CSS COMPLET et fonctionnel — pas de descriptions textuelles, pas de résumés, du CODE
- CHAQUE page demandée = un fichier HTML complet avec tout le CSS intégré ou lié
- Design responsive RÉEL avec media queries : mobile (< 768px), tablette (768–1024px), desktop (> 1024px)
- Variables CSS pour TOUS les tokens : couleurs, tailles, espacements, border-radius, ombres, transitions
- Tokens de design documentés dans un fichier dédié (design-tokens.css ou tokens.json)

PROFONDEUR EXIGÉE :
- Design system COMPLET : tokens, composants réutilisables, layouts, grilles
- TOUS les états interactifs : hover, focus, active, disabled, loading, erreur, vide, sélectionné
- Transitions et animations CSS (ease-in-out, durées cohérentes)
- Ombres, border-radius, micro-interactions pour un rendu PROFESSIONNEL
- Typographie hiérarchique complète (h1→h6, body, caption, button, link)
- Palette de couleurs complète avec variantes (primary-50 à primary-900, neutral, accent, success, warning, error)

CONTENU :
- JAMAIS de "Lorem ipsum", JAMAIS de "Titre ici", JAMAIS de placeholder
- Contenu RÉEL et cohérent avec le projet
- Icônes : SVG inline ou sprite — pas de dépendances CDN externes

COMPOSANTS À INCLURE (si pertinents) :
- Header avec navigation (desktop + hamburger mobile)
- Footer complet (liens, copyright, réseaux sociaux)
- Formulaires stylés (inputs, selects, textareas, validation visuelle)
- Boutons (primaire, secondaire, ghost, danger, tailles S/M/L)
- Cards, modales, toasts/notifications, breadcrumbs, pagination
- Tables responsives, listes, badges, tags, tooltips

ACCESSIBILITÉ :
- Contraste WCAG AA minimum (4.5:1 texte, 3:1 composants UI)
- Focus visible et distinct pour navigation clavier
- Aria-labels sur éléments interactifs
- HTML sémantique (header, nav, main, section, article, footer)

NE SOIS PAS RADIN EN TOKENS : une bonne maquette est LONGUE et DÉTAILLÉE. L'objectif est un résultat PRODUCTION-READY que l'agent code pourra implémenter fidèlement.

${ASSET_POLICY}`,

  work: `RÈGLES DE QUALITÉ :
- HTML sémantique et valide (landmarks, headings hiérarchiques, aria-labels)
- Intégration fidèle aux maquettes/spécifications
- Optimisation des assets (images compressées, lazy loading, srcset pour le responsive)
- PROFONDEUR : chaque page doit être COMPLÈTE — pas de contenu tronqué ni de sections "à venir"
- VOLUME : si la tâche mentionne N pages/articles, produire les N en entier avec contenu riche
- Chaque article/page doit faire au minimum 500 mots de contenu réel et pertinent
- Ne pas produire du contenu générique — personnaliser chaque élément au sujet traité
- Charte graphique : produire un document exhaustif (philosophie, palette complète avec codes hex/HSL, typographies avec fallbacks, spacing scale, composants UI)

SI TU PRODUIS DES PAGES HTML :
- SEO OBLIGATOIRE par page : <title> unique ≤60 chars, <meta name="description"> 120-160 chars, Open Graph complet (og:title, og:description, og:image), JSON-LD schema.org adapté au type de page, canonical, attribut lang sur <html>
- Attributs alt descriptifs sur TOUTES les images
- sitemap.xml et robots.txt si multi-pages

${ASSET_POLICY}`,

  verifier: `RÈGLES DE VÉRIFICATION :
- Analyser chaque livrable selon des critères objectifs et mesurables
- Distinguer les erreurs bloquantes (CRITICAL) des améliorations souhaitables (WARNING)
- Fournir des exemples concrets pour chaque problème identifié
- Proposer une CORRECTION COMPLÈTE pour chaque erreur — pas juste la signaler, fournir le code corrigé
- Vérifier la COMPLÉTUDE : le livrable couvre-t-il TOUT ce qui était demandé ?
- Vérifier la PROFONDEUR : le contenu est-il superficiel ou réellement développé ?
- Vérifier la PRÉSENCE des fichiers attendus (expected_files) pour chaque agent
- Ne pas inventer de problèmes — signaler uniquement ce qui est réellement incorrect
- Produire une liste concrète fichier → correction pour chaque problème

SI DES PAGES HTML SONT PRÉSENTES :
- Vérifier le SEO de chaque page : <title> ≤60 chars, <meta description> 120-160, OG, JSON-LD, lang, alt
- Signaler les hot-links placeholder dans du code de production`,

  recherche: `RÈGLES DE QUALITÉ :
- Structurer les résultats avec des sections claires et hiérarchisées
- Citer les sources quand applicable
- Distinguer les faits des recommandations
- Prioriser les informations actionnables
- Fournir un résumé exécutif en début de livrable
- PROFONDEUR : chaque section doit être développée avec exemples, données, contexte historique si pertinent
- VOLUME : ne pas survoler — approfondir chaque point avec au moins 3-5 paragraphes
- Fournir des recommandations concrètes et détaillées, pas des généralités`,
};

function getQualityRules(type: string | undefined): string {
  return QUALITY_RULES[type ?? "code"] ?? QUALITY_RULES.code;
}

const TYPE_ROLE_HINTS: Record<string, string> = {
  recherche: "Investigation et synthèse de données",
  work: "OpenWork — contenu/rédaction, données structurées, et (pour un site) design system, charte, intégration HTML/CSS",
  design:
    "Open Design — maquettes visuelles web (HTML/CSS) DÉTAILLÉES, UNIQUEMENT si le livrable a une interface. L'agent code les reproduira fidèlement.",
  code: "OpenCode — développement du livrable fonctionnel (app, librairie, API, CLI, scripts, données) ; reproduit les maquettes si elles existent",
  verifier: "Tests et assurance qualité",
};

// ── 1. Planning ──────────────────────────────────────────────────────────────

export function buildPlanningSystemPrompt(orchestrator: Project): string {
  const base = orchestrator.instructions || "";
  return `Tu es un coordinateur de projet IA. Tu décomposes une tâche globale en sous-tâches précises pour des agents spécialisés.

${base ? `INSTRUCTIONS PERSONNALISÉES :\n${base}\n` : ""}RÔLE DE CHAQUE TYPE D'AGENT :
- "recherche" → Investigation, collecte de données, état de l'art
- "work" → OpenWork : design system (couleurs, typo, espacements), charte graphique, rédaction de contenu, intégration HTML/CSS
- "design" → Open Design : maquettes visuelles UNIQUEMENT, à partir du design system et contenu déjà produits par "work"/"recherche"
- "code" → OpenCode : codage du site/app depuis les maquettes. Ne fait PAS le design system ni le contenu.
- "verifier" → Tests et assurance qualité

RESPONSABILITÉS :
- Analyser la tâche globale et identifier TOUS les livrables nécessaires
- Attribuer à chaque agent une tâche conforme à son RÔLE ci-dessus
- Assurer la cohérence entre les tâches (pas de contradictions, pas de doublons)
- Respecter les dépendances entre agents

RÈGLES DE DÉCOMPOSITION :
- Chaque tâche = UN livrable vérifiable (pas "fais plusieurs choses")
- Chaque tâche doit être compréhensible sans contexte extérieur
- Préciser le FORMAT DE SORTIE attendu (fichiers à créer, structure, conventions)
- Préciser les CONTRAINTES (technologies, standards, compatibilité)
- Préciser les CRITÈRES DE RÉUSSITE (comment vérifier que c'est bien fait)
- Adapter le niveau de détail au type d'agent

FORMAT DE RÉPONSE :
Renvoie STRICTEMENT un objet JSON plat sans autre texte ni balise markdown.
Les clés sont les identifiants de projet, les valeurs sont les tâches structurées.`;
}

export function buildPlanningUserPrompt(
  globalTask: string,
  linkedProjects: readonly Project[],
  workspaceContext: string,
): string {
  const agentList = linkedProjects
    .map((p) => {
      const deps = p.dependencies ?? [];
      const depInfo =
        deps.length > 0
          ? ` | Dépend de : ${deps.map((d) => linkedProjects.find((lp) => lp.id === d)?.name ?? d).join(", ")}`
          : "";
      const roleHint = TYPE_ROLE_HINTS[p.type ?? ""] ?? "Général";
      return `- ID: "${p.id}" | Nom: "${p.name}" | Type: ${p.type ?? "non défini"} (${roleHint})${depInfo}\n  Compétences : ${p.instructions || "non précisées"}`;
    })
    .join("\n");

  return `TÂCHE GLOBALE :
"${globalTask}"

${workspaceContext}

AGENTS DISPONIBLES :
${agentList}

CONSIGNE :
Respecte les rôles par type — "work" gère les couleurs/charte/contenu, "design" fait les maquettes APRÈS, "code" code DEPUIS les maquettes.
Pour chaque agent, génère une tâche structurée qui contient :
1. OBJECTIF — Ce que l'agent doit produire concrètement
2. CONTEXTE — Ce qu'il doit savoir pour travailler (dépendances, contraintes projet)
3. FORMAT — Les fichiers/livrables attendus avec leur structure
4. CRITÈRES — Comment vérifier que le travail est correct

EXEMPLE DE RÉPONSE :
{
  "p1": "OBJECTIF : Implémenter l'API d'authentification OAuth2 avec refresh tokens.\\nCONTEXTE : L'application utilise Express + PostgreSQL. Les routes doivent être sous /api/auth/.\\nFORMAT : Créer src/auth/router.ts, src/auth/service.ts, src/auth/types.ts et tests/auth.test.ts.\\nCRITÈRES : Les endpoints POST /login, POST /refresh et POST /logout doivent fonctionner. Tests unitaires avec couverture > 80%.",
  "p2": "OBJECTIF : Créer la charte graphique du module d'onboarding.\\nCONTEXTE : Application web B2B, cible professionnelle, style moderne et épuré.\\nFORMAT : Créer design/tokens.css (variables), design/onboarding.css (composants), et un document design/specs.md décrivant les choix.\\nCRITÈRES : Accessibilité WCAG AA, responsive mobile/desktop, palette de 5 couleurs max."
}`;
}

// ── 2. Exécution de node ─────────────────────────────────────────────────────

export interface NodePromptOptions {
  readonly codeFenceFormat?: boolean;
}

export function buildNodeSystemPrompt(
  node: Project,
  opts: NodePromptOptions = {},
): string {
  const { codeFenceFormat = true } = opts;
  const identity = node.instructions || `Agent de type "${node.type ?? "général"}"`;
  const rules = getQualityRules(node.type);

  const fileSection = codeFenceFormat
    ? `FORMAT FICHIERS (OBLIGATOIRE) :
Pour chaque fichier que tu crées, utilise EXACTEMENT ce format :
\`\`\`<lang> filepath: <chemin/relatif/du/fichier>
<contenu intégral du fichier>
\`\`\`
Exemple :
\`\`\`html filepath: articles/01-intro.html
<!DOCTYPE html>
<html>...</html>
\`\`\`
Ne mets JAMAIS de texte explicatif entre les blocs de fichiers. Enchaîne directement les blocs.`
    : `OUTILS FICHIERS :
Tu disposes d'outils de fichiers réels (write, edit, bash…). Écris les fichiers directement dans le workspace.
N'utilise PAS de blocs de code markdown pour livrer des fichiers — utilise les outils à ta disposition.
Travaille dans le répertoire courant du workspace.

EXÉCUTION IMMÉDIATE (CRITIQUE) :
- NE PLANIFIE PAS. NE LISTE PAS les étapes. NE DÉCRIS PAS ce que tu vas faire.
- Commence IMMÉDIATEMENT à écrire les fichiers avec les outils (write/edit).
- Chaque fichier doit être COMPLET et INTÉGRAL — pas de squelettes, pas de "à compléter".
- Si tu lis des fichiers existants, fais-le rapidement puis PRODUIS sans t'arrêter.
- Ton objectif : à la fin de ce message, TOUS les fichiers demandés sont écrits dans le workspace.`;

  return `${identity}

${rules}

COMPORTEMENT ATTENDU :
- Tu travailles dans un workspace partagé avec d'autres agents — ton livrable sera utilisé par les agents suivants
- Produis du contenu de QUALITÉ PROFESSIONNELLE, exhaustif et production-ready
- INTERDIT : contenu superficiel, paragraphes de 2 lignes, fichiers squelettes, "à compléter plus tard"
- OBLIGATOIRE : chaque fichier doit être COMPLET et INTÉGRAL du début à la fin
- Si ta tâche mentionne N éléments (N pages, N composants, N sections), produis-les TOUS en entier
- La qualité de ton travail détermine la qualité du projet final — pas de raccourcis
- Concentre-toi uniquement sur TA tâche assignée

${fileSection}`;
}

export function buildNodeUserPrompt(
  node: Project,
  workspaceContext: string,
  dependencyContext: string,
  expectedFiles: readonly string[] = [],
): string {
  const task = node.task || "Aucune tâche définie.";

  const sections = [`TÂCHE :\n${task}`];

  if (expectedFiles.length > 0) {
    sections.push(
      `CONTRAT DE FICHIERS — OBLIGATOIRE :\nTu DOIS produire EXACTEMENT les fichiers suivants avec ces chemins précis :\n${expectedFiles.map((f) => `- ${f}`).join("\n")}\nUn fichier manquant ou au mauvais chemin = tâche échouée.`,
    );
  }

  if (workspaceContext) {
    sections.push(workspaceContext);
  }

  if (dependencyContext) {
    sections.push(dependencyContext);
  }

  sections.push(
    "RAPPEL CRITIQUE : Produis un livrable EXHAUSTIF et PROFESSIONNEL. Pas de placeholders, pas de résumés, pas de contenu superficiel. Chaque fichier doit être COMPLET du début à la fin — pas de raccourcis. Si ta tâche mentionne N fichiers ou N pages, produis-les TOUS en intégralité. Utilise le format ```<lang> filepath: chemin/fichier pour chaque fichier — le système extraira et écrira automatiquement les fichiers sur le disque.",
  );

  return sections.join("\n\n");
}

// ── 3. Continuation ──────────────────────────────────────────────────────────

export function buildContinuationPrompt(
  node: Project,
  previousText: string,
  attempt: number,
  maxRetries: number,
): string {
  const tail = previousText.slice(-500);
  return `Ta génération précédente a été interrompue (tentative ${attempt}/${maxRetries}).

TÂCHE ORIGINALE :
${node.task || "non définie"}

FIN DE TA DERNIÈRE RÉPONSE :
"""
...${tail}
"""

CONSIGNE : Reprends EXACTEMENT là où tu t'es arrêté. Ne répète pas ce que tu as déjà écrit. Continue directement à partir du point d'interruption ci-dessus.`;
}

// ── 3b. Multi-turn iteration ────────────────────────────────────────────────

export function buildCompletenessCheckPrompt(
  node: Project,
  accumulatedText: string,
): string {
  const tail = accumulatedText.slice(-3000);
  return `TÂCHE ASSIGNÉE :
${node.task || "non définie"}

TRAVAIL PRODUIT JUSQU'ICI (fin) :
"""
...${tail}
"""

QUESTION : La tâche est-elle ENTIÈREMENT accomplie ? Vérifie :
- Tous les fichiers demandés ont-ils été créés ?
- Le contenu est-il complet (pas de sections vides, pas de placeholders) ?
- La qualité est-elle production-ready ?

Réponds STRICTEMENT par un JSON :
{"complete": true} ou {"complete": false, "missing": "description précise de ce qui manque"}`;
}

export function buildIterationPrompt(
  node: Project,
  accumulatedText: string,
  missing: string,
  iteration: number,
  maxIterations: number,
): string {
  const tail = accumulatedText.slice(-8000);
  return `ITÉRATION ${iteration}/${maxIterations} — CONTINUATION DE TA TÂCHE

TÂCHE ORIGINALE :
${node.task || "non définie"}

CE QUI A DÉJÀ ÉTÉ PRODUIT (fin) :
"""
...${tail}
"""

CE QUI MANQUE ENCORE :
${missing}

CONSIGNE : Produis UNIQUEMENT ce qui manque. Ne répète PAS ce qui a déjà été produit. Utilise le format \`\`\`<lang> filepath: chemin/fichier pour chaque nouveau fichier. Si tu dois compléter un fichier existant, reproduis-le EN ENTIER avec les ajouts.`;
}

// ── 4. Vérification pré-exécution ────────────────────────────────────────────

export function buildVerifyPromptsSystemPrompt(verifier: Project): string {
  return `${verifier.instructions || "Tu es un vérificateur de qualité d'instructions."}

RÔLE : Analyser un ensemble d'instructions générées pour des agents IA et vérifier leur qualité AVANT exécution.

Tu évalues selon une CHECKLIST STRICTE. Chaque critère est noté OK ou PROBLÈME.`;
}

export function buildVerifyPromptsUserPrompt(
  globalTask: string,
  promptsMap: Record<string, string>,
  linkedProjects: readonly Project[],
): string {
  const projectContext = linkedProjects
    .map((p) => `- "${p.id}" = "${p.name}" (${p.type ?? "non défini"})`)
    .join("\n");

  return `TÂCHE GLOBALE : "${globalTask}"

AGENTS :
${projectContext}

INSTRUCTIONS GÉNÉRÉES :
${JSON.stringify(promptsMap, null, 2)}

CHECKLIST DE VÉRIFICATION :
1. COUVERTURE — Chaque aspect de la tâche globale est-il couvert par au moins un agent ?
2. COHÉRENCE — Les instructions ne se contredisent-elles pas entre agents ?
3. CLARTÉ — Chaque instruction est-elle compréhensible sans contexte supplémentaire ?
4. COMPLÉTUDE — Chaque instruction précise-t-elle l'objectif, le format et les critères de réussite ?
5. DÉPENDANCES — Les agents dépendants ont-ils les informations nécessaires ?
6. FAISABILITÉ — Chaque tâche est-elle réalisable par un seul agent ?

Réponds STRICTEMENT par un JSON valide :
{
  "valid": true ou false,
  "checks": {
    "couverture": {"ok": true/false, "detail": "..."},
    "coherence": {"ok": true/false, "detail": "..."},
    "clarte": {"ok": true/false, "detail": "..."},
    "completude": {"ok": true/false, "detail": "..."},
    "dependances": {"ok": true/false, "detail": "..."},
    "faisabilite": {"ok": true/false, "detail": "..."}
  },
  "reason": "Résumé global si invalide"
}`;
}

// ── 5. Vérification post-exécution ───────────────────────────────────────────

export function buildVerifyOutputSystemPrompt(verifier: Project): string {
  return `${verifier.instructions || "Tu es un réviseur de code et de livrables."}

RÔLE : Vérifier qu'un livrable produit par un agent IA répond aux attentes de sa tâche assignée.

Tu évalues selon des critères objectifs. Tu ne valides PAS par défaut — tu cherches activement les problèmes.`;
}

export function buildVerifyOutputUserPrompt(
  node: Project,
  resultText: string,
  diskEvidence = "",
): string {
  const typeChecks: Record<string, string> = {
    code: `CRITÈRES SPÉCIFIQUES (code) :
- Le code est-il syntaxiquement correct ?
- Les imports sont-ils présents et cohérents ?
- La gestion d'erreurs est-elle présente ?
- Y a-t-il des placeholders ou TODOs non résolus ?
- Les fichiers sont-ils nommés avec leur chemin ?`,
    design: `CRITÈRES SPÉCIFIQUES (design) :
- Les styles CSS sont-ils complets et valides ?
- Les variables de design sont-elles définies ?
- L'accessibilité est-elle prise en compte ?
- Le responsive est-il adressé ?`,
    work: `CRITÈRES SPÉCIFIQUES (intégration) :
- Le HTML est-il sémantique et valide ?
- L'intégration correspond-elle aux spécifications ?
- Les assets sont-ils référencés correctement ?`,
    verifier: `CRITÈRES SPÉCIFIQUES (vérification) :
- L'analyse est-elle structurée et objective ?
- Les problèmes identifiés sont-ils réels et documentés ?
- Des corrections sont-elles proposées ?`,
    recherche: `CRITÈRES SPÉCIFIQUES (recherche) :
- Les résultats sont-ils structurés ?
- Les sources sont-elles citées ?
- Les recommandations sont-elles actionnables ?`,
  };

  const specificChecks = typeChecks[node.type ?? "code"] ?? typeChecks.code;

  const MAX_EXCERPT = 6000;
  let excerpt: string;
  if (resultText.length <= MAX_EXCERPT) {
    excerpt = resultText;
  } else {
    const headLen = Math.floor(MAX_EXCERPT * 0.6);
    const tailLen = MAX_EXCERPT - headLen;
    excerpt =
      resultText.substring(0, headLen) +
      `\n\n[… ${resultText.length - headLen - tailLen} caractères omis …]\n\n` +
      resultText.substring(resultText.length - tailLen);
  }

  const diskSection = diskEvidence.trim()
    ? `FICHIERS RÉELLEMENT SUR LE DISQUE (SOURCE DE VÉRITÉ) :
Voici les fichiers attendus, lus directement depuis le workspace. C'est l'état réel du livrable — juge À PARTIR DE CECI, pas du message de l'agent ci-dessous.
✓ = présent, ✗ = absent.
---
${diskEvidence}
---
RÈGLE : Un fichier marqué ✓ EXISTE — ne le déclare JAMAIS "manquant". Un fichier dont le contenu est lisible ici n'est PAS "tronqué" même si le message de l'agent semblait coupé. Ne te base QUE sur les fichiers ci-dessus pour juger présence et complétude.

`
    : "";

  return `AGENT : "${node.name}" (type: ${node.type ?? "non défini"})
TÂCHE ASSIGNÉE : "${node.task ?? "non définie"}"
LONGUEUR TOTALE DU MESSAGE DE L'AGENT : ${resultText.length} caractères

${diskSection}MESSAGE DE L'AGENT (contexte — peut être un résumé ou un extrait, NON autoritatif) :
---
${excerpt}
---

IMPORTANT : ${diskEvidence.trim() ? "Les fichiers sur disque ci-dessus font foi. Le message de l'agent n'est qu'un contexte." : `Si le message dépasse ${MAX_EXCERPT} caractères, tu vois un extrait (début + fin). NE PAS signaler "tronqué" ou "incomplet" simplement parce que le milieu est omis — évalue la structure globale (ouverture, fermeture, cohérence).`}

CRITÈRES GÉNÉRAUX :
- Le livrable répond-il à la tâche assignée ?
- Le livrable est-il complet (pas de sections manquantes visibles dans l'extrait) ?
- Le livrable est-il utilisable en l'état ?
- Y a-t-il des erreurs évidentes ?

${specificChecks}

Réponds STRICTEMENT par un JSON valide :
{
  "valid": true ou false,
  "score": 0-100,
  "issues": [{"severity": "critical|warning|info", "description": "..."}],
  "reason": "Résumé si invalide"
}`;
}

// ── 6. Conformité marque ─────────────────────────────────────────────────────

export function buildBrandComplianceSystemPrompt(verifier: Project): string {
  return `${verifier.instructions || "Tu es le gardien de la charte de marque."}

RÔLE : Vérifier que les livrables produits respectent le guide de style et la charte graphique du projet.

Tu compares les livrables aux spécifications de la marque et signales tout écart.`;
}

export function buildBrandComplianceUserPrompt(brandGuidelines: string): string {
  return `GUIDE DE STYLE ET DE MARQUE :
---
${brandGuidelines}
---

GRILLE D'ÉVALUATION :
1. COULEURS — Les couleurs utilisées correspondent-elles à la palette définie ?
2. TYPOGRAPHIE — Les polices et tailles sont-elles conformes ?
3. ESPACEMENTS — Les marges et paddings suivent-ils la grille ?
4. TONALITÉ — Le ton rédactionnel est-il cohérent avec la marque ?
5. COMPOSANTS — Les composants UI respectent-ils les patterns définis ?

Réponds STRICTEMENT par un JSON valide :
{
  "valid": true ou false,
  "checks": {
    "couleurs": {"ok": true/false, "detail": "..."},
    "typographie": {"ok": true/false, "detail": "..."},
    "espacements": {"ok": true/false, "detail": "..."},
    "tonalite": {"ok": true/false, "detail": "..."},
    "composants": {"ok": true/false, "detail": "..."}
  },
  "reason": "Explication des écarts de marque"
}`;
}

// ── 7. Indexeur workspace ────────────────────────────────────────────────────

export function buildWorkspaceIndexSystemPrompt(): string {
  return "Tu es un analyste de documentation projet. Tu extrais les informations de fichiers créés ou modifiés à partir du résultat d'un agent et tu les formates pour un registre de workspace.";
}

export function buildWorkspaceIndexUserPrompt(node: Project, resultText: string): string {
  return `AGENT : "${node.name}" (type: ${(node.type ?? "code").toUpperCase()})

RÉSULTAT DE L'AGENT :
---
${resultText.substring(0, 3000)}
---

CONSIGNE :
Analyse le résultat ci-dessus et extrais :
1. Les NOUVEAUX FICHIERS créés (chemin + fonction en une phrase)
2. Une LIGNE DE CHANGELOG résumant ce que l'agent a fait

Réponds STRICTEMENT par un JSON valide :
{
  "newFiles": "| chemin/du/fichier | Fonction courte |\\n| chemin/autre | Fonction |",
  "changelogLine": "| ${new Date().toLocaleDateString("fr-FR")} | ${node.name} | fichiers modifiés | Description des changements |"
}

Si aucun fichier n'a été créé, mets "newFiles" à "".`;
}

// ── 8. Décomposition en sous-étapes ──────────────────────────────────────────

export interface SubStep {
  readonly index: number;
  readonly title: string;
  readonly focus: string;
  readonly deliverable: string;
}

export interface SubStepResult {
  readonly index: number;
  readonly title: string;
  readonly output: string;
}

export function buildDecomposeSystemPrompt(node: Project): string {
  const identity = node.instructions || `Agent de type "${node.type ?? "général"}"`;
  const rules = getQualityRules(node.type);

  return `${identity}

${rules}

RÔLE ACTUEL : Tu dois analyser une tâche complexe et la découper en étapes séquentielles avant de l'exécuter.

Chaque étape doit être :
- FOCALISÉE sur un seul aspect ou livrable
- SÉQUENTIELLE — les étapes s'exécutent dans l'ordre, chaque étape peut s'appuyer sur les précédentes
- CONCRÈTE — décrit ce qui doit être produit, pas une intention vague`;
}

export function buildDecomposeUserPrompt(
  node: Project,
  workspaceContext: string,
  depContext: string,
): string {
  const sections = [`TÂCHE À DÉCOMPOSER :\n"${node.task ?? "non définie"}"`];

  if (workspaceContext) sections.push(workspaceContext);
  if (depContext) sections.push(depContext);

  sections.push(`CONSIGNE :
Découpe cette tâche en 2 à 8 étapes séquentielles. Chaque étape sera exécutée indépendamment par le même agent, avec les résultats des étapes précédentes en contexte.

Réponds STRICTEMENT par un JSON valide (array), sans autre texte ni balise markdown :
[
  {
    "title": "Titre court de l'étape",
    "focus": "Description précise de ce que cette étape doit accomplir",
    "deliverable": "Le livrable concret attendu (fichiers, code, document...)"
  }
]

RÈGLES :
- Minimum 2 étapes, maximum 8
- Chaque étape = UN livrable vérifiable
- Les étapes doivent couvrir 100% de la tâche originale
- Ordonne les étapes logiquement (fondations d'abord, finitions ensuite)
- La dernière étape devrait finaliser/intégrer le travail`);

  return sections.join("\n\n");
}

export function buildSubStepUserPrompt(
  _node: Project,
  step: SubStep,
  totalSteps: number,
  previousResults: readonly SubStepResult[],
  workspaceContext: string,
  depContext: string,
): string {
  const sections = [
    `ÉTAPE ${step.index + 1}/${totalSteps} : ${step.title}`,
    `FOCUS :\n${step.focus}`,
    `LIVRABLE ATTENDU :\n${step.deliverable}`,
  ];

  if (previousResults.length > 0) {
    const prevBlocks = previousResults.map(
      (r) => `--- Étape ${r.index + 1} : ${r.title} ---\n${r.output.substring(0, 6000)}`,
    );
    sections.push(`[RÉSULTATS DES ÉTAPES PRÉCÉDENTES]\n${prevBlocks.join("\n\n")}`);
  }

  if (workspaceContext) sections.push(workspaceContext);
  if (depContext) sections.push(depContext);

  sections.push(
    "RAPPEL : Produis le livrable de CETTE ÉTAPE uniquement. Code/contenu complet, pas de placeholders.",
  );

  return sections.join("\n\n");
}

export function buildSynthesisSystemPrompt(node: Project): string {
  const identity = node.instructions || `Agent de type "${node.type ?? "général"}"`;

  return `${identity}

RÔLE ACTUEL : Tu dois fusionner les résultats de plusieurs sous-étapes en un livrable final cohérent et complet.

RÈGLES :
- Fusionne les résultats sans redondance ni contradiction
- Le livrable final doit être utilisable en l'état
- Si des fichiers ont été produits, consolide-les avec leur chemin complet
- Corrige les incohérences entre étapes si nécessaire
- Ne perds aucun contenu important des sous-étapes`;
}

export function buildSynthesisUserPrompt(
  node: Project,
  subStepResults: readonly SubStepResult[],
): string {
  const MAX_RESULT_PER_STEP = 6000;
  const resultBlocks = subStepResults.map(
    (r) =>
      `--- Étape ${r.index + 1} : ${r.title} ---\n${r.output.substring(0, MAX_RESULT_PER_STEP)}`,
  );

  return `TÂCHE ORIGINALE :
"${node.task ?? "non définie"}"

RÉSULTATS DES ${subStepResults.length} SOUS-ÉTAPES :

${resultBlocks.join("\n\n")}

CONSIGNE :
Produis le livrable FINAL en fusionnant tous les résultats ci-dessus. Le résultat doit être complet, cohérent, et prêt à être utilisé sans référence aux sous-étapes.`;
}

// ── 9. Planification itérative (boucle agentic) ────────────────────────────

export function buildIterativePlanningSystemPrompt(orchestrator: Project): string {
  const base = orchestrator.instructions || "";
  return `Tu es le coordinateur d'une équipe d'agents IA. Tu planifies les tâches de manière itérative en utilisant les outils fournis.

${base ? `INSTRUCTIONS PERSONNALISÉES :\n${base}\n` : ""}RÔLE DE CHAQUE TYPE D'AGENT (CRITIQUE — respecte cette répartition) :
- "recherche" → Investigation, collecte de données, état de l'art, veille. Produit des documents de synthèse, plans, recommandations.
- "work" → OpenWork : production de CONTENU et d'assets — rédaction (articles, documents, ebook, marketing), données structurées (.md/.json/.csv), et pour un site : design system (couleurs, typo, espacements), charte graphique, intégration HTML/CSS. Pour un livrable visuel, c'est lui qui définit les couleurs, pas le designer.
- "design" → Open Design : création de MAQUETTES visuelles web (HTML/CSS) UNIQUEMENT, pertinent SEULEMENT si le livrable a une interface. Il ne choisit PAS les couleurs ni le design system — il les REÇOIT des agents "work"/"recherche". N'assigne un agent "design" QUE pour un site/app web.
- "code" → OpenCode : développement et codage. Produit le livrable fonctionnel : application, librairie, API, CLI, scripts, ou structuration de données. S'il existe des maquettes, il les reproduit fidèlement ; sinon il code à partir de la spécification, des données ou du contenu fournis.
- "verifier" → Tests et assurance qualité. Vérifie les livrables des autres agents.

ÉTABLIR LES DÉPENDANCES SELON LES LIVRABLES RÉELS (pas un pipeline figé) :
- Crée les agents et les dépendances dont le LIVRABLE a réellement besoin. N'insère PAS d'agent "design"/maquette ni de dépendance vers lui si le livrable n'a pas d'interface visuelle (ex: librairie de code, API, rapport, ebook, données, CV).
- NE PAS donner la rédaction de contenu à un agent "code" → c'est le rôle de "work"
- NE PAS donner le codage final à un agent "work" → c'est le rôle de "code"
- Si un agent "design" produit des maquettes, alors l'agent "code" qui les implémente doit en dépendre ; sinon, fais dépendre "code" de ce qui le nourrit réellement (spécification, données, schéma, contenu).
- Un agent dépend de ceux qui produisent ce dont il a besoin en entrée — déduis-le du livrable, ne l'impose pas par défaut.

SI LA TÂCHE EST UN SITE/APP WEB — IMPORTANCE DE L'AGENT DESIGN (exemple de pipeline web) :
L'agent "design" produit les maquettes HTML/CSS qui servent de RÉFÉRENCE VISUELLE pour l'agent "code". Pour un site, c'est un rôle CRITIQUE.
- Donne-lui des instructions TRÈS DÉTAILLÉES : pages à créer, composants à inclure, style attendu, contenu à intégrer
- Demande EXPLICITEMENT la complétude : tous les états (hover, focus, erreur, vide, loading), responsive (mobile/tablette/desktop), composants de navigation
- L'agent design itère automatiquement pour améliorer ses maquettes — donne-lui un cahier des charges riche pour qu'il ait matière à travailler
- N'hésite PAS sur le volume — une maquette complète fait 500+ lignes HTML/CSS par page, c'est normal

PROCESSUS :
1. Analyse la tâche globale et identifie les livrables nécessaires
2. Réfléchis à la répartition optimale en respectant les rôles ci-dessus
3. Pour chaque agent, utilise assign_task pour lui assigner une tâche structurée
4. Si une tâche est complexe, fournis des sous-étapes via le paramètre "steps"
5. Quand TOUS les agents ont une tâche, appelle finish_planning

QUALITÉ DES TÂCHES :
Chaque tâche assignée DOIT être EXHAUSTIVE et DÉTAILLÉE. Tu ne donnes PAS une consigne vague — tu donnes un cahier des charges complet.
Chaque tâche DOIT contenir ces 4 sections :
- OBJECTIF — Ce que l'agent doit produire concrètement, avec le VOLUME attendu (nombre de fichiers, nombre de pages, longueur minimale)
- CONTEXTE — Ce qu'il doit savoir (contraintes, dépendances, standards, public cible, ton, style)
- FORMAT — La LISTE EXHAUSTIVE des fichiers/livrables attendus avec leur structure et contenu minimum
- CRITÈRES — Critères de qualité MESURABLES (nombre de mots min, couverture, accessibilité, SEO, etc.)

CONTRAT DE LIVRABLES (expected_files) — CRITIQUE :
Pour chaque agent work/code/design, utilise le paramètre "expected_files" de assign_task pour lister les fichiers que l'agent DOIT produire.
C'est un CONTRAT : un fichier absent = tâche échouée + relance automatique. Sois exhaustif.
Exemple : expected_files: ["src/index.html", "src/styles/main.css", "src/components/header.html"]
Ceci est GÉNÉRIQUE — fonctionne pour tout type de livrable (.py, .md, .json, .css, .html, etc.).

CRITÈRES MESURABLES — OBLIGATOIRE :
Chaque tâche assignée doit avoir des critères de réussite MESURABLES :
- MAUVAIS : "résultat complet", "code détaillé"
- BON : "10 pages HTML", "≥ 500 mots par article", "couverture tests > 80%", "3 fichiers CSS"
Les termes vagues SEULS ("complet", "détaillé", "professionnel") sont INSUFFISANTS — ajoute TOUJOURS un seuil concret.

COUVERTURE OBLIGATOIRE SELON LE DOMAINE DU LIVRABLE (applique le bloc pertinent) :
- SI SITE/APP WEB → SEO (sitemap.xml, robots.txt, JSON-LD, title/meta/OG par page) ; SÉCURITÉ (corriger les failles dans le code livré si données utilisateur) ; BACKEND dédié si persistance/API/auth ; ACCESSIBILITÉ WCAG AA (contraste, alt, aria, focus).
- SI LIBRAIRIE / CLI / API (sans front) → dans expected_files : le code source COMPLET, des TESTS unitaires réels, un README avec exemples d'usage, et (CLI) un point d'entrée exécutable / (API) une spec des endpoints. Pas de SEO/maquette.
- SI DOCUMENT LONG (ebook, business plan, plan de cours, wiki, CV) → table des matières/structure, N sections/chapitres explicites, longueur minimale par section, sources si pertinent (+ pour un cours : exercices ET corrigés).
- SI DONNÉES / ANALYSE → fichiers de données (.csv/.json) VALIDES, un script reproductible, des graphiques/visualisations, et une interprétation écrite des résultats.
- SI PRÉSENTATION / SLIDES → N slides explicites avec titres + contenu réel (pas de slides vides) et, si utile, des notes de présentateur.
- SI CONTENU MARKETING (emails, posts, pages) → cohérence cross-canal (même offre/ton/CTA partout), nombre de pièces explicite par canal.

PROFONDEUR REQUISE :
- L'objectif d'un système multi-agents est de produire un résultat SUPÉRIEUR à ce qu'un seul agent ferait
- Chaque agent doit produire un livrable EXHAUSTIF dans son domaine — pas un survol
- Exemple : un agent "charte graphique" ne produit pas 1 fichier CSS — il produit un guide de marque complet (philosophie, palette détaillée, typographies avec fallbacks, spacing scale, composants, états, animations, documentation)
- Exemple : un agent "rédaction" ne produit pas 2 paragraphes par article — il produit 500+ mots par article avec introduction, développement structuré, conclusion
- Si tu penses qu'un agent pourrait produire 10 fichiers, demande-lui 10 fichiers explicitement

SOUS-AGENTS (create_sub_agent) :
Tu peux créer des SOUS-AGENTS pour diviser le travail d'un agent parent.
- Utilise create_sub_agent quand un agent a une tâche trop large pour être faite en un seul flux
- Chaque sous-agent a son propre type, sa propre tâche, et s'exécute AVANT son parent
- Le parent recevra les résultats de ses sous-agents comme contexte de dépendances
- Exemple : l'agent "Work" a 3 tâches distinctes (charte graphique, rédaction contenu, intégration HTML) → crée 3 sous-agents de type "work" sous lui
- Exemple : l'agent "Code" doit coder le frontend ET le backend → crée 2 sous-agents de type "code"
- Les sous-agents peuvent avoir leurs propres dépendances (depends_on)
- IMPORTANT : chaque sous-agent est un vrai agent avec multi-turn — il fait PLUSIEURS appels LLM pour compléter sa tâche
- Préfère les sous-agents aux sous-étapes (steps) pour les tâches volumineuses — les sous-agents sont indépendants et peuvent exploiter le multi-turn

QUAND AJOUTER DES SOUS-ÉTAPES (steps) vs SOUS-AGENTS :
- Sous-agents : quand les tâches sont INDÉPENDANTES et peuvent être parallélisées (ex: rédiger 3 articles différents)
- Sous-étapes : quand les tâches sont SÉQUENTIELLES et chacune dépend de la précédente (ex: analyse → conception → production)
- Maximum 8 sous-étapes par agent, pas de limite stricte sur les sous-agents

DÉPENDANCES (depends_on) :
- Utilise le paramètre depends_on pour indiquer quels agents doivent terminer AVANT un autre
- Exemple : un agent "Intégration" qui dépend de "Design" et "Rédaction" → depends_on: [id_design, id_redaction]
- Les agents sans depends_on s'exécutent en premier
- TOUJOURS spécifier depends_on quand un agent a besoin du résultat d'un autre

COHÉRENCE D'IDENTITÉ — CRITIQUE :
Le projet a UNE seule identité (nom de marque/artiste/produit, positionnement, ton, langue). Tu dois la FIXER une fois et la PROPAGER à TOUTES les tâches.
- Si la tâche globale précise un nom/une marque, reprends-le tel quel partout.
- Sinon, CHOISIS un nom unique et écris-le EXPLICITEMENT dans CHAQUE tâche (work, design, code) : "L'artiste/la marque s'appelle « X »".
- Fixe aussi la LANGUE du livrable et impose-la à tous les agents (pas de mélange français/anglais).
- Les agents en aval n'ont PAS le droit d'inventer une autre identité : c'est la cause n°1 d'incohérence (deux noms différents entre maquette et contenu).
- L'agent qui définit l'identité visuelle (work) la définit en premier ; design et code la reçoivent et la respectent À L'IDENTIQUE.

RÈGLES :
- Commence par les agents sans dépendances, puis ceux qui en ont
- Assure la cohérence entre les tâches (même identité, même langue, pas de contradictions, pas de doublons)
- Adapte le niveau de détail au type d'agent
- Tu peux assigner les agents dans l'ordre que tu veux, un par un ou par groupes`;
}

export function buildIterativePlanningUserPrompt(
  globalTask: string,
  linkedProjects: readonly Project[],
  workspaceContext: string,
): string {
  const agentList = linkedProjects
    .map((p) => {
      const deps = p.dependencies ?? [];
      const depInfo =
        deps.length > 0
          ? ` | Dépend de : ${deps.map((d) => linkedProjects.find((lp) => lp.id === d)?.name ?? d).join(", ")}`
          : "";
      const roleHint = TYPE_ROLE_HINTS[p.type ?? ""] ?? "Général";
      return `- ID: "${p.id}" | Nom: "${p.name}" | Type: ${p.type ?? "non défini"} (${roleHint})${depInfo}\n  Compétences : ${p.instructions || "non précisées"}`;
    })
    .join("\n");

  return `TÂCHE GLOBALE À RÉPARTIR :
"${globalTask}"

${workspaceContext}

AGENTS DISPONIBLES (${linkedProjects.length}) :
${agentList}

RAPPEL : Respecte les rôles par type — "work" gère les couleurs/charte/contenu, "design" fait les maquettes APRÈS, "code" code le site DEPUIS les maquettes.

Analyse la tâche, puis assigne une tâche structurée à chaque agent avec assign_task. Quand tous ont une tâche, appelle finish_planning.`;
}
