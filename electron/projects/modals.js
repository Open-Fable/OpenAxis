/* modals.js — Project modal, templates, suggestions */

function onProjectTypeChange() {
  var type = document.getElementById("projType").value;
  var isOrch = type === "orchestrator";
  document.getElementById("orchAutoSection").style.display = isOrch ? "" : "none";
  document.getElementById("dependencySelectGroup").style.display = isOrch ? "none" : "";
  if (!isOrch) {
    var depList = document.getElementById("dependencyList");
    var activeOrch = projects.find(function (p) {
      return p.id === selectedOrchestratorId;
    });
    var activeWf = workflows.find(function (w) {
      return w.id === activeWorkflowId;
    });
    var linkedIds = activeWf
      ? activeWf.linkedProjectIds || []
      : activeOrch
        ? activeOrch.linked || []
        : [];
    var potentialDeps = projects.filter(function (p) {
      return (
        p.type !== "orchestrator" && (linkedIds.includes(p.id) || p.id === selectedNodeId)
      );
    });
    var editId = document.getElementById("btnSaveProjectConfirm").dataset.editId;
    depList.innerHTML = potentialDeps
      .filter(function (p) {
        return p.id !== editId;
      })
      .map(function (p) {
        return (
          '<label class="checkbox-label"><input type="checkbox" name="depProject" value="' +
          p.id +
          '"> ' +
          escapeHtml(p.name) +
          " (" +
          (p.type || "code").toUpperCase() +
          ")</label>"
        );
      })
      .join("");
    if (depList.innerHTML === "") {
      depList.innerHTML =
        '<div style="font-size:11px;color:var(--text-muted);padding:4px">Aucun autre agent disponible.</div>';
    }
  }
}

async function editProject(id) {
  var p = projects.find(function (proj) {
    return proj.id === id;
  });
  if (!p) return;
  document.getElementById("modalProjectTitle").textContent = "Modifier l'agent";
  document.getElementById("projName").value = p.name || "";
  document.getElementById("projType").value = p.type || "code";
  document.getElementById("projModel").value = p.model || "";
  document.getElementById("projInstructions").value = p.instructions || "";
  document.getElementById("projTask").value = p.task || "";
  document.getElementById("projSteps").value =
    p.steps && p.steps.length > 0 ? p.steps.join("\n---\n") : "";
  document.getElementById("chkAutoSteps").checked = p.autoSteps !== false;
  document.getElementById("projPath").value = p.path || "";
  _selectedProjectPath = p.path || "";
  document.getElementById("chkBypassMemory").checked = !!p.bypassMemory;
  if (p.type === "orchestrator" && p.orchSettings) {
    document.getElementById("chkAutoDistribute").checked =
      !!p.orchSettings.autoDistribute;
    document.getElementById("chkCheckCoherence").checked =
      !!p.orchSettings.checkCoherence;
    document.getElementById("chkRelaunchOnError").checked =
      !!p.orchSettings.relaunchOnError;
  }
  document.getElementById("btnSaveProjectConfirm").dataset.editId = id;
  onProjectTypeChange();
  if (p.type !== "orchestrator" && p.dependencies) {
    document.querySelectorAll('input[name="depProject"]').forEach(function (chk) {
      chk.checked = p.dependencies.includes(chk.value);
    });
  }
  openModal("modalProject");
}

async function deleteProject(id) {
  return new Promise(function (resolve) {
    var modal = document.getElementById("modalConfirmDelete");
    modal.classList.add("open");
    document.getElementById("confirmDeleteBtn").onclick = async function () {
      modal.classList.remove("open");
      await window.openhub.deleteProject(id);
      projects.forEach(async function (p) {
        if (p.type === "orchestrator" && p.linked && p.linked.includes(id)) {
          p.linked = p.linked.filter(function (lid) {
            return lid !== id;
          });
          await window.openhub.saveProject(p);
        }
      });
      showToast("Agent supprimé", "success");
      if (selectedOrchestratorId === id) selectedOrchestratorId = null;
      await loadProjects();
      resolve();
    };
    document.getElementById("cancelDeleteBtn").onclick = function () {
      modal.classList.remove("open");
      resolve();
    };
  });
}

