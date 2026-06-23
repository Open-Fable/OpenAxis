import { describe, it, expect, vi, beforeEach } from "vitest";

// fs.promises.readFile est mocké pour piloter le contenu de settings.json
// sans toucher le disque réel de l'utilisateur (~/.config/openaxis/settings.json).
const readFileMock = vi.fn();
vi.mock("fs", () => ({
  promises: {
    readFile: (...args: unknown[]) => readFileMock(...args),
  },
}));

import {
  shouldBypassVisionProxy,
  parseVisionResponse,
  formatDescriptionForDeepSeek,
  getVisionConfig,
  MAX_IMAGE_SIZE_MB,
} from "./vision.js";

describe("vision — shouldBypassVisionProxy", () => {
  it("bypasse les modèles à vision native", () => {
    expect(shouldBypassVisionProxy("gpt-4o")).toBe(true);
    expect(shouldBypassVisionProxy("GPT-4O-mini")).toBe(true);
    expect(shouldBypassVisionProxy("claude-3-5-sonnet-latest")).toBe(true);
    expect(shouldBypassVisionProxy("claude-3-opus-latest")).toBe(true);
    expect(shouldBypassVisionProxy("gemini-2.0-flash")).toBe(true);
    expect(shouldBypassVisionProxy("pixtral-12b")).toBe(true);
    expect(shouldBypassVisionProxy("o1-preview")).toBe(true);
  });

  it("ne bypasse JAMAIS DeepSeek ni Llama (modèles texte pur)", () => {
    expect(shouldBypassVisionProxy("deepseek-v4-pro")).toBe(false);
    expect(shouldBypassVisionProxy("meta-llama/llama-3.3-70b")).toBe(false);
    // Même si "vision" apparaît, deepseek/llama forcent le proxy
    expect(shouldBypassVisionProxy("deepseek-vision")).toBe(false);
    expect(shouldBypassVisionProxy("llava-llama")).toBe(false);
  });

  it("ne bypasse pas les modèles texte génériques", () => {
    expect(shouldBypassVisionProxy("mistral")).toBe(false);
    expect(shouldBypassVisionProxy("gpt-3.5-turbo")).toBe(false);
    expect(shouldBypassVisionProxy("")).toBe(false);
  });
});

describe("vision — parseVisionResponse", () => {
  it("retourne une description vide pour un contenu vide", () => {
    const d = parseVisionResponse("");
    expect(d.tags).toEqual([]);
    expect(d.layout.zones).toEqual([]);
    expect(d.text_content).toEqual([]);
  });

  it("parse un JSON de vision complet", () => {
    const json = JSON.stringify({
      scene_type: "ui",
      summary: "Un écran de connexion",
      layout: {
        background: "bleu nuit",
        overall_structure: "centré",
        estimated_dimensions: "1280x720",
        zones: [
          { position: "centre", description: "formulaire", elements: ["champ email"] },
        ],
      },
      text_content: [{ text: "Connexion", position: "haut", style: "gras" }],
      interactive_elements: [
        {
          type: "bouton",
          label: "Valider",
          position: "bas",
          color: "bleu",
          state: "actif",
        },
      ],
      visual_cues: {
        dominant_colors: ["bleu", "blanc"],
        highlighted: "le bouton",
        spatial_relations: ["le bouton est sous le champ"],
      },
      reproduction_notes: "centrer verticalement",
      tags: ["login", "form"],
    });

    const d = parseVisionResponse(json);
    expect(d.scene_type).toBe("ui");
    expect(d.summary).toBe("Un écran de connexion");
    expect(d.layout.zones).toHaveLength(1);
    expect(d.text_content[0].text).toBe("Connexion");
    expect(d.interactive_elements[0].label).toBe("Valider");
    expect(d.visual_cues.dominant_colors).toEqual(["bleu", "blanc"]);
    expect(d.tags).toEqual(["login", "form"]);
  });

  it("extrait le JSON noyé dans du texte libre", () => {
    const content =
      'Voici le résultat :\n{"scene_type":"photo","summary":"un chat"}\nFin.';
    const d = parseVisionResponse(content);
    expect(d.scene_type).toBe("photo");
    expect(d.summary).toBe("un chat");
  });

  it("retombe sur summary tronqué quand la réponse n'est pas du JSON", () => {
    const text = "x".repeat(300);
    const d = parseVisionResponse(text);
    expect(d.summary).toHaveLength(200);
    expect(d.layout.zones[0].position).toBe("centre");
  });

  it("applique des valeurs par défaut robustes pour des champs manquants", () => {
    const d = parseVisionResponse('{"summary":"partiel"}');
    expect(d.scene_type).toBe("other");
    expect(d.summary).toBe("partiel");
    expect(d.text_content).toEqual([]);
    expect(d.interactive_elements).toEqual([]);
  });
});

