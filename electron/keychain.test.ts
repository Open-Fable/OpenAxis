import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("keytar", () => {
  const store = new Map<string, string>();
  return {
    default: {
      getPassword: vi.fn((service: string, account: string) =>
        Promise.resolve(store.get(`${service}:${account}`) ?? null),
      ),
      setPassword: vi.fn((service: string, account: string, secret: string) => {
        store.set(`${service}:${account}`, secret);
        return Promise.resolve();
      }),
      deletePassword: vi.fn((service: string, account: string) => {
        store.delete(`${service}:${account}`);
        return Promise.resolve(true);
      }),
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
import keytar from "keytar";

describe("keychain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (keytar.getPassword as ReturnType<typeof vi.fn>).mockReset();
    (keytar.setPassword as ReturnType<typeof vi.fn>).mockReset();
    (keytar.deletePassword as ReturnType<typeof vi.fn>).mockReset();
  });

  describe("readSecret", () => {
    it("delegates to keytar.getPassword", async () => {
      (keytar.getPassword as ReturnType<typeof vi.fn>).mockResolvedValue("my-secret");
      const result = await readSecret("openhub", "test-key");
      expect(result).toBe("my-secret");
      expect(keytar.getPassword).toHaveBeenCalledWith("openhub", "test-key");
    });

    it("returns null when no secret exists", async () => {
      (keytar.getPassword as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const result = await readSecret("openhub", "missing");
      expect(result).toBeNull();
    });
  });

  describe("writeSecret", () => {
    it("delegates to keytar.setPassword", async () => {
      await writeSecret("openhub", "test-key", "secret-value");
      expect(keytar.setPassword).toHaveBeenCalledWith(
        "openhub",
        "test-key",
        "secret-value",
      );
    });
  });

  describe("deleteSecret", () => {
    it("delegates to keytar.deletePassword", async () => {
      await deleteSecret("openhub", "test-key");
      expect(keytar.deletePassword).toHaveBeenCalledWith("openhub", "test-key");
    });
  });

  describe("readAllApiKeys", () => {
    it("reads all keys in parallel", async () => {
      (keytar.getPassword as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const result = await readAllApiKeys();
      expect(keytar.getPassword).toHaveBeenCalledTimes(7);
      expect(result.ollamaUrl).toBe("http://127.0.0.1:11434");
    });

    it("returns stored values", async () => {
      (keytar.getPassword as ReturnType<typeof vi.fn>).mockImplementation(
        (_service: string, account: string) => {
          if (account === "anthropic-api-key") return Promise.resolve("sk-ant-xxx");
          if (account === "ollama-url") return Promise.resolve("http://custom:11434");
          return Promise.resolve(null);
        },
      );
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
      expect(isSafeOllamaUrl("http://2852039166")).toBe(false); // decimal 169.254.169.254
      expect(isSafeOllamaUrl("http://0xA9FEA9FE")).toBe(false); // hex
    });
  });
});