async function importDemoTemplate() {
  try {
    showToast("Génération du modèle de démonstration...", "info");
    var p1 = await window.openhub.saveProject({
      name: "API Backend — Authentification",
      instructions:
        "Tu es un développeur backend senior spécialisé Node.js/TypeScript.\n\nCOMPÉTENCES :\n- Architecture REST, validation de données, gestion d'erreurs robuste\n- Tests unitaires Jest, couverture 80%+\n- PostgreSQL, requêtes paramétrées, migrations\n\nRÈGLES :\n- Code TypeScript strict, pas de `any`\n- Fonctions < 50 lignes, fichiers < 400 lignes\n- Gestion d'erreurs explicite, pas de secrets en dur\n\nFORMAT DE SORTIE :\n- Code complet et fonctionnel (pas de placeholders)\n- Nomme chaque fichier avec son chemin relatif\n- Inclus tous les imports nécessaires",
      color: "#0d9488",
      type: "code",
      x: 420,
      y: 120,
      task: "Implémenter le flux OAuth2 avec refresh tokens.",
    });
    var p2 = await window.openhub.saveProject({
      name: "Design System — Composants",
      instructions:
        "Tu es un designer UI/UX senior expert en design systems.\n\nCOMPÉTENCES :\n- Design systems, tokens, composants réutilisables\n- Accessibilité WCAG AA, contrastes, navigation clavier\n- CSS moderne (variables, grid, flexbox), responsive mobile-first\n\nRÈGLES :\n- Variables CSS pour couleurs, tailles et espacements\n- Composants accessibles par défaut\n\nFORMAT DE SORTIE :\n- Code CSS/HTML complet et fonctionnel\n- Documenter les tokens de design\n- Fournir les variantes (hover, focus, disabled)",
      color: "#d97706",
      type: "design",
      x: 420,
      y: 280,
      task: "Créer les composants de boutons et inputs v1.0.",
    });
    var p3 = await window.openhub.saveProject({
      name: "Pipeline CI/CD — Déploiement",
      instructions:
        "Tu es un ingénieur DevOps senior spécialisé CI/CD.\n\nCOMPÉTENCES :\n- GitHub Actions, workflows YAML, matrices de build\n- Optimisation de cache, déploiement automatisé\n\nRÈGLES :\n- Pipelines idempotents et reproductibles\n- Séparer lint, test, build, deploy\n- Pas de secrets en dur\n\nFORMAT DE SORTIE :\n- Fichiers YAML complets et valides\n- Nommer chaque fichier avec son chemin",
      color: "#0d9488",
      type: "work",
      x: 420,
      y: 440,
      task: "Mettre en place le pipeline GitHub Actions de vérification.",
    });
    var p5 = await window.openhub.saveProject({
      name: "Tests E2E — Playwright",
      instructions:
        "Tu es un ingénieur QA senior spécialisé tests automatisés.\n\nCOMPÉTENCES :\n- Tests E2E Playwright, sélecteurs robustes, assertions\n- Couverture des flux critiques\n\nRÈGLES :\n- Tests indépendants et reproductibles\n- Sélecteurs stables (data-testid, rôles ARIA)\n- Couvrir chemin nominal ET cas d'erreur\n\nFORMAT DE SORTIE :\n- Fichiers de test complets avec imports\n- Nommer les tests de manière descriptive",
      color: "#dc2626",
      type: "code",
      dependencies: [p1.id],
      x: 700,
      y: 120,
      task: "Écrire les tests E2E de connexion et inscription.",
    });
    var p6 = await window.openhub.saveProject({
      name: "Vérification qualité globale",
      instructions:
        "Tu es un vérificateur qualité senior.\n\nCOMPÉTENCES :\n- Revue de code (sécurité, performance, maintenabilité)\n- Vérification de cohérence visuelle et d'accessibilité\n- Validation de conformité aux spécifications\n\nRÈGLES :\n- Critères objectifs et mesurables, classés par sévérité (CRITICAL/WARNING/INFO)\n- Exemple concret et correction proposée pour chaque problème\n- Ne pas inventer de problèmes\n\nFORMAT DE SORTIE :\n- Liste structurée avec sévérité, description et correction\n- Score global sur 100, verdict VALIDÉ ou REJETÉ",
      color: "#0d9488",
      type: "verifier",
      dependencies: [p1.id, p2.id, p3.id, p5.id],
      x: 700,
      y: 360,
      bypassMemory: true,
      task: "Vérifier le code généré, les rendus CSS et les tests.",
    });
    var orch = await window.openhub.saveProject({
      name: "Refonte onboarding",
      instructions: "Tu es un chef de projet IA.",
      color: "#0d9488",
      type: "orchestrator",
      linked: [p1.id, p2.id, p3.id, p5.id, p6.id],
      orchSettings: { autoDistribute: true, checkCoherence: true, relaunchOnError: true },
      x: 100,
      y: 280,
      task: "Coordonner la refonte complète de l'onboarding.",
    });
    showToast("Modèle onboarding créé !", "success");
    await loadProjects();
    selectOrchestrator(orch.id);
  } catch (err) {
    showToast("Erreur lors de l'importation : " + err.message, "error");
  }
}

