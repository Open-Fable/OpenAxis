import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runNodeGate,
  buildNodeGateFeedback,
  MAX_NODE_GATE_RETRIES,
  type NodeGateResult,
} from "./orchestrator-nodegate.js";

const mockCheckExpectedFiles = vi.fn();
vi.mock("./orchestrator-quality.js", () => ({
  checkExpectedFiles: (...args: unknown[]) => mockCheckExpectedFiles(...args),
}));

const mockBuildCommandDefects = vi.fn();
vi.mock("./orchestrator-commands.js", () => ({
  buildCommandDefects: (...args: unknown[]) => mockBuildCommandDefects(...args),
}));

const fakeNode = {
  id: "agent-code",
  name: "Code Agent",
  instructions: "",
  color: "#000",
  type: "code" as const,
  createdAt: 0,
  updatedAt: 0,
};

describe("runNodeGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckExpectedFiles.mockResolvedValue({ present: [], missing: [] });
    mockBuildCommandDefects.mockReturnValue([]);
  });

  it("passes when no issues", async () => {
    const result = await runNodeGate(
      fakeNode,
      "/ws",
      null,
      ["file.ts"],
      () => "agent-code",
      [fakeNode],
    );
    expect(result.pass).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("fails when expected files are missing", async () => {
    mockCheckExpectedFiles.mockResolvedValue({
      present: [],
      missing: ["missing.ts"],
    });

    const result = await runNodeGate(
      fakeNode,
      "/ws",
      null,
      ["missing.ts"],
      () => "agent-code",
      [fakeNode],
    );
    expect(result.pass).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].issue).toContain("missing.ts");
  });

  it("runs commands when runner is provided", async () => {
    const fakeRunner = {
      has: vi.fn((id: string) => id === "typecheck"),
      run: vi.fn().mockResolvedValue({
        command: "typecheck",
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "error TS2345",
        durationMs: 100,
        timedOut: false,
      }),
      availableIds: vi.fn(() => ["typecheck"]),
      runAll: vi.fn(),
    };

    mockBuildCommandDefects.mockReturnValue([
      { agent: "agent-code", issue: "TS error", fix: "Fix the type" },
    ]);

    const result = await runNodeGate(
      fakeNode,
      "/ws",
      fakeRunner as any,
      [],
      () => "agent-code",
      [fakeNode],
    );
    expect(result.pass).toBe(false);
    expect(result.commandOutcomes).toHaveLength(1);
    expect(fakeRunner.run).toHaveBeenCalledWith("typecheck", undefined);
  });

  it("skips commands not in whitelist", async () => {
    const fakeRunner = {
      has: vi.fn(() => false),
      run: vi.fn(),
      availableIds: vi.fn(() => []),
      runAll: vi.fn(),
    };

    const result = await runNodeGate(
      fakeNode,
      "/ws",
      fakeRunner as any,
      [],
      () => "agent-code",
      [fakeNode],
    );
    expect(result.pass).toBe(true);
    expect(fakeRunner.run).not.toHaveBeenCalled();
  });
});

describe("buildNodeGateFeedback", () => {
  it("returns empty string on pass", () => {
    const result: NodeGateResult = { pass: true, issues: [], commandOutcomes: [] };
    expect(buildNodeGateFeedback("Agent", result)).toBe("");
  });

  it("includes issue details on failure", () => {
    const result: NodeGateResult = {
      pass: false,
      issues: [{ agent: "a", issue: "file missing", fix: "create it" }],
      commandOutcomes: [],
    };
    const feedback = buildNodeGateFeedback("Code Agent", result);
    expect(feedback).toContain("Code Agent");
    expect(feedback).toContain("file missing");
    expect(feedback).toContain("create it");
  });

  it("includes command stderr on failure", () => {
    const result: NodeGateResult = {
      pass: false,
      issues: [],
      commandOutcomes: [
        {
          command: { id: "typecheck", argv: ["tsc", "--noEmit"], source: "package.json" },
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "error TS2345: something wrong",
          durationMs: 50,
          timedOut: false,
        },
      ],
    };
    const feedback = buildNodeGateFeedback("Agent", result);
    expect(feedback).toContain("typecheck");
    expect(feedback).toContain("tsc --noEmit");
    expect(feedback).toContain("TS2345");
  });
});

describe("MAX_NODE_GATE_RETRIES", () => {
  it("is 2", () => {
    expect(MAX_NODE_GATE_RETRIES).toBe(2);
  });
});
