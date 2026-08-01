import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCallLLMStructured = vi.fn();
vi.mock("./orchestrator-llm.js", () => ({
  callLLMStructured: (...args: unknown[]) => mockCallLLMStructured(...args),
}));

const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { reviewRunDiff, getRunDiff } from "./orchestrator-diffreview.js";

const fakeOrch = {
  id: "orch-1",
  name: "Orchestrator",
  instructions: "",
  color: "#000",
  type: "orchestrator" as const,
  createdAt: 0,
  updatedAt: 0,
};

describe("getRunDiff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns diff output from git", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "diff --git a/file.ts b/file.ts\n+added line", "");
      },
    );

    const diff = await getRunDiff("/ws", "abc123");
    expect(diff).toContain("diff --git");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["diff", "abc123..HEAD"]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns empty string on git error", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("not a git repo"), "", "");
      },
    );

    const diff = await getRunDiff("/ws", "abc123");
    expect(diff).toBe("");
  });

  it("rejects non-SHA baselineRef", async () => {
    const diff = await getRunDiff("/ws", "$(whoami)");
    expect(diff).toBe("");
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe("reviewRunDiff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty issues when no diff", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "", "");
      },
    );

    const result = await reviewRunDiff(
      "/ws",
      "abc123",
      "build app",
      () => "agent-1",
      fakeOrch,
    );
    expect(result.issues).toHaveLength(0);
    expect(result.reviewSummary).toContain("No diff");
  });

  it("routes critical issues to agents", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "diff --git a/file.ts\n+code", "");
      },
    );

    mockCallLLMStructured.mockResolvedValue(
      JSON.stringify({
        summary: "Found a bug",
        issues: [
          {
            file: "src/api.ts",
            issue: "SQL injection",
            severity: "critical",
            fix: "Use parameterized queries",
          },
          {
            file: "src/utils.ts",
            issue: "Minor style",
            severity: "low",
            fix: "Rename variable",
          },
        ],
      }),
    );

    const result = await reviewRunDiff(
      "/ws",
      "abc123",
      "build app",
      (f) => (f === "src/api.ts" ? "agent-api" : "agent-utils"),
      fakeOrch,
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].agent).toBe("agent-api");
    expect(result.issues[0].issue).toContain("SQL injection");
    expect(result.reviewSummary).toBe("Found a bug");
  });

  it("handles LLM failure gracefully", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "diff output", "");
      },
    );

    mockCallLLMStructured.mockRejectedValue(new Error("LLM timeout"));

    const result = await reviewRunDiff(
      "/ws",
      "abc123",
      "build app",
      () => "agent-1",
      fakeOrch,
    );
    expect(result.issues).toHaveLength(0);
    expect(result.reviewSummary).toContain("failed");
  });

  it("includes high severity issues", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "diff", "");
      },
    );

    mockCallLLMStructured.mockResolvedValue(
      JSON.stringify({
        summary: "Issues found",
        issues: [
          { file: "a.ts", issue: "Race condition", severity: "high", fix: "Add lock" },
          { file: "b.ts", issue: "Naming", severity: "medium", fix: "Rename" },
        ],
      }),
    );

    const result = await reviewRunDiff(
      "/ws",
      "abc123",
      "task",
      () => "agent-1",
      fakeOrch,
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].issue).toContain("Race condition");
  });
});