async function importWebsiteTemplate() {
  try {
    showToast("Création du modèle Site Web...", "info");
    var p1 = await window.openhub.saveProject({
      name: "Styles & Design CSS",
      instructions:
        "Tu es un designer CSS senior.\n\nCOMPÉTENCES :\n- CSS moderne (variables, grid, flexbox), responsive mobile-first\n- Chartes graphiques, palettes de couleurs, typographies\n- Animations CSS, transitions fluides\n\nRÈGLES :\n- Variables CSS pour tous les tokens de design\n- Mobile-first, accessibilité WCAG AA\n\nFORMAT DE SORTIE :\n- Fichiers CSS complets avec variables définies\n- Documenter la palette et les choix typographiques",
      color: "#d97706",
      type: "design",
      x: 420,
      y: 120,
      task: "Créer une charte graphique moderne.",
    });
    var p2 = await window.openhub.saveProject({
      name: "Intégration HTML/JS",
      instructions:
        "Tu es un développeur frontend senior.\n\nCOMPÉTENCES :\n- HTML5 sémantique, intégration CSS, JavaScript vanilla/framework\n- Responsive design, optimisation des performances\n- SEO de base (balises meta, structure de titres, alt text)\n\nRÈGLES :\n- HTML sémantique et valide\n- Code propre, indenté, sans redondance\n- Intégration fidèle aux maquettes\n\nFORMAT DE SORTIE :\n- Fichiers HTML/JS complets et fonctionnels\n- Nommer chaque fichier avec son chemin relatif",
      color: "#0d9488",
      type: "code",
      dependencies: [p1.id],
      x: 700,
      y: 120,
      task: "Créer l'ossature HTML5 du site.",
    });
    var p3 = await window.openhub.saveProject({
      name: "Vérificateur Accessibilité & RGPD",
      instructions:
        "Tu es un expert senior en conformité web.\n\nCOMPÉTENCES :\n- Accessibilité WCAG 2.1 AA, audit et correction\n- Conformité RGPD (bannière cookies, politique de confidentialité)\n- Validation HTML/CSS, performances web\n\nRÈGLES :\n- Critères objectifs et mesurables\n- Classer par sévérité (CRITICAL/WARNING/INFO)\n- Proposer une correction pour chaque problème\n\nFORMAT DE SORTIE :\n- Rapport structuré avec liste de problèmes\n- Score de conformité, verdict CONFORME ou NON CONFORME",
      color: "#0d9488",
      type: "verifier",
      dependencies: [p2.id],
      x: 700,
      y: 360,
      bypassMemory: true,
      task: "Vérifier l'accessibilité WCAG du code.",
    });
    var orch = await window.openhub.saveProject({
      name: "Site Web Vitrine",
      instructions:
        "Tu es un coordinateur de projet web senior.\n\nCOMPÉTENCES :\n- Décomposition de tâches, coordination inter-agents\n- Gestion des dépendances et des priorités\n\nRÈGLES :\n- Chaque sous-tâche = un livrable vérifiable\n- Préciser objectif, contraintes, format et critères de réussite",
      color: "#0d9488",
      type: "orchestrator",
      linked: [p1.id, p2.id, p3.id],
      orchSettings: { autoDistribute: true, checkCoherence: true, relaunchOnError: true },
      x: 100,
      y: 240,
      task: "Créer un site web vitrine responsive.",
    });
    showToast("Modèle Site Web créé !", "success");
    await loadProjects();
    selectOrchestrator(orch.id);
  } catch (err) {
    showToast("Erreur lors de l'importation : " + err.message, "error");
  }
}

