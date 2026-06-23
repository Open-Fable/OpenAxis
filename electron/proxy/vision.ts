import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import { isSafeOllamaUrl } from "../keychain.js";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

// Resolves the configured Ollama URL but rejects unsafe (cloud-metadata / link-local)
// hosts, falling back to loopback — prevents the vision proxy becoming an SSRF pivot.
function safeOllamaUrl(candidate: string | null | undefined): string {
  return candidate && isSafeOllamaUrl(candidate) ? candidate : DEFAULT_OLLAMA_URL;
}

export interface VisionConfig {
  visionProxyEnabled: boolean;
  visionModel: string;
  ollamaUrl: string;
  visionDetailLevel: "low" | "high";
}

export interface VisionZone {
  position: string;
  description: string;
  elements: string[];
}

export interface VisionTextEntry {
  text: string;
  position: string;
  style: string;
}

export interface VisionInteractiveElement {
  type: string;
  label: string;
  position: string;
  state: string;
  color: string;
  size?: string;
  dimensions?: string;
  border_radius?: string;
}

export interface VisionDescription {
  scene_type: string;
  summary: string;
  layout: {
    background: string;
    overall_structure?: string;
    estimated_dimensions?: string;
    zones: VisionZone[];
  };
  text_content: VisionTextEntry[];
  interactive_elements: VisionInteractiveElement[];
  visual_cues: {
    dominant_colors: string[];
    highlighted: string;
    spatial_relations: string[];
  };
  reproduction_notes?: string;
  tags: string[];
}

/**
 * Détermine si un modèle possède déjà des capacités de vision native
 * et ne nécessite pas de proxy (ex: GPT-4o, Claude 3.5, Gemini).
 */
export function shouldBypassVisionProxy(modelName: string): boolean {
  const lowercaseName = modelName.toLowerCase();

  // On ne bypass JAMAIS pour DeepSeek ou Llama (modèles texte pur)
  if (lowercaseName.includes("deepseek") || lowercaseName.includes("llama")) {
    return false;
  }

  const nativeVisionModels = [
    "gpt-4o",
    "gpt-4-vision",
    "claude-3-5",
    "claude-3-opus",
    "gemini-",
    "pixtral",
    "llava",
    "o1-",
    "vision",
  ];
  return nativeVisionModels.some((m) => lowercaseName.includes(m));
}

/**
 * Lit la configuration de vision depuis settings.json
 * Accepte une URL optionnelle pour écraser celle par défaut (depuis les réglages)
 */
export async function getVisionConfig(
  overrideOllamaUrl?: string | null,
): Promise<VisionConfig> {
  const settingsPath = path.join(homedir(), ".config", "openaxis", "settings.json");
  const defaultConfig: VisionConfig = {
    visionProxyEnabled: true,
    visionModel: "openbmb/minicpm-v4.6",
    ollamaUrl: safeOllamaUrl(overrideOllamaUrl),
    visionDetailLevel: "high",
  };

  try {
    const content = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content);

    return {
      visionProxyEnabled: settings.visionProxyEnabled ?? defaultConfig.visionProxyEnabled,
      visionModel: settings.visionModel ?? defaultConfig.visionModel,
      ollamaUrl: safeOllamaUrl(overrideOllamaUrl || settings.ollamaUrl),
      visionDetailLevel: settings.visionDetailLevel ?? defaultConfig.visionDetailLevel,
    };
  } catch {
    return defaultConfig;
  }
}

export const MAX_IMAGE_SIZE_MB = 10;

/**
 * Vérifie si Ollama est joignable
 */
export async function checkOllamaHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Appelle Ollama pour décrire une image
 */
