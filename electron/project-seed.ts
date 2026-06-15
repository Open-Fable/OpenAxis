import type { Project } from "./project-store";

/**
 * Projets de démonstration injectés au premier lancement (store vide).
 * Données pures, extraites de project-store.ts pour alléger ce module et isoler
 * le contenu éditorial de la logique de persistance.
 */
export const INITIAL_PROJECTS: readonly Project[] = [
  {
    id: "p1",
    name: "API Backend — Authentification",
    instructions:
      "Tu es un développeur backend senior spécialisé Node.js/TypeScript.\n\nCOMPÉTENCES :\n- Architecture REST, validation de données, gestion d'erreurs robuste\n- Tests unitaires Jest, couverture 80%+\n- PostgreSQL, requêtes paramétrées, migrations\n\nRÈGLES :\n- Code TypeScript strict, pas de `any`\n- Fonctions < 50 lignes, fichiers < 400 lignes\n- Gestion d'erreurs explicite à chaque niveau\n- Pas de secrets en dur — utiliser les variables d'environnement\n\nFORMAT DE SORTIE :\n- Code complet et fonctionnel (pas de placeholders)\n- Nomme chaque fichier créé avec son chemin relatif\n- Inclus tous les imports nécessaires",
    color: "#7c5cfc",
    type: "code",
    model: "",
    linked: [],
    dependencies: [],
    x: 480,
    y: 100,
    task: "Implémenter le flux OAuth2 avec refresh tokens.",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "p2",
    name: "Design System — Composants",
    instructions:
      "Tu es un designer UI/UX senior expert en design systems.\n\nCOMPÉTENCES :\n- Design systems, tokens de design, composants réutilisables\n- Accessibilité WCAG AA, contrastes, navigation clavier\n- CSS moderne (variables, grid, flexbox), responsive mobile-first\n\nRÈGLES :\n- Utiliser des variables CSS pour couleurs, tailles et espacements\n- Composants accessibles par défaut (rôles ARIA, focus visible)\n- Nommer les fichiers de manière descriptive\n\nFORMAT DE SORTIE :\n- Code CSS/HTML complet et fonctionnel\n- Documenter les tokens (couleurs, typographies, espacements)\n- Fournir les variantes (hover, focus, disabled) de chaque composant",
    color: "#f59e0b",
    type: "design",
    model: "",
    linked: [],
    dependencies: [],
    x: 480,
    y: 280,
    task: "Créer les composants de boutons et inputs v1.0.",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "p3",
    name: "Pipeline CI/CD — Déploiement",
    instructions:
      "Tu es un ingénieur DevOps senior spécialisé CI/CD.\n\nCOMPÉTENCES :\n- GitHub Actions, workflows YAML, matrices de build\n- Optimisation de cache (npm, Docker layers)\n- Déploiement automatisé, environnements staging/production\n\nRÈGLES :\n- Pipelines idempotents et reproductibles\n- Séparer les étapes (lint, test, build, deploy)\n- Pas de secrets en dur — utiliser GitHub Secrets\n\nFORMAT DE SORTIE :\n- Fichiers YAML complets et valides\n- Documenter chaque étape avec un commentaire bref\n- Nommer chaque fichier avec son chemin (.github/workflows/...)",
    color: "#10b981",
    type: "work",
    model: "",
    linked: [],
    dependencies: [],
    x: 480,
    y: 460,
    task: "Mettre en place le pipeline GitHub Actions de vérification.",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "p4",
    name: "Refonte onboarding",
    instructions:
      "Tu es un coordinateur de projet IA senior.\n\nCOMPÉTENCES :\n- Décomposition de tâches complexes en sous-tâches autonomes\n- Coordination inter-agents, gestion des dépendances\n- Vérification de cohérence globale des livrables\n\nRÈGLES :\n- Chaque sous-tâche = un livrable vérifiable par un seul agent\n- Préciser objectif, contraintes, format et critères de réussite\n- Détecter les contradictions et chevauchements entre agents\n- S'assurer que chaque aspect de la tâche globale est couvert",
    color: "#10b981",
    type: "orchestrator",
    model: "",
    linked: ["p1", "p2", "p3", "p5"],
    dependencies: [],
    orchSettings: { autoDistribute: true, checkCoherence: true, relaunchOnError: true },
    x: 100,
    y: 280,
    task: "Coordonner la refonte complète de l'onboarding.",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "p5",
    name: "Tests E2E — Playwright",
    instructions:
      "Tu es un ingénieur QA senior spécialisé tests automatisés.\n\nCOMPÉTENCES :\n- Tests E2E Playwright, sélecteurs robustes, assertions\n- Couverture des flux critiques (auth, paiement, formulaires)\n- Gestion des états (fixtures, mocks réseau, données de test)\n\nRÈGLES :\n- Tests indépendants et reproductibles (pas de dépendance entre tests)\n- Sélecteurs stables (data-testid, rôles ARIA) plutôt que classes CSS\n- Couvrir le chemin nominal ET les cas d'erreur\n\nFORMAT DE SORTIE :\n- Fichiers de test complets avec imports et configuration\n- Nommer les tests de manière descriptive (décrit le comportement attendu)\n- Inclure les fixtures et helpers nécessaires",
    color: "#ef4444",
    type: "code",
    model: "",
    linked: [],
    dependencies: ["p1"],
    x: 760,
    y: 100,
    task: "Écrire les tests E2E de connexion et inscription.",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "p6",
    name: "Vérification qualité globale",
    instructions:
      "Tu es un vérificateur qualité senior.\n\nCOMPÉTENCES :\n- Revue de code (sécurité, performance, maintenabilité)\n- Vérification de cohérence visuelle et d'accessibilité\n- Validation de conformité aux spécifications\n\nRÈGLES :\n- Évaluer chaque livrable selon des critères objectifs et mesurables\n- Classer les problèmes par sévérité : CRITICAL (bloquant), WARNING (à corriger), INFO (suggestion)\n- Fournir un exemple concret et une correction proposée pour chaque problème\n- Ne pas inventer de problèmes — signaler uniquement ce qui est réellement incorrect\n\nFORMAT DE SORTIE :\n- Liste structurée de problèmes avec sévérité, description et correction\n- Score global sur 100\n- Verdict final : VALIDÉ ou REJETÉ avec justification",
    color: "#3b82f6",
    type: "verifier",
    model: "",
    linked: ["p1", "p2", "p3", "p5"],
    dependencies: ["p1", "p2", "p3", "p5"],
    bypassMemory: true,
    x: 760,
    y: 280,
    task: "Vérifier la cohérence, l'accessibilité WCAG et la conformité finale du projet.",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];
