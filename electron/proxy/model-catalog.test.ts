import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any SUT import so vi.mock hoisting works.
// Mirrors the setup in ollama-models.test.ts to import proxy/index without
// booting the Express server or touching the real keychain.
// ---------------------------------------------------------------------------

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(async (p: string) => {
      if (p.includes("settings.json")) {
        return JSON.stringify({
          customProviders: [
            {
              id: "custom-groq",
              name: "Groq",
              baseUrl: "https://api.groq.com/openai/v1",
              models: ["llama3-8b"],
            },
          ],
        });
      }
      throw new Error("ENOENT");
    }),
  },
}));

vi.mock("express", () => {
  const app = {
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    listen: vi.fn(),
    options: vi.fn(),
  };
  const fn = vi.fn(() => app);
  (fn as Record<string, unknown>).json = vi.fn();
  (fn as Record<string, unknown>).urlencoded = vi.fn();
  (fn as Record<string, unknown>).raw = vi.fn();
  return { default: fn };
});

vi.mock("../project-store.js", () => ({
  getActiveProject: vi.fn(() => null),
  getProjectById: vi.fn(() => null),
}));

vi.mock("../gemini-oauth.js", () => ({
  getGeminiAuthStatus: vi.fn(async () => ({ connected: true })),
}));

vi.mock("../memory-store.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  addFact: vi.fn(),
  getMemory: vi.fn(() => ({ facts: [], createdAt: "" })),
  parseFactsFromJson: vi.fn(() => []),
}));

vi.mock("../cache-metrics.js", () => ({
  getCacheMetrics: vi.fn(() => ({ hits: 0, misses: 0 })),
  recordCacheMetric: vi.fn(),
  resetCacheMetrics: vi.fn(),
}));

