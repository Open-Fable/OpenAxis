import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OrchestratorRunner,
  mapWithConcurrency,
  resolveMaxParallelNodes,
  resolveFallbackModel,
} from "./orchestrator-runner.js";
import {
  parseFilepathBlocks,
  parseEditBlocks,
  applyEdits,
  detectTruncation,
} from "./orchestrator-files.js";
import type { Project } from "./project-store.js";

function makeNode(id: string, deps: string[] = []): Project {
  return {
    id,
    name: `Node ${id}`,
    instructions: "",
    color: "#000",
    dependencies: deps,
    createdAt: 0,
    updatedAt: 0,
  };
}

function runner(): OrchestratorRunner {
  return new OrchestratorRunner(() => {});
}

// Private surface used by the concurrency tests below.
type WritableRunner = {
  extractAndWriteFiles: (
    resultText: string,
    workspaceDir: string,
    pathFilter: (relPath: string) => boolean,
    nodeId: string,
    skipPaths?: ReadonlySet<string>,
  ) => Promise<string[]>;
  fileOwner: Map<string, string>;
  nodeWorkspaces: Map<string, string>;
  resetPerRunState: () => void;
  correctiveNodeIds: ReadonlySet<string> | null;
  buildNodePathFilter: (
    nodeId: string,
    expectedFiles: readonly string[],
  ) => (relPath: string) => boolean;
};

function fileBlock(relPath: string, content: string): string {
  return "```js filepath: " + relPath + "\n" + content + "\n```";
}

describe("resolveMaxParallelNodes", () => {
  const orch = (max?: number): Project => ({
    ...makeNode("orch"),
    type: "orchestrator",
    orchSettings: {
      autoDistribute: false,
      checkCoherence: false,
      relaunchOnError: false,
      maxParallelNodes: max,
    },
  });

  it("defaults to 3 when unset", () => {
    expect(resolveMaxParallelNodes(makeNode("o"))).toBe(3);
    expect(resolveMaxParallelNodes(orch(undefined))).toBe(3);
  });

  it("clamps to the [1, 4] range", () => {
    expect(resolveMaxParallelNodes(orch(0))).toBe(1);
    expect(resolveMaxParallelNodes(orch(-5))).toBe(1);
    expect(resolveMaxParallelNodes(orch(2))).toBe(2);
    expect(resolveMaxParallelNodes(orch(99))).toBe(4);
  });

  it("floors fractional values and rejects NaN", () => {
    expect(resolveMaxParallelNodes(orch(2.9))).toBe(2);
    expect(resolveMaxParallelNodes(orch(Number.NaN))).toBe(3);
  });
});

describe("resetPerRunState", () => {
  it("clears per-run state so a reused singleton runner starts clean", () => {
    const r = runner() as unknown as WritableRunner;
    r.fileOwner.set("a.js", "node-1");
    r.nodeWorkspaces.set("node-1", "/tmp/wt");

    r.resetPerRunState();

    expect(r.fileOwner.size).toBe(0);
    expect(r.nodeWorkspaces.size).toBe(0);
  });
});

describe("buildNodePathFilter — corrective rerun guard", () => {
  it("opens free paths on a first run (no corrective set, no ownership)", () => {
    const r = runner() as unknown as WritableRunner;
    const filter = r.buildNodePathFilter("n1", []);
    expect(filter("brand-new.js")).toBe(true);
  });

  it("refuses new free paths for a node in the corrective set, deterministically", () => {
    const r = runner() as unknown as WritableRunner;
    // No fileOwner entry for "n1" — the old logic would treat it as a first run
    // and allow free paths. The corrective set must override that.
    r.correctiveNodeIds = new Set(["n1"]);
    const filter = r.buildNodePathFilter("n1", ["allowed.js"]);
    expect(filter("brand-new.js")).toBe(false); // free path refused (anti-parasitic)
    expect(filter("allowed.js")).toBe(true); // its declared deliverable is fine
    expect(filter("WORKSPACE_INDEX.md")).toBe(true); // shared path always allowed
  });
});

