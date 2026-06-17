import { describe, it, expect, vi, beforeAll } from "vitest";
import { request as httpRequest } from "http";
import { connect } from "net";

// The proxy binds a hardcoded loopback port (9999). If a real OpenHub instance
// is already running, startProxy() can't bind it and a foreign server answers
// with a token we don't know — making auth assertions meaningless. Detect that
// up front and skip the whole suite (it still runs in CI, where no app runs).
function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const portBusy = await isPortBusy(9999);

// undici's fetch() forbids overriding the Host header, so DNS-rebinding tests
// need a raw socket. Returns { status, body } for a GET with a chosen Host.
function rawGet(path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: 9999, path, method: "GET", headers: { Host: host } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Integration test — boots the REAL Express proxy (no express mock) and
// exercises the security middleware end-to-end over a real loopback socket:
//   • Bearer-token authentication (timing-safe comparison)
//   • public-path bypass
//   • DNS-rebinding / Host-header validation (421)
//   • security headers on every response
//   • CORS origin allow-listing
//
// Everything the proxy depends on at import/boot time is mocked so the test
// neither touches the real Keychain nor reaches any upstream provider.
// ---------------------------------------------------------------------------

// keychain.ts imports `app` from electron purely for app.getPath(...)
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/openhub-proxy-auth-test") },
}));

vi.mock("keytar", () => ({
  default: {
    getPassword: vi.fn(() => Promise.resolve(null)),
    setPassword: vi.fn(() => Promise.resolve()),
    deletePassword: vi.fn(() => Promise.resolve(true)),
  },
}));

vi.mock("../project-store.js", () => ({
  getActiveProject: vi.fn(() => null),
  getProjectById: vi.fn(() => null),
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

// Avoid the background readAllApiKeys()→fetchOllamaModels() boot hop reaching out.
vi.mock("../keychain.js", async () => {
  const actual = await vi.importActual<typeof import("../keychain.js")>("../keychain.js");
  return {
    ...actual,
    readAllApiKeys: vi.fn(() =>
      Promise.resolve({
        anthropic: null,
        openai: null,
        openrouterKey: null,
        googleAiKey: null,
        githubToken: null,
        braveSearchKey: null,
        ollamaUrl: "http://127.0.0.1:11434",
      }),
    ),
  };
});

const PROXY = "http://127.0.0.1:9999";
const HOST = "127.0.0.1:9999";

let sessionToken: string;

beforeAll(async () => {
  if (portBusy) return;
  const mod = await import("./index.js");
  sessionToken = await mod.startProxy();
}, 15_000);

describe.skipIf(portBusy)("proxy Bearer authentication", () => {
  it("returns a 64-char hex session token from startProxy", () => {
    expect(sessionToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a protected route with no Authorization header (401)", async () => {
    const res = await fetch(`${PROXY}/workspaces`, { headers: { Host: HOST } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects a non-Bearer Authorization scheme (401)", async () => {
    const res = await fetch(`${PROXY}/workspaces`, {
      headers: { Host: HOST, Authorization: `Basic ${sessionToken}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a Bearer token that does not match (401)", async () => {
    const res = await fetch(`${PROXY}/workspaces`, {
      headers: { Host: HOST, Authorization: "Bearer deadbeef" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a near-miss token of identical length (timing-safe compare)", async () => {
    // Flip the last hex nibble so length matches but content differs.
    const lastChar = sessionToken.slice(-1);
    const flipped = sessionToken.slice(0, -1) + (lastChar === "0" ? "1" : "0");
    const res = await fetch(`${PROXY}/workspaces`, {
      headers: { Host: HOST, Authorization: `Bearer ${flipped}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts the correct Bearer token (not 401)", async () => {
    const res = await fetch(`${PROXY}/workspaces`, {
      headers: { Host: HOST, Authorization: `Bearer ${sessionToken}` },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });
});

describe.skipIf(portBusy)("proxy public paths bypass auth", () => {
  for (const path of ["/status", "/health", "/capabilities", "/runtime/versions"]) {
    it(`allows ${path} without any token`, async () => {
      const res = await fetch(`${PROXY}${path}`, { headers: { Host: HOST } });
      expect(res.status).not.toBe(401);
    });
  }
});

describe.skipIf(portBusy)("proxy Host-header validation (DNS-rebinding defense)", () => {
  it("rejects an unexpected Host header with 421", async () => {
    const res = await rawGet("/status", "evil.example.com");
    expect(res.status).toBe(421);
    expect(JSON.parse(res.body).error).toBe("Misdirected Request");
  });

  it("accepts the loopback Host authority", async () => {
    const res = await rawGet("/status", HOST);
    expect(res.status).not.toBe(421);
  });
});

describe.skipIf(portBusy)("proxy security headers", () => {
  it("sets hardening headers on every response", async () => {
    const res = await fetch(`${PROXY}/status`, { headers: { Host: HOST } });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe.skipIf(portBusy)("proxy CORS origin allow-listing", () => {
  it("echoes an allowed origin", async () => {
    const res = await fetch(`${PROXY}/status`, {
      headers: { Host: HOST, Origin: "http://localhost:5173" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("falls back to the proxy origin for a disallowed origin", async () => {
    const res = await fetch(`${PROXY}/status`, {
      headers: { Host: HOST, Origin: "http://evil.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:9999");
  });
});
