import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomBytes } from "crypto";
import { inferModelCapabilities } from "./model-capabilities.js";

const CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json");

/**
 * Détermine la "source" d'un modèle pour l'inférence de capacités.
 * Utilise le préfixe ou le pattern du nom pour détecter le fournisseur.
 */
function inferModelSource(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("anthropic/") || lower.startsWith("claude-")) return "anthropic";
  if (lower.startsWith("openai/") || lower.startsWith("gpt-") || /^o[13]\b/.test(lower))
    return "openai";
  if (
    lower.startsWith("deepseek/") ||
    lower.startsWith("deepseek-") ||
    lower.includes("deepseek")
  )
    return "deepseek";
  if (lower.startsWith("google/") || lower.startsWith("gemini")) return "gemini";
  return "custom";
}

interface GenerateOptions {
  proxyToken: string;
  anthropicKey: string | null;
  openaiKey: string | null;
  deepseekKey: string | null;
  openrouterKey: string | null;
  customProviders?: Array<{
    id: string;
    name: string;
    baseUrl: string;
    models: string[];
  }> | null;
}

export async function generateOpenCodeConfig(opts: GenerateOptions): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // No existing config — start fresh
  }

  const existingProviders = (existing.provider ?? {}) as Record<string, unknown>;
  // Explicitly remove legacy openhub/openhb proxy configurations
  delete existingProviders.openhub;
  delete existingProviders.openhb;

  const existingOhub = existingProviders.openaxis as Record<string, unknown> | undefined;
  const existingModels = existingOhub?.models as Record<string, unknown> | undefined;

  // Load Ollama URL from keychain
  const { readAllApiKeys } = await import("./keychain.js");
  const keys = await readAllApiKeys();
  const ollamaUrl = keys.ollamaUrl || "http://127.0.0.1:11434";

  // Identify which providers are enabled
  const hasAnthropic = !!opts.anthropicKey;
  const hasOpenAI = !!opts.openaiKey;
  const hasDeepSeek = !!opts.deepseekKey;
  const hasOpenRouter = !!opts.openrouterKey;

  // Get installed Ollama models
  let ollamaFetchSuccess = false;
  const installedOllamaModels = new Set<string>();
  try {
    const safeUrl = ollamaUrl.startsWith("http") ? ollamaUrl : "http://127.0.0.1:11434";
    const res = await fetch(`${safeUrl}/api/tags`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      for (const m of data.models ?? []) {
        installedOllamaModels.add(m.name);
      }
      ollamaFetchSuccess = true;
    }
  } catch {
    // Ollama offline / not installed
  }

  // Get all custom provider models
  const customModelIds = new Set<string>();
  if (opts.customProviders) {
    for (const cp of opts.customProviders) {
      for (const mId of cp.models) {
        customModelIds.add(mId);
      }
    }
  }

  const isModelAvailable = (modelId: string): boolean => {
    const source = inferModelSource(modelId);
    if (source === "anthropic") return hasAnthropic;
    if (source === "openai") return hasOpenAI;
    if (source === "deepseek") return hasDeepSeek;
    if (source === "openrouter") return hasOpenRouter;
    if (source === "gemini") return false; // Gemini OAuth is deprecated/blocked by Google

    // Custom / Ollama models
    if (customModelIds.has(modelId)) return true;
    if (modelId === "llama3" || modelId === "mistral") {
      return installedOllamaModels.has(modelId);
    }
    if (!ollamaFetchSuccess) return true; // Preserve user's other local config if Ollama is offline
    return installedOllamaModels.has(modelId);
  };

  // Decide which models to use:
  // If the user already has selected models in openaxis (from Catalog), PRESERVE them if they are available.
  // Only use defaults for a fresh install (no existing models).
  let models: Record<string, Record<string, unknown>>;

  if (existingModels && Object.keys(existingModels).length > 0) {
    // Preserve user's catalog selections exactly, but filter out unavailable ones
    models = {};
    for (const [modelId, meta] of Object.entries(existingModels)) {
      if (isModelAvailable(modelId)) {
        models[modelId] = meta as Record<string, unknown>;
      }
    }
    console.warn(
      `[config] Preserving ${Object.keys(models).length} user-selected models from Catalog (filtered from ${Object.keys(existingModels).length})`,
    );
  } else {
    // Fresh install: use defaults based on available API keys and connections
    models = {};
    if (hasAnthropic) {
      models["claude-3-7-sonnet-latest"] = {};
      models["claude-3-5-sonnet-latest"] = {};
      models["claude-3-5-haiku-latest"] = {};
      models["claude-3-opus-latest"] = {};
      models["claude-sonnet-4-6"] = {};
      models["claude-opus-4-6"] = {};
      models["claude-haiku-4-5"] = {};
    }
    if (hasOpenAI) {
      models["gpt-4o"] = {};
      models["gpt-4o-mini"] = {};
      models["o1"] = {};
      models["o1-preview"] = {};
      models["o1-mini"] = {};
      models["o3-mini"] = {};
    }
    if (hasDeepSeek) {
      models["deepseek-chat"] = {};
      models["deepseek-reasoner"] = {};
    }
    if (hasOpenRouter) {
      models["anthropic/claude-sonnet-4-6"] = {};
      models["anthropic/claude-sonnet-4-6:thinking"] = {};
      models["openai/o1"] = {};
      models["openai/o3-mini"] = {};
      models["deepseek/deepseek-r1"] = {};
      models["deepseek/deepseek-chat"] = {};
      models["meta-llama/llama-3.3-70b-instruct"] = {};
    }
    if (installedOllamaModels.has("llama3")) {
      models["llama3"] = {};
    }
    if (installedOllamaModels.has("mistral")) {
      models["mistral"] = {};
    }
  }

  if (opts.customProviders) {
    for (const provider of opts.customProviders) {
      for (const mId of provider.models) {
        models[mId] = models[mId] || {};
      }
    }
  }

  // Enrich ALL models with adaptive capabilities (reasoning, limit, interleaved, etc.)
  // Pattern-based : tout nouveau modèle d'une famille reconnue obtient automatiquement
  // les bonnes capacités sans mise à jour manuelle du catalogue.
  for (const modelId of Object.keys(models)) {
    const source = inferModelSource(modelId);
    const caps = inferModelCapabilities(modelId, source);
    if (Object.keys(caps).length > 0) {
      // Les valeurs explicites de l'utilisateur (s'il y en a) écrasent les inférences.
      models[modelId] = { ...caps, ...(models[modelId] as Record<string, unknown>) };
    }
  }

  // Ensure we don't carry over the invalid key from existing config
  const cleanExisting = { ...existing };
  delete cleanExisting.selectedModels;

  const config = {
    ...cleanExisting,
    $schema: "https://opencode.ai/config.json",
    provider: {
      ...existingProviders,
      openaxis: {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenAxis Proxy",
        options: {
          baseURL: "http://localhost:9999/v1",
          apiKey: opts.proxyToken,
          headerTimeout: 60000,
        },
        models,
      },
    },
  };

  // The file embeds the per-session proxy token — restrict to owner read/write.
  // Write to a fresh 0600 temp file then atomically rename over the target, so the
  // secret is never briefly readable via a pre-existing file's looser perms and a
  // concurrent reader never sees a half-written config.
  const tmpPath = `${CONFIG_PATH}.tmp.${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.rename(tmpPath, CONFIG_PATH);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
  console.warn(`[config] opencode.json → ${CONFIG_PATH}`);
}