describe("extractAndWriteFiles — concurrent ownership", () => {
  async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "oh-orch-"));
    try {
      return await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("lets only one node win a contested free path, no silent clobber", async () => {
    await withWorkspace(async (dir) => {
      const r = runner() as unknown as WritableRunner;
      const accept = (): boolean => true;

      // Both nodes try to write the SAME free path concurrently.
      const [wroteA, wroteB] = await Promise.all([
        r.extractAndWriteFiles(fileBlock("app.js", "from-A"), dir, accept, "A"),
        r.extractAndWriteFiles(fileBlock("app.js", "from-B"), dir, accept, "B"),
      ]);

      const owner = r.fileOwner.get("app.js");
      expect(owner).toBeDefined();
      const disk = await fs.readFile(path.join(dir, "app.js"), "utf-8");

      // Exactly one node wrote the file; the disk content matches the owner.
      const winners = [
        { id: "A", wrote: wroteA },
        { id: "B", wrote: wroteB },
      ].filter((w) => w.wrote.includes("app.js"));
      expect(winners).toHaveLength(1);
      expect(winners[0].id).toBe(owner);
      expect(disk).toBe(`from-${owner}`);
    });
  });

  it("lets each node write its own distinct path in parallel", async () => {
    await withWorkspace(async (dir) => {
      const r = runner() as unknown as WritableRunner;
      const accept = (): boolean => true;

      await Promise.all([
        r.extractAndWriteFiles(fileBlock("a.js", "AAA"), dir, accept, "A"),
        r.extractAndWriteFiles(fileBlock("b.js", "BBB"), dir, accept, "B"),
      ]);

      expect(await fs.readFile(path.join(dir, "a.js"), "utf-8")).toBe("AAA");
      expect(await fs.readFile(path.join(dir, "b.js"), "utf-8")).toBe("BBB");
      expect(r.fileOwner.get("a.js")).toBe("A");
      expect(r.fileOwner.get("b.js")).toBe("B");
    });
  });

  it("does NOT block isolated worktree nodes writing the same relative path", async () => {
    // Two backend agents in separate worktrees writing the same path is not a
    // conflict — the shared-ownership refusal must be bypassed for isolated nodes.
    await withWorkspace(async (dirA) => {
      await withWorkspace(async (dirB) => {
        const r = runner() as unknown as WritableRunner;
        r.nodeWorkspaces.set("A", dirA);
        r.nodeWorkspaces.set("B", dirB);
        const accept = (): boolean => true;

        const [wa, wb] = await Promise.all([
          r.extractAndWriteFiles(fileBlock("app.js", "AAA"), dirA, accept, "A"),
          r.extractAndWriteFiles(fileBlock("app.js", "BBB"), dirB, accept, "B"),
        ]);

        expect(wa).toContain("app.js");
        expect(wb).toContain("app.js");
        expect(await fs.readFile(path.join(dirA, "app.js"), "utf-8")).toBe("AAA");
        expect(await fs.readFile(path.join(dirB, "app.js"), "utf-8")).toBe("BBB");
        // Isolated nodes never pollute the shared ownership map.
        expect(r.fileOwner.has("app.js")).toBe(false);
      });
    });
  });
});

