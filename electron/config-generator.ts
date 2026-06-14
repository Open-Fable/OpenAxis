import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { randomBytes } from "crypto";

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

  const existingProviders = (existing.provider ?? {}) as Record<string, unknown>;
  const existingOhub = existingProviders.openhub as Record<string, unknown> | undefined;
  const existingModels = existingOhub?.models as Record<string, unknown> | undefined;

  // Decide which models to use:
  // If the user already has selected models in openhub (from Catalog), PRESERVE them.
  // Only use defaults for a fresh install (no existing models).
  let models: Record<string, Record<string, never>>;

  if (existingModels && Object.keys(existingModels).length > 0) {
    // Preserve user's catalog selections exactly
    models = existingModels as Record<string, Record<string, never>>;
    console.warn(
      `[config] Preserving ${Object.keys(models).length} user-selected models from Catalog`,
    );
  } else {
    // Fresh install: use defaults based on available API keys
    models = {};
    if (opts.anthropicKey) {
      models["claude-3-7-sonnet-latest"] = {};
      models["claude-3-5-sonnet-latest"] = {};
      models["claude-3-5-haiku-latest"] = {};
      models["claude-3-opus-latest"] = {};
      models["claude-sonnet-4-6"] = {};
      models["claude-opus-4-6"] = {};
      models["claude-haiku-4-5"] = {};
    }
    if (opts.openaiKey) {
      models["gpt-4o"] = {};
      models["gpt-4o-mini"] = {};
      models["o1"] = {};
      models["o1-preview"] = {};
      models["o1-mini"] = {};
      models["o3-mini"] = {};
    }
    models["google/gemini-2.0-flash-thinking-exp"] = {};
    models["google/gemini-2.0-pro-exp-02-05"] = {};
    models["google/gemini-2.0-flash"] = {};
    models["google/gemini-3-flash-preview"] = {};
    models["google/gemini-3-pro-preview"] = {};
    if (opts.openrouterKey) {
      models["anthropic/claude-3.7-sonnet"] = {};
      models["anthropic/claude-3.7-sonnet:thinking"] = {};
      models["openai/o1"] = {};
      models["openai/o3-mini"] = {};
      models["deepseek/deepseek-r1"] = {};
      models["deepseek/deepseek-chat"] = {};
      models["deepseek/deepseek-v4-pro"] = {};
      models["deepseek/deepseek-v4-flash"] = {};
      models["meta-llama/llama-3.3-70b-instruct"] = {};
    }
    models["llama3"] = {};
    models["mistral"] = {};
  }

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