async function importSEOContentTemplate() {
  try {
    showToast("Création du modèle Contenu SEO...", "info");
    var p1 = await window.openhub.saveProject({
      name: "Rédaction de l'article (FR)",
      instructions:
        "Tu es un rédacteur web professionnel senior.\n\nCOMPÉTENCES :\n- Rédaction SEO, structure H1-H6, maillage interne\n- Ton éditorial adapté à la cible, storytelling\n- Optimisation de la densité de mots-clés sans sur-optimisation\n\nRÈGLES :\n- Articles structurés (introduction, corps, conclusion)\n- Paragraphes courts (3-4 phrases max)\n- Inclure un meta-title et meta-description\n\nFORMAT DE SORTIE :\n- Article complet en markdown avec balisage H1-H6\n- Meta-title (< 60 chars) et meta-description (< 160 chars) en en-tête",
      color: "#0d9488",
      type: "work",
      x: 420,
      y: 120,
      task: "Rédiger un article complet d'environ 800 mots en français.",
    });
    var p2 = await window.openhub.saveProject({
      name: "Traduction Anglaise (EN)",
      instructions:
        "Tu es un traducteur professionnel bilingue français-anglais.\n\nCOMPÉTENCES :\n- Traduction littéraire et technique, adaptation culturelle\n- Préservation du ton, du style et de la structure SEO\n- Localisation (formats de date, monnaie, expressions idiomatiques)\n\nRÈGLES :\n- Traduire fidèlement sans reformuler le sens\n- Conserver la structure H1-H6 et le balisage markdown\n- Adapter les meta-title/description pour le marché cible\n\nFORMAT DE SORTIE :\n- Texte traduit complet en markdown\n- Meta-title et meta-description traduits en en-tête",
      color: "#0d9488",
      type: "work",
      dependencies: [p1.id],
      x: 700,
      y: 120,
      task: "Traduire fidèlement l'article généré en anglais.",
    });
    var p3 = await window.openhub.saveProject({
      name: "Audit & Optimisation SEO",
      instructions:
        "Tu es un expert senior en référencement naturel (SEO).\n\nCOMPÉTENCES :\n- Audit SEO on-page (titres, metas, densité, maillage)\n- Analyse de mots-clés, intention de recherche\n- Optimisation technique (vitesse, mobile, structured data)\n\nRÈGLES :\n- Critères objectifs et mesurables\n- Recommandations actionnables avec priorité\n- Ne pas sur-optimiser au détriment de la lisibilité\n\nFORMAT DE SORTIE :\n- Rapport structuré avec score par critère\n- Liste de recommandations classées par impact",
      color: "#0d9488",
      type: "verifier",
      dependencies: [p1.id],
      x: 700,
      y: 360,
      bypassMemory: true,
      task: "Vérifier la densité des mots-clés stratégiques.",
    });
    var orch = await window.openhub.saveProject({
      name: "Campagne Contenu SEO",
      instructions:
        "Tu es un responsable éditorial senior.\n\nCOMPÉTENCES :\n- Stratégie de contenu, calendrier éditorial\n- Coordination rédaction/traduction/SEO\n- Contrôle qualité éditorial\n\nRÈGLES :\n- Chaque sous-tâche = un livrable vérifiable\n- Préciser objectif, contraintes, format et critères de réussite",
      color: "#0d9488",
      type: "orchestrator",
      linked: [p1.id, p2.id, p3.id],
      orchSettings: { autoDistribute: true, checkCoherence: true, relaunchOnError: true },
      x: 100,
      y: 240,
      task: "Rédiger un article de blog complet et optimisé SEO.",
    });
    showToast("Modèle Contenu SEO créé !", "success");
    await loadProjects();
    selectOrchestrator(orch.id);
  } catch (err) {
    showToast("Erreur lors de l'importation : " + err.message, "error");
  }
}

