export interface ModelCapabilities {
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  modalities?: { input: string[]; output: string[] };
  interleaved?: { field: string } | false;
  limit?: { context: number; output: number };
  cost?: { input: number; output: number; cache: { read: number; write: number } };
}

/**
 * Infère les capacités d'un modèle à partir de son ID et de sa source.
 * Utilise des patterns d'ID plutôt qu'une liste en dur pour être adaptatif :
 * tout nouveau modèle d'une famille reconnue obtient automatiquement les bonnes capacités.
 */
export function inferModelCapabilities(
  id: string,
  source: string,
): Partial<ModelCapabilities> {
  const lower = id.toLowerCase();
  const caps: Partial<ModelCapabilities> = {};

  // --- tool_call : la plupart des modèles modernes le supportent ---
  caps.tool_call = true;

  // --- temperature : désactivé pour les modèles à sortie déterministe ---
  const noTemperature =
    /(^|[/:])o[13](\b|[-_])|:thinking|flash-thinking|flash-thinking-exp|reasoner$/;
  caps.temperature = !noTemperature.test(lower);

  // --- modalities (entrées acceptées) ---
  const hasVision =
    /claude|gemini|gpt-4o|gpt-4\.1|vision|llava|cogvlm|v4-flash|sonnet|opus|haiku|reka|idefics|fuyu|paligemma|phi-3-vision|qwen-vl|internvl|minicpm-v/;
  const isTextOnly =
    /deepseek-(r1|v3|v4-pro|chat|reasoner)|^o[13]\b|llama-3|mixtral|mistral|qwen2\.5(?!-vl)|phi-3(?!-vision)|command-r/;
  if (source === "gemini" || lower.startsWith("google/gemini")) {
    caps.modalities = { input: ["text", "image", "audio", "video"], output: ["text"] };
  } else if (hasVision.test(lower)) {
    caps.modalities = { input: ["text", "image"], output: ["text"] };
  } else if (isTextOnly.test(lower)) {
    caps.modalities = { input: ["text"], output: ["text"] };
  } else {
    // défaut : texte seul
    caps.modalities = { input: ["text"], output: ["text"] };
  }

  // --- reasoning (modèles capables de réflexion / extended thinking) ---
  caps.reasoning = false;

  // DeepSeek (sauf deepseek-chat / deepseek-v3 standard sans reasoning_effort)
  if (
    source === "deepseek" ||
    lower.startsWith("deepseek/") ||
    lower.startsWith("deepseek-")
  ) {
    if (lower.includes("reasoner") || lower.includes("r1") || lower.includes("v4")) {
      caps.reasoning = true;
    }
  }

  // OpenAI o-series
  if (source === "openai" || lower.startsWith("openai/")) {
    if (/^o[13](\b|[-_])/.test(lower.replace(/^.*\//, ""))) {
      caps.reasoning = true;
    }
  }

  // Anthropic extended thinking (sonnet 3.7+, sonnet 4+, opus 4+)
  if (source === "anthropic" || lower.startsWith("anthropic/")) {
    if (/claude-3-7|claude-sonnet-4|claude-opus-4/.test(lower)) {
      caps.reasoning = true;
    }
  }

  // Gemini Pro et Flash-Thinking
  if (source === "gemini" || lower.startsWith("google/gemini")) {
    if (lower.includes("pro") || lower.includes("thinking")) {
      caps.reasoning = true;
    }
  }

  // OpenRouter : on détecte via le préfixe du provider dans l'ID
  if (source === "openrouter") {
    if (
      /deepseek.*(reasoner|r1|v4)/.test(lower) ||
      /^o[13](\b|[-_])/.test(lower.replace(/^.*\//, "")) ||
      /claude-(3-7|sonnet-4|opus-4)/.test(lower) ||
      /flash-thinking/.test(lower)
    ) {
      caps.reasoning = true;
    }
  }

  // --- interleaved (champ de streaming pour le contenu de réflexion) ---
  if (
    lower.includes("deepseek") ||
    lower.startsWith("deepseek-") ||
    source === "deepseek"
  ) {
    caps.interleaved = { field: "reasoning_content" };
  }
  if (source === "openrouter" && lower.includes("deepseek")) {
    caps.interleaved = { field: "reasoning_content" };
  }

  // --- limites de contexte par famille ---
  if (lower.includes("gemini")) {
    caps.limit = { context: 1_048_576, output: lower.includes("pro") ? 65536 : 8192 };
  } else if (lower.includes("deepseek")) {
    const ctx = 1_000_000;
    if (lower.includes("v4-pro")) caps.limit = { context: ctx, output: 32000 };
    else if (lower.includes("v4-flash")) caps.limit = { context: ctx, output: 16000 };
    else caps.limit = { context: ctx, output: 8000 };
  } else if (lower.includes("o1") || lower.includes("o3")) {
    caps.limit = { context: 200_000, output: 100_000 };
  } else if (lower.includes("claude") || lower.startsWith("anthropic")) {
    caps.limit = { context: 200_000, output: lower.includes("opus") ? 4096 : 8192 };
  } else if (lower.includes("gpt-4")) {
    caps.limit = { context: 128_000, output: 16384 };
  } else if (lower.includes("llama")) {
    caps.limit = { context: 131_072, output: 4096 };
  } else if (lower.startsWith("google/")) {
    caps.limit = { context: 1_048_576, output: 8192 };
  }

  return caps;
}
