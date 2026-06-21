// OpenHub shell translations (sidebar, config panel, nav popup).
// fr values MUST match the original French markup exactly so French users see
// no change. Registered into the i18n runtime; resolve with window.t("key").
(function () {
  "use strict";
  if (!window.I18N || !window.I18N.register) return;

  window.I18N.register({
    fr: {
      // ── Common (shared across surfaces) ──
      "common.install": "Installer",
      "common.retry": "Réessayer",
      "common.check": "Vérifier",
      "common.checking": "Vérification…",
      "common.cancel": "Annuler",
      "common.errorWith": "Erreur : {msg}",
      "common.unknown": "inconnue",
      "common.failed": "échec",

      // ── Header / navigation ──
      "nav.config.aria": "Configuration",
      "nav.slot.chat": "Chat",
      "nav.slot.work": "Work",
      "nav.slot.code": "Code",
      "nav.slot.design": "Design",
      "nav.slot.projects": "Orchestrateur",
      "nav.tooltip.chat": "Chat IA",
      "nav.tooltip.work": "OpenWork",
      "nav.tooltip.code": "OpenCode",
      "nav.tooltip.design": "Open Design",
      "nav.tooltip.projects": "Orchestration",
      "nav.tooltip.config": "Paramètres",

      // ── Config panel chrome ──
      "cfg.nav.title": "Réglages",
      "cfg.nav.aria": "Sections des réglages",
      "cfg.tab.keys": "Clés API",
      "cfg.tab.models": "Modèles IA",
      "cfg.tab.memory": "Mémoire",
      "cfg.tab.updates": "Général & Mises à jour",
      "cfg.tab.notifs": "Notifications",
      "cfg.tab.cache": "Cache",
      "cfg.nav.hint": "Keychain macOS",
      "cfg.close.aria": "Fermer les réglages",
      "cfg.keys.desc": "Stockées en sécurité dans le Keychain macOS.",
      "cfg.models.desc": "Configuration des modèles et fonctionnalités.",
      "cfg.memory.desc": "Profil utilisateur et base de connaissances.",
      "cfg.updates.desc": "Gérer l'apparence, l'onboarding et les mises à jour.",
      "cfg.notifs.desc": "Alertes de fin de tâche par source.",
      "cfg.cache.desc": "Statistiques d'efficacité du prompt caching.",

      // ── Shared option labels ──
      "opt.high": "Élevé",
      "opt.low": "Bas",

      // ── Keys pane ──
      "cfg.keys.group.ai": "Modèles IA",
      "cfg.keys.anthropic.desc": "Modèles Claude",
      "cfg.keys.openai.desc": "Modèles GPT",
      "cfg.keys.deepseek.desc": "Modèles DeepSeek officiels",
      "cfg.keys.openrouter.desc": "Routage multi-fournisseurs",
      "cfg.keys.ollama.desc": "Modèles locaux",
      "cfg.keys.reveal": "Afficher la clé",
      "cfg.keys.hide": "Masquer la clé",
      "cfg.keys.ollamaRequired": "Modèles Ollama requis",
      "cfg.keys.group.integrations": "Intégrations",
      "cfg.keys.github.desc": "Token d'accès personnel",
      "cfg.keys.brave.desc": "Clé API pour la recherche web",

      // ── Models pane ──
      "cfg.models.classifier": "Classifieur mémoire",
      "cfg.models.sort.label": "Tri des informations",
      "cfg.models.sort.desc": "Modèle utilisé pour classer les faits mémorisés.",
      "cfg.models.effort.label": "Effort de réflexion",
      "cfg.models.effort.desc": "Niveau par défaut pour tous les modèles.",
      "cfg.models.effort.none": "Aucun",
      "cfg.models.effort.minimal": "Minimal",
      "cfg.models.effort.low": "Bas",
      "cfg.models.effort.medium": "Moyen",
      "cfg.models.effort.high": "Élevé",
      "cfg.models.effort.xhigh": "Très élevé",
      "cfg.models.effort.max": "Maximum",
      "cfg.models.websearch.label": "Recherche Internet",
      "cfg.models.websearch.desc": "Permet aux modèles d'interroger Brave Search.",
      "cfg.models.vision.group": "Vision",
      "cfg.models.vision.desc": "Ajoute la vision aux modèles qui n'en ont pas.",
      "cfg.models.visionModel.label": "Modèle de vision",
      "cfg.models.visionModel.desc": "Modèle Ollama local pour l'analyse d'images.",
      "cfg.models.detail.label": "Niveau de détail",
      "cfg.models.detail.desc": "Résolution de l'analyse.",

      // ── Memory pane ──
      "cfg.tab.memory.badge": "Bientôt",
      "cfg.memory.soon.title": "Bientôt disponible",
      "cfg.memory.soon.desc":
        "La mémoire à long terme et l'extraction de faits par IA sont temporairement désactivées et seront disponibles dans une prochaine mise à jour.",
      "cfg.memory.control": "Contrôle",
      "cfg.memory.longterm.label": "Mémoire long-terme",
      "cfg.memory.longterm.desc": "Injecte le profil et les faits dans chaque requête.",
      "cfg.memory.profile.group": "Profil utilisateur",
      "cfg.memory.profile.label": "Instructions globales (YAML)",
      "cfg.memory.profile.desc":
        "Définit le contexte persistant : langue, style, stack technique.",
      "cfg.memory.profile.placeholder": "lang:fr style:concis stack:ts,electron",
      "cfg.memory.auto.group": "Mémorisation automatique",
      "cfg.memory.auto.label": "Auto-extraction de faits",
      "cfg.memory.auto.desc": "Extrait automatiquement les faits via Ollama.",
      "cfg.memory.kb.group": "Base de connaissances",
      "cfg.memory.kb.placeholder": "Ajouter un fait manuellement...",
      "cfg.memory.kb.aria": "Ajouter un fait à la mémoire",
      "cfg.memory.kb.add": "+ Ajouter",
      "memory.tokenHint":
        "~{total} tokens max · {included}/{count} faits candidats (selon la requête) · {count}/50 max",

      // ── Updates pane ──
      "cfg.updates.system": "Système",
      "cfg.updates.auto.label": "Mise à jour automatique",
      "cfg.updates.auto.desc": "Installe les mises à jour des apps au démarrage.",
      "cfg.updates.autoPackaged.label": "Vérifier les mises à jour au démarrage",
      "cfg.updates.autoPackaged.desc":
        "Vérifie si une nouvelle version est disponible (l'installation reste manuelle).",
      "cfg.updates.bundled": "Applications incluses",
      "cfg.updates.appearance": "Apparence",
      "cfg.updates.nav.label": "Style de navigation",
      "cfg.updates.nav.desc": "Barre d'onglets ou menu déroulant.",
      "cfg.updates.nav.topbar": "Barre d'onglets",
      "cfg.updates.nav.dropdown": "Menu déroulant",
      "cfg.updates.lang.label": "Langue",
      "cfg.updates.lang.desc": "Langue de l'interface.",
      "cfg.updates.apps": "Applications",
      "cfg.updates.redo.label": "Refaire l'onboarding",
      "cfg.updates.redo.desc": "Relancer l'assistant de premier lancement.",
      "cfg.updates.redo.btn": "Relancer",

      // ── Notifications pane ──
      "cfg.notifs.behavior": "Comportement",
      "cfg.notifs.when.label": "Quand notifier",
      "cfg.notifs.when.desc": "Notifications de fin de tâche.",
      "cfg.notifs.when.always": "Toujours",
      "cfg.notifs.when.otherTab": "Autre onglet ou arrière-plan",
      "cfg.notifs.when.background": "App en arrière-plan uniquement",
      "cfg.notifs.when.sound": "Son bref uniquement",
      "cfg.notifs.when.never": "Jamais",
      "cfg.notifs.sources": "Sources",

      // ── Cache pane ──
      "cfg.cache.efficiency": "Efficacité du caching",
      "cfg.cache.reset": "Réinitialiser",
      "cfg.cache.hitRatio": "Ratio cache hit global",
      "cfg.cache.savedTokens": "Tokens économisés",
      "cfg.cache.savedSubPre": "sur",
      "cfg.cache.savedSubPost": "analysés au total",
      "cfg.cache.byModel": "Gains par modèle",
      "cfg.cache.byWorkspace": "Gains par espace de travail",
      "cfg.cache.th.model": "Modèle",
      "cfg.cache.th.requests": "Requêtes",
      "cfg.cache.th.gains": "Gains",
      "cfg.cache.th.ratio": "Ratio",
      "cfg.cache.th.workspace": "Workspace",
      "cfg.cache.empty.title": "Aucune statistique disponible",
      "cfg.cache.empty.desc":
        "Envoyez des requêtes pour mesurer vos gains de prompt caching.",
      "cfg.cache.confirm": "Confirmer ?",
      "cfg.cache.yes": "Oui",
      "cfg.cache.no": "Non",

      // ── Toasts ──
      "toast.saved": "Enregistré",
      "toast.keySaved": "Clé enregistrée",
      "toast.keySaveFailed": "Échec de l'enregistrement de la clé",
      "toast.profileSaved": "Profil enregistré",
      "toast.cacheReset": "Cache réinitialisé",

      // ── Gemini login ──
      "gemini.connected": "Connecté",
      "gemini.connectedWith": "Connecté : {email}",
      "gemini.disconnected": "Non connecté",
      "gemini.connect": "Se connecter avec Google",
      "gemini.reconnect": "Reconnecter",
      "gemini.connecting": "Connexion…",
      "gemini.connectedToast": "Connecté à Google",
      "gemini.connectFailed": "Connexion échouée",

      // ── App updates ──
      "update.update": "Mettre à jour",
      "update.updating": "Mise à jour en cours…",
      "update.done": "Mise à jour terminée ✓",
      "update.upToDate": "À jour",

      // ── Self-update ──
      "selfupdate.upToDate": "Vous utilisez la dernière version.",
      "selfupdate.checkFailed": "Impossible de vérifier les mises à jour.",
      "selfupdate.available": "Une nouvelle version est prête à être installée.",
      "selfupdate.versionAvailable": "v{version} disponible",
      "selfupdate.downloading": "Téléchargement… {percent} %",
      "selfupdate.installing": "Installation en cours…",

      // ── Ollama manager ──
      "ollama.initializing": "Initialisation...",
      "ollama.missing": "Manquant",
      "ollama.pulling": "En cours...",
      "ollama.installed": "Installé ✓",

      // ── Onboarding ──
      "onboarding.step": "Étape {current} sur {total}",
      "onboarding.next": "Suivant",
      "onboarding.prev": "Précédent",
      "onboarding.skip": "Passer",
      "onboarding.finish": "Terminer",
      "onboarding.start": "Commencer",

      "onboarding.welcome.title": "Bienvenue sur OpenHub",
      "onboarding.welcome.subtitle":
        "Votre environnement IA unifié — trois outils, une seule interface.",
      "onboarding.welcome.work.title": "Work",
      "onboarding.welcome.work.desc":
        "Gestion de tâches et productivité assistée par IA.",
      "onboarding.welcome.code.title": "Code",
      "onboarding.welcome.code.desc": "Éditeur de code avec assistant IA intégré.",
      "onboarding.welcome.design.title": "Design",
      "onboarding.welcome.design.desc": "Conception visuelle et prototypage IA.",
      "onboarding.welcome.orchestrator.title": "Orchestrateur",
      "onboarding.welcome.orchestrator.desc":
        "Coordonne des équipes d'agents IA sur vos projets.",

      "onboarding.lang.title": "Langue",
      "onboarding.lang.subtitle": "Choisissez la langue de l'interface.",

      "onboarding.prefs.title": "Préférences",
      "onboarding.prefs.subtitle":
        "Configurez vos fournisseurs IA et préférences. Vous pourrez tout modifier plus tard dans Réglages.",
      "onboarding.prefs.provider": "Fournisseur IA",
      "onboarding.prefs.provider.desc":
        "Ajoutez au moins une clé API pour utiliser les modèles IA.",
      "onboarding.prefs.google": "Se connecter avec Google",
      "onboarding.prefs.models": "Modèles par défaut",
      "onboarding.prefs.proModel": "Modèle raisonnement",
      "onboarding.prefs.flashModel": "Modèle rapide",
      "onboarding.prefs.notifications": "Notifications",
      "onboarding.prefs.notifyMode": "Mode de notification",
      "onboarding.prefs.memory": "Mémoire",
      "onboarding.prefs.memoryEnabled": "Mémoire long terme",
      "onboarding.prefs.memoryEnabled.desc":
        "Injecte le profil et les faits dans chaque requête.",
      "onboarding.prefs.autoExtract": "Extraction automatique",
      "onboarding.prefs.autoExtract.desc":
        "Extrait les faits automatiquement via Ollama local.",

      "onboarding.ollama.title": "Modèles locaux",
      "onboarding.ollama.subtitle":
        "Ces modèles tournent sur votre machine via Ollama pour la vision et la mémoire.",
      "onboarding.ollama.notRunning":
        "Ollama n'est pas détecté sur votre machine. Installez-le pour activer la vision et la mémoire locales.",
      "onboarding.ollama.download": "Télécharger Ollama",
      "onboarding.ollama.recheck": "Revérifier",
      "onboarding.ollama.vision": "Vision",
      "onboarding.ollama.vision.desc": "Analyse d'images en local.",
      "onboarding.ollama.memory": "Mémoire / Cache",
      "onboarding.ollama.memory.desc": "Extraction automatique de faits.",

      "onboarding.done.title": "Vous êtes prêt !",
      "onboarding.done.subtitle":
        "Tout est configuré. Vous pouvez toujours modifier vos réglages depuis l'icône ⚙ en haut à droite.",
    },

    en: {
      // ── Common ──
      "common.install": "Install",
      "common.retry": "Retry",
      "common.check": "Check",
      "common.checking": "Checking…",
      "common.cancel": "Cancel",
      "common.errorWith": "Error: {msg}",
      "common.unknown": "unknown",
      "common.failed": "failed",

      // ── Header / navigation ──
      "nav.config.aria": "Settings",
      "nav.slot.chat": "Chat",
      "nav.slot.work": "Work",
      "nav.slot.code": "Code",
      "nav.slot.design": "Design",
      "nav.slot.projects": "Orchestrator",
      "nav.tooltip.chat": "AI Chat",
      "nav.tooltip.work": "OpenWork",
      "nav.tooltip.code": "OpenCode",
      "nav.tooltip.design": "Open Design",
      "nav.tooltip.projects": "Orchestration",
      "nav.tooltip.config": "Settings",

      // ── Config panel chrome ──
      "cfg.nav.title": "Settings",
      "cfg.nav.aria": "Settings sections",
      "cfg.tab.keys": "API Keys",
      "cfg.tab.models": "AI Models",
      "cfg.tab.memory": "Memory",
      "cfg.tab.updates": "General & Updates",
      "cfg.tab.notifs": "Notifications",
      "cfg.tab.cache": "Cache",
      "cfg.nav.hint": "macOS Keychain",
      "cfg.close.aria": "Close settings",
      "cfg.keys.desc": "Stored securely in the macOS Keychain.",
      "cfg.models.desc": "Model and feature configuration.",
      "cfg.memory.desc": "User profile and knowledge base.",
      "cfg.updates.desc": "Manage appearance, onboarding, and updates.",
      "cfg.notifs.desc": "Task-completion alerts by source.",
      "cfg.cache.desc": "Prompt caching efficiency statistics.",

      // ── Shared option labels ──
      "opt.high": "High",
      "opt.low": "Low",

      // ── Keys pane ──
      "cfg.keys.group.ai": "AI Models",
      "cfg.keys.anthropic.desc": "Claude models",
      "cfg.keys.openai.desc": "GPT models",
      "cfg.keys.deepseek.desc": "Official DeepSeek models",
      "cfg.keys.openrouter.desc": "Multi-provider routing",
      "cfg.keys.ollama.desc": "Local models",
      "cfg.keys.reveal": "Show key",
      "cfg.keys.hide": "Hide key",
      "cfg.keys.ollamaRequired": "Required Ollama models",
      "cfg.keys.group.integrations": "Integrations",
      "cfg.keys.github.desc": "Personal access token",
      "cfg.keys.brave.desc": "API key for web search",

      // ── Models pane ──
      "cfg.models.classifier": "Memory classifier",
      "cfg.models.sort.label": "Information sorting",
      "cfg.models.sort.desc": "Model used to classify memorized facts.",
      "cfg.models.effort.label": "Reasoning effort",
      "cfg.models.effort.desc": "Default level for all models.",
      "cfg.models.effort.none": "None",
      "cfg.models.effort.minimal": "Minimal",
      "cfg.models.effort.low": "Low",
      "cfg.models.effort.medium": "Medium",
      "cfg.models.effort.high": "High",
      "cfg.models.effort.xhigh": "Very high",
      "cfg.models.effort.max": "Maximum",
      "cfg.models.websearch.label": "Web search",
      "cfg.models.websearch.desc": "Lets models query Brave Search.",
      "cfg.models.vision.group": "Vision",
      "cfg.models.vision.desc": "Adds vision to models that lack it.",
      "cfg.models.visionModel.label": "Vision model",
      "cfg.models.visionModel.desc": "Local Ollama model for image analysis.",
      "cfg.models.detail.label": "Detail level",
      "cfg.models.detail.desc": "Analysis resolution.",

      // ── Memory pane ──
      "cfg.tab.memory.badge": "Soon",
      "cfg.memory.soon.title": "Coming Soon",
      "cfg.memory.soon.desc":
        "Long-term memory and AI fact extraction are temporarily disabled and will be available in a future update.",
      "cfg.memory.control": "Control",
      "cfg.memory.longterm.label": "Long-term memory",
      "cfg.memory.longterm.desc": "Injects the profile and facts into every request.",
      "cfg.memory.profile.group": "User profile",
      "cfg.memory.profile.label": "Global instructions (YAML)",
      "cfg.memory.profile.desc":
        "Defines persistent context: language, style, tech stack.",
      "cfg.memory.profile.placeholder": "lang:en style:concise stack:ts,electron",
      "cfg.memory.auto.group": "Automatic memorization",
      "cfg.memory.auto.label": "Automatic fact extraction",
      "cfg.memory.auto.desc": "Automatically extracts facts via Ollama.",
      "cfg.memory.kb.group": "Knowledge base",
      "cfg.memory.kb.placeholder": "Add a fact manually...",
      "cfg.memory.kb.aria": "Add a fact to memory",
      "cfg.memory.kb.add": "+ Add",
      "memory.tokenHint":
        "~{total} tokens max · {included}/{count} candidate facts (per query) · {count}/50 max",

      // ── Updates pane ──
      "cfg.updates.system": "System",
      "cfg.updates.auto.label": "Automatic update",
      "cfg.updates.auto.desc": "Installs app updates on startup.",
      "cfg.updates.autoPackaged.label": "Check for updates on startup",
      "cfg.updates.autoPackaged.desc":
        "Checks if a new version is available (installation stays manual).",
      "cfg.updates.bundled": "Bundled apps",
      "cfg.updates.appearance": "Appearance",
      "cfg.updates.nav.label": "Navigation style",
      "cfg.updates.nav.desc": "Tab bar or dropdown menu.",
      "cfg.updates.nav.topbar": "Tab bar",
      "cfg.updates.nav.dropdown": "Dropdown menu",
      "cfg.updates.lang.label": "Language",
      "cfg.updates.lang.desc": "Interface language.",
      "cfg.updates.apps": "Applications",
      "cfg.updates.redo.label": "Redo onboarding",
      "cfg.updates.redo.desc": "Relaunch the first-run setup wizard.",
      "cfg.updates.redo.btn": "Relaunch",

      // ── Notifications pane ──
      "cfg.notifs.behavior": "Behavior",
      "cfg.notifs.when.label": "When to notify",
      "cfg.notifs.when.desc": "Task-completion notifications.",
      "cfg.notifs.when.always": "Always",
      "cfg.notifs.when.otherTab": "Other tab or background",
      "cfg.notifs.when.background": "App in background only",
      "cfg.notifs.when.sound": "Short sound only",
      "cfg.notifs.when.never": "Never",
      "cfg.notifs.sources": "Sources",

      // ── Cache pane ──
      "cfg.cache.efficiency": "Caching efficiency",
      "cfg.cache.reset": "Reset",
      "cfg.cache.hitRatio": "Global cache hit ratio",
      "cfg.cache.savedTokens": "Tokens saved",
      "cfg.cache.savedSubPre": "of",
      "cfg.cache.savedSubPost": "analyzed in total",
      "cfg.cache.byModel": "Gains by model",
      "cfg.cache.byWorkspace": "Gains by workspace",
      "cfg.cache.th.model": "Model",
      "cfg.cache.th.requests": "Requests",
      "cfg.cache.th.gains": "Gains",
      "cfg.cache.th.ratio": "Ratio",
      "cfg.cache.th.workspace": "Workspace",
      "cfg.cache.empty.title": "No statistics available",
      "cfg.cache.empty.desc": "Send requests to measure your prompt caching gains.",
      "cfg.cache.confirm": "Confirm?",
      "cfg.cache.yes": "Yes",
      "cfg.cache.no": "No",

      // ── Toasts ──
      "toast.saved": "Saved",
      "toast.keySaved": "Key saved",
      "toast.keySaveFailed": "Failed to save key",
      "toast.profileSaved": "Profile saved",
      "toast.cacheReset": "Cache reset",

      // ── Gemini login ──
      "gemini.connected": "Connected",
      "gemini.connectedWith": "Connected: {email}",
      "gemini.disconnected": "Not connected",
      "gemini.connect": "Sign in with Google",
      "gemini.reconnect": "Reconnect",
      "gemini.connecting": "Connecting…",
      "gemini.connectedToast": "Connected to Google",
      "gemini.connectFailed": "Connection failed",

      // ── App updates ──
      "update.update": "Update",
      "update.updating": "Updating…",
      "update.done": "Update complete ✓",
      "update.upToDate": "Up to date",

      // ── Self-update ──
      "selfupdate.upToDate": "You're on the latest version.",
      "selfupdate.checkFailed": "Couldn't check for updates.",
      "selfupdate.available": "A new version is ready to install.",
      "selfupdate.versionAvailable": "v{version} available",
      "selfupdate.downloading": "Downloading… {percent}%",
      "selfupdate.installing": "Installing…",

      // ── Ollama manager ──
      "ollama.initializing": "Initializing...",
      "ollama.missing": "Missing",
      "ollama.pulling": "In progress...",
      "ollama.installed": "Installed ✓",

      // ── Onboarding ──
      "onboarding.step": "Step {current} of {total}",
      "onboarding.next": "Next",
      "onboarding.prev": "Back",
      "onboarding.skip": "Skip",
      "onboarding.finish": "Finish",
      "onboarding.start": "Get started",

      "onboarding.welcome.title": "Welcome to OpenHub",
      "onboarding.welcome.subtitle":
        "Your unified AI environment — three tools, one interface.",
      "onboarding.welcome.work.title": "Work",
      "onboarding.welcome.work.desc": "AI-assisted task management and productivity.",
      "onboarding.welcome.code.title": "Code",
      "onboarding.welcome.code.desc": "Code editor with built-in AI assistant.",
      "onboarding.welcome.design.title": "Design",
      "onboarding.welcome.design.desc": "AI-powered visual design and prototyping.",
      "onboarding.welcome.orchestrator.title": "Orchestrator",
      "onboarding.welcome.orchestrator.desc":
        "Coordinates AI agent teams on your projects.",

      "onboarding.lang.title": "Language",
      "onboarding.lang.subtitle": "Choose the interface language.",

      "onboarding.prefs.title": "Preferences",
      "onboarding.prefs.subtitle":
        "Set up your AI providers and preferences. You can change everything later in Settings.",
      "onboarding.prefs.provider": "AI Provider",
      "onboarding.prefs.provider.desc": "Add at least one API key to use AI models.",
      "onboarding.prefs.google": "Sign in with Google",
      "onboarding.prefs.models": "Default models",
      "onboarding.prefs.proModel": "Reasoning model",
      "onboarding.prefs.flashModel": "Fast model",
      "onboarding.prefs.notifications": "Notifications",
      "onboarding.prefs.notifyMode": "Notification mode",
      "onboarding.prefs.memory": "Memory",
      "onboarding.prefs.memoryEnabled": "Long-term memory",
      "onboarding.prefs.memoryEnabled.desc":
        "Injects the profile and facts into every request.",
      "onboarding.prefs.autoExtract": "Automatic extraction",
      "onboarding.prefs.autoExtract.desc":
        "Automatically extracts facts via local Ollama.",

      "onboarding.ollama.title": "Local models",
      "onboarding.ollama.subtitle":
        "These models run on your machine via Ollama for vision and memory.",
      "onboarding.ollama.notRunning":
        "Ollama was not detected on your machine. Install it to enable local vision and memory.",
      "onboarding.ollama.download": "Download Ollama",
      "onboarding.ollama.recheck": "Recheck",
      "onboarding.ollama.vision": "Vision",
      "onboarding.ollama.vision.desc": "Local image analysis.",
      "onboarding.ollama.memory": "Memory / Cache",
      "onboarding.ollama.memory.desc": "Automatic fact extraction.",

      "onboarding.done.title": "You're all set!",
      "onboarding.done.subtitle":
        "Everything is configured. You can always change your settings from the ⚙ icon in the top right.",
    },
  });

  if (window.I18N.apply) window.I18N.apply(document);
})();
