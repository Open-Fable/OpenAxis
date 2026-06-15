import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as realFs } from "fs";
import path from "path";
import os from "os";
import {
  sanitizeExpectedFiles,
  isTrivialResult,
  checkExpectedFiles,
  buildMissingFilesPrompt,
  buildTrivialResultPrompt,
  enforceDeliverables,
  extractJsonObject,
  parseQualityVerdict,
  buildAutoFeedback,
  buildSyntheticRun,
  buildQualityGateUserPrompt,
  findBrokenAssetRefs,
  buildBrokenAssetsReport,
  findInvalidJsonFiles,
  sanitizeChecks,
  validateDeclaredChecks,
  findCsvColumnProblems,
  findPlaceholderDeliverables,
  findUnreferencedModules,
  findModuleGraphProblems,
  findOrphanStylesheets,
  findServedHtmlPlaceholders,
  findStructuredDataMismatch,
  sanitizeWorkspaceIndex,
  deriveFloorChecks,
  PROSE_FLOOR_WORDS,
  findConsolidationShrinkage,
  findUnstyledClasses,
  findDivergentDuplicates,
  findScatteredDuplicates,
  findUnwantedWebScaffolding,
  findUselessDesignArtifacts,
  findCssConsistencyProblems,
  MIN_RESULT_CHARS,
  MIN_FILE_BYTES,
} from "./orchestrator-quality.js";
import type { Project } from "./project-store.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "test-agent",
    name: "Test Agent",
    instructions: "",
    color: "#000",
    type: "work",
    task: "Create index.html and styles.css",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("sanitizeExpectedFiles", () => {
  it("returns empty for non-array input", () => {
    expect(sanitizeExpectedFiles(null)).toEqual([]);
    expect(sanitizeExpectedFiles("hello")).toEqual([]);
    expect(sanitizeExpectedFiles(42)).toEqual([]);
    expect(sanitizeExpectedFiles(undefined)).toEqual([]);
  });

  it("accepts valid relative paths", () => {
    const result = sanitizeExpectedFiles(["src/index.html", "styles/main.css"]);
    expect(result).toEqual(["src/index.html", "styles/main.css"]);
  });

  it("rejects absolute paths", () => {
    expect(sanitizeExpectedFiles(["/etc/passwd"])).toEqual([]);
  });

  it("rejects paths with ..", () => {
    expect(sanitizeExpectedFiles(["../secret.txt"])).toEqual([]);
    expect(sanitizeExpectedFiles(["foo/../bar.txt"])).toEqual([]);
  });

  it("rejects hidden files (starting with .)", () => {
    expect(sanitizeExpectedFiles([".env", ".gitignore"])).toEqual([]);
  });

  it("rejects null bytes", () => {
    expect(sanitizeExpectedFiles(["file\0.txt"])).toEqual([]);
  });

  it("limits to 50 entries", () => {
    const input = Array.from({ length: 60 }, (_, i) => `file${i}.txt`);
    expect(sanitizeExpectedFiles(input)).toHaveLength(50);
  });

  it("rejects paths longer than 200 chars", () => {
    const longPath = "a/".repeat(101) + "file.txt";
    expect(sanitizeExpectedFiles([longPath])).toEqual([]);
  });

  it("filters out non-string items", () => {
    expect(sanitizeExpectedFiles([42, null, "valid.txt", {}, "other.css"])).toEqual([
      "valid.txt",
      "other.css",
    ]);
  });

  it("trims whitespace", () => {
    expect(sanitizeExpectedFiles(["  src/file.ts  "])).toEqual(["src/file.ts"]);
  });
});

describe("isTrivialResult", () => {
  it("returns true for undefined/null/empty", () => {
    expect(isTrivialResult(undefined)).toBe(true);
    expect(isTrivialResult("")).toBe(true);
  });

  it("returns true for short text", () => {
    expect(isTrivialResult("Done.")).toBe(true);
    expect(isTrivialResult("x".repeat(MIN_RESULT_CHARS - 1))).toBe(true);
  });

  it("returns false for text >= MIN_RESULT_CHARS", () => {
    expect(isTrivialResult("x".repeat(MIN_RESULT_CHARS))).toBe(false);
    expect(isTrivialResult("x".repeat(500))).toBe(false);
  });

  it("trims before checking length", () => {
    const padded = " ".repeat(300) + "short" + " ".repeat(300);
    expect(isTrivialResult(padded)).toBe(true);
  });
});

describe("checkExpectedFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "qtest-"));
  });

  it("reports missing files as missing", async () => {
    const result = await checkExpectedFiles(tmpDir, ["nonexistent.html"]);
    expect(result.present).toEqual([]);
    expect(result.missing).toEqual(["nonexistent.html"]);
  });

  it("reports files >= MIN_FILE_BYTES as present", async () => {
    const content = "x".repeat(MIN_FILE_BYTES);
    await realFs.writeFile(path.join(tmpDir, "big.txt"), content);
    const result = await checkExpectedFiles(tmpDir, ["big.txt"]);
    expect(result.present).toEqual(["big.txt"]);
    expect(result.missing).toEqual([]);
  });

  it("reports files < MIN_FILE_BYTES as missing", async () => {
    await realFs.writeFile(path.join(tmpDir, "tiny.txt"), "hi");
    const result = await checkExpectedFiles(tmpDir, ["tiny.txt"]);
    expect(result.present).toEqual([]);
    expect(result.missing).toEqual(["tiny.txt"]);
  });

  it("handles mixed present/missing", async () => {
    await realFs.writeFile(path.join(tmpDir, "ok.txt"), "y".repeat(200));
    const result = await checkExpectedFiles(tmpDir, ["ok.txt", "nope.txt"]);
    expect(result.present).toEqual(["ok.txt"]);
    expect(result.missing).toEqual(["nope.txt"]);
  });

  it("handles subdirectories", async () => {
    await realFs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "sub/file.css"), "a".repeat(150));
    const result = await checkExpectedFiles(tmpDir, ["sub/file.css"]);
    expect(result.present).toEqual(["sub/file.css"]);
  });
});

