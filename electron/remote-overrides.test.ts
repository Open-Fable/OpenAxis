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
  validateManifest,
} from "./remote-overrides.js";

const HASH_SCROLL_CSS =
  "c7e4a58852c92873eb10490753805e32eb3b4854d4aaf5d1860dc39d0dc1fd94";
const HASH_SIDEBAR_CSS =
  "6a24303c67abdc2e1eeb60cd4eec1561d50f37b1c3b54613677eefa5d0e5511b";
const HASH_SIDEBAR_JS =
  "3dfdaf15fb06d442ba4d64b49c397757878a492e0e2409680822bd3c770fa57c";

const MANIFEST = {
  version: 1,
  overrides: {
    global: {
      "hotfix-scroll": { hash: HASH_SCROLL_CSS, types: ["css"] },
    },
    openwork: {
      "fix-sidebar": { hash: HASH_SIDEBAR_CSS, types: ["css"] },
      "fix-sidebar-js": { hash: HASH_SIDEBAR_JS, types: ["js"] },
    },
  },
};

function mockFetchResponses(responses: Record<string, string>) {
  fetchMock.mockImplementation(async (url: string) => {
    const content = responses[url];
    if (content === undefined) return { ok: false, status: 404 };
    return {
      ok: true,
      headers: { get: () => null },
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

      const base =
        "https://raw.githubusercontent.com/Open-Fable/OpenAxis/remote-overrides";
      mockFetchResponses({
        [`${base}/manifest.json`]: JSON.stringify(MANIFEST),
        [`${base}/global/hotfix-scroll.css`]: "body { overflow: auto; }",
        [`${base}/openwork/fix-sidebar.css`]: ".sidebar { width: 250px; }",
        [`${base}/openwork/fix-sidebar-js.js`]: "console.log('fix');",
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
            "fix-sidebar": {
              hash: "1f28a2d4e00cf1884981110f891b132c4cfb8fbc0309963605fce26b11ec4624",
              types: ["css"],
            },
            "fix-sidebar-js": {
              hash: "9fe7239ef5e28616aee7826ddddcb2e79fbfdbf7379698bd98460d33ad6783f7",
              types: ["js"],
            },
          },
        },
      };
      readFileMock.mockImplementation(async (p: string) => {
        if (p.endsWith("manifest.json")) return JSON.stringify(manifest);
        if (p.endsWith("fix-sidebar.css")) return ".sidebar { color: red; }";
        if (p.endsWith("fix-sidebar-js.js")) return "// js fix";
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
            "css-only": { hash: "a".repeat(64), types: ["css"] },
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

  describe("validateManifest", () => {
    it("accepts a well-formed manifest", () => {
      const result = validateManifest(MANIFEST);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(1);
      expect(result!.overrides["global"]).toBeDefined();
      expect(result!.overrides["openwork"]).toBeDefined();
    });

    it("rejects non-object input", () => {
      expect(validateManifest(null)).toBeNull();
      expect(validateManifest("string")).toBeNull();
      expect(validateManifest(42)).toBeNull();
    });

    it("rejects missing version", () => {
      expect(validateManifest({ overrides: {} })).toBeNull();
    });

    it("strips entries with invalid appDir", () => {
      const result = validateManifest({
        version: 1,
        overrides: {
          "../../evil": {
            payload: { hash: "a".repeat(64), types: ["js"] },
          },
          global: {
            legit: { hash: "b".repeat(64), types: ["css"] },
          },
        },
      });
      expect(result).not.toBeNull();
      expect(result!.overrides["../../evil"]).toBeUndefined();
      expect(result!.overrides["global"]).toBeDefined();
    });

    it("strips entries with invalid override name", () => {
      const result = validateManifest({
        version: 1,
        overrides: {
          global: {
            "../../escape": { hash: "a".repeat(64), types: ["css"] },
            "legit-name": { hash: "b".repeat(64), types: ["css"] },
          },
        },
      });
      expect(result!.overrides["global"]["../../escape"]).toBeUndefined();
      expect(result!.overrides["global"]["legit-name"]).toBeDefined();
    });

    it("strips entries with short/invalid hash", () => {
      const result = validateManifest({
        version: 1,
        overrides: {
          global: {
            "short-hash": { hash: "abc123", types: ["css"] },
            "empty-hash": { hash: "", types: ["css"] },
          },
        },
      });
      expect(result!.overrides["global"]).toBeUndefined();
    });

    it("strips entries with invalid types", () => {
      const result = validateManifest({
        version: 1,
        overrides: {
          global: {
            "bad-type": { hash: "a".repeat(64), types: ["exe"] },
            "no-types": { hash: "b".repeat(64), types: [] },
          },
        },
      });
      expect(result!.overrides["global"]).toBeUndefined();
    });

    it("filters valid types from mixed arrays", () => {
      const result = validateManifest({
        version: 1,
        overrides: {
          global: {
            mixed: { hash: "a".repeat(64), types: ["css", "exe", "js"] },
          },
        },
      });
      expect(result!.overrides["global"]["mixed"].types).toEqual(["css", "js"]);
    });
  });

  describe("syncRemoteOverrides — hash integrity", () => {
    it("rejects downloaded file with mismatched hash", async () => {
      readFileMock.mockRejectedValue(new Error("ENOENT"));

      const manifest = {
        version: 1,
        overrides: {
          global: {
            tampered: { hash: "f".repeat(64), types: ["css"] },
          },
        },
      };

      const base =
        "https://raw.githubusercontent.com/Open-Fable/OpenAxis/remote-overrides";
      mockFetchResponses({
        [`${base}/manifest.json`]: JSON.stringify(manifest),
        [`${base}/global/tampered.css`]: "body { color: red; }",
      });

      await syncRemoteOverrides();

      const cssWrites = writeFileMock.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).endsWith("tampered.css"),
      );
      expect(cssWrites).toHaveLength(0);
    });
  });
});
