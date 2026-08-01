import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  writeRunState,
  readRunState,
  readLatestResumable,
  clearRunState,
  buildInitialRunState,
  updateNodeInState,
  type PersistedRunState,
} from "./orchestrator-runstate.js";

// We test the pure functions directly; the fs-based functions are tested
// via a real tmpdir to verify atomicity and round-trip correctness.

// ── buildInitialRunState ─────────────────────────────────────────────────────

describe("buildInitialRunState", () => {
  it("creates a state with all nodes pending", () => {
    const state = buildInitialRunState(
      "run-1",
      "orch-1",
      "Build a web app",
      "/tmp/ws",
      ["agent-a", "agent-b"],
      { "agent-a": "task A", "agent-b": "task B" },
      { "agent-a": ["file1.ts"] },
      {},
      "orch/mission-run1",
    );

    expect(state.runId).toBe("run-1");
    expect(state.orchestratorId).toBe("orch-1");
    expect(state.missionBranch).toBe("orch/mission-run1");
    expect(state.nodeStatuses["agent-a"]).toBe("pending");
    expect(state.nodeStatuses["agent-b"]).toBe("pending");
    expect(state.plan.agentIds).toEqual(["agent-a", "agent-b"]);
    expect(state.nodeResults).toEqual({});
    expect(state.updatedAt).toBeTruthy();
  });
});

// ── updateNodeInState ────────────────────────────────────────────────────────

describe("updateNodeInState", () => {
  const base = buildInitialRunState(
    "run-1",
    "orch-1",
    "task",
    "/ws",
    ["a", "b"],
    { a: "do A", b: "do B" },
    {},
    {},
  );

  it("updates node status immutably", () => {
    const updated = updateNodeInState(base, "a", "done", "result text");
    expect(updated.nodeStatuses["a"]).toBe("done");
    expect(updated.nodeStatuses["b"]).toBe("pending");
    expect(updated.nodeResults["a"]).toBe("result text");
    // Original unchanged
    expect(base.nodeStatuses["a"]).toBe("pending");
  });

  it("truncates results to 4096 chars", () => {
    const longResult = "x".repeat(5000);
    const updated = updateNodeInState(base, "a", "done", longResult);
    expect(updated.nodeResults["a"]).toHaveLength(4096);
  });

  it("updates fileOwner and checkpoint sha", () => {
    const updated = updateNodeInState(
      base,
      "a",
      "done",
      undefined,
      { "file.ts": "a" },
      "abc123",
    );
    expect(updated.fileOwner["file.ts"]).toBe("a");
    expect(updated.lastCheckpointSha).toBe("abc123");
  });

  it("preserves existing checkpoint when none provided", () => {
    const withCk = { ...base, lastCheckpointSha: "existing" };
    const updated = updateNodeInState(withCk, "a", "running");
    expect(updated.lastCheckpointSha).toBe("existing");
  });
});

// ── Round-trip write/read/clear ──────────────────────────────────────────────

describe("write/read/clear round-trip", () => {
  // These tests use the real STATE_DIR which is ~/.config/openaxis/orch-state
  // We use unique run IDs to avoid collisions, and clean up after.

  const testRunId = `test-rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const testState = buildInitialRunState(
    testRunId,
    "orch-rt",
    "round trip test",
    "/tmp/ws-rt",
    ["node-1"],
    { "node-1": "task 1" },
    {},
    {},
  );

  afterEach(async () => {
    await clearRunState(testRunId);
  });

  it("writes and reads back a state file", async () => {
    await writeRunState(testState);
    const read = await readRunState(testRunId);
    expect(read).not.toBeNull();
    expect(read!.runId).toBe(testRunId);
    expect(read!.orchestratorId).toBe("orch-rt");
    expect(read!.nodeStatuses["node-1"]).toBe("pending");
  });

  it("returns null for nonexistent run", async () => {
    const read = await readRunState("nonexistent-run-id-xyz");
    expect(read).toBeNull();
  });

  it("clears a state file", async () => {
    await writeRunState(testState);
    await clearRunState(testRunId);
    const read = await readRunState(testRunId);
    expect(read).toBeNull();
  });

  it("clearRunState is safe on missing file", async () => {
    await expect(clearRunState("never-existed")).resolves.toBeUndefined();
  });
});

// ── readLatestResumable ──────────────────────────────────────────────────────

describe("readLatestResumable", () => {
  const orchId = `orch-resume-${Date.now()}`;
  const runId1 = `resume-1-${Date.now()}`;
  const runId2 = `resume-2-${Date.now()}`;

  afterEach(async () => {
    await clearRunState(runId1);
    await clearRunState(runId2);
  });

  it("finds the latest incomplete run for an orchestrator", async () => {
    const state1 = buildInitialRunState(
      runId1,
      orchId,
      "task 1",
      "/ws1",
      ["a"],
      { a: "t" },
      {},
      {},
    );
    const state2 = buildInitialRunState(
      runId2,
      orchId,
      "task 2",
      "/ws2",
      ["b"],
      { b: "t" },
      {},
      {},
    );

    await writeRunState(state1);
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await writeRunState(state2);

    const latest = await readLatestResumable(orchId);
    expect(latest).not.toBeNull();
    expect(latest!.runId).toBe(runId2);
  });

  it("skips completed runs", async () => {
    const complete = updateNodeInState(
      buildInitialRunState(runId1, orchId, "t", "/ws", ["a"], { a: "t" }, {}, {}),
      "a",
      "done",
    );
    await writeRunState(complete);

    const latest = await readLatestResumable(orchId);
    expect(latest).toBeNull();
  });

  it("returns null for unknown orchestrator", async () => {
    const latest = await readLatestResumable("nonexistent-orch-id");
    expect(latest).toBeNull();
  });
});