describe("findInvalidJsonFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "json-"));
  });

  it("flags a *.json file that does not parse", async () => {
    await realFs.writeFile(path.join(tmpDir, "data.json"), "{ bad json, ");
    const problems = await findInvalidJsonFiles(tmpDir);
    expect(problems.map((p) => p.sourceFile)).toContain("data.json");
  });

  it("passes valid JSON and ignores non-json + *.artifact.json", async () => {
    await realFs.writeFile(path.join(tmpDir, "ok.json"), '{"a":1,"b":[2,3]}');
    await realFs.writeFile(path.join(tmpDir, "note.md"), "{ not json but md");
    await realFs.writeFile(path.join(tmpDir, "x.artifact.json"), "{ broken artifact");
    const problems = await findInvalidJsonFiles(tmpDir);
    expect(problems).toEqual([]);
  });

  it("skips the design backend scratch dir", async () => {
    await realFs.mkdir(path.join(tmpDir, "design"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "design/broken.json"), "{ nope");
    const problems = await findInvalidJsonFiles(tmpDir);
    expect(problems).toEqual([]);
  });
});

describe("sanitizeChecks", () => {
  it("returns {} for non-object / array / null", () => {
    expect(sanitizeChecks(null)).toEqual({});
    expect(sanitizeChecks([1, 2])).toEqual({});
    expect(sanitizeChecks("x")).toEqual({});
  });

  it("rejects path-traversal / absolute / hidden keys", () => {
    const out = sanitizeChecks({
      "../escape.md": { minWords: 5 },
      "/abs.json": { minItems: 2 },
      ".hidden": { minWords: 1 },
    });
    expect(out).toEqual({});
  });

  it("clamps invalid numbers and drops empty entries", () => {
    const out = sanitizeChecks({
      "a.md": { minWords: -3 },
      "b.md": { minWords: 1e9 },
      "c.md": { format: "xml" },
      "d.md": { minSections: 4 },
    });
    expect(out["a.md"]).toBeUndefined();
    expect(out["b.md"]?.minWords).toBe(100000);
    expect(out["c.md"]).toBeUndefined();
    expect(out["d.md"]?.minSections).toBe(4);
  });

  it("caps requiredSubstrings and ignores bad format", () => {
    const out = sanitizeChecks({
      "a.md": { requiredSubstrings: ["x", 2, "", "y"], format: "md" },
    });
    expect(out["a.md"]?.requiredSubstrings).toEqual(["x", "y"]);
    expect(out["a.md"]?.format).toBe("md");
  });
});

describe("validateDeclaredChecks", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "checks-"));
  });

  it("flags minWords below threshold and passes when met", async () => {
    await realFs.writeFile(path.join(tmpDir, "short.md"), "one two three four five");
    await realFs.writeFile(path.join(tmpDir, "long.md"), "w ".repeat(120));
    const out = await validateDeclaredChecks(tmpDir, {
      "short.md": { minWords: 50 },
      "long.md": { minWords: 50 },
    });
    expect(out.map((p) => p.sourceFile)).toContain("short.md");
    expect(out.map((p) => p.sourceFile)).not.toContain("long.md");
  });

  it("flags minSections and minItems", async () => {
    await realFs.writeFile(path.join(tmpDir, "doc.md"), "## Only one\n\ntext");
    await realFs.writeFile(path.join(tmpDir, "arr.json"), "[1,2]");
    await realFs.writeFile(path.join(tmpDir, "obj.json"), '{"items":[1,2,3,4,5]}');
    const out = await validateDeclaredChecks(tmpDir, {
      "doc.md": { minSections: 3 },
      "arr.json": { minItems: 5 },
      "obj.json": { minItems: 5 },
    });
    const files = out.map((p) => p.sourceFile);
    expect(files).toContain("doc.md");
    expect(files).toContain("arr.json");
    expect(files).not.toContain("obj.json");
  });

  it("flags missing requiredSubstrings (case-insensitive) and absent files are skipped", async () => {
    await realFs.writeFile(path.join(tmpDir, "x.md"), "Bonjour le Monde");
    const out = await validateDeclaredChecks(tmpDir, {
      "x.md": { requiredSubstrings: ["bonjour", "introuvable"] },
      "absent.md": { minWords: 10 },
    });
    expect(out).toHaveLength(1);
    expect(out[0].sourceFile).toBe("x.md");
    expect(out[0].problem).toContain("introuvable");
  });
});

describe("findCsvColumnProblems", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "csv-"));
  });

  it("flags inconsistent column counts and passes a regular CSV", async () => {
    await realFs.writeFile(path.join(tmpDir, "bad.csv"), "a,b,c\n1,2\n3,4,5");
    await realFs.writeFile(path.join(tmpDir, "ok.csv"), "a,b\n1,2\n3,4");
    const out = await findCsvColumnProblems(tmpDir);
    expect(out.map((p) => p.sourceFile)).toContain("bad.csv");
    expect(out.map((p) => p.sourceFile)).not.toContain("ok.csv");
  });

  it("respects quoted commas (no false positive)", async () => {
    await realFs.writeFile(path.join(tmpDir, "q.csv"), 'name,note\n"a,b",c\n"d,e",f');
    const out = await findCsvColumnProblems(tmpDir);
    expect(out).toEqual([]);
  });
});

