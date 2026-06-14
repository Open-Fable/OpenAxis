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
  parseQualityVerdict,
  buildAutoFeedback,
  buildSyntheticRun,
  buildQualityGateUserPrompt,
  findBrokenAssetRefs,
  buildBrokenAssetsReport,
  findInvalidJsonFiles,
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
