import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRunner, buildCommandDefects } from "./orchestrator-commands.js";
import type { DiscoveredCommand } from "./orchestrator-recon.js";
import type { Project } from "./project-store.js";

async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "oh-cmd-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeCmd(id: string, argv: readonly string[]): DiscoveredCommand {
  return { id, argv, source: "test" };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "test-agent",
    name: "Test Agent",
    instructions: "",
    color: "#000",
    type: "code",
    task: "Build something",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ── CommandRunner ────────────────────────────────────────────────────────────

describe("CommandRunner", () => {
  it("refuses commands not in the whitelist", async () => {
    await withWorkspace(async (dir) => {
      const runner = new CommandRunner([makeCmd("test", ["echo", "hello"])], dir);

      await expect(runner.run("hack")).rejects.toThrow("not in the whitelist");
    });
  });

  it("reports available command ids", () => {
    const runner = new CommandRunner(
      [makeCmd("test", ["echo", "a"]), makeCmd("build", ["echo", "b"])],
      "/tmp",
    );
    expect(runner.availableIds()).toContain("test");
    expect(runner.availableIds()).toContain("build");
    expect(runner.has("test")).toBe(true);
    expect(runner.has("deploy")).toBe(false);
  });

  it("executes a passing command and returns ok=true", async () => {
    await withWorkspace(async (dir) => {
      const runner = new CommandRunner(
        [makeCmd("check", ["node", "-e", "process.exit(0)"])],
        dir,
      );
      const result = await runner.run("check");

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });
  });

  it("captures failure with ok=false and exit code", async () => {
    await withWorkspace(async (dir) => {
      const runner = new CommandRunner(
        [
          makeCmd("fail", [
            "node",
            "-e",
            "process.stderr.write('boom'); process.exit(2)",
          ]),
        ],
        dir,
      );
      const result = await runner.run("fail");

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("boom");
    });
  });

  it("detects timeout (killed process)", async () => {
    await withWorkspace(async (dir) => {
      const runner = new CommandRunner(
        [makeCmd("slow", ["node", "-e", "setTimeout(() => {}, 60000)"])],
        dir,
        500,
      );
      const result = await runner.run("slow");

      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
    });
  });

  it("runs multiple commands sequentially with runAll", async () => {
    await withWorkspace(async (dir) => {
      const runner = new CommandRunner(
        [
          makeCmd("a", ["node", "-e", "process.exit(0)"]),
          makeCmd("b", ["node", "-e", "process.exit(1)"]),
        ],
        dir,
      );
      const results = await runner.runAll(["a", "b"]);

      expect(results).toHaveLength(2);
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(false);
    });
  });

  it("skips unknown ids in runAll without throwing", async () => {
    await withWorkspace(async (dir) => {
      const runner = new CommandRunner(
        [makeCmd("a", ["node", "-e", "process.exit(0)"])],
        dir,
      );
      const results = await runner.runAll(["a", "unknown", "also-unknown"]);

      expect(results).toHaveLength(1);
      expect(results[0].command.id).toBe("a");
    });
  });

  it("deduplicates commands by id (first wins)", () => {
    const runner = new CommandRunner(
      [makeCmd("test", ["echo", "first"]), makeCmd("test", ["echo", "second"])],
      "/tmp",
    );
    expect(runner.availableIds()).toEqual(["test"]);
  });
});

// ── buildCommandDefects ──────────────────────────────────────────────────────

describe("buildCommandDefects", () => {
  it("returns no issues for passing commands", () => {
    const outcomes = [
      {
        command: makeCmd("test", ["npm", "run", "test"]),
        ok: true,
        exitCode: 0,
        stdout: "all tests passed",
        stderr: "",
        durationMs: 1200,
        timedOut: false,
      },
    ];

    const issues = buildCommandDefects(outcomes, () => "integration", [makeProject()]);
    expect(issues).toHaveLength(0);
  });

  it("attributes tsc errors to the correct agent by file path", () => {
    const outcomes = [
      {
        command: makeCmd("typecheck", ["npx", "tsc", "--noEmit"]),
        ok: false,
        exitCode: 2,
        stdout: "",
        stderr:
          "src/auth.ts(12,5): error TS2322: Type 'string' not assignable\nsrc/utils.ts(3,1): error TS2304: Cannot find name",
        durationMs: 3000,
        timedOut: false,
      },
    ];

    const fileOwner = (file: string): string => {
      if (file.includes("auth")) return "Auth Agent";
      if (file.includes("utils")) return "Utils Agent";
      return "integration";
    };

    const issues = buildCommandDefects(outcomes, fileOwner, [
      makeProject({ name: "Auth Agent" }),
      makeProject({ name: "Utils Agent" }),
    ]);

    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.some((i) => i.agent === "Auth Agent")).toBe(true);
    expect(issues.some((i) => i.agent === "Utils Agent")).toBe(true);
  });

  it("falls back to integration when no file paths are extractable", () => {
    const outcomes = [
      {
        command: makeCmd("build", ["npm", "run", "build"]),
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "FATAL ERROR: something went wrong",
        durationMs: 500,
        timedOut: false,
      },
    ];

    const issues = buildCommandDefects(outcomes, () => "integration", [
      makeProject({ name: "Builder" }),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0].agent).toBe("Builder");
    expect(issues[0].issue).toContain("build failed");
  });

  it("includes timeout info in the issue description", () => {
    const outcomes = [
      {
        command: makeCmd("test", ["npm", "test"]),
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 120000,
        timedOut: true,
      },
    ];

    const issues = buildCommandDefects(outcomes, () => "integration", [makeProject()]);

    expect(issues).toHaveLength(1);
    expect(issues[0].issue).toContain("timed out");
  });

  it("includes the command in the fix suggestion", () => {
    const outcomes = [
      {
        command: makeCmd("lint", ["npm", "run", "lint"]),
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "Too many errors",
        durationMs: 100,
        timedOut: false,
      },
    ];

    const issues = buildCommandDefects(outcomes, () => "integration", [makeProject()]);

    expect(issues[0].fix).toContain("npm run lint");
  });
});