async function importSimpleOrchestrator() {
  try {
    showToast("Création de l'orchestrateur...", "info");
    var orch = await window.openhub.saveProject({
      name: "Mon Orchestrateur",
      instructions:
        "Tu es un coordinateur de projet IA senior.\n\nCOMPÉTENCES :\n- Décomposition de tâches complexes en sous-tâches autonomes\n- Coordination inter-agents, gestion des dépendances\n- Vérification de cohérence globale des livrables\n\nRÈGLES :\n- Chaque sous-tâche = un livrable vérifiable par un seul agent\n- Préciser objectif, contraintes, format et critères de réussite\n- Détecter les contradictions et chevauchements entre agents",
      color: "#0d9488",
      type: "orchestrator",
      linked: [],
      orchSettings: { autoDistribute: true, checkCoherence: true, relaunchOnError: true },
      x: 100,
      y: 240,
      task: "Définis ici l'objectif global du workflow...",
    });
    showToast("Orchestrateur créé !", "success");
    await loadProjects();
    selectOrchestrator(orch.id);
  } catch (err) {
    showToast("Erreur lors de la création : " + err.message, "error");
  }
}

async function applyTaskSuggestion(text) {
  var activeOrch = projects.find(function (p) {
    return p.id === selectedOrchestratorId;
  });
  if (!activeOrch || activeOrch.type !== "orchestrator") {
    showToast("Création d'un orchestrateur pour la suggestion...", "info");
    await importSimpleOrchestrator();
    activeOrch = projects.find(function (p) {
      return p.id === selectedOrchestratorId;
    });
  }
  if (activeOrch) {
    activeOrch.task = text;
    await window.openhub.saveProject(activeOrch);
    document.getElementById("sharedTaskText").value = text;
    showToast("Suggestion appliquée !", "success");
    updateDetailPanel();
  }
}

function confirmLoadTemplate() {
  var activeOrch = projects.find(function (p) {
    return p.id === selectedOrchestratorId;
  });
  var hasProjects = activeOrch && (activeOrch.linked || []).length > 0;
  if (
    hasProjects &&
    !confirm(
      "Charger ce modèle va ajouter des projets à votre graphe actuel. Continuer ?",
    )
  )
    return false;
  return true;
}

function resetProjectModal() {
  document.getElementById("modalProjectTitle").textContent = "Nouvel agent";
  document.getElementById("projName").value = "";
  document.getElementById("projType").value = "code";
  document.getElementById("projModel").value = "";
  document.getElementById("projInstructions").value = "";
  document.getElementById("projTask").value = "";
  document.getElementById("projSteps").value = "";
  document.getElementById("chkAutoSteps").checked = true;
  document.getElementById("projPath").value = "";
  _selectedProjectPath = "";
  document.getElementById("chkBypassMemory").checked = false;
  document.getElementById("chkAutoDistribute").checked = true;
  document.getElementById("chkCheckCoherence").checked = true;
  document.getElementById("chkRelaunchOnError").checked = true;
  delete document.getElementById("btnSaveProjectConfirm").dataset.editId;
  onProjectTypeChange();
}

