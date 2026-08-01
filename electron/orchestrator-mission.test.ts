import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import path from "node:path";
import {
  beginMission,
  commitCheckpoint,
  endMission,
  createScratchMissionState,
  listPreexistingFiles,
  findUndeclaredDiffFiles,
} from "./orchestrator-mission.js";

function gitSync(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args as string[], { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

async function withCleanRepo<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "oh-mission-"));
  try {
    await gitSync(["init", "-q"], dir);
    await gitSync(["config", "user.email", "test@test.local"], dir);
    await gitSync(["config", "user.name", "Test"], dir);
    await fs.writeFile(path.join(dir, "existing.ts"), "export const x = 1;");
    await fs.writeFile(path.join(dir, "README.md"), "# Test");
    await gitSync(["add", "-A"], dir);
    await gitSync(["commit", "-q", "-m", "initial"], dir);
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── beginMission ─────────────────────────────────────────────────────────────

describe("beginMission", () => {
  it("creates a branch and returns brownfield state", async () => {
    await withCleanRepo(async (dir) => {
      const state = await beginMission(dir, "test-run-123");

      expect(state.mode).toBe("brownfield");
      expect(state.branch).toMatch(/^orch\/mission-/);
      expect(state.baselineRef).toBeTruthy();
      expect(state.checkpoints).toHaveLength(0);

      const currentBranch = (
        await gitSync(["rev-parse", "--abbrev-ref", "HEAD"], dir)
      ).trim();
      expect(currentBranch).toBe(state.branch);
    });
  });

  it("rejects a dirty repo", async () => {
    await withCleanRepo(async (dir) => {
      await fs.writeFile(path.join(dir, "dirty.txt"), "uncommitted");
      await expect(beginMission(dir, "run1")).rejects.toThrow("uncommitted");
    });
  });

  it("rejects a non-git directory", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "oh-nogit-"));
    try {
      await expect(beginMission(dir, "run1")).rejects.toThrow("not a git repository");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects forbidden system roots", async () => {
    await expect(beginMission("/", "run1")).rejects.toThrow("system-protected");
    await expect(beginMission("/usr", "run1")).rejects.toThrow("system-protected");
  });

  it("writes .git/info/exclude entries", async () => {
    await withCleanRepo(async (dir) => {
      await beginMission(dir, "run-exclude");
      const exclude = await fs.readFile(
        path.join(dir, ".git", "info", "exclude"),
        "utf-8",
      );
      expect(exclude).toContain("MISSION_CONTEXT.md");
      expect(exclude).toContain("WORKSPACE_INDEX.md");
      expect(exclude).toContain("reports/");
    });
  });
});

// ── commitCheckpoint ─────────────────────────────────────────────────────────

describe("commitCheckpoint", () => {
  it("creates a commit and returns updated state with new checkpoint", async () => {
    await withCleanRepo(async (dir) => {
      const state = await beginMission(dir, "ck-run");
      await fs.writeFile(path.join(dir, "new-file.ts"), "export const y = 2;");

      const updated = await commitCheckpoint(state, "wave-1", ["agent-a"]);

      expect(updated.checkpoints).toHaveLength(1);
      expect(updated.checkpoints[0]).toMatch(/^[0-9a-f]+$/);

      const log = await gitSync(["log", "--oneline", "-1"], dir);
      expect(log).toContain("orch checkpoint: wave-1");
    });
  });

  it("is a no-op when the tree is clean", async () => {
    await withCleanRepo(async (dir) => {
      const state = await beginMission(dir, "ck-clean");
      const updated = await commitCheckpoint(state, "clean", []);

      expect(updated.checkpoints).toHaveLength(0);
    });
  });

  it("is a no-op in scratch mode", async () => {
    const state = createScratchMissionState("s-1", "/tmp/fake");
    const updated = await commitCheckpoint(state, "test", []);
    expect(updated.checkpoints).toHaveLength(0);
  });
});

// ── listPreexistingFiles / findUndeclaredDiffFiles ───────────────────────────

describe("diff contract", () => {
  it("lists preexisting files from baseline", async () => {
    await withCleanRepo(async (dir) => {
      const state = await beginMission(dir, "diff-test");
      const files = await listPreexistingFiles(dir, state.baselineRef!);

      expect(files.has("existing.ts")).toBe(true);
      expect(files.has("README.md")).toBe(true);
      expect(files.has("nonexistent.ts")).toBe(false);
    });
  });

  it("detects undeclared file modifications", async () => {
    await withCleanRepo(async (dir) => {
      const state = await beginMission(dir, "diff-undecl");

      await fs.writeFile(path.join(dir, "existing.ts"), "modified content");
      await fs.writeFile(path.join(dir, "new-agent-file.ts"), "new file");
      await gitSync(["add", "-A"], dir);
      await gitSync(["commit", "-q", "-m", "agent work"], dir);

      const declared = new Set(["new-agent-file.ts"]);
      const undeclared = await findUndeclaredDiffFiles(dir, state.baselineRef!, declared);

      expect(undeclared).toContain("existing.ts");
      expect(undeclared).not.toContain("new-agent-file.ts");
    });
  });

  it("returns empty when all changes are declared", async () => {
    await withCleanRepo(async (dir) => {
      const state = await beginMission(dir, "diff-ok");

      await fs.writeFile(path.join(dir, "existing.ts"), "fixed content");
      await gitSync(["add", "-A"], dir);
      await gitSync(["commit", "-q", "-m", "fix"], dir);

      const declared = new Set(["existing.ts"]);
      const undeclared = await findUndeclaredDiffFiles(dir, state.baselineRef!, declared);

      expect(undeclared).toHaveLength(0);
    });
  });
});

// ── endMission ───────────────────────────────────────────────────────────────

describe("endMission", () => {
  it("writes a mission report and commits it", async () => {
    await withCleanRepo(async (dir) => {
      const state = await beginMission(dir, "end-run");
      await fs.writeFile(path.join(dir, "output.ts"), "export const z = 3;");
      await gitSync(["add", "-A"], dir);
      await gitSync(["commit", "-q", "-m", "agent output"], dir);

      const reportPath = await endMission(state, true);

      expect(reportPath).toContain("MISSION_REPORT.md");
      const report = await fs.readFile(reportPath, "utf-8");
      expect(report).toContain("Mission Report");
      expect(report).toContain("PASS");
      expect(report).toContain(state.branch!);

      const log = await gitSync(["log", "--oneline", "-1"], dir);
      expect(log).toContain("mission report");
    });
  });

  it("marks FAIL in the report when gate failed", async () => {
    await withCleanRepo(async (dir) => {
      const state = await beginMission(dir, "fail-run");
      const reportPath = await endMission(state, false);
      const report = await fs.readFile(reportPath, "utf-8");
      expect(report).toContain("FAIL");
    });
  });
});

// ── createScratchMissionState ────────────────────────────────────────────────

describe("createScratchMissionState", () => {
  it("creates a scratch state with no git fields", () => {
    const state = createScratchMissionState("s-1", "/tmp/workspace");
    expect(state.mode).toBe("scratch");
    expect(state.branch).toBeUndefined();
    expect(state.baselineRef).toBeUndefined();
    expect(state.checkpoints).toHaveLength(0);
  });
});