export async function describeImage(
  imageBase64: string,
  config: VisionConfig,
): Promise<VisionDescription> {
  // Refuse les URL distantes (http/https) : les laisser passer déclencherait soit
  // un SSRF si on les fetchait, soit (aujourd'hui) un décodage base64 silencieux qui
  // produit des octets parasites. Seules les data: URI / base64 brut sont acceptées.
  if (/^https?:\/\//i.test(imageBase64.trim())) {
    throw new Error("URL d'image distante non supportée — fournir une data: URI.");
  }

  // Nettoyage du base64 (retrait du préfixe data:image/...)
  const base64Data = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;

  // Vérification de la taille
  const imageBuffer = Buffer.from(base64Data, "base64");
  const sizeMB = imageBuffer.length / (1024 * 1024);
  if (sizeMB > MAX_IMAGE_SIZE_MB) {
    throw new Error(
      `Image trop volumineuse : ${sizeMB.toFixed(2)} Mo (max ${MAX_IMAGE_SIZE_MB} Mo)`,
    );
  }

  const systemPrompt = `Tu es les YEUX d'une IA qui ne peut pas voir. Ta description sera injectée mot pour mot dans son contexte. L'utilisateur parlera ensuite COMME SI l'IA voyait l'image. Il dira des choses comme "le truc en haut à droite", "le bouton bleu", "là où c'est surligné", "à côté du logo", "tu vois le petit truc là ?", ou même "refais-moi ça à l'identique". Ta description doit permettre à l'IA de répondre aussi naturellement que si elle voyait l'image, ET de reproduire fidèlement ce qu'elle contient si on le lui demande.

PRINCIPE FONDAMENTAL :
Chaque pixel compte. Si un humain qui regarde l'image pourrait le remarquer, même en plissant les yeux, tu DOIS le décrire. Aucun élément n'est trop petit, trop discret, trop évident ou trop secondaire pour être omis. Un détail que tu juges "insignifiant" pourrait être exactement celui dont l'utilisateur va parler, ou celui qui manquera si on demande de reproduire l'image.

MÉTHODE DE SCAN (3 passes obligatoires) :

PASSE 1 — CADRE GLOBAL :
Type de scène, fond, proportions apparentes de l'image (paysage/portrait/carré), ambiance lumineuse (clair/sombre/contraste élevé), thème de couleurs général.

PASSE 2 — ZONE PAR ZONE (grille 3×3) :
haut-gauche → haut-centre → haut-droite → centre-gauche → centre → centre-droite → bas-gauche → bas-centre → bas-droite.
Pour chaque zone, décris TOUT ce qui s'y trouve sans exception.

PASSE 3 — INTERSTICES :
Repasse sur les espaces vides, les marges, les gaps entre les éléments principaux. C'est là que se cachent les petits éléments (icônes, séparateurs, badges, timestamps) que tu rates le plus souvent.

CE QUE TU DOIS CAPTURER (sans exception) :
- Tout élément visuel quelle que soit sa taille : texte, icône, forme, ligne, point, ombre, bordure, dégradé.
- Tout élément interactif ou qui y ressemble. Quand il n'y a pas de texte, DÉDUIS la fonction depuis la forme (deux carrés superposés = copier, × = fermer, crayon = éditer, engrenage = paramètres, ⋯ = plus d'options, poubelle = supprimer, loupe = rechercher, etc.).
- Tout indicateur d'état : points colorés, coches, badges, compteurs, barres de progression, spinners, verrous, statut en ligne/hors ligne.
- Le curseur de la souris s'il est visible, et ce qu'il survole.
- Les éléments partiellement visibles ou tronqués par les bords.
- Les différences subtiles entre éléments similaires : onglet plus clair = actif, bordure plus épaisse = sélectionné, opacité réduite = désactivé.

POUR CHAQUE ÉLÉMENT, donne :
- Sa POSITION (zone 3×3 + position relative aux voisins)
- Sa COULEUR exacte (code hex si tu peux l'estimer, sinon nom précis comme "gris clair", "bleu-vert vif", "noir pur")
- Sa TAILLE relative (petit/moyen/grand par rapport à l'image)
- Son ÉTAT apparent (actif, inactif, survolé, sélectionné, désactivé, chargement)

DÉTAILS DE REPRODUCTION — essentiels si l'utilisateur demande de recréer l'image :
Pour chaque élément structurant (conteneur, carte, bulle, barre, panneau), estime :
- Dimensions approximatives en % de l'image (ex: "~60% de la largeur, ~20% de la hauteur")
- Marges et espacements par rapport aux voisins (ex: "~16px de marge avec le bord gauche", "~8px d'écart avec l'élément au-dessus")
- Coins arrondis (aucun / légers ~4px / moyens ~8px / forts ~16px / circulaires)
- Ombres portées (aucune / légère / prononcée, direction si visible)
- Bordures (aucune / fine 1px / épaisse, couleur)
- Padding interne estimé (ex: "~12px horizontal, ~8px vertical")

Pour le texte, estime :
- La police (serif / sans-serif / monospace)
- La taille relative (très petit ~10px / petit ~12px / normal ~14px / moyen ~16px / grand ~20px / titre ~24px / très grand ~32px+)
- La graisse (light / normal / medium / semibold / bold)
- L'interligne (serré / normal / aéré)
- L'alignement (gauche / centré / droite)

Pour la mise en page globale :
- Type de layout (flex colonne / flex ligne / grille / empilé / centré)
- Alignement des éléments entre eux (alignés à gauche / centrés / justifiés / espacés uniformément)
- Hiérarchie visuelle : quel élément domine, lesquels sont secondaires, lesquels sont discrets

FORMAT JSON OBLIGATOIRE :
{
  "scene_type": "screenshot | photo | diagram | document | other",
  "summary": "Une phrase décrivant ce qu'on voit globalement",
  "layout": {
    "background": "couleur exacte du fond principal",
    "overall_structure": "description du layout global (ex: flex colonne centré, sidebar + contenu principal, grille 2 colonnes)",
    "estimated_dimensions": "proportions de l'image (ex: ~500×800px portrait)",
    "zones": [
      {
        "position": "haut-gauche | haut-centre | haut-droite | centre-gauche | centre | centre-droite | bas-gauche | bas-centre | bas-droite",
        "description": "ce qu'il y a dans cette zone",
        "elements": ["CHAQUE élément : nature, couleur exacte, taille, état, dimensions estimées, marges, coins arrondis, ombres si applicable"]
      }
    ]
  },
  "text_content": [
    {"text": "texte exact mot pour mot", "position": "où dans l'image", "style": "police, taille estimée, graisse, couleur, alignement"}
  ],
  "interactive_elements": [
    {"type": "bouton|lien|champ|menu|checkbox|toggle|onglet|icône|slider|badge", "label": "texte visible OU fonction déduite", "position": "où", "state": "actif|inactif|survolé|sélectionné|désactivé", "color": "couleur exacte", "size": "petit|moyen|grand", "dimensions": "largeur×hauteur estimées", "border_radius": "aucun|léger|moyen|fort|circulaire"}
  ],
  "visual_cues": {
    "dominant_colors": ["les 3-5 couleurs principales avec noms précis ou hex estimés"],
    "highlighted": "ce qui attire l'œil en premier et pourquoi",
    "spatial_relations": ["A est à gauche de B avec ~Npx d'écart", "C est en dessous de D", "E est centré dans F"]
  },
  "reproduction_notes": "résumé des informations clés pour reproduire cette image : structure du layout, palette de couleurs, typographie, espacements dominants, style général (flat/material/glassmorphism/neumorphism/etc)",
  "tags": ["mots-clés"]
}`;

  const response = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.visionModel,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            "Analyse cette image. Sois exhaustif sur les positions, couleurs, textes et éléments interactifs. L'utilisateur va te poser des questions comme si tu voyais l'image — ta description doit couvrir chaque détail spatial.",
          images: [base64Data],
        },
      ],
      stream: false,
      format: "json",
      options: {
        num_ctx: 8192, // Limite le contexte à 8k pour économiser de la RAM
        temperature: 0.1,
      },
    }),
    signal: AbortSignal.timeout(45000), // Timeout réduit à 45s
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.statusText}`);
  }

  const result = (await response.json()) as Record<string, unknown>;
  const msg = result["message"];
  const content = (
    typeof msg === "object" &&
    msg !== null &&
    typeof (msg as Record<string, unknown>)["content"] === "string"
      ? (msg as Record<string, unknown>)["content"]
      : typeof result["content"] === "string"
        ? result["content"]
        : ""
  ) as string;

  if (!content) {
    throw new Error("Réponse Ollama vide ou malformée (champ content manquant)");
  }

  return parseVisionResponse(content);
}

const EMPTY_DESCRIPTION: VisionDescription = {
  scene_type: "other",
  summary: "Aucune donnée de vision",
  layout: { background: "", zones: [] },
  text_content: [],
  interactive_elements: [],
  visual_cues: { dominant_colors: [], highlighted: "", spatial_relations: [] },
  tags: [],
};

function safeArray<T>(val: unknown): T[] {
  return Array.isArray(val) ? (val as T[]) : [];
}

export function parseVisionResponse(content: string): VisionDescription {
  if (!content) return { ...EMPTY_DESCRIPTION };

  const cleanContent = content.trim();

  try {
    const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : cleanContent;
    const p = JSON.parse(jsonStr) as Record<string, unknown>;

    const layout = (p.layout ?? {}) as Record<string, unknown>;
    const cues = (p.visual_cues ?? {}) as Record<string, unknown>;

    return {
      scene_type: String(p.scene_type || "other"),
      summary: String(p.summary || "Analyse d'image"),
      layout: {
        background: String(layout.background || ""),
        overall_structure: layout.overall_structure
          ? String(layout.overall_structure)
          : undefined,
        estimated_dimensions: layout.estimated_dimensions
          ? String(layout.estimated_dimensions)
          : undefined,
        zones: safeArray<VisionZone>(layout.zones),
      },
      text_content: safeArray<VisionTextEntry>(p.text_content),
      interactive_elements: safeArray<VisionInteractiveElement>(p.interactive_elements),
      visual_cues: {
        dominant_colors: safeArray<string>(cues.dominant_colors),
        highlighted: String(cues.highlighted || ""),
        spatial_relations: safeArray<string>(cues.spatial_relations),
      },
      reproduction_notes: p.reproduction_notes ? String(p.reproduction_notes) : undefined,
      tags: safeArray<string>(p.tags),
    };
  } catch {
    // Fallback : le modèle a répondu en texte libre, on emballe dans summary
    return {
      ...EMPTY_DESCRIPTION,
      summary: cleanContent.slice(0, 200),
      layout: {
        background: "",
        zones: [{ position: "centre", description: cleanContent, elements: [] }],
      },
    };
  }
}

export function formatDescriptionForDeepSeek(
  d: VisionDescription,
  detailLevel: "low" | "high" = "high",
): string {
  const lines: string[] = [
    `### [CONTEXTE VISUEL — IMAGE REÇUE]`,
    `Voici ce que tu vois dans l'image. C'est ta perception directe. Réponds comme si tu regardais l'image toi-même : ne dis JAMAIS que tu ne peux pas voir, que tu te fies à une description, ou qu'un autre modèle a analysé l'image. Pour toi, tu VOIS cette image. Si l'utilisateur dit "tu vois le truc là ?", tu réponds "oui" ou "non" directement.`,
    ``,
    `**Type** : ${d.scene_type}`,
    `**Ce que je vois** : ${d.summary}`,
  ];

  if (detailLevel === "low") {
    if (d.text_content.length > 0) {
      lines.push(`**Texte visible** : ${d.text_content.map((t) => t.text).join(" | ")}`);
    }
    lines.push(`### [FIN DU CONTEXTE VISUEL]`);
    return lines.join("\n");
  }

  // Structure globale
  if (d.layout.background) {
    lines.push(`**Fond** : ${d.layout.background}`);
  }
  if (d.layout.overall_structure) {
    lines.push(`**Structure** : ${d.layout.overall_structure}`);
  }
  if (d.layout.estimated_dimensions) {
    lines.push(`**Dimensions estimées** : ${d.layout.estimated_dimensions}`);
  }

  // Carte spatiale zone par zone
  if (d.layout.zones.length > 0) {
    lines.push(``, `**Carte spatiale** :`);
    for (const z of d.layout.zones) {
      lines.push(`- [${z.position}] ${z.description}`);
      for (const el of z.elements) {
        lines.push(`  - ${el}`);
      }
    }
  }

  // Texte extrait avec positions et style
  if (d.text_content.length > 0) {
    lines.push(``, `**Textes visibles** :`);
    for (const t of d.text_content) {
      lines.push(`- "${t.text}" → ${t.position} (${t.style})`);
    }
  }

  // Éléments interactifs
  if (d.interactive_elements.length > 0) {
    lines.push(``, `**Éléments interactifs** :`);
    for (const el of d.interactive_elements) {
      const extras: string[] = [];
      if (el.size) extras.push(`taille: ${el.size}`);
      if (el.dimensions) extras.push(`~${el.dimensions}`);
      if (el.border_radius) extras.push(`coins: ${el.border_radius}`);
      const suffix = extras.length > 0 ? `, ${extras.join(", ")}` : "";
      lines.push(
        `- ${el.type} "${el.label}" → ${el.position}, ${el.color}, état: ${el.state}${suffix}`,
      );
    }
  }

  // Indices visuels
  if (d.visual_cues.dominant_colors.length > 0) {
    lines.push(
      ``,
      `**Couleurs dominantes** : ${d.visual_cues.dominant_colors.join(", ")}`,
    );
  }
  if (d.visual_cues.highlighted) {
    lines.push(`**Point focal** : ${d.visual_cues.highlighted}`);
  }
  if (d.visual_cues.spatial_relations.length > 0) {
    lines.push(`**Relations spatiales** :`);
    for (const r of d.visual_cues.spatial_relations) {
      lines.push(`- ${r}`);
    }
  }

  // Notes de reproduction
  if (d.reproduction_notes) {
    lines.push(``, `**Guide de reproduction** : ${d.reproduction_notes}`);
  }

  if (d.tags.length > 0) {
    lines.push(``, `**Tags** : ${d.tags.join(", ")}`);
  }

  lines.push(``, `### [FIN DU CONTEXTE VISUEL]`);
  return lines.join("\n");
}
