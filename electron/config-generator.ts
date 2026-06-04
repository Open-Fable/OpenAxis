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

  const models: Record<string, { name: string }> = {};
  if (opts.anthropicKey) {
    models["claude-sonnet-4-6"] = { name: "Claude Sonnet 4.6" };
    models["claude-opus-4-6"] = { name: "Claude Opus 4.6" };
    models["claude-haiku-4-5"] = { name: "Claude Haiku 4.5" };
  }
  if (opts.openaiKey) {
    models["gpt-4o"] = { name: "GPT-4o" };
    models["gpt-4o-mini"] = { name: "GPT-4o Mini" };
  }
  if (opts.openrouterKey) {
    models["anthropic/claude-opus-4"] = { name: "Claude Opus 4 (OpenRouter)" };
    models["anthropic/claude-sonnet-4-5"] = { name: "Claude Sonnet 4.5 (OpenRouter)" };
    models["openai/gpt-4o"] = { name: "GPT-4o (OpenRouter)" };
    models["google/gemini-2.0-flash-001"] = { name: "Gemini 2.0 Flash (OpenRouter)" };
    models["deepseek/deepseek-r1"] = { name: "DeepSeek R1 (OpenRouter)" };
    models["meta-llama/llama-3.3-70b-instruct"] = { name: "Llama 3.3 70B (OpenRouter)" };
  }
  models["llama3"] = { name: "Llama 3 (local)" };
  models["mistral"] = { name: "Mistral (local)" };

  const existingProviders = (existing.provider ?? {}) as Record<string, unknown>;

  const config = {
    ...existing,
    $schema: "https://opencode.ai/config.json",
    provider: {
      ...existingProviders,
      openhub: {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenHub Proxy",
        options: {
          baseURL: "http://localhost:9999/v1",
          apiKey: opts.proxyToken,
        },
        models,
      },
    },
  };

  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  console.warn(`[config] opencode.json → ${CONFIG_PATH}`);
}