describe("findPlaceholderDeliverables", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "ph-"));
  });

  it("flags a short markdown with lorem ipsum", async () => {
    await realFs.writeFile(path.join(tmpDir, "notes.md"), "lorem ipsum dolor sit amet");
    const out = await findPlaceholderDeliverables(tmpDir);
    expect(out.map((p) => p.sourceFile)).toContain("notes.md");
  });

  it("does NOT flag a // TODO inside code (.js excluded)", async () => {
    await realFs.writeFile(
      path.join(tmpDir, "app.js"),
      "// TODO: refactor\n" + "x".repeat(300),
    );
    const out = await findPlaceholderDeliverables(tmpDir);
    expect(out).toEqual([]);
  });

  it("does NOT flag a long document with a single isolated marker (density guard)", async () => {
    const body =
      "Contenu réel et substantiel. ".repeat(40) + " lorem ipsum est une locution.";
    await realFs.writeFile(path.join(tmpDir, "article.md"), body);
    const out = await findPlaceholderDeliverables(tmpDir);
    expect(out).toEqual([]);
  });

  it("flags a near-empty text deliverable", async () => {
    await realFs.writeFile(path.join(tmpDir, "vide.txt"), "ok");
    const out = await findPlaceholderDeliverables(tmpDir);
    expect(out.map((p) => p.sourceFile)).toContain("vide.txt");
  });
});

describe("findUnreferencedModules", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "mod-"));
  });

  it("flags an orphan module but not entry points, tests, or referenced modules", async () => {
    await realFs.writeFile(path.join(tmpDir, "orphan.ts"), "export const a = 1;");
    await realFs.writeFile(path.join(tmpDir, "index.ts"), "export const b = 2;");
    await realFs.writeFile(path.join(tmpDir, "util.ts"), "export const c = 3;");
    await realFs.writeFile(path.join(tmpDir, "main.ts"), "import { c } from './util';");
    await realFs.writeFile(path.join(tmpDir, "foo.test.ts"), "test('x', () => {});");
    const out = await findUnreferencedModules(tmpDir);
    const files = out.map((p) => p.sourceFile);
    expect(files).toContain("orphan.ts");
    expect(files).not.toContain("index.ts");
    expect(files).not.toContain("util.ts");
    expect(files).not.toContain("foo.test.ts");
  });
});

describe("findModuleGraphProblems", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "graph-"));
  });

  it("flags a Python import of a symbol the target module doesn't define", async () => {
    await realFs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await realFs.writeFile(
      path.join(tmpDir, "src/sorter.py"),
      "class DataSorter:\n    @staticmethod\n    def sort(data):\n        return data\n",
    );
    await realFs.writeFile(
      path.join(tmpDir, "src/main.py"),
      "from sorter import sort_data\nprint(sort_data)\n",
    );
    const out = await findModuleGraphProblems(tmpDir);
    const hit = out.find((p) => p.sourceFile.endsWith("main.py"));
    expect(hit).toBeTruthy();
    expect(hit?.problem).toContain("sort_data");
  });

  it("does not flag a Python import that resolves correctly (incl. re-exports)", async () => {
    await realFs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await realFs.writeFile(
      path.join(tmpDir, "src/error_handler.py"),
      "class ErrorTracker:\n    pass\n",
    );
    await realFs.writeFile(
      path.join(tmpDir, "src/main.py"),
      "from error_handler import ErrorTracker\nx = ErrorTracker()\n",
    );
    const out = await findModuleGraphProblems(tmpDir);
    expect(out.find((p) => p.sourceFile.endsWith("main.py"))).toBeFalsy();
  });

  it("flags a TS named import the target module doesn't export", async () => {
    await realFs.writeFile(
      path.join(tmpDir, "sorter.ts"),
      "export class DataSorter {}\n",
    );
    await realFs.writeFile(
      path.join(tmpDir, "index.ts"),
      "import { sortData } from './sorter';\nconsole.log(sortData);\n",
    );
    const out = await findModuleGraphProblems(tmpDir);
    const hit = out.find((p) => p.sourceFile === "index.ts");
    expect(hit?.problem).toContain("sortData");
  });

  it("resolves correct TS named imports without flagging", async () => {
    await realFs.writeFile(
      path.join(tmpDir, "engine.ts"),
      "export function validateEmail() {}\nexport const VERSION = '1';\n",
    );
    await realFs.writeFile(
      path.join(tmpDir, "index.ts"),
      "import { validateEmail, VERSION } from './engine';\nvalidateEmail();\n",
    );
    const out = await findModuleGraphProblems(tmpDir);
    expect(out.find((p) => p.sourceFile === "index.ts")).toBeFalsy();
  });

  it("does not flag imports from external packages or wildcard re-exports", async () => {
    await realFs.writeFile(path.join(tmpDir, "barrel.ts"), "export * from './impl';\n");
    await realFs.writeFile(path.join(tmpDir, "impl.ts"), "export const x = 1;\n");
    await realFs.writeFile(
      path.join(tmpDir, "index.ts"),
      "import { useState } from 'react';\nimport { anything } from './barrel';\nconsole.log(useState, anything);\n",
    );
    const out = await findModuleGraphProblems(tmpDir);
    expect(out.find((p) => p.sourceFile === "index.ts")).toBeFalsy();
  });

  it("flags an orphan exporting module that no file imports", async () => {
    await realFs.writeFile(
      path.join(tmpDir, "types.ts"),
      "export interface T { a: number }\n",
    );
    await realFs.writeFile(path.join(tmpDir, "engine.ts"), "export function f() {}\n");
    await realFs.writeFile(path.join(tmpDir, "index.ts"), "export * from './engine';\n");
    const out = await findModuleGraphProblems(tmpDir);
    const orphans = out.filter((p) => p.problem.includes("jamais importé"));
    expect(orphans.map((p) => p.sourceFile)).toContain("types.ts");
    expect(orphans.map((p) => p.sourceFile)).not.toContain("engine.ts");
  });

  it("never flags a Python test file as an orphan", async () => {
    await realFs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await realFs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "src/a.py"), "def a():\n    return 1\n");
    await realFs.writeFile(path.join(tmpDir, "src/b.py"), "def b():\n    return 2\n");
    await realFs.writeFile(
      path.join(tmpDir, "tests/test_unit.py"),
      "from a import a\nfrom b import b\n\ndef test_it():\n    assert a() == 1\n",
    );
    const out = await findModuleGraphProblems(tmpDir);
    expect(out.find((p) => p.sourceFile.includes("test_unit.py"))).toBeFalsy();
  });

  it("dedupes the same broken import reported twice (e.g. dual try/except import)", async () => {
    await realFs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await realFs.writeFile(
      path.join(tmpDir, "src/sorter.py"),
      "class DataSorter:\n    pass\n",
    );
    await realFs.writeFile(
      path.join(tmpDir, "src/main.py"),
      "try:\n    from sorter import sort_data\nexcept ImportError:\n    from src.sorter import sort_data\n",
    );
    const out = await findModuleGraphProblems(tmpDir);
    const hits = out.filter(
      (p) => p.sourceFile.endsWith("main.py") && p.problem.includes("sort_data"),
    );
    expect(hits).toHaveLength(1);
  });

  it("returns nothing for a coherent single-purpose project", async () => {
    await realFs.writeFile(path.join(tmpDir, "a.ts"), "export const a = 1;\n");
    await realFs.writeFile(
      path.join(tmpDir, "b.ts"),
      "import { a } from './a';\nexport const b = a + 1;\n",
    );
    await realFs.writeFile(path.join(tmpDir, "index.ts"), "export * from './b';\n");
    const out = await findModuleGraphProblems(tmpDir);
    expect(out).toEqual([]);
  });
});

