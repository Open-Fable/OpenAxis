import { describe, it, expect, vi, beforeEach } from "vitest";

// fs.promises mocké par un système de fichiers en mémoire : on contrôle le
// contenu existant de opencode.json et on inspecte le fichier écrit (contenu +
// permissions), sans jamais toucher au vrai ~/.config/opencode/opencode.json.
interface WrittenFile {
  content: string;
  mode?: number;
}
const fsState = {
  files: new Map<string, WrittenFile>(),
};

vi.mock("fs", () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(async (p: string) => {
      const f = fsState.files.get(p);
      if (!f) throw new Error("ENOENT");
      return f.content;
    }),
    writeFile: vi.fn(async (p: string, content: string, opts?: { mode?: number }) => {
      fsState.files.set(p, { content, mode: opts?.mode });
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const f = fsState.files.get(from);
      if (f) {
        fsState.files.set(to, f);
        fsState.files.delete(from);
      }
    }),
    rm: vi.fn(async (p: string) => {
      fsState.files.delete(p);
    }),
  },
}));

import os from "os";
import path from "path";
import { generateOpenCodeConfig } from "./config-generator.js";

const CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json");

function readGeneratedConfig(): { config: Record<string, unknown>; mode?: number } {
  const f = fsState.files.get(CONFIG_PATH);
  if (!f) throw new Error("config non écrite");
  return { config: JSON.parse(f.content) as Record<string, unknown>, mode: f.mode };
}

function getModels(config: Record<string, unknown>): Record<string, unknown> {
  const provider = config.provider as Record<string, unknown>;
  const openhub = provider.openhub as Record<string, unknown>;
  return openhub.models as Record<string, unknown>;
}

const noKeys = { anthropicKey: null, openaiKey: null, openrouterKey: null };

describe("config-generator — generateOpenCodeConfig", () => {
  beforeEach(() => {
    fsState.files.clear();
  });

  it("écrit le provider openhub pointant vers le proxy local avec le token de session", async () => {
    await generateOpenCodeConfig({ proxyToken: "tok-123", ...noKeys });
    const { config } = readGeneratedConfig();
    const provider = config.provider as Record<string, unknown>;
    const openhub = provider.openhub as Record<string, unknown>;
    const options = openhub.options as Record<string, unknown>;
    expect(options.baseURL).toBe("http://localhost:9999/v1");
    expect(options.apiKey).toBe("tok-123");
    expect(config.$schema).toBe("https://opencode.ai/config.json");
  });

  it("écrit le fichier avec des permissions 0600 (le token y est embarqué)", async () => {
    await generateOpenCodeConfig({ proxyToken: "secret", ...noKeys });
    const { mode } = readGeneratedConfig();
    expect(mode).toBe(0o600);
  });

  it("inclut les modèles Anthropic uniquement si une clé Anthropic est fournie", async () => {
    await generateOpenCodeConfig({
      proxyToken: "t",
      anthropicKey: "sk-ant",
      openaiKey: null,
      openrouterKey: null,
    });
    const models = getModels(readGeneratedConfig().config);
    expect(models["claude-sonnet-4-6"]).toBeDefined();
    expect(models["gpt-4o"]).toBeUndefined();
  });

  it("inclut les modèles OpenAI et OpenRouter selon les clés disponibles", async () => {
    await generateOpenCodeConfig({
      proxyToken: "t",
      anthropicKey: null,
      openaiKey: "sk-oai",
      openrouterKey: "sk-or",
    });
    const models = getModels(readGeneratedConfig().config);
    expect(models["gpt-4o"]).toBeDefined();
    expect(models["deepseek/deepseek-r1"]).toBeDefined();
    expect(models["claude-sonnet-4-6"]).toBeUndefined();
  });

  it("inclut toujours les modèles Gemini et locaux (llama3, mistral) par défaut", async () => {
    await generateOpenCodeConfig({ proxyToken: "t", ...noKeys });
    const models = getModels(readGeneratedConfig().config);
    expect(models["google/gemini-2.0-flash"]).toBeDefined();
    expect(models["llama3"]).toBeDefined();
    expect(models["mistral"]).toBeDefined();
  });

  it("PRÉSERVE les modèles sélectionnés par l'utilisateur dans le Catalog", async () => {
    fsState.files.set(CONFIG_PATH, {
      content: JSON.stringify({
        provider: {
          openhub: { models: { "modele-perso-1": {}, "modele-perso-2": {} } },
        },
      }),
    });
    await generateOpenCodeConfig({
      proxyToken: "t",
      anthropicKey: "sk-ant",
      openaiKey: null,
      openrouterKey: null,
    });
    const models = getModels(readGeneratedConfig().config);
    expect(Object.keys(models)).toEqual(["modele-perso-1", "modele-perso-2"]);
    // Les défauts Anthropic ne doivent PAS écraser la sélection existante
    expect(models["claude-sonnet-4-6"]).toBeUndefined();
  });

  it("préserve les autres providers existants et nettoie selectedModels invalide", async () => {
    fsState.files.set(CONFIG_PATH, {
      content: JSON.stringify({
        provider: { autre: { name: "Autre" } },
        selectedModels: ["ancien-format-invalide"],
        customField: "garde-moi",
      }),
    });
    await generateOpenCodeConfig({ proxyToken: "t", ...noKeys });
    const { config } = readGeneratedConfig();
    const provider = config.provider as Record<string, unknown>;
    expect(provider.autre).toBeDefined();
    expect(provider.openhub).toBeDefined();
    expect(config.selectedModels).toBeUndefined();
    expect(config.customField).toBe("garde-moi");
  });

  it("repart de zéro quand le fichier existant est un JSON corrompu", async () => {
    fsState.files.set(CONFIG_PATH, { content: "{ pas du json" });
    await generateOpenCodeConfig({ proxyToken: "t", ...noKeys });
    const { config } = readGeneratedConfig();
    expect((config.provider as Record<string, unknown>).openhub).toBeDefined();
  });
});