function initModals() {
  var _origImportDemo = importDemoTemplate;
  importDemoTemplate = function () {
    if (confirmLoadTemplate()) _origImportDemo();
  };
  var _origImportWebsite = importWebsiteTemplate;
  importWebsiteTemplate = function () {
    if (confirmLoadTemplate()) _origImportWebsite();
  };
  var _origImportSEO = importSEOContentTemplate;
  importSEOContentTemplate = function () {
    if (confirmLoadTemplate()) _origImportSEO();
  };
  var _origImportSimple = importSimpleOrchestrator;
  importSimpleOrchestrator = function () {
    if (confirmLoadTemplate()) _origImportSimple();
  };

  document.getElementById("btnPickPath").onclick = async function () {
    if (window.openhub.pickProjectPath) {
      var p = await window.openhub.pickProjectPath();
      if (p) {
        _selectedProjectPath = p;
        document.getElementById("projPath").value = p;
      }
    }
  };

  document.getElementById("projType").onchange = onProjectTypeChange;

  document.getElementById("btnSaveProjectConfirm").onclick = async function () {
    var name = document.getElementById("projName").value.trim();
    if (!name) {
      showToast("Le nom de l'agent est obligatoire.", "error");
      return;
    }
    var type = document.getElementById("projType").value;
    var model = document.getElementById("projModel").value;
    var instructions = document.getElementById("projInstructions").value;
    var task = document.getElementById("projTask").value;
    var stepsRaw = document.getElementById("projSteps").value.trim();
    var bypassMemory = document.getElementById("chkBypassMemory").checked;
    var editId = this.dataset.editId;
    var steps;
    var autoSteps = document.getElementById("chkAutoSteps").checked;
    if (stepsRaw) {
      var parsed = stepsRaw
        .split(/\n---\n/)
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
      if (parsed.length > 1) steps = parsed;
    }
    var data = {
      name: name,
      type: type,
      model: model,
      instructions: instructions,
      task: task,
      steps: steps,
      autoSteps: autoSteps,
      path: _selectedProjectPath || undefined,
      bypassMemory: bypassMemory,
    };
    if (editId) data.id = editId;
    if (type === "orchestrator") {
      data.orchSettings = {
        autoDistribute: document.getElementById("chkAutoDistribute").checked,
        checkCoherence: document.getElementById("chkCheckCoherence").checked,
        relaunchOnError: document.getElementById("chkRelaunchOnError").checked,
      };
    } else {
      var checkedDeps = [];
      document
        .querySelectorAll('input[name="depProject"]:checked')
        .forEach(function (chk) {
          checkedDeps.push(chk.value);
        });
      data.dependencies = checkedDeps;
    }
    var saved = await window.openhub.saveProject(data);
    if (!editId && selectedOrchestratorId && type !== "orchestrator") {
      var activeOrch = projects.find(function (p) {
        return p.id === selectedOrchestratorId;
      });
      if (activeOrch) {
        if (!activeOrch.linked) activeOrch.linked = [];
        activeOrch.linked.push(saved.id);
        await window.openhub.saveProject(activeOrch);
      }
      var activeWf = workflows.find(function (w) {
        return w.id === activeWorkflowId;
      });
      if (activeWf) {
        if (!activeWf.linkedProjectIds) activeWf.linkedProjectIds = [];
        if (!activeWf.linkedProjectIds.includes(saved.id)) {
          activeWf.linkedProjectIds = [].concat(activeWf.linkedProjectIds, [saved.id]);
          await window.openhub.saveWorkflow(activeWf);
        }
      }
    }
    closeModal("modalProject");
    showToast(editId ? "Agent mis à jour" : "Agent créé", "success");
    await loadProjects();
  };

  document.querySelectorAll("[data-close-modal]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      closeModal(this.dataset.closeModal);
    });
  });
}
