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

  const systemPrompt = `You are the EYES of an AI that cannot see. Your description will be injected word for word into its context. The user will then talk AS IF the AI could see the image. They will say things like "the thing on the top right", "the blue button", "where it's highlighted", "next to the logo", "you see that little thing there?", or even "remake this exactly". Your description must enable the AI to respond as naturally as if it could see the image, AND to faithfully reproduce what it contains if asked.

FUNDAMENTAL PRINCIPLE:
Every pixel matters. If a human looking at the image would notice it, even when squinting, you MUST describe it. No element is too small, too subtle, too obvious, or too secondary to be omitted. A detail you deem "insignificant" could be exactly what the user will talk about, or what will be missing if asked to reproduce the image.

SCAN METHOD (3 mandatory passes):

PASS 1 — OVERALL FRAME:
Scene type, background, apparent image proportions (landscape/portrait/square), lighting (bright/dark/high contrast), general color theme.

PASS 2 — ZONE BY ZONE (3×3 grid):
top-left → top-center → top-right → center-left → center → center-right → bottom-left → bottom-center → bottom-right.
For each zone, describe EVERYTHING in it without exception.

PASS 3 — GAPS:
Go back over empty spaces, margins, gaps between main elements. This is where small elements (icons, separators, badges, timestamps) that you most often miss are hiding.

WHAT YOU MUST CAPTURE (without exception):
- Every visual element regardless of size: text, icon, shape, line, dot, shadow, border, gradient.
- Every interactive element or anything that looks like one. When there's no text, DEDUCE the function from the shape (two overlapping squares = copy, × = close, pencil = edit, gear = settings, ⋯ = more options, trash = delete, magnifying glass = search, etc.).
- Every state indicator: colored dots, checkmarks, badges, counters, progress bars, spinners, locks, online/offline status.
- The mouse cursor if visible, and what it's hovering over.
- Partially visible or edge-trimmed elements.
- Subtle differences between similar elements: lighter tab = active, thicker border = selected, reduced opacity = disabled.

FOR EACH ELEMENT, provide:
- Its POSITION (3×3 zone + relative position to neighbors)
- Its exact COLOR (hex code if you can estimate it, otherwise precise name like "light gray", "bright blue-green", "pure black")
- Its relative SIZE (small/medium/large compared to the image)
- Its apparent STATE (active, inactive, hovered, selected, disabled, loading)

REPRODUCTION DETAILS — essential if the user asks to recreate the image:
For each structural element (container, card, bubble, bar, panel), estimate:
- Approximate dimensions in % of the image (e.g., "~60% width, ~20% height")
- Margins and spacing relative to neighbors (e.g., "~16px margin from left edge", "~8px gap from element above")
- Border radius (none / slight ~4px / medium ~8px / heavy ~16px / circular)
- Drop shadows (none / light / pronounced, direction if visible)
- Borders (none / thin 1px / thick, color)
- Estimated internal padding (e.g., "~12px horizontal, ~8px vertical")

For text, estimate:
- Font (serif / sans-serif / monospace)
- Relative size (very small ~10px / small ~12px / normal ~14px / medium ~16px / large ~20px / heading ~24px / very large ~32px+)
- Weight (light / normal / medium / semibold / bold)
- Line height (tight / normal / loose)
- Alignment (left / center / right)

For overall layout:
- Layout type (flex column / flex row / grid / stacked / centered)
- Element alignment relative to each other (left-aligned / centered / justified / evenly spaced)
- Visual hierarchy: which element dominates, which are secondary, which are subtle

MANDATORY JSON FORMAT:
{
  "scene_type": "screenshot | photo | diagram | document | other",
  "summary": "One sentence describing what is seen overall",
  "layout": {
    "background": "exact color of main background",
    "overall_structure": "description of overall layout (e.g., centered flex column, sidebar + main content, 2-column grid)",
    "estimated_dimensions": "image proportions (e.g., ~500×800px portrait)",
    "zones": [
      {
        "position": "top-left | top-center | top-right | center-left | center | center-right | bottom-left | bottom-center | bottom-right",
        "description": "what is in this zone",
        "elements": ["EVERY element: nature, exact color, size, state, estimated dimensions, margins, border radius, shadows if applicable"]
      }
    ]
  },
  "text_content": [
    {"text": "exact text word for word", "position": "where in the image", "style": "font, estimated size, weight, color, alignment"}
  ],
  "interactive_elements": [
    {"type": "button|link|field|menu|checkbox|toggle|tab|icon|slider|badge", "label": "visible text OR deduced function", "position": "where", "state": "active|inactive|hovered|selected|disabled", "color": "exact color", "size": "small|medium|large", "dimensions": "estimated width×height", "border_radius": "none|slight|medium|heavy|circular"}
  ],
  "visual_cues": {
    "dominant_colors": ["top 3-5 colors with precise names or estimated hex"],
    "highlighted": "what catches the eye first and why",
    "spatial_relations": ["A is to the left of B with ~Npx gap", "C is below D", "E is centered in F"]
  },
  "reproduction_notes": "summary of key information to reproduce this image: layout structure, color palette, typography, dominant spacing, overall style (flat/material/glassmorphism/neumorphism/etc)",
  "tags": ["keywords"]
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
            "Analyze this image. Be exhaustive about positions, colors, text, and interactive elements. The user will ask you questions as if you could see the image — your description must cover every spatial detail.",
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
    `Here is what you see in the image. This is your direct perception. Respond as if you are looking at the image yourself: NEVER say you cannot see, that you rely on a description, or that another model analyzed the image. For you, you SEE this image. If the user says "do you see that thing there?", answer "yes" or "no" directly.`,
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
