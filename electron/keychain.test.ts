import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Electron app module (only getPath is needed)
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/openaxis-test") },
}));

// Mock child_process to return a fake hardware UUID (avoid real ioreg call)
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execFileSync: vi.fn(() =>
      Buffer.from('  "IOPlatformUUID" = "FAKE-UUID-1234-5678-ABCDEF012345"\n'),
    ),
  };
});

// Mock fs to avoid real disk I/O
let fileContent: Buffer | null = null;
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(async () => {
        if (fileContent) return fileContent;
        throw new Error("ENOENT");
      }),
      writeFile: vi.fn(async (_path: string, data: Buffer) => {
        // saveStore writes to a temp path then renames; the single-file mock
        // ignores the path, so the temp content becomes the committed content.
        fileContent = Buffer.isBuffer(data) ? data : Buffer.from(data);
      }),
      rename: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
    },
  };
});

import {
  readSecret,
  writeSecret,
  deleteSecret,
  readAllApiKeys,
  isSafeOllamaUrl,
} from "./keychain.js";

describe("keychain (AES-256-GCM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileContent = null;
  });

  describe("readSecret", () => {
    it("returns null when no secret exists", async () => {
      const result = await readSecret("openaxis", "missing");
      expect(result).toBeNull();
    });
  });

  describe("writeSecret + readSecret round-trip", () => {
    it("stores and retrieves a secret", async () => {
      await writeSecret("openaxis", "test-key", "secret-value");
      const result = await readSecret("openaxis", "test-key");
      expect(result).toBe("secret-value");
    });
  });

  describe("deleteSecret", () => {
    it("removes a stored secret", async () => {
      await writeSecret("openaxis", "del-key", "to-delete");
      await deleteSecret("openaxis", "del-key");
      const result = await readSecret("openaxis", "del-key");
      expect(result).toBeNull();
    });
  });

  describe("readAllApiKeys", () => {
    it("returns defaults when store is empty", async () => {
      const result = await readAllApiKeys();
      expect(result.anthropic).toBeNull();
      expect(result.openai).toBeNull();
      expect(result.ollamaUrl).toBe("http://127.0.0.1:11434");
    });

    it("returns stored values", async () => {
      await writeSecret("openaxis", "anthropic-api-key", "sk-ant-xxx");
      await writeSecret("openaxis", "ollama-url", "http://custom:11434");
      const result = await readAllApiKeys();
      expect(result.anthropic).toBe("sk-ant-xxx");
      expect(result.ollamaUrl).toBe("http://custom:11434");
      expect(result.openai).toBeNull();
    });
  });

  describe("isSafeOllamaUrl", () => {
    it("allows loopback and ordinary LAN/DNS hosts", () => {
      expect(isSafeOllamaUrl("http://127.0.0.1:11434")).toBe(true);
      expect(isSafeOllamaUrl("http://localhost:11434")).toBe(true);
      expect(isSafeOllamaUrl("http://192.168.1.50:11434")).toBe(true);
      expect(isSafeOllamaUrl("http://my-gpu.lan:11434")).toBe(true);
      expect(isSafeOllamaUrl("https://[::1]:11434")).toBe(true);
    });

    it("rejects non-http(s) schemes and malformed URLs", () => {
      expect(isSafeOllamaUrl("file:///etc/passwd")).toBe(false);
      expect(isSafeOllamaUrl("ftp://host")).toBe(false);
      expect(isSafeOllamaUrl("not a url")).toBe(false);
      expect(isSafeOllamaUrl("")).toBe(false);
    });

    it("blocks cloud-metadata and link-local addresses", () => {
      expect(isSafeOllamaUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
      expect(isSafeOllamaUrl("http://169.254.0.1")).toBe(false);
      expect(isSafeOllamaUrl("http://metadata.google.internal")).toBe(false);
      expect(isSafeOllamaUrl("http://metadata")).toBe(false);
    });

    it("blocks 0.0.0.0, unspecified IPv6 and IPv4-mapped link-local", () => {
      expect(isSafeOllamaUrl("http://0.0.0.0:11434")).toBe(false);
      expect(isSafeOllamaUrl("http://[::]:11434")).toBe(false);
      expect(isSafeOllamaUrl("http://[::ffff:169.254.169.254]")).toBe(false);
    });

    it("blocks numeric-encoded IP hosts that bypass string checks", () => {
      expect(isSafeOllamaUrl("http://2852039166")).toBe(false);
      expect(isSafeOllamaUrl("http://0xA9FEA9FE")).toBe(false);
    });
  });
});