describe("deriveFloorChecks", () => {
  it("adds a prose minWords floor to .md/.txt content files", () => {
    const out = deriveFloorChecks(["content/ch1.md", "notes.txt"], {});
    expect(out["content/ch1.md"]?.minWords).toBe(PROSE_FLOOR_WORDS);
    expect(out["notes.txt"]?.minWords).toBe(PROSE_FLOOR_WORDS);
  });

  it("never overrides a declared minWords", () => {
    const out = deriveFloorChecks(["g.md"], { "g.md": { minWords: 5000 } });
    expect(out["g.md"]?.minWords).toBe(5000);
  });

  it("skips reports/audits and non-prose files", () => {
    const out = deriveFloorChecks(["reports/qa.md", "data.json", "app.js"], {});
    expect(out["reports/qa.md"]).toBeUndefined();
    expect(out["data.json"]).toBeUndefined();
    expect(out["app.js"]).toBeUndefined();
  });
});

describe("findConsolidationShrinkage", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "consol-"));
  });

  it("flags a final file far shorter than the content sources", async () => {
    await realFs.mkdir(path.join(tmpDir, "content"), { recursive: true });
    await realFs.mkdir(path.join(tmpDir, "final"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "content/ch1.md"), "mot ".repeat(2000));
    await realFs.writeFile(path.join(tmpDir, "content/ch2.md"), "mot ".repeat(2000));
    await realFs.writeFile(
      path.join(tmpDir, "final/guide_complet.md"),
      "mot ".repeat(500),
    );
    const out = await findConsolidationShrinkage(tmpDir);
    expect(out.map((p) => p.sourceFile)).toContain("final/guide_complet.md");
  });

  it("passes when the final includes the full content", async () => {
    await realFs.mkdir(path.join(tmpDir, "content"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "content/ch1.md"), "mot ".repeat(1000));
    await realFs.writeFile(path.join(tmpDir, "content/ch2.md"), "mot ".repeat(1000));
    await realFs.writeFile(path.join(tmpDir, "guide_complet.md"), "mot ".repeat(2000));
    const out = await findConsolidationShrinkage(tmpDir);
    expect(out).toEqual([]);
  });
});

describe("findUnstyledClasses", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "css-"));
  });

  it("flags a page whose classes have no CSS rule", async () => {
    await realFs.mkdir(path.join(tmpDir, "public"), { recursive: true });
    await realFs.writeFile(
      path.join(tmpDir, "public/index.html"),
      '<link rel="stylesheet" href="styles.css"><div class="hero card feature alpha beta"></div>',
    );
    await realFs.writeFile(
      path.join(tmpDir, "public/styles.css"),
      "body { color: red; }",
    );
    const out = await findUnstyledClasses(tmpDir);
    expect(out.map((p) => p.sourceFile)).toContain("public/index.html");
  });

  it("passes when classes are defined (incl. via @import)", async () => {
    await realFs.mkdir(path.join(tmpDir, "public"), { recursive: true });
    await realFs.writeFile(
      path.join(tmpDir, "public/index.html"),
      '<link rel="stylesheet" href="styles.css"><div class="hero card feature"></div>',
    );
    await realFs.writeFile(path.join(tmpDir, "public/styles.css"), "@import 'comp.css';");
    await realFs.writeFile(
      path.join(tmpDir, "public/comp.css"),
      ".hero{} .card{} .feature{}",
    );
    const out = await findUnstyledClasses(tmpDir);
    expect(out).toEqual([]);
  });
});

describe("findDivergentDuplicates", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "dup-"));
  });

  it("flags same-basename content files with divergent content", async () => {
    await realFs.mkdir(path.join(tmpDir, "legal"), { recursive: true });
    await realFs.writeFile(
      path.join(tmpDir, "regulations.md"),
      "# Reg\nVersion A content here.",
    );
    await realFs.writeFile(
      path.join(tmpDir, "legal/regulations.md"),
      "# Reg\nVersion B is completely different.",
    );
    const out = await findDivergentDuplicates(tmpDir);
    expect(out.length).toBe(1);
    expect(out[0].problem).toContain("contenus divergents");
    expect(out[0].problem).toContain("regulations.md");
  });

  it("does NOT flag identical copies (only whitespace differs)", async () => {
    await realFs.mkdir(path.join(tmpDir, "reports"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "figures.md"), "# Figures\nSame body.\n");
    await realFs.writeFile(
      path.join(tmpDir, "reports/figures.md"),
      "# Figures\r\nSame body.   \r\n",
    );
    const out = await findDivergentDuplicates(tmpDir);
    expect(out).toEqual([]);
  });

  it("excludes legitimately-recurring basenames (package.json) even when divergent", async () => {
    await realFs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "package.json"), '{"name":"root"}');
    await realFs.writeFile(path.join(tmpDir, "sub/package.json"), '{"name":"sub"}');
    const out = await findDivergentDuplicates(tmpDir);
    expect(out).toEqual([]);
  });

  it("ignores single occurrences", async () => {
    await realFs.writeFile(path.join(tmpDir, "unique.md"), "only one copy of this file");
    const out = await findDivergentDuplicates(tmpDir);
    expect(out).toEqual([]);
  });
});

