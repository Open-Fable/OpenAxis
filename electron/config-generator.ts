import { promises as fs } from "fs";
import path from "path";
import os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json");

interface GenerateOptions {
  proxyToken: string;
  anthropicKey: string | null;
  openaiKey: string | null;
  openrouterKey: string | null;
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

  const models: Record<string, Record<string, never>> = {};
  if (opts.anthropicKey) {
    models["claude-sonnet-4-6"] = {};
    models["claude-opus-4-6"] = {};
    models["claude-haiku-4-5"] = {};
  }
  if (opts.openaiKey) {
    models["gpt-4o"] = {};
    models["gpt-4o-mini"] = {};
  }
  // Google Gemini models via OpenHub proxy
  models["google/gemini-3-flash-preview"] = {};
  models["google/gemini-3-pro-preview"] = {};
  models["google/gemini-3.1-pro-preview"] = {};
  models["google/gemini-2.5-pro"] = {};
  models["google/gemini-2.5-flash"] = {};
  if (opts.openrouterKey) {
    models["anthropic/claude-opus-4"] = {};
    models["anthropic/claude-sonnet-4-5"] = {};
    models["openai/gpt-4o"] = {};
    models["deepseek/deepseek-r1"] = {};
    models["deepseek/deepseek-v4-pro"] = {};
    models["deepseek/deepseek-v4-flash"] = {};
    models["meta-llama/llama-3.3-70b-instruct"] = {};
  }
  models["llama3"] = {};
  models["mistral"] = {};

  const existingProviders = (existing.provider ?? {}) as Record<string, unknown>;

  // Ensure we don't carry over the invalid key from existing config
  const cleanExisting = { ...existing };
  delete cleanExisting.selectedModels;

  const config = {
    ...cleanExisting,
    $schema: "https://opencode.ai/config.json",
    provider: {
      ...existingProviders,
      openhub: {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenHub Proxy",
        options: {
          baseURL: "http://localhost:9999/v1",
          apiKey: opts.proxyToken,
          headerTimeout: 60000,
        },
        models,
      },
    },
  };

  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  console.warn(`[config] opencode.json → ${CONFIG_PATH}`);
}
