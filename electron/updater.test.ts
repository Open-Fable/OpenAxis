import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The self-update engine imports `electron` at module load. We mock it so the
// security-sensitive logic (host allowlist, version comparison, strict asset
// name matching) can be exercised in isolation, without a packaged app.
const appState = {
  isPackaged: true,
  version: "1.0.0",
};

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged;
    },
    getVersion: () => appState.version,
    getAppPath: () => "/Applications/OpenAxis.app/Contents/Resources/app",
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  Notification: class {
    static isSupported = () => true;
    on = vi.fn();
    show = vi.fn();
  },
  shell: { openExternal: vi.fn() },
}));

/**
 * Builds a GitHub "latest release" payload. Defaults describe a well-formed,
 * newer release whose assets live on an allowed host.
 */
function makeRelease(
  overrides: {
    tag?: string;
    version?: string;
    zipHost?: string;
    shaHost?: string;
    omitZip?: boolean;
    omitSha?: boolean;
    zipName?: string;
  } = {},
): unknown {
  const version = overrides.version ?? "2.0.0";
  const tag = overrides.tag ?? `v${version}`;
  const zipName = overrides.zipName ?? `OpenAxis-${version}-${process.arch}-mac.zip`;
  const zipHost = overrides.zipHost ?? "github.com";
  const shaHost = overrides.shaHost ?? "objects.githubusercontent.com";
  const assets: Array<{ name: string; browser_download_url: string }> = [];
  if (!overrides.omitZip) {
    assets.push({
      name: zipName,
      browser_download_url: `https://${zipHost}/download/${zipName}`,
    });
  }
  if (!overrides.omitSha) {
    assets.push({
      name: `${zipName}.sha256`,
      browser_download_url: `https://${shaHost}/download/${zipName}.sha256`,
    });
  }
  return { tag_name: tag, assets };
}

/** Fresh module instance per test — the updater keeps module-level state. */
async function loadUpdater(githubToken?: string) {
  vi.resetModules();
  const mod = await import("./updater.js");
  const statuses: unknown[] = [];
  mod.initUpdater({
    getProcessManager: () => null,
    onStatusChange: (s) => statuses.push(s),
    githubToken,
  });
  return { mod, statuses };
}

describe("updater — checkForUpdate", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    appState.isPackaged = true;
    appState.version = "1.0.0";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null and never fetches when the app is not packaged (dev guard U4)", async () => {
    appState.isPackaged = false;
    const { mod } = await loadUpdater();
    const info = await mod.checkForUpdate();
    expect(info).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns update info for a newer, well-formed release", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeRelease({ version: "2.0.0" }),
    });
    const { mod, statuses } = await loadUpdater();
    const info = await mod.checkForUpdate();
    expect(info).toEqual({
      version: "2.0.0",
      zipUrl: `https://github.com/download/OpenAxis-2.0.0-${process.arch}-mac.zip`,
      shaUrl: `https://objects.githubusercontent.com/download/OpenAxis-2.0.0-${process.arch}-mac.zip.sha256`,
    });
    expect(statuses).toContainEqual({ stage: "checking" });
    expect(statuses).toContainEqual({ stage: "available", version: "2.0.0" });
  });

  it("ignores a release that is not strictly newer than the running version", async () => {
    appState.version = "2.0.0";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeRelease({ version: "2.0.0" }),
    });
    const { mod, statuses } = await loadUpdater();
    expect(await mod.checkForUpdate()).toBeNull();
    expect(statuses).toContainEqual({ stage: "idle" });
  });

  it("treats a higher patch/minor/major correctly via semantic comparison", async () => {
    appState.version = "1.2.3";
    const cases: Array<[string, boolean]> = [
      ["1.2.4", true], // patch bump
      ["1.3.0", true], // minor bump
      ["2.0.0", true], // major bump
      ["1.2.2", false], // older patch
      ["1.1.9", false], // older minor
      ["0.9.9", false], // older major
    ];
    for (const [version, expected] of cases) {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => makeRelease({ version }),
      });
      const { mod } = await loadUpdater();
      const info = await mod.checkForUpdate();
      expect(Boolean(info), `version ${version}`).toBe(expected);
    }
  });

  it("rejects a zip asset hosted on a non-allowlisted domain (U3)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeRelease({ zipHost: "evil.example.com" }),
    });
    const { mod } = await loadUpdater();
    expect(await mod.checkForUpdate()).toBeNull();
  });

  it("rejects a sha sidecar hosted on a non-allowlisted domain (U3)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeRelease({ shaHost: "cdn.attacker.test" }),
    });
    const { mod } = await loadUpdater();
    expect(await mod.checkForUpdate()).toBeNull();
  });

  it("rejects http (non-https) download URLs", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v2.0.0",
        assets: [
          {
            name: `OpenAxis-2.0.0-${process.arch}-mac.zip`,
            browser_download_url: `http://github.com/download/OpenAxis-2.0.0-${process.arch}-mac.zip`,
          },
          {
            name: `OpenAxis-2.0.0-${process.arch}-mac.zip.sha256`,
            browser_download_url: `http://github.com/download/OpenAxis-2.0.0-${process.arch}-mac.zip.sha256`,
          },
        ],
      }),
    });
    const { mod } = await loadUpdater();
    expect(await mod.checkForUpdate()).toBeNull();
  });

  it("returns null when the expected zip asset name is absent (strict anchoring)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeRelease({ zipName: "OpenAxis-portable.zip" }),
    });
    const { mod } = await loadUpdater();
    expect(await mod.checkForUpdate()).toBeNull();
  });

  it("returns null when the sha256 sidecar is missing", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeRelease({ omitSha: true }),
    });
    const { mod } = await loadUpdater();
    expect(await mod.checkForUpdate()).toBeNull();
  });

  it("returns null on a non-ok GitHub response", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    const { mod } = await loadUpdater();
    expect(await mod.checkForUpdate()).toBeNull();
  });

  it("returns null and resets to idle when the network call throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { mod, statuses } = await loadUpdater();
    expect(await mod.checkForUpdate()).toBeNull();
    expect(statuses).toContainEqual({ stage: "idle" });
  });

  it("sends a Bearer Authorization header when a github token is configured", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeRelease(),
    });
    const { mod } = await loadUpdater("ghp_secrettoken");
    await mod.checkForUpdate();
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer ghp_secrettoken");
  });

  it("omits the Authorization header when no token is configured", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeRelease(),
    });
    const { mod } = await loadUpdater();
    await mod.checkForUpdate();
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBeUndefined();
    expect(opts.headers.Accept).toBe("application/vnd.github+json");
  });

  it("ignores a malformed tag_name that is not a string", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 42, assets: [] }),
    });
    const { mod } = await loadUpdater();
    expect(await mod.checkForUpdate()).toBeNull();
  });
});

describe("updater — getUpdateStatus / downloadAndInstall guards", () => {
  beforeEach(() => {
    appState.isPackaged = true;
    appState.version = "1.0.0";
  });

  it("reports idle status before any check runs", async () => {
    const { mod } = await loadUpdater();
    expect(mod.getUpdateStatus()).toEqual({ stage: "idle" });
  });

  it("downloadAndInstall is a no-op in dev (not packaged)", async () => {
    appState.isPackaged = false;
    const { mod } = await loadUpdater();
    await expect(mod.downloadAndInstall()).resolves.toBeUndefined();
  });

  it("downloadAndInstall is a no-op when no update has been staged", async () => {
    const { mod } = await loadUpdater();
    // No prior checkForUpdate → latestInfo is null → returns without error.
    await expect(mod.downloadAndInstall()).resolves.toBeUndefined();
  });
});