describe("findScatteredDuplicates", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "scatter-"));
  });

  it("flags identical content copied across 3+ locations", async () => {
    const body = "# Market figures\nAll the same data everywhere.";
    await realFs.mkdir(path.join(tmpDir, "research"), { recursive: true });
    await realFs.mkdir(path.join(tmpDir, "reports"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "figures.md"), body);
    await realFs.writeFile(path.join(tmpDir, "research/figures.md"), body);
    await realFs.writeFile(path.join(tmpDir, "reports/figures.md"), body);
    const out = await findScatteredDuplicates(tmpDir);
    expect(out.length).toBe(1);
    expect(out[0].problem).toContain("éparpillé dans 3 emplacements");
  });

  it("does NOT flag only 2 identical copies (under threshold)", async () => {
    const body = "# Figures\nSame in two places.";
    await realFs.mkdir(path.join(tmpDir, "reports"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "figures.md"), body);
    await realFs.writeFile(path.join(tmpDir, "reports/figures.md"), body);
    const out = await findScatteredDuplicates(tmpDir);
    expect(out).toEqual([]);
  });

  it("does NOT flag 3 copies that diverge (that's Problème 1's job)", async () => {
    await realFs.mkdir(path.join(tmpDir, "a"), { recursive: true });
    await realFs.mkdir(path.join(tmpDir, "b"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "note.md"), "version one of the note");
    await realFs.writeFile(path.join(tmpDir, "a/note.md"), "version two differs");
    await realFs.writeFile(path.join(tmpDir, "b/note.md"), "version three differs again");
    const out = await findScatteredDuplicates(tmpDir);
    expect(out).toEqual([]);
  });
});

describe("findUnwantedWebScaffolding", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "scaffold-"));
  });

  it("flags sitemap/robots/seo when the deliverable is .md-only", async () => {
    await realFs.writeFile(path.join(tmpDir, "study.md"), "x".repeat(600));
    await realFs.writeFile(path.join(tmpDir, "sitemap.xml"), "<urlset></urlset>");
    await realFs.writeFile(path.join(tmpDir, "robots.txt"), "User-agent: *");
    await realFs.mkdir(path.join(tmpDir, "seo"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "seo/robots.txt"), "User-agent: *");
    const out = await findUnwantedWebScaffolding(tmpDir);
    const flagged = out.map((p) => p.sourceFile);
    expect(flagged).toContain("sitemap.xml");
    expect(flagged).toContain("robots.txt");
    expect(flagged).toContain(path.join("seo", "robots.txt"));
  });

  it("does NOT flag when a substantial served HTML page exists", async () => {
    await realFs.mkdir(path.join(tmpDir, "public"), { recursive: true });
    await realFs.writeFile(
      path.join(tmpDir, "public/index.html"),
      `<!doctype html><html><head><title>Real site</title></head><body>${"<p>content</p>".repeat(50)}</body></html>`,
    );
    await realFs.writeFile(path.join(tmpDir, "public/sitemap.xml"), "<urlset></urlset>");
    await realFs.writeFile(path.join(tmpDir, "public/robots.txt"), "User-agent: *");
    const out = await findUnwantedWebScaffolding(tmpDir);
    expect(out).toEqual([]);
  });

  it("does NOT flag package.json (legit for code deliverables)", async () => {
    await realFs.writeFile(path.join(tmpDir, "report.md"), "y".repeat(600));
    await realFs.writeFile(path.join(tmpDir, "package.json"), '{"name":"x"}');
    const out = await findUnwantedWebScaffolding(tmpDir);
    expect(out).toEqual([]);
  });
});

describe("findUselessDesignArtifacts", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "design-"));
  });

  it("flags a mockup HTML when the deliverable is documentary", async () => {
    await realFs.writeFile(path.join(tmpDir, "guide.md"), "z".repeat(600));
    await realFs.writeFile(
      path.join(tmpDir, "maquette_page_type.html"),
      "<div>mock</div>",
    );
    await realFs.writeFile(path.join(tmpDir, "style_guide.css"), ".x{}");
    const out = await findUselessDesignArtifacts(tmpDir);
    const flagged = out.map((p) => p.sourceFile);
    expect(flagged).toContain("maquette_page_type.html");
    expect(flagged).toContain("style_guide.css");
  });

  it("does NOT flag when a substantial served site exists", async () => {
    await realFs.mkdir(path.join(tmpDir, "public"), { recursive: true });
    await realFs.writeFile(
      path.join(tmpDir, "public/index.html"),
      `<!doctype html><html><body>${"<p>real</p>".repeat(60)}</body></html>`,
    );
    await realFs.mkdir(path.join(tmpDir, "mockups"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "mockups/home.html"), "<div></div>");
    const out = await findUselessDesignArtifacts(tmpDir);
    expect(out).toEqual([]);
  });

  it("spares a plain styles.css (not design-named) in a documentary workspace", async () => {
    await realFs.writeFile(path.join(tmpDir, "doc.md"), "w".repeat(600));
    await realFs.writeFile(path.join(tmpDir, "styles.css"), "body{}");
    const out = await findUselessDesignArtifacts(tmpDir);
    expect(out).toEqual([]);
  });
});

describe("findCssConsistencyProblems — served roots beyond allowlist (B1)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "b1-"));
  });

  it("now scans an ad-hoc 'presentation/' folder containing HTML", async () => {
    await realFs.mkdir(path.join(tmpDir, "presentation"), { recursive: true });
    await realFs.writeFile(
      path.join(tmpDir, "presentation/a.html"),
      '<link rel="stylesheet" href="x.css">',
    );
    await realFs.writeFile(
      path.join(tmpDir, "presentation/b.html"),
      '<link rel="stylesheet" href="y.css">',
    );
    const out = await findCssConsistencyProblems(tmpDir);
    expect(out.some((p) => p.sourceFile === "presentation/")).toBe(true);
  });

  it("ignores a folder with no HTML", async () => {
    await realFs.mkdir(path.join(tmpDir, "content"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "content/ch1.md"), "# x");
    const out = await findCssConsistencyProblems(tmpDir);
    expect(out).toEqual([]);
  });
});

