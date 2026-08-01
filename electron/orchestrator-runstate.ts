import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { ChecksMap } from "./orchestrator-quality.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PersistedRunState {
  readonly runId: string;
  readonly orchestratorId: string;
  readonly task: string;
  readonly workspaceDir: string;
  readonly workflowName?: string;
  readonly missionBranch?: string;
  readonly plan: {
    readonly tasksMap: Readonly<Record<string, string>>;
    readonly expectedFilesMap: Readonly<Record<string, readonly string[]>>;
    readonly checksMap: ChecksMap;
    readonly agentIds: readonly string[];
  };
  readonly nodeStatuses: Readonly<Record<string, NodePersistStatus>>;
  readonly nodeResults: Readonly<Record<string, string>>;
  readonly fileOwner: Readonly<Record<string, string>>;
  readonly lastCheckpointSha?: string;
  readonly updatedAt: string;
}

export type NodePersistStatus = "pending" | "running" | "done" | "error" | "skipped";

// ── Paths ────────────────────────────────────────────────────────────────────

const STATE_DIR = path.join(homedir(), ".config", "openaxis", "orch-state");

function stateFilePath(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(STATE_DIR, `${safe}.json`);
}

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

// ── Write (atomic: tmp + rename) ─────────────────────────────────────────────

export async function writeRunState(state: PersistedRunState): Promise<void> {
  await ensureStateDir();
  const filePath = stateFilePath(state.runId);
  const tmpPath = filePath + ".tmp." + randomBytes(4).toString("hex");
  const stamped = { ...state, updatedAt: new Date().toISOString() };
  await fs.writeFile(tmpPath, JSON.stringify(stamped, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ── Read latest resumable ────────────────────────────────────────────────────

export async function readLatestResumable(
  orchestratorId: string,
): Promise<PersistedRunState | null> {
  try {
    await ensureStateDir();
    const files = await fs.readdir(STATE_DIR);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    if (jsonFiles.length === 0) return null;

    let latest: PersistedRunState | null = null;
    let latestTime = 0;

    for (const file of jsonFiles) {
      try {
        const content = await fs.readFile(path.join(STATE_DIR, file), "utf-8");
        const parsed = JSON.parse(content) as PersistedRunState;
        if (parsed.orchestratorId !== orchestratorId) continue;

        const hasIncomplete = Object.values(parsed.nodeStatuses).some(
          (s) => s === "pending" || s === "running",
        );
        if (!hasIncomplete) continue;

        const time = new Date(parsed.updatedAt).getTime();
        if (time > latestTime) {
          latestTime = time;
          latest = parsed;
        }
      } catch {
        continue;
      }
    }

    return latest;
  } catch {
    return null;
  }
}

// ── Read by ID ──────────────────────────────────────────────────────────────

export async function readRunState(runId: string): Promise<PersistedRunState | null> {
  try {
    const content = await fs.readFile(stateFilePath(runId), "utf-8");
    return JSON.parse(content) as PersistedRunState;
  } catch {
    return null;
  }
}

// ── Clear (run completed — no longer resumable) ──────────────────────────────

export async function clearRunState(runId: string): Promise<void> {
  try {
    await fs.unlink(stateFilePath(runId));
  } catch {
    // already gone or never written
  }
}

// ── Helpers for building state snapshots ─────────────────────────────────────

export function buildInitialRunState(
  runId: string,
  orchestratorId: string,
  task: string,
  workspaceDir: string,
  agentIds: readonly string[],
  tasksMap: Readonly<Record<string, string>>,
  expectedFilesMap: Readonly<Record<string, readonly string[]>>,
  checksMap: ChecksMap,
  missionBranch?: string,
  workflowName?: string,
): PersistedRunState {
  const nodeStatuses: Record<string, NodePersistStatus> = {};
  for (const id of agentIds) {
    nodeStatuses[id] = "pending";
  }

  return {
    runId,
    orchestratorId,
    task,
    workspaceDir,
    workflowName,
    missionBranch,
    plan: {
      tasksMap,
      expectedFilesMap,
      checksMap,
      agentIds,
    },
    nodeStatuses,
    nodeResults: {},
    fileOwner: {},
    updatedAt: new Date().toISOString(),
  };
}

export function updateNodeInState(
  state: PersistedRunState,
  nodeId: string,
  status: NodePersistStatus,
  result?: string,
  fileOwnerUpdates?: Readonly<Record<string, string>>,
  checkpointSha?: string,
): PersistedRunState {
  const truncatedResult = result ? result.substring(0, 4096) : undefined;

  return {
    ...state,
    nodeStatuses: { ...state.nodeStatuses, [nodeId]: status },
    nodeResults: truncatedResult
      ? { ...state.nodeResults, [nodeId]: truncatedResult }
      : state.nodeResults,
    fileOwner: fileOwnerUpdates
      ? { ...state.fileOwner, ...fileOwnerUpdates }
      : state.fileOwner,
    lastCheckpointSha: checkpointSha ?? state.lastCheckpointSha,
    updatedAt: new Date().toISOString(),
  };
}
