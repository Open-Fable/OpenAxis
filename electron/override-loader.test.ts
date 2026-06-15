import { describe, it, expect, vi, beforeEach } from "vitest";

// readFile mocké pour piloter index.json ET le contenu des fichiers d'override,
// afin de tester la sélection global/slot et le garde-fou anti-path-traversal
// sans dépendre des fichiers réels du dépôt.
const readFileMock = vi.fn();
vi.mock("fs", () => ({
  promises: { readFile: (...args: unknown[]) => readFileMock(...args) },
}));

import { loadOverrides } from "./override-loader.js";

function mockFs(
  index: Record<string, Record<string, boolean>>,
  files: Record<string, string>,
) {
  readFileMock.mockImplementation(async (p: string) => {
    if (p.endsWith("index.json")) return JSON.stringify(index);
    for (const [name, content] of Object.entries(files)) {
      if (p.endsWith(name)) return content;
    }
    throw new Error("ENOENT");
  });
}

describe("override-loader — loadOverrides", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it("combine les overrides global puis spécifiques au slot", async () => {
    mockFs(
      { global: { theme: true }, opencode: { bridge: true } },
      { "global/theme.css": "GLOBAL_CSS", "opencode/bridge.css": "OPENCODE_CSS" },
    );
    const result = await loadOverrides("code", "css");
    expect(result).toEqual(["GLOBAL_CSS", "OPENCODE_CSS"]);
  });

  it("mappe les slots vers les bons noms d'app (work→openwork, design→open-design)", async () => {
    mockFs({ openwork: { theme: true } }, { "openwork/theme.css": "WORK_CSS" });
    expect(await loadOverrides("work", "css")).toEqual(["WORK_CSS"]);

    mockFs({ "open-design": { theme: true } }, { "open-design/theme.css": "DESIGN_CSS" });
    expect(await loadOverrides("design", "css")).toEqual(["DESIGN_CSS"]);
  });

  it("ignore les overrides désactivés (valeur false dans l'index)", async () => {
    mockFs(
      { global: { theme: false, layout: true } },
      { "global/theme.css": "THEME", "global/layout.css": "LAYOUT" },
    );
    const result = await loadOverrides("code", "css");
    expect(result).toEqual(["LAYOUT"]);
  });

  it("filtre les fichiers absents pour le type demandé (un override CSS sans JS)", async () => {
    mockFs(
      { global: { theme: true } },
      { "global/theme.css": "THEME_CSS" }, // pas de theme.js
    );
    expect(await loadOverrides("code", "js")).toEqual([]);
  });

  it("REJETTE un nom d'override avec path traversal (../../) sans lire le fichier", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFs({ global: { "../../etc/passwd": true } }, {});
    const result = await loadOverrides("code", "css");
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Rejected unsafe override name"),
    );
    warn.mockRestore();
  });

  it("retourne un tableau vide quand le slot n'a aucun override déclaré", async () => {
    mockFs({ global: {} }, {});
    expect(await loadOverrides("design", "css")).toEqual([]);
  });
});
