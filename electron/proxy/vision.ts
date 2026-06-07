import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";

export interface VisionConfig {
  visionProxyEnabled: boolean;
  visionModel: string;
  ollamaUrl: string;
  visionDetailLevel: "low" | "high";
}

export interface VisionDescription {
  summary: string;
  details: string;
  tags: string[];
  ui_elements?: string[];
  text_content?: string;
}

export interface VisionMessagePart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
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
    "vision"
  ];
  return nativeVisionModels.some(m => lowercaseName.includes(m));
}

/**
 * Lit la configuration de vision depuis settings.json
 * Accepte une URL optionnelle pour écraser celle par défaut (provenant du Keychain)
 */
export async function getVisionConfig(overrideOllamaUrl?: string | null): Promise<VisionConfig> {
  const settingsPath = path.join(homedir(), ".config", "openhub", "settings.json");
  const defaultConfig: VisionConfig = {
    visionProxyEnabled: true,
    visionModel: "openbmb/minicpm-v4.6",
    ollamaUrl: overrideOllamaUrl || "http://127.0.0.1:11434",
    visionDetailLevel: "high",
  };

  try {
    const content = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    
    return {
      visionProxyEnabled: settings.visionProxyEnabled ?? defaultConfig.visionProxyEnabled,
      visionModel: settings.visionModel ?? defaultConfig.visionModel,
      ollamaUrl: overrideOllamaUrl || settings.ollamaUrl || defaultConfig.ollamaUrl,
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
      signal: AbortSignal.timeout(2000)
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
  config: VisionConfig
): Promise<VisionDescription> {
  // Nettoyage du base64 (retrait du préfixe data:image/...)
  const base64Data = imageBase64.includes(",") 
    ? imageBase64.split(",")[1] 
    : imageBase64;

  // Vérification de la taille
  const imageBuffer = Buffer.from(base64Data, "base64");
  const sizeMB = imageBuffer.length / (1024 * 1024);
  if (sizeMB > MAX_IMAGE_SIZE_MB) {
    throw new Error(`Image trop volumineuse : ${sizeMB.toFixed(2)} Mo (max ${MAX_IMAGE_SIZE_MB} Mo)`);
  }

  const systemPrompt = `Tu es un expert en vision par ordinateur et analyse d'images. 
Ton but est de décrire avec précision et de manière exhaustive l'image fournie.
Fournis une analyse détaillée couvrant :
1. **Résumé** : Une description courte de l'image.
2. **Détails** : Une analyse approfondie de la scène, des sujets, des objets et de l'ambiance.
3. **Interface Utilisateur (UI)** : Si l'image est une capture d'écran, décris les composants UI (boutons, formulaires, navigation).
4. **Texte** : Extrais tout le texte visible.
5. **Tags** : Liste des mots-clés pertinents.

Réponds TOUJOURS au format JSON suivant :
{
  "summary": "...",
  "details": "...",
  "ui_elements": ["...", "..."],
  "text_content": "...",
  "tags": ["...", "..."]
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
          content: "Décris cette image en détail en respectant le format JSON demandé.",
          images: [base64Data] 
        }
      ],
      stream: false,
      format: "json",
      options: {
        num_ctx: 8192, // Limite le contexte à 8k pour économiser de la RAM
        temperature: 0.1
      }
    }),
    signal: AbortSignal.timeout(45000), // Timeout réduit à 45s
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.statusText}`);
  }

  const result = (await response.json()) as any;
  const content = result?.message?.content || result?.content || "";
  
  if (!content) {
    throw new Error("Réponse Ollama vide ou malformée (champ content manquant)");
  }

  return parseVisionResponse(content);
}

/**
 * Structure la sortie du modèle avec une tolérance aux erreurs de syntaxe
 */
export function parseVisionResponse(content: string): VisionDescription {
  if (!content) {
    return {
      summary: "Aucune donnée de vision",
      details: "Le modèle n'a renvoyé aucun contenu.",
      tags: [],
    };
  }

  const cleanContent = content.trim();
  
  try {
    // 1. Tentative de parsing JSON standard
    const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : cleanContent;
    const parsed = JSON.parse(jsonStr);
    
    return {
      summary: parsed.summary || parsed.resume || "Analyse d'image",
      details: parsed.details || parsed.description || "Aucun détail supplémentaire",
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      ui_elements: Array.isArray(parsed.ui_elements) ? parsed.ui_elements : [],
      text_content: typeof parsed.text_content === 'string' ? parsed.text_content : JSON.stringify(parsed.text_content || ""),
    };
  } catch (e) {
    // 2. Fallback par Expressions Régulières si le JSON est malformé
    // Utile quand le modèle liste des éléments sans crochets ou oublie des guillemets
    
    const summary = cleanContent.match(/"summary"\s*:\s*"([^"]+)"/i)?.[1] || 
                    cleanContent.match(/Résumé\s*:\s*([^\n]+)/i)?.[1] || 
                    "Analyse visuelle";
                    
    const details = cleanContent.match(/"details"\s*:\s*"([^"]+)"/i)?.[1] || 
                    cleanContent.match(/Analyse détaillée\s*:\s*([\s\S]+?)(?="\w+"\s*:|###|$)/i)?.[1] || 
                    cleanContent; // Si tout échoue, on prend le brut

    // Extraction basique des tags (souvent source d'erreur JSON)
    const tagsMatch = cleanContent.match(/"tags"\s*:\s*\[?([^\]]+)\]?/i);
    const tags = tagsMatch ? tagsMatch[1].split(',').map(t => t.replace(/"/g, '').trim()) : [];

    return {
      summary: summary.trim(),
      details: details.trim(),
      tags: tags,
      text_content: cleanContent.match(/"text_content"\s*:\s*"([^"]+)"/i)?.[1] || ""
    };
  }
}

/**
 * Prépare la description pour injection dans le prompt final (ex: DeepSeek)
 */
export function formatDescriptionForDeepSeek(
  description: VisionDescription,
  detailLevel: "low" | "high" = "high"
): string {
  let output = `### [DÉBUT DU CONTEXTE VISUEL GÉNÉRÉ LOCALEMENT]\n`;
  output += `Ce message contenait une image qui a été analysée par un modèle de vision local car ton modèle actuel ne supporte pas la vision native. Voici la transcription fidèle de ce qui est visible :\n\n`;
  output += `**Résumé** : ${description.summary}\n`;

  if (detailLevel === "low") {
    if (description.text_content) {
      output += `**Texte extrait** : ${description.text_content}\n`;
    }
    output += `\n### [FIN DU CONTEXTE VISUEL]\n`;
    return output;
  }

  output += `**Analyse détaillée** : ${description.details}\n`;
  
  if (description.text_content) {
    output += `**Texte extrait** : ${description.text_content}\n`;
  }
  
  if (description.ui_elements && description.ui_elements.length > 0) {
    output += `**Éléments UI détectés** : ${description.ui_elements.join(", ")}\n`;
  }
  
  if (description.tags && description.tags.length > 0) {
    output += `**Mots-clés** : ${description.tags.join(", ")}\n`;
  }
  
  output += `\n### [FIN DU CONTEXTE VISUEL]\n\n`;
  output += `*Note : Utilise la transcription ci-dessus comme source de vérité visuelle pour répondre à la consigne suivante :*\n`;
  
  return output;
}