describe("buildMissingFilesPrompt", () => {
  it("includes node task and missing files", () => {
    const node = makeProject({ task: "Build the homepage" });
    const result = buildMissingFilesPrompt(node, ["index.html", "style.css"]);
    expect(result).toContain("Build the homepage");
    expect(result).toContain("index.html");
    expect(result).toContain("style.css");
    expect(result).toContain("FICHIERS MANQUANTS");
  });
});

describe("buildTrivialResultPrompt", () => {
  it("includes node task and MIN_RESULT_CHARS", () => {
    const node = makeProject({ task: "Generate a report" });
    const result = buildTrivialResultPrompt(node);
    expect(result).toContain("Generate a report");
    expect(result).toContain(String(MIN_RESULT_CHARS));
    expect(result).toContain("RÉSULTAT INSUFFISANT");
  });
});

describe("enforceDeliverables", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "enforce-"));
  });

  it("returns immediately when expected files are present and result is non-trivial", async () => {
    await realFs.writeFile(path.join(tmpDir, "file.txt"), "x".repeat(200));
    const relaunch = vi.fn();
    const writeFiles = vi.fn();

    const result = await enforceDeliverables(
      makeProject(),
      ["file.txt"],
      tmpDir,
      "x".repeat(300),
      { relaunch, writeFiles: writeFiles as never, onStatus: vi.fn() },
    );

    expect(result.missing).toEqual([]);
    expect(result.trivial).toBe(false);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("retries when expected files are missing", async () => {
    const relaunch = vi.fn().mockResolvedValue("retry output " + "x".repeat(300));
    const writeFiles = vi.fn().mockImplementation(async () => {
      await realFs.writeFile(path.join(tmpDir, "needed.txt"), "y".repeat(200));
      return ["needed.txt"];
    });

    const result = await enforceDeliverables(
      makeProject({ maxRetries: 2 }),
      ["needed.txt"],
      tmpDir,
      "initial " + "x".repeat(300),
      { relaunch, writeFiles, onStatus: vi.fn() },
    );

    expect(result.missing).toEqual([]);
    expect(result.trivial).toBe(false);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("reports persistent missing files after maxRetries", async () => {
    const relaunch = vi.fn().mockResolvedValue("still nothing useful " + "x".repeat(300));
    const writeFiles = vi.fn().mockResolvedValue([]);

    const result = await enforceDeliverables(
      makeProject({ maxRetries: 2 }),
      ["forever-missing.txt"],
      tmpDir,
      "initial " + "x".repeat(300),
      { relaunch, writeFiles, onStatus: vi.fn() },
    );

    expect(result.missing).toContain("forever-missing.txt");
    expect(relaunch).toHaveBeenCalledTimes(2);
  });

  it("does not retry trivial result when files are present on disk (backend node)", async () => {
    await realFs.writeFile(
      path.join(tmpDir, "backend.py"),
      "print('hello world')\n" + "x".repeat(200),
    );
    const relaunch = vi.fn();

    const result = await enforceDeliverables(
      makeProject({ type: "code" }),
      ["backend.py"],
      tmpDir,
      "Done.",
      { relaunch, writeFiles: vi.fn() as never, onStatus: vi.fn() },
    );

    expect(result.trivial).toBe(false);
    expect(result.missing).toEqual([]);
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe("parseQualityVerdict", () => {
  it("parses valid JSON verdict", () => {
    const raw = '{"pass": true, "issues": []}';
    const result = parseQualityVerdict(raw);
    expect(result).toEqual({ pass: true, issues: [] });
  });

  it("parses fenced JSON", () => {
    const raw =
      '```json\n{"pass": false, "issues": [{"agent": "A", "issue": "bad", "fix": "fix it"}]}\n```';
    const result = parseQualityVerdict(raw);
    expect(result).not.toBeNull();
    expect(result!.pass).toBe(false);
    expect(result!.issues).toHaveLength(1);
  });

  it("returns null for invalid JSON", () => {
    expect(parseQualityVerdict("not json at all")).toBeNull();
  });

  it("returns null when pass is not boolean", () => {
    expect(parseQualityVerdict('{"pass": "yes"}')).toBeNull();
  });

  it("defaults issues to empty array if missing", () => {
    const result = parseQualityVerdict('{"pass": true}');
    expect(result).toEqual({ pass: true, issues: [] });
  });

  it("parses a verdict wrapped in surrounding prose", () => {
    const raw =
      'Voici mon analyse du livrable.\n{"pass": false, "issues": []}\nEn conclusion, à corriger.';
    expect(parseQualityVerdict(raw)).toEqual({ pass: false, issues: [] });
  });
});

describe("findOrphanStylesheets", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "orphan-"));
  });

  it("flags a stylesheet no page references but not the linked one", async () => {
    const root = path.join(tmpDir, "presentation");
    await realFs.mkdir(root, { recursive: true });
    await realFs.writeFile(
      path.join(root, "index.html"),
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head><body>x</body></html>',
    );
    await realFs.writeFile(path.join(root, "style.css"), "body{color:red}");
    await realFs.writeFile(path.join(root, "styles.css"), "body{color:blue}");

    const orphans = await findOrphanStylesheets(tmpDir);
    const files = orphans.map((o) => o.sourceFile);
    expect(files).toContain(path.join("presentation", "styles.css"));
    expect(files).not.toContain(path.join("presentation", "style.css"));
  });

  it("follows @import chains so indirectly-used sheets are not orphans", async () => {
    const root = path.join(tmpDir, "site");
    await realFs.mkdir(root, { recursive: true });
    await realFs.writeFile(
      path.join(root, "index.html"),
      '<html><head><link rel="stylesheet" href="main.css"></head><body>x</body></html>',
    );
    await realFs.writeFile(path.join(root, "main.css"), '@import "tokens.css";\nbody{}');
    await realFs.writeFile(path.join(root, "tokens.css"), ":root{--c:red}");

    const orphans = await findOrphanStylesheets(tmpDir);
    expect(orphans).toEqual([]);
  });

  it("ignores the design daemon scratch dir", async () => {
    const scratch = path.join(tmpDir, "design", "orch-abc", "presentation");
    await realFs.mkdir(scratch, { recursive: true });
    await realFs.writeFile(path.join(scratch, "index.html"), "<html></html>");
    await realFs.writeFile(path.join(scratch, "orphan.css"), "body{}");

    const orphans = await findOrphanStylesheets(tmpDir);
    expect(orphans).toEqual([]);
  });
});

describe("findServedHtmlPlaceholders", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "htmlph-"));
  });

  it("flags a placeholder container but not a legit input placeholder attribute", async () => {
    const root = path.join(tmpDir, "public");
    await realFs.mkdir(root, { recursive: true });
    await realFs.writeFile(
      path.join(root, "page.html"),
      '<html><body><div class="demo-placeholder">x</div></body></html>',
    );
    await realFs.writeFile(
      path.join(root, "form.html"),
      '<html><body><input type="email" placeholder="votre@email.com"></body></html>',
    );
    const found = await findServedHtmlPlaceholders(tmpDir);
    const files = found.map((p) => p.sourceFile);
    expect(files).toContain(path.join("public", "page.html"));
    expect(files).not.toContain(path.join("public", "form.html"));
  });

  it("flags generic filler phrases", async () => {
    const root = path.join(tmpDir, "site");
    await realFs.mkdir(root, { recursive: true });
    await realFs.writeFile(
      path.join(root, "index.html"),
      "<html><body><p>Lorem ipsum dolor sit amet.</p></body></html>",
    );
    const found = await findServedHtmlPlaceholders(tmpDir);
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("findStructuredDataMismatch", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "jsonld-"));
  });

  it("flags a JSON-LD price absent from the visible page", async () => {
    const root = path.join(tmpDir, "public");
    await realFs.mkdir(root, { recursive: true });
    await realFs.writeFile(
      path.join(root, "index.html"),
      `<html><head><script type="application/ld+json">{"@type":"Product","offers":{"price":"14.90"}}</script></head><body><p>Abonnement 19,90€/mois</p></body></html>`,
    );
    const found = await findStructuredDataMismatch(tmpDir);
    expect(found.map((p) => p.sourceFile)).toContain(path.join("public", "index.html"));
  });

  it("does not flag when the JSON-LD price is shown on the page", async () => {
    const root = path.join(tmpDir, "public");
    await realFs.mkdir(root, { recursive: true });
    await realFs.writeFile(
      path.join(root, "index.html"),
      `<html><head><script type="application/ld+json">{"offers":{"price":"19.90"}}</script></head><body><p>Seulement 19,90 € par mois</p></body></html>`,
    );
    const found = await findStructuredDataMismatch(tmpDir);
    expect(found).toEqual([]);
  });

  it("does not flag a price of a different number (no false 14 inside 114)", async () => {
    const root = path.join(tmpDir, "shop");
    await realFs.mkdir(root, { recursive: true });
    await realFs.writeFile(
      path.join(root, "p.html"),
      `<html><head><script type="application/ld+json">{"offers":{"price":"14"}}</script></head><body><p>Prix : 114 dollars</p></body></html>`,
    );
    const found = await findStructuredDataMismatch(tmpDir);
    expect(found.length).toBe(1); // 14 not shown (only 114) → correctly flagged
  });
});

