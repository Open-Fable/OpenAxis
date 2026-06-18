import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BackendContext, BackendResult } from "./types.js";

// Stub the concrete backends so the registry/orchestration logic in index.ts is
// exercised without touching opencode/open-design daemons or the network.
// Declared via vi.hoisted so they exist before vi.mock factories (also hoisted).
const { opencodeIsAvailable, opencodeExecute, designIsAvailable, designExecute } =
  vi.hoisted(() => ({
    opencodeIsAvailable: vi.fn<() => Promise<boolean>>(),
    opencodeExecute: vi.fn<(ctx: BackendContext) => Promise<BackendResult>>(),
    designIsAvailable: vi.fn<() => Promise<boolean>>(),
    designExecute: vi.fn<(ctx: BackendContext) => Promise<BackendResult>>(),
  }));

vi.mock("./opencode-backend.js", () => ({
  OpencodeBackend: class {
    slot = "code" as const;
    apiPort = 4096;
    isAvailable = opencodeIsAvailable;
    execute = opencodeExecute;
  },
}));

vi.mock("./design-backend.js", () => ({
  DesignBackend: class {
    slot = "design" as const;
    apiPort = 7456;
    isAvailable = designIsAvailable;
    execute = designExecute;
  },
}));

import { selectBackend, executeWithBackend, BackendUnavailableError } from "./index.js";

function makeContext(type: string | undefined): BackendContext {
  return {
    // Only `node.type` matters for routing; the rest is structurally valid filler.
    node: { type, id: "n1", name: "Node" } as BackendContext["node"],
    workspaceDir: "/tmp/ws",
    systemPrompt: "sys",
    userPrompt: "do the thing",
    onProgress: vi.fn(),
  };
}

const RESULT: BackendResult = {
  resultText: "ok",
  backend: "opencode",
  filesWritten: 3,
  writtenPaths: ["a.ts", "b.ts", "c.ts"],
};

describe("selectBackend", () => {
  it("routes code and work nodes to the opencode backend", () => {
    const code = selectBackend("code");
    const work = selectBackend("work");
    expect(code).not.toBeNull();
    expect(code?.slot).toBe("code");
    // Both slots share the same opencode backend instance.
    expect(work).toBe(code);
  });

  it("routes design nodes to the design backend", () => {
    const design = selectBackend("design");
    expect(design?.slot).toBe("design");
    expect(design?.apiPort).toBe(7456);
  });

  it("returns null for non-executing node types (recherche, verifier)", () => {
    expect(selectBackend("recherche")).toBeNull();
    expect(selectBackend("verifier")).toBeNull();
  });

  it("returns null for unknown or undefined types", () => {
    expect(selectBackend("inconnu")).toBeNull();
    expect(selectBackend(undefined)).toBeNull();
  });
});

describe("executeWithBackend", () => {
  const ensureRunning = vi.fn<(slot: "code" | "design") => Promise<number | null>>();

  beforeEach(() => {
    opencodeIsAvailable.mockReset();
    opencodeExecute.mockReset();
    designIsAvailable.mockReset();
    designExecute.mockReset();
    ensureRunning.mockReset();
  });

  it("throws BackendUnavailableError before lifecycle for an unroutable type", async () => {
    await expect(
      executeWithBackend(makeContext("verifier"), ensureRunning),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it("ensures the backend slot is running, then executes when available", async () => {
    ensureRunning.mockResolvedValue(4096);
    opencodeIsAvailable.mockResolvedValue(true);
    opencodeExecute.mockResolvedValue(RESULT);

    const result = await executeWithBackend(makeContext("code"), ensureRunning);

    expect(ensureRunning).toHaveBeenCalledWith("code");
    expect(opencodeExecute).toHaveBeenCalledTimes(1);
    expect(result).toBe(RESULT);
  });

  it("throws BackendUnavailableError when the backend reports unavailable after start", async () => {
    ensureRunning.mockResolvedValue(4096);
    opencodeIsAvailable.mockResolvedValue(false);

    await expect(
      executeWithBackend(makeContext("code"), ensureRunning),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(opencodeExecute).not.toHaveBeenCalled();
  });

  it("routes a design node through the design backend lifecycle", async () => {
    ensureRunning.mockResolvedValue(7456);
    designIsAvailable.mockResolvedValue(true);
    designExecute.mockResolvedValue({ ...RESULT, backend: "open-design" });

    const result = await executeWithBackend(makeContext("design"), ensureRunning);

    expect(ensureRunning).toHaveBeenCalledWith("design");
    expect(designExecute).toHaveBeenCalledTimes(1);
    expect(result.backend).toBe("open-design");
  });

  it("propagates an error thrown by the backend's execute()", async () => {
    ensureRunning.mockResolvedValue(4096);
    opencodeIsAvailable.mockResolvedValue(true);
    opencodeExecute.mockRejectedValue(new Error("boom"));

    await expect(executeWithBackend(makeContext("code"), ensureRunning)).rejects.toThrow(
      "boom",
    );
  });
});