describe("mapWithConcurrency", () => {
  it("processes all items and preserves order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5, 6];
    await mapWithConcurrency(items, 2, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("propagates errors from the callback", async () => {
    await expect(
      mapWithConcurrency([1], 1, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("returns empty array for empty input", async () => {
    const results = await mapWithConcurrency([], 3, async (n: number) => n);
    expect(results).toEqual([]);
  });
});

describe("parseFilepathBlocks", () => {
  const fence = "```";

  it("extracts a single clean block", () => {
    const text = [
      `${fence}typescript filepath: src/a.ts`,
      "export const a = 1;",
      fence,
    ].join("\n");
    const blocks = parseFilepathBlocks(text);
    expect(blocks).toEqual([{ path: "src/a.ts", content: "export const a = 1;" }]);
  });

  it("extracts multiple blocks in order", () => {
    const text = [
      `${fence}typescript filepath: src/a.ts`,
      "const a = 1;",
      fence,
      "",
      "And the test:",
      "",
      `${fence}typescript filepath: tests/a.test.ts`,
      "test('a', () => {});",
      fence,
    ].join("\n");
    const blocks = parseFilepathBlocks(text);
    expect(blocks.map((b) => b.path)).toEqual(["src/a.ts", "tests/a.test.ts"]);
    expect(blocks[0].content).toBe("const a = 1;");
    expect(blocks[1].content).toBe("test('a', () => {});");
  });

  it("preserves nested same-length fences inside markdown (the truncation bug)", () => {
    const text = [
      `${fence}markdown filepath: README.md`,
      "# Title",
      "",
      "## Installation",
      "",
      `${fence}bash`,
      "npm install mylib",
      fence,
      "",
      "## Usage",
      "",
      `${fence}typescript`,
      "import { x } from 'mylib';",
      fence,
      "",
      "## Contributing",
      "",
      "PRs welcome.",
      fence,
    ].join("\n");
    const blocks = parseFilepathBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].path).toBe("README.md");
    // Full content survives — nested fences and trailing sections included.
    expect(blocks[0].content).toContain("npm install mylib");
    expect(blocks[0].content).toContain("import { x } from 'mylib';");
    expect(blocks[0].content).toContain("## Contributing");
    expect(blocks[0].content).toContain("PRs welcome.");
  });

  it("does not truncate code containing a stray fence before its real close", () => {
    const text = [
      `${fence}typescript filepath: src/engine.ts`,
      "/**",
      " * @example",
      ` * ${fence}`,
      " * validate('x@y.z')",
      ` * ${fence}`,
      " */",
      "export function validate(input: string): ValidationResult {",
      "  return { valid: true };",
      "}",
      fence,
    ].join("\n");
    const blocks = parseFilepathBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("export function validate");
    expect(blocks[0].content).toContain("return { valid: true };");
  });

  it("treats shorter inner fences as content when the opener is longer", () => {
    const text = [
      "````markdown filepath: README.md",
      "# Title",
      fence,
      "code()",
      fence,
      "````",
    ].join("\n");
    const blocks = parseFilepathBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe(["# Title", fence, "code()", fence].join("\n"));
  });

  it("returns empty array when there are no filepath blocks", () => {
    expect(parseFilepathBlocks("just some prose\nwith no blocks")).toEqual([]);
  });

  it("captures content to EOF when the closing fence is missing", () => {
    const text = [`${fence}typescript filepath: src/a.ts`, "const a = 1;"].join("\n");
    const blocks = parseFilepathBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("const a = 1;");
  });

  it("ignores ```edit filepath: blocks (reserved for surgical edits)", () => {
    const text = [
      `${fence}edit filepath: src/a.ts`,
      "<<<<<<< SEARCH",
      "old",
      "=======",
      "new",
      ">>>>>>> REPLACE",
      fence,
    ].join("\n");
    expect(parseFilepathBlocks(text)).toEqual([]);
  });

  it("ignores ```edit fences regardless of case (no marker corruption)", () => {
    for (const kw of ["Edit", "EDIT", "eDiT"]) {
      const text = [
        `${fence}${kw} filepath: src/a.ts`,
        "<<<<<<< SEARCH",
        "old",
        "=======",
        "new",
        ">>>>>>> REPLACE",
        fence,
      ].join("\n");
      // Must NOT be parsed as a full-file write (which would dump raw markers).
      expect(parseFilepathBlocks(text)).toEqual([]);
      // And parseEditBlocks must claim it instead.
      expect(parseEditBlocks(text)).toHaveLength(1);
    }
  });
});

describe("parseEditBlocks", () => {
  const fence = "```";

  it("parses a single SEARCH/REPLACE pair", () => {
    const text = [
      `${fence}edit filepath: index.html`,
      "<<<<<<< SEARCH",
      "<h1>Ancien</h1>",
      "=======",
      "<h1>Nouveau</h1>",
      ">>>>>>> REPLACE",
      fence,
    ].join("\n");
    const blocks = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].path).toBe("index.html");
    expect(blocks[0].edits).toEqual([
      { search: "<h1>Ancien</h1>", replace: "<h1>Nouveau</h1>" },
    ]);
  });

  it("parses multiple pairs in one block and multiline bodies", () => {
    const text = [
      `${fence}edit filepath: a.css`,
      "<<<<<<< SEARCH",
      ".a { color: red; }",
      "=======",
      ".a { color: blue; }",
      ">>>>>>> REPLACE",
      "<<<<<<< SEARCH",
      "line1",
      "line2",
      "=======",
      "line1-bis",
      ">>>>>>> REPLACE",
      fence,
    ].join("\n");
    const blocks = parseEditBlocks(text);
    expect(blocks[0].edits).toHaveLength(2);
    expect(blocks[0].edits[1]).toEqual({ search: "line1\nline2", replace: "line1-bis" });
  });

  it("ignores a malformed block with no divider", () => {
    const text = [
      `${fence}edit filepath: a.ts`,
      "<<<<<<< SEARCH",
      "orphan",
      ">>>>>>> REPLACE",
      fence,
    ].join("\n");
    expect(parseEditBlocks(text)).toEqual([]);
  });

  it("returns empty when there are no edit blocks", () => {
    expect(parseEditBlocks("just prose")).toEqual([]);
  });
});

describe("applyEdits", () => {
  it("applies a unique-match edit", () => {
    const res = applyEdits("a\nOLD\nb", [{ search: "OLD", replace: "NEW" }]);
    expect(res.ok).toBe(true);
    expect(res.content).toBe("a\nNEW\nb");
  });

  it("applies sequential edits in order", () => {
    const res = applyEdits("x1 y1", [
      { search: "x1", replace: "x2" },
      { search: "y1", replace: "y2" },
    ]);
    expect(res.content).toBe("x2 y2");
  });

  it("fails (all-or-nothing) when SEARCH is not found", () => {
    const res = applyEdits("hello", [{ search: "absent", replace: "x" }]);
    expect(res.ok).toBe(false);
    expect(res.content).toBe("hello");
  });

  it("fails when SEARCH matches more than once (ambiguous)", () => {
    const res = applyEdits("dup dup", [{ search: "dup", replace: "x" }]);
    expect(res.ok).toBe(false);
    expect(res.content).toBe("dup dup");
  });

  it("leaves the original untouched when a later edit in the batch fails", () => {
    const res = applyEdits("keep OLD", [
      { search: "OLD", replace: "NEW" },
      { search: "missing", replace: "z" },
    ]);
    expect(res.ok).toBe(false);
    expect(res.content).toBe("keep OLD");
  });

  it("treats replacement as a literal (no $ pattern interpretation)", () => {
    const res = applyEdits("price: X", [{ search: "X", replace: "$1.00" }]);
    expect(res.content).toBe("price: $1.00");
  });
});

describe("detectTruncation", () => {
  it("returns null for a short but cleanly-ended markdown document", () => {
    const md = "# Titre\n\n## 1. Contexte\nDu contenu.\n\n## 2. Conclusion\nFin nette.\n";
    expect(detectTruncation(md)).toBeNull();
  });

  it("flags an empty file", () => {
    expect(detectTruncation("   \n  ")).toBe("empty file");
  });

  it("flags an unclosed code fence", () => {
    const md = "# Titre\n\n```js\nconst a = 1;\n";
    expect(detectTruncation(md)).toBe("unclosed code block");
  });

  it("does not flag balanced code fences", () => {
    const md = "# Titre\n\n```js\nconst a = 1;\n```\n\nVoilà la fin.\n";
    expect(detectTruncation(md)).toBeNull();
  });

  it("flags HTML missing its closing </html>", () => {
    const html = '<!DOCTYPE html>\n<html lang="fr">\n<body><p>Salut</p></body>\n';
    expect(detectTruncation(html)).toBe("missing </html> tag");
  });

  it("flags prose cut off mid-sentence", () => {
    const md =
      "# Plan\n\nCampagnes ciblées sur des mots-clés spécifiques liés à la fiscalité et au revenu complémentaire des freelances qui cherchent à optimiser";
    expect(detectTruncation(md)).toMatch(/mid-sentence/);
  });

  it("does not flag a heading or list item as truncated", () => {
    expect(detectTruncation("## Une section sans ponctuation finale")).toBeNull();
    expect(detectTruncation("- un point de liste de longueur correcte ici")).toBeNull();
  });
});

describe("resolveFallbackModel", () => {
  it("prefers the orchestrator's global model over any agent model", () => {
    const orch = { model: "global/x" };
    const agents = [{ model: undefined }, { model: "agent/y" }];
    expect(resolveFallbackModel(orch, agents)).toBe("global/x");
  });

  it("falls back to the first agent with a model when the orchestrator has none", () => {
    const orch = { model: undefined };
    const agents = [{ model: undefined }, { model: "agent/y" }, { model: "agent/z" }];
    expect(resolveFallbackModel(orch, agents)).toBe("agent/y");
  });

  it("returns undefined when no model is configured anywhere", () => {
    expect(
      resolveFallbackModel({ model: undefined }, [{ model: undefined }]),
    ).toBeUndefined();
  });

  it("resolves identically for first-run and resume inputs (no model drift)", () => {
    const orch = { model: "global/x" };
    const agents = [{ model: "agent/y" }];
    // Both call sites now share this helper, so the two resolutions must match.
    expect(resolveFallbackModel(orch, agents)).toBe(resolveFallbackModel(orch, agents));
    expect(resolveFallbackModel(orch, agents)).toBe("global/x");
  });
});