describe("sanitizeWorkspaceIndex", () => {
  it("drops duplicate file-map rows, keeping the first", () => {
    const idx = [
      "## 1. Cartographie",
      "| Fichier | Fonction |",
      "|---|---|",
      "| a.css | Styles. |",
      "| b.html | Page. |",
      "",
      "| a.css | Styles (doublon). |",
      "| b.html | Page (doublon). |",
    ].join("\n");
    const out = sanitizeWorkspaceIndex(idx);
    expect((out.match(/\| a\.css \|/g) ?? []).length).toBe(1);
    expect((out.match(/\| b\.html \|/g) ?? []).length).toBe(1);
    expect(out).toContain("| a.css | Styles. |"); // first kept
  });

  it("does not dedupe changelog rows that share a date", () => {
    const idx = [
      "## 2. Journal",
      "| Date | Agent | Description |",
      "|---|---|---|",
      "| 2026-06-15 | Design | A. |",
      "| 2026-06-15 | Work | B. |",
    ].join("\n");
    const out = sanitizeWorkspaceIndex(idx);
    expect((out.match(/2026-06-15/g) ?? []).length).toBe(2);
  });
});

describe("extractJsonObject", () => {
  it("returns a bare object unchanged", () => {
    expect(extractJsonObject('{"a": 1}')).toBe('{"a": 1}');
  });

  it("strips ```json fences", () => {
    expect(extractJsonObject('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it("extracts the object from surrounding prose", () => {
    expect(extractJsonObject('blah { "a": 1 } trailing')).toBe('{ "a": 1 }');
  });

  it("ignores braces inside quoted strings", () => {
    const raw = '{"reason": "use a } brace { here", "pass": true}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it("returns null when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });
});

describe("buildAutoFeedback", () => {
  it("formats issues into feedback string", () => {
    const verdict = {
      pass: false,
      issues: [
        { agent: "Design", issue: "Missing mobile layout", fix: "Add media queries" },
        { agent: "Code", issue: "No error handling", fix: "Add try-catch" },
      ],
    };
    const result = buildAutoFeedback(verdict);
    expect(result).toContain("CYCLE QUALITÉ AUTOMATIQUE");
    expect(result).toContain("[Design]");
    expect(result).toContain("[Code]");
    expect(result).toContain("Missing mobile layout");
    expect(result).toContain("Add media queries");
  });
});

describe("buildSyntheticRun", () => {
  it("creates an OrchRun from execution state", () => {
    const linked = [
      makeProject({ id: "a1", name: "Agent 1" }),
      makeProject({ id: "a2", name: "Agent 2" }),
    ];
    const statuses: Record<string, "done" | "error" | "skipped"> = {
      a1: "done",
      a2: "error",
    };
    const results = new Map([["a1", "result text"]]);

    const run = buildSyntheticRun("global task", "orch-1", statuses, results, linked);

    expect(run.id).toBe("synthetic");
    expect(run.task).toBe("global task");
    expect(run.orchProjectId).toBe("orch-1");
    expect(run.nodeResults).toHaveLength(2);
    expect(run.nodeResults[0].status).toBe("done");
    expect(run.nodeResults[0].result).toBe("result text");
    expect(run.nodeResults[1].status).toBe("error");
    expect(run.nodeResults[1].result).toBeUndefined();
  });
});

describe("buildQualityGateUserPrompt", () => {
  it("includes generic criteria without htmlHeads", () => {
    const result = buildQualityGateUserPrompt({
      globalTask: "Build a Python CLI",
      nodeResultSummaries: "Agent A: done",
      expectedFilesReport: "Aucun contrat",
      htmlHeads: "",
    });
    expect(result).toContain("Build a Python CLI");
    expect(result).toContain("COMPLÉTUDE");
    expect(result).not.toContain("SEO");
  });

  it("includes web criteria when htmlHeads is non-empty", () => {
    const result = buildQualityGateUserPrompt({
      globalTask: "Build a website",
      nodeResultSummaries: "Agent A: done",
      expectedFilesReport: "file.html OK",
      htmlHeads: "<title>Test</title>",
    });
    expect(result).toContain("SEO");
    expect(result).toContain("ACCESSIBILITÉ");
    expect(result).toContain("<title>Test</title>");
  });

  it("includes CSS criteria when cssSnippets is provided", () => {
    const result = buildQualityGateUserPrompt({
      globalTask: "Build a website",
      nodeResultSummaries: "Agent A: done",
      expectedFilesReport: "ok",
      htmlHeads: "<title>x</title>",
      cssSnippets: ":root { --color: #A3A3A3; }",
    });
    expect(result).toContain("CONTRASTE");
    expect(result).toContain("RESPONSIVE");
    expect(result).toContain("--color: #A3A3A3");
  });

  it("includes broken-assets criteria when a report is provided", () => {
    const result = buildQualityGateUserPrompt({
      globalTask: "Build a website",
      nodeResultSummaries: "Agent A: done",
      expectedFilesReport: "ok",
      htmlHeads: "<title>x</title>",
      brokenAssetsReport:
        'RÉFÉRENCES CASSÉES (détection déterministe) :\n  ✗ gallery.html → "assets/x.svg" (introuvable)',
    });
    expect(result).toContain("ASSETS");
    expect(result).toContain("BLOQUANT");
    expect(result).toContain("assets/x.svg");
  });
});

describe("findBrokenAssetRefs / buildBrokenAssetsReport", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "assets-"));
  });

  it("flags a local image referenced by HTML but absent from disk", async () => {
    await realFs.writeFile(
      path.join(tmpDir, "gallery.html"),
      '<img src="assets/missing.svg"><link href="css/main.css">',
    );
    await realFs.mkdir(path.join(tmpDir, "css"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "css/main.css"), "body{}");

    const broken = await findBrokenAssetRefs(tmpDir);
    expect(broken).toHaveLength(1);
    expect(broken[0].ref).toBe("assets/missing.svg");
    expect(broken[0].sourceFile).toBe("gallery.html");
  });

  it("does not flag references whose targets exist", async () => {
    await realFs.mkdir(path.join(tmpDir, "assets"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "assets/ok.svg"), "<svg/>");
    await realFs.writeFile(path.join(tmpDir, "index.html"), '<img src="assets/ok.svg">');

    const broken = await findBrokenAssetRefs(tmpDir);
    expect(broken).toHaveLength(0);
  });

  it("ignores external, data, anchor and mailto references", async () => {
    await realFs.writeFile(
      path.join(tmpDir, "index.html"),
      '<a href="https://x.com/p"><a href="#top"><a href="mailto:a@b.c"><img src="data:image/svg+xml,...">',
    );
    const broken = await findBrokenAssetRefs(tmpDir);
    expect(broken).toHaveLength(0);
  });

  it("detects broken url() targets inside CSS files", async () => {
    await realFs.writeFile(
      path.join(tmpDir, "main.css"),
      ".hero { background: url('images/bg.jpg'); }",
    );
    const broken = await findBrokenAssetRefs(tmpDir);
    expect(broken).toHaveLength(1);
    expect(broken[0].ref).toBe("images/bg.jpg");
  });

  it("strips query strings and hashes before resolving", async () => {
    await realFs.mkdir(path.join(tmpDir, "fonts"), { recursive: true });
    await realFs.writeFile(path.join(tmpDir, "fonts/f.woff2"), "x");
    await realFs.writeFile(
      path.join(tmpDir, "main.css"),
      "@font-face { src: url('fonts/f.woff2?v=2'); }",
    );
    const broken = await findBrokenAssetRefs(tmpDir);
    expect(broken).toHaveLength(0);
  });

  it("buildBrokenAssetsReport returns empty string for no broken refs", () => {
    expect(buildBrokenAssetsReport([])).toBe("");
  });

  it("buildBrokenAssetsReport lists each broken ref", () => {
    const report = buildBrokenAssetsReport([
      { sourceFile: "a.html", ref: "x.png" },
      { sourceFile: "b.css", ref: "y.jpg" },
    ]);
    expect(report).toContain("RÉFÉRENCES CASSÉES");
    expect(report).toContain("a.html");
    expect(report).toContain("x.png");
    expect(report).toContain("y.jpg");
  });
});
