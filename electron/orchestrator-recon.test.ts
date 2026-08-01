import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectCommands, runReconnaissance } from "./orchestrator-recon.js";
import type { Project } from "./project-store.js";

async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "oh-recon-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "orch-test",
    name: "Test Orchestrator",
    instructions: "",
    color: "#000",
    type: "orchestrator",
    task: "Build something",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: "test-model",
    ...overrides,
  };
}

// ── detectCommands ───────────────────────────────────────────────────────────

describe("detectCommands", () => {
  it("detects npm scripts from package.json", async () => {
    await withWorkspace(async (dir) => {
      const pkg = {
        name: "test-project",
        scripts: {
          test: "vitest run",
          lint: "eslint .",
          build: "tsc",
          typecheck: "tsc --noEmit",
        },
      };
      await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));

      const { commands, stack } = await detectCommands(dir);

      expect(stack).toBe("node");
      expect(commands).toContainEqual(
        expect.objectContaining({ id: "test", argv: ["npm", "run", "test"] }),
      );
      expect(commands).toContainEqual(
        expect.objectContaining({ id: "lint", argv: ["npm", "run", "lint"] }),
      );
      expect(commands).toContainEqual(
        expect.objectContaining({ id: "build", argv: ["npm", "run", "build"] }),
      );
      expect(commands).toContainEqual(
        expect.objectContaining({ id: "typecheck", argv: ["npm", "run", "typecheck"] }),
      );
    });
  });

  it("infers typecheck from typescript devDependency when no script exists", async () => {
    await withWorkspace(async (dir) => {
      const pkg = {
        name: "ts-project",
        scripts: { test: "jest" },
        devDependencies: { typescript: "^5.0.0" },
      };
      await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));

      const { commands } = await detectCommands(dir);

      expect(commands).toContainEqual(
        expect.objectContaining({
          id: "typecheck",
          argv: ["./node_modules/.bin/tsc", "--noEmit"],
        }),
      );
    });
  });

  it("detects Cargo.toml commands", async () => {
    await withWorkspace(async (dir) => {
      await fs.writeFile(path.join(dir, "Cargo.toml"), '[package]\nname = "myapp"\n');

      const { commands, stack } = await detectCommands(dir);

      expect(stack).toBe("rust");
      expect(commands.some((c) => c.id === "build")).toBe(true);
      expect(commands.some((c) => c.id === "test")).toBe(true);
      expect(commands.some((c) => c.id === "lint")).toBe(true);
    });
  });

  it("detects Makefile commands", async () => {
    await withWorkspace(async (dir) => {
      await fs.writeFile(path.join(dir, "Makefile"), "all:\n\techo hello\n");

      const { commands, stack } = await detectCommands(dir);

      expect(stack).toBe("make");
      expect(commands.some((c) => c.id === "build")).toBe(true);
      expect(commands.some((c) => c.id === "test")).toBe(true);
    });
  });

  it("detects pyproject.toml commands", async () => {
    await withWorkspace(async (dir) => {
      await fs.writeFile(
        path.join(dir, "pyproject.toml"),
        "[tool.ruff]\nline-length = 88\n",
      );

      const { commands, stack } = await detectCommands(dir);

      expect(stack).toBe("python");
      expect(commands.some((c) => c.id === "test")).toBe(true);
      // TOML is not JSON-parseable, so ruff detection via manifest won't trigger
      // lint command would require a JSON-compatible manifest or a TOML parser
    });
  });

  it("returns unknown stack and empty commands for empty workspace", async () => {
    await withWorkspace(async (dir) => {
      const { commands, stack } = await detectCommands(dir);
      expect(stack).toBe("unknown");
      expect(commands).toHaveLength(0);
    });
  });

  it("handles invalid JSON in package.json gracefully", async () => {
    await withWorkspace(async (dir) => {
      await fs.writeFile(path.join(dir, "package.json"), "NOT JSON {{{");

      const { commands, stack } = await detectCommands(dir);

      expect(stack).toBe("node");
      expect(commands).toHaveLength(0);
    });
  });

  it("produces no shell metacharacters in argv", async () => {
    await withWorkspace(async (dir) => {
      const pkg = {
        name: "test",
        scripts: { test: "vitest", build: "tsc" },
      };
      await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));

      const { commands } = await detectCommands(dir);
      const shellChars = /[;|&$`\\><(){}!]/;
      for (const cmd of commands) {
        for (const arg of cmd.argv) {
          expect(arg).not.toMatch(shellChars);
        }
      }
    });
  });

  it("detects multiple stacks (node + make)", async () => {
    await withWorkspace(async (dir) => {
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "dual", scripts: { test: "jest" } }),
      );
      await fs.writeFile(path.join(dir, "Makefile"), "all:\n\techo ok\n");

      const { stack } = await detectCommands(dir);
      expect(stack).toContain("node");
      expect(stack).toContain("make");
    });
  });
});

// ── runReconnaissance ────────────────────────────────────────────────────────

const fetchMock = vi.fn();

describe("runReconnaissance", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("produces a deterministic context when LLM succeeds", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "tc_1",
                  type: "function",
                  function: {
                    name: "report_mission_context",
                    arguments: JSON.stringify({
                      summary: "A Node.js web app with Express",
                      conventions: "camelCase, ESM imports",
                      relevant_files: ["src/index.ts", "package.json"],
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    });

    await withWorkspace(async (dir) => {
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "my-app", scripts: { test: "vitest" } }),
      );
      await fs.mkdir(path.join(dir, "src"));
      await fs.writeFile(path.join(dir, "src", "index.ts"), "export const x = 1;");

      const result = await runReconnaissance(dir, "Add auth", makeProject());

      expect(result.isBrownfield).toBe(true);
      expect(result.stack).toBe("node");
      expect(result.commands.some((c) => c.id === "test")).toBe(true);
      expect(result.missionContext).toContain("brownfield");
      expect(result.missionContext).toContain("Analysis");
      expect(result.missionContext).toContain("A Node.js web app");

      const written = await fs.readFile(path.join(dir, "MISSION_CONTEXT.md"), "utf-8");
      expect(written).toBe(result.missionContext);
    });
  });

  it("falls back to deterministic context when LLM fails", async () => {
    fetchMock.mockRejectedValue(new Error("Network error"));

    await withWorkspace(async (dir) => {
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "app", scripts: { build: "tsc" } }),
      );

      const result = await runReconnaissance(dir, "Fix bug", makeProject());

      expect(result.isBrownfield).toBe(true);
      expect(result.stack).toBe("node");
      expect(result.missionContext).toContain("brownfield");
      expect(result.missionContext).toContain("build");
      expect(result.missionContext).not.toContain("Analysis");
    });
  });

  it("detects greenfield (empty workspace)", async () => {
    fetchMock.mockRejectedValue(new Error("skip"));

    await withWorkspace(async (dir) => {
      const result = await runReconnaissance(dir, "Create app", makeProject());
      expect(result.isBrownfield).toBe(false);
      expect(result.stack).toBe("unknown");
      expect(result.commands).toHaveLength(0);
      expect(result.missionContext).toContain("greenfield");
    });
  });

  it("reads README when available", async () => {
    fetchMock.mockRejectedValue(new Error("skip"));

    await withWorkspace(async (dir) => {
      await fs.writeFile(path.join(dir, "README.md"), "# My Project\nThis is a test.");

      const result = await runReconnaissance(dir, "Explore", makeProject());
      expect(result.missionContext).toContain("My Project");
    });
  });

  it("handles LLM returning empty/malformed JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: "I cannot use tools",
            },
            finish_reason: "stop",
          },
        ],
      }),
    });

    await withWorkspace(async (dir) => {
      await fs.writeFile(path.join(dir, "Cargo.toml"), '[package]\nname = "test"\n');

      const result = await runReconnaissance(dir, "Build it", makeProject());
      expect(result.stack).toBe("rust");
      expect(result.missionContext).toContain("Detected stack: rust");
    });
  });
});