vi.mock("./vision.js", () => ({
  getVisionConfig: vi.fn(() => Promise.resolve({ visionProxyEnabled: false })),
  shouldBypassVisionProxy: vi.fn(() => true),
  describeImage: vi.fn(),
  formatDescriptionForDeepSeek: vi.fn(),
  checkOllamaHealth: vi.fn(() => Promise.resolve(false)),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeys(overrides: Record<string, unknown> = {}) {
  return {
    anthropic: null as string | null,
    openai: null as string | null,
    openrouterKey: null as string | null,
    googleAiKey: null as string | null,
    githubToken: null as string | null,
    braveSearchKey: null as string | null,
    ollamaUrl: "http://127.0.0.1:11434",
    deepseek: null as string | null,
    customKeys: {} as Record<string, string>,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getFullModelCatalog
// ---------------------------------------------------------------------------

describe("getFullModelCatalog", () => {
  let getFullModelCatalog: typeof import("./index.js").getFullModelCatalog;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("./index.js");
    getFullModelCatalog = mod.getFullModelCatalog;
  });

  it("returns a non-empty catalog with unique ids", () => {
    const catalog = getFullModelCatalog();
    const ids = catalog.map((c) => c.id);

    expect(catalog.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tags every entry with a recognised source", () => {
    const sources = new Set(getFullModelCatalog().map((c) => c.source));

    expect(sources).toContain("anthropic");
    expect(sources).toContain("gemini");
    expect(sources).toContain("openrouter");
    for (const s of sources) {
      expect(["anthropic", "gemini", "openrouter"]).toContain(s);
    }
  });
});

// ---------------------------------------------------------------------------
// buildModelList — filters the catalog by which API keys are configured
// ---------------------------------------------------------------------------

describe("buildModelList", () => {
  let buildModelList: typeof import("./index.js").buildModelList;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    // No dynamic models: Ollama down, no OpenRouter key by default.
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("./index.js");
    buildModelList = mod.buildModelList;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("excludes Anthropic direct models when no anthropic key is set", async () => {
    const list = await buildModelList(makeKeys());

    expect(list.some((m) => m.id === "claude-3-7-sonnet-latest")).toBe(false);
  });

  it("includes Anthropic direct models when the anthropic key is set", async () => {
    const list = await buildModelList(makeKeys({ anthropic: "sk-ant-test" }));

    expect(list.some((m) => m.id === "claude-3-7-sonnet-latest")).toBe(true);
  });

  it("excludes OpenAI direct models without an openai key", async () => {
    const list = await buildModelList(makeKeys());

    expect(list.some((m) => m.id === "gpt-4o")).toBe(false);
    expect(list.some((m) => m.id === "o1")).toBe(false);
  });

  it("includes OpenAI direct models when the openai key is set", async () => {
    const list = await buildModelList(makeKeys({ openai: "sk-test" }));

    expect(list.some((m) => m.id === "gpt-4o")).toBe(true);
  });

  it("excludes DeepSeek direct models when no deepseek key is set", async () => {
    const list = await buildModelList(makeKeys());

    expect(list.some((m) => m.id === "deepseek-chat")).toBe(false);
  });

  it("includes DeepSeek direct models when the deepseek key is set", async () => {
    const list = await buildModelList(makeKeys({ deepseek: "sk-ds-test" }));

    expect(list.some((m) => m.id === "deepseek-chat")).toBe(true);
  });

  it("excludes OpenRouter catalog models without an openrouter key", async () => {
    const list = await buildModelList(makeKeys());

    expect(list.some((m) => m.source === "openrouter")).toBe(false);
  });

  it("exposes Gemini models when Gemini OAuth is connected (no API key required)", async () => {
    const list = await buildModelList(makeKeys());

    expect(list.some((m) => m.source === "gemini")).toBe(true);
  });

  it("hides Gemini models when Gemini OAuth is not connected", async () => {
    const { getGeminiAuthStatus } = await import("../gemini-oauth.js");
    vi.mocked(getGeminiAuthStatus).mockResolvedValue({ connected: false });

    const list = await buildModelList(makeKeys());

    expect(list.some((m) => m.source === "gemini")).toBe(false);
  });

  it("includes custom provider models in buildModelList", async () => {
    const list = await buildModelList(makeKeys());

    expect(list.some((m) => m.id === "llama3-8b" && m.source === "custom")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveRoute — upstream selection + authentication header construction.
// Covers the direct-provider branches not exercised by ollama-models.test.ts.
// ---------------------------------------------------------------------------

describe("resolveRoute — direct providers", () => {
  let resolveRoute: typeof import("./index.js").resolveRoute;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("./index.js");
    resolveRoute = mod.resolveRoute;
  });

  it("routes claude-* to Anthropic with x-api-key and version headers", () => {
    const route = resolveRoute(
      "claude-3-5-sonnet-latest",
      makeKeys({ anthropic: "sk-ant-xyz" }),
    );

    expect(route.provider).toBe("anthropic");
    expect(route.targetUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(route.headers["x-api-key"]).toBe("sk-ant-xyz");
    expect(route.headers["anthropic-version"]).toBe("2023-06-01");
    // alias resolves to a dated upstream id
    expect(route.model).toBe("claude-3-5-sonnet-20241022");
  });

  it("routes gpt-* to OpenAI with a Bearer header", () => {
    const route = resolveRoute("gpt-4o", makeKeys({ openai: "sk-oai" }));

    expect(route.provider).toBe("openai");
    expect(route.targetUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(route.headers.Authorization).toBe("Bearer sk-oai");
  });

  it("routes deepseek-* to DeepSeek official API with a Bearer header", () => {
    const route = resolveRoute("deepseek-chat", makeKeys({ deepseek: "sk-ds-xyz" }));

    expect(route.provider).toBe("openai");
    expect(route.targetUrl).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(route.headers.Authorization).toBe("Bearer sk-ds-xyz");
  });

  it("routes o3 reasoning models to OpenAI", () => {
    const route = resolveRoute("o3-mini", makeKeys({ openai: "sk-oai" }));

    expect(route.provider).toBe("openai");
    expect(route.targetUrl).toContain("api.openai.com");
  });

  it("routes google/* to Gemini Cloud Code Assist", () => {
    const route = resolveRoute("google/gemini-2.5-pro", makeKeys());

    expect(route.provider).toBe("gemini");
    expect(route.targetUrl).toContain("cloudcode-pa.googleapis.com");
    expect(route.model).toBe("gemini-2.5-pro");
  });

  it("routes a namespaced model to OpenRouter when a key is present", () => {
    const route = resolveRoute(
      "deepseek/deepseek-chat",
      makeKeys({ openrouterKey: "sk-or" }),
    );

    expect(route.provider).toBe("openai");
    expect(route.targetUrl).toContain("openrouter.ai");
    expect(route.headers.Authorization).toBe("Bearer sk-or");
  });

  it("throws for a namespaced model without an OpenRouter key", () => {
    expect(() => resolveRoute("deepseek/deepseek-chat", makeKeys())).toThrow(
      /nécessite une clé OpenRouter/,
    );
  });

  it("does not leak a missing key as undefined in the auth header", () => {
    // No anthropic key configured — header must be an empty string, not "undefined".
    const route = resolveRoute("claude-3-opus-latest", makeKeys());

    expect(route.headers["x-api-key"]).toBe("");
  });

  it("routes custom provider models to their baseUrl with custom key", async () => {
    const { loadCustomProviders } = await import("./index.js");
    await loadCustomProviders();

    const route = resolveRoute(
      "llama3-8b",
      makeKeys({
        customKeys: {
          "custom-groq": "sk-groq-123",
        },
      }),
    );

    expect(route.provider).toBe("openai");
    expect(route.targetUrl).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(route.headers.Authorization).toBe("Bearer sk-groq-123");
    expect(route.isCustom).toBe(true);
  });
});