describe("vision — formatDescriptionForDeepSeek", () => {
  const base = parseVisionResponse(
    JSON.stringify({
      scene_type: "ui",
      summary: "Un dashboard",
      layout: {
        background: "gris",
        zones: [{ position: "haut", description: "barre", elements: ["logo"] }],
      },
      text_content: [{ text: "Tableau de bord", position: "haut", style: "titre" }],
      interactive_elements: [
        {
          type: "bouton",
          label: "Exporter",
          position: "droite",
          color: "vert",
          state: "actif",
        },
      ],
      visual_cues: {
        dominant_colors: ["gris", "vert"],
        highlighted: "bouton export",
        spatial_relations: [],
      },
      tags: ["dashboard"],
    }),
  );

  it("produit un contexte visuel complet en mode high", () => {
    const out = formatDescriptionForDeepSeek(base, "high");
    expect(out).toContain("[CONTEXTE VISUEL");
    expect(out).toContain("Un dashboard");
    expect(out).toContain("Tableau de bord");
    expect(out).toContain("Exporter");
    expect(out).toContain("Couleurs dominantes");
    expect(out).toContain("dashboard");
  });

  it("produit une version compacte en mode low (texte seul, pas d'éléments interactifs)", () => {
    const out = formatDescriptionForDeepSeek(base, "low");
    expect(out).toContain("Tableau de bord");
    expect(out).toContain("[FIN DU CONTEXTE VISUEL]");
    expect(out).not.toContain("Éléments interactifs");
    expect(out).not.toContain("Couleurs dominantes");
  });

  it("instruit le modèle de ne jamais avouer qu'il ne voit pas", () => {
    const out = formatDescriptionForDeepSeek(base);
    expect(out.toLowerCase()).toContain("tu vois");
  });
});

describe("vision — getVisionConfig", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it("retourne la config par défaut quand settings.json est absent", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    const cfg = await getVisionConfig();
    expect(cfg.visionProxyEnabled).toBe(true);
    expect(cfg.visionModel).toBe("openbmb/minicpm-v4.6");
    expect(cfg.ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(cfg.visionDetailLevel).toBe("high");
  });

  it("fusionne les valeurs lues depuis settings.json", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        visionProxyEnabled: false,
        visionModel: "custom-vlm",
        ollamaUrl: "http://192.168.1.10:11434",
        visionDetailLevel: "low",
      }),
    );
    const cfg = await getVisionConfig();
    expect(cfg.visionProxyEnabled).toBe(false);
    expect(cfg.visionModel).toBe("custom-vlm");
    expect(cfg.ollamaUrl).toBe("http://192.168.1.10:11434");
    expect(cfg.visionDetailLevel).toBe("low");
  });

  it("rejette une URL Ollama dangereuse (SSRF métadonnées cloud) et retombe sur loopback", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({ ollamaUrl: "http://169.254.169.254/latest/meta-data/" }),
    );
    const cfg = await getVisionConfig();
    expect(cfg.ollamaUrl).toBe("http://127.0.0.1:11434");
  });

  it("privilégie l'override d'URL passé en argument", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({ ollamaUrl: "http://192.168.1.10:11434" }),
    );
    const cfg = await getVisionConfig("http://localhost:11434");
    expect(cfg.ollamaUrl).toBe("http://localhost:11434");
  });
});

describe("vision — constantes", () => {
  it("plafonne la taille d'image à 10 Mo", () => {
    expect(MAX_IMAGE_SIZE_MB).toBe(10);
  });
});
