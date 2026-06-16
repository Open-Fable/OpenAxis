import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";

const readFileMock = vi.fn();
const writeFileMock = vi.fn().mockResolvedValue(undefined);
const mkdirMock = vi.fn().mockResolvedValue(undefined);
const rmMock = vi.fn().mockResolvedValue(undefined);
vi.mock("fs", () => ({
  promises: {
    readFile: (...args: unknown[]) => readFileMock(...args),
    writeFile: (...args: unknown[]) => writeFileMock(...args),
    mkdir: (...args: unknown[]) => mkdirMock(...args),
    rm: (...args: unknown[]) => rmMock(...args),
  },
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
  syncRemoteOverrides,
  loadRemoteOverrides,
  clearRemoteCache,
  CACHE_DIR,
} from "./remote-overrides.js";

const MANIFEST = {
  version: 1,
  overrides: {
    global: {
      "hotfix-scroll": { hash: "abc123", types: ["css"] },
    },
    openwork: {
      "fix-sidebar": { hash: "def456", types: ["css", "js"] },
    },
  },
};

function mockFetchResponses(responses: Record<string, string>) {
  fetchMock.mockImplementation(async (url: string) => {
    const content = responses[url];
    if (content === undefined) return { ok: false, status: 404 };
    return {
      ok: true,
      json: async () => JSON.parse(content),
      text: async () => content,
    };
  });
}

describe("remote-overrides", () => {
  beforeEach(() => {
    readFileMock.mockReset();
    writeFileMock.mockReset().mockResolvedValue(undefined);
    mkdirMock.mockReset().mockResolvedValue(undefined);
    rmMock.mockReset().mockResolvedValue(undefined);
    fetchMock.mockReset();
  });

  afterEach(async () => {
    await clearRemoteCache();
  });

  describe("syncRemoteOverrides", () => {
    it("fetches manifest and downloads override files", async () => {
      readFileMock.mockRejectedValue(new Error("ENOENT"));

      const base = "https://raw.githubusercontent.com/1zalt/OpenHub/remote-overrides";
      mockFetchResponses({
        [`${base}/manifest.json`]: JSON.stringify(MANIFEST),
        [`${base}/global/hotfix-scroll.css`]: "body { overflow: auto; }",
        [`${base}/openwork/fix-sidebar.css`]: ".sidebar { width: 250px; }",
        [`${base}/openwork/fix-sidebar.js`]: "console.log('fix');",
      });

      await syncRemoteOverrides();

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(mkdirMock).toHaveBeenCalled();
      expect(writeFileMock).toHaveBeenCalled();
    });

    it("silently fails when offline (no fetch errors thrown)", async () => {
      fetchMock.mockRejectedValue(new Error("NetworkError"));

      await expect(syncRemoteOverrides()).resolves.toBeUndefined();
    });

    it("silently fails when manifest returns 404", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404 });

      await expect(syncRemoteOverrides()).resolves.toBeUndefined();
    });
  });

  describe("loadRemoteOverrides", () => {
    it("loads cached files for the requested app and type", async () => {
      const manifest = {
        version: 1,
        overrides: {
          openwork: {
            "fix-sidebar": { hash: "aaa", types: ["css", "js"] },
          },
        },
      };
      readFileMock.mockImplementation(async (p: string) => {
        if (p.endsWith("manifest.json")) return JSON.stringify(manifest);
        if (p.endsWith("fix-sidebar.css")) return ".sidebar { color: red; }";
        if (p.endsWith("fix-sidebar.js")) return "// js fix";
        throw new Error("ENOENT");
      });

      const css = await loadRemoteOverrides("openwork", "css");
      expect(css).toEqual([".sidebar { color: red; }"]);

      const js = await loadRemoteOverrides("openwork", "js");
      expect(js).toEqual(["// js fix"]);
    });

    it("returns empty array when no cached manifest exists", async () => {
      readFileMock.mockRejectedValue(new Error("ENOENT"));

      const result = await loadRemoteOverrides("global", "css");
      expect(result).toEqual([]);
    });

    it("skips files not matching the requested type", async () => {
      const manifest = {
        version: 1,
        overrides: {
          global: {
            "css-only": { hash: "bbb", types: ["css"] },
          },
        },
      };
      readFileMock.mockImplementation(async (p: string) => {
        if (p.endsWith("manifest.json")) return JSON.stringify(manifest);
        throw new Error("ENOENT");
      });

      const js = await loadRemoteOverrides("global", "js");
      expect(js).toEqual([]);
    });
  });

  describe("clearRemoteCache", () => {
    it("removes the cache directory", async () => {
      await clearRemoteCache();
      expect(rmMock).toHaveBeenCalledWith(CACHE_DIR, {
        recursive: true,
        force: true,
      });
    });
  });
});
