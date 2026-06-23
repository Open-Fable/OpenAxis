import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { INITIAL_PROJECTS } from "./project-seed.js";

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly color: string;
  readonly type?: "code" | "design" | "work" | "orchestrator" | "verifier" | "recherche";
  readonly path?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly linked?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly orchSettings?: {
    readonly autoDistribute: boolean;
    readonly checkCoherence: boolean;
    readonly relaunchOnError: boolean;
    readonly adaptToWeakModel?: boolean;
    // Independent nodes in the same DAG wave run concurrently (pure-LLM lane).
    // Clamped to [1, MAX_PARALLEL_NODES_CAP]; 1 = legacy strictly-sequential.
    readonly maxParallelNodes?: number;
  };
  readonly bypassMemory?: boolean;
  readonly maxRetries?: number;
  readonly x?: number;
  readonly y?: number;
  readonly task?: string;
  readonly steps?: readonly string[];
  readonly autoSteps?: boolean;
  readonly pinned?: boolean;
  readonly folder?: string;
  readonly archived?: boolean;
  readonly generated?: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly orchProjectId: string;
  readonly linkedProjectIds: readonly string[];
  readonly agentTypes: Record<string, string>;
  readonly workDir?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Folder {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly createdAt: number;
}

interface ProjectStoreData {
  readonly projects: readonly Project[];
  readonly workflows: readonly Workflow[];
  readonly folders: readonly Folder[];
  readonly activeProjectId: string | null;
}

const STORE_DIR = path.join(homedir(), ".config", "openaxis");
const STORE_PATH = path.join(STORE_DIR, "projects.json");

const DEFAULT_COLORS = [
  "#7c5cfc",
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#8b5cf6",
  "#06b6d4",
];

let cache: ProjectStoreData | null = null;

async function ensureDir(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
}

async function load(): Promise<ProjectStoreData> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProjectStoreData>;
    // Defensive normalization: coerce the top-level collections to arrays so a
    // hand-edited or corrupted file can't cause type-confusion crashes downstream.
    cache = {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      workflows: Array.isArray(parsed.workflows) ? parsed.workflows : [],
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      activeProjectId:
        typeof parsed.activeProjectId === "string" ? parsed.activeProjectId : null,
    };
    return cache;
  } catch {
    const defaultWorkflow: Workflow = {
      id: "wf-default",
      name: "Refonte onboarding",
      orchProjectId: "p4",
      linkedProjectIds: ["p1", "p2", "p3", "p5"],
      agentTypes: { p1: "code", p2: "design", p3: "work", p5: "code" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    cache = {
      projects: INITIAL_PROJECTS,
      workflows: [defaultWorkflow],
      folders: [],
      activeProjectId: "p4",
    };
    await save(cache);
    return cache;
  }
}

async function save(data: ProjectStoreData): Promise<void> {
  await ensureDir();
  const tmpPath = STORE_PATH + ".tmp." + randomBytes(4).toString("hex");
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmpPath, STORE_PATH);
  cache = data;
}

// Serializes load→modify→save sequences so concurrent mutators cannot read the same
// cache and clobber each other's writes (lost-update race).
let writeLock: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeLock.then(fn, fn);
  writeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function invalidateCache(): void {
  cache = null;
}

export async function getProjects(): Promise<readonly Project[]> {
  const data = await load();
  return data.projects;
}

export async function getActiveProjectId(): Promise<string | null> {
  const data = await load();
  return data.activeProjectId;
}

export async function getActiveProject(): Promise<Project | null> {
  const data = await load();
  if (!data.activeProjectId) return null;
  return data.projects.find((p) => p.id === data.activeProjectId) ?? null;
}

export async function getProjectById(id: string): Promise<Project | null> {
  const data = await load();
  return data.projects.find((p) => p.id === id) ?? null;
}

export async function saveProject(
  project: Partial<Omit<Project, "createdAt" | "updatedAt">> & {
    name: string;
    id?: string;
  },
): Promise<Project> {
  return withWriteLock(async () => {
    const data = await load();
    const now = Date.now();
    const existing = project.id ? data.projects.find((p) => p.id === project.id) : null;

    if (existing) {
      const updated: Project = {
        ...existing,
        name: project.name,
        instructions: project.instructions ?? existing.instructions ?? "",
        color: project.color ?? existing.color ?? "",
        type: project.type ?? existing.type,
        path: project.path ?? existing.path,
        model: project.model ?? existing.model,
        reasoningEffort: project.reasoningEffort ?? existing.reasoningEffort,
        linked: project.linked ?? existing.linked,
        dependencies: project.dependencies ?? existing.dependencies,
        orchSettings: project.orchSettings ?? existing.orchSettings,
        bypassMemory: project.bypassMemory ?? existing.bypassMemory,
        maxRetries: project.maxRetries ?? existing.maxRetries,
        x: project.x ?? existing.x,
        y: project.y ?? existing.y,
        task: project.task ?? existing.task,
        steps: project.steps ?? existing.steps,
        autoSteps: project.autoSteps ?? existing.autoSteps,
        pinned: project.pinned ?? existing.pinned,
        folder: project.folder ?? existing.folder,
        archived: project.archived ?? existing.archived,
        generated: project.generated ?? existing.generated,
        updatedAt: now,
      };
      await save({
        ...data,
        projects: data.projects.map((p) => (p.id === updated.id ? updated : p)),
      });
      return updated;
    }

    const created: Project = {
      id: project.id || randomBytes(8).toString("hex"),
      name: project.name,
      instructions: project.instructions || "",
      color:
        project.color || DEFAULT_COLORS[data.projects.length % DEFAULT_COLORS.length],
      type: project.type,
      path: project.path,
      model: project.model,
      reasoningEffort: project.reasoningEffort,
      linked: project.linked || [],
      dependencies: project.dependencies || [],
      orchSettings: project.orchSettings,
      bypassMemory: project.bypassMemory,
      maxRetries: project.maxRetries,
      x: project.x,
      y: project.y,
      task: project.task || "",
      steps: project.steps || [],
      autoSteps: project.autoSteps,
      pinned: project.pinned,
      folder: project.folder,
      archived: project.archived,
      generated: project.generated,
      createdAt: now,
      updatedAt: now,
    };
    await save({
      ...data,
      projects: [...data.projects, created],
    });
    return created;
  });
}

export async function deleteProject(id: string): Promise<void> {
  return withWriteLock(async () => {
    const data = await load();
    const nextActive = data.activeProjectId === id ? null : data.activeProjectId;
    await save({
      ...data,
      projects: data.projects.filter((p) => p.id !== id),
      activeProjectId: nextActive,
    });
  });
}

export async function setActiveProject(id: string | null): Promise<void> {
  return withWriteLock(async () => {
    const data = await load();
    if (id && !data.projects.some((p) => p.id === id)) return;
    await save({ ...data, activeProjectId: id, workflows: data.workflows });
  });
}

export async function getWorkflows(): Promise<readonly Workflow[]> {
  const data = await load();
  return data.workflows;
}

export async function saveWorkflow(
  workflow: Partial<Omit<Workflow, "createdAt" | "updatedAt">> & {
    name: string;
    id?: string;
  },
): Promise<Workflow> {
  return withWriteLock(async () => {
    const data = await load();
    const now = Date.now();
    const existing = workflow.id
      ? data.workflows.find((w) => w.id === workflow.id)
      : null;

    if (existing) {
      const updated: Workflow = {
        ...existing,
        name: workflow.name,
        orchProjectId: workflow.orchProjectId ?? existing.orchProjectId,
        linkedProjectIds: workflow.linkedProjectIds ?? existing.linkedProjectIds,
        agentTypes: workflow.agentTypes ?? existing.agentTypes,
        workDir: workflow.workDir ?? existing.workDir,
        updatedAt: now,
      };
      await save({
        ...data,
        workflows: data.workflows.map((w) => (w.id === updated.id ? updated : w)),
      });
      return updated;
    }

    const created: Workflow = {
      id: workflow.id || randomBytes(8).toString("hex"),
      name: workflow.name,
      orchProjectId: workflow.orchProjectId || "",
      linkedProjectIds: workflow.linkedProjectIds || [],
      agentTypes: workflow.agentTypes || {},
      workDir: workflow.workDir,
      createdAt: now,
      updatedAt: now,
    };
    await save({ ...data, workflows: [...data.workflows, created] });
    return created;
  });
}

export async function deleteWorkflow(id: string): Promise<void> {
  return withWriteLock(async () => {
    const data = await load();
    await save({
      ...data,
      workflows: data.workflows.filter((w) => w.id !== id),
    });
  });
}

// ── Folders ──────────────────────────────────────────────────────────────────

export async function getFolders(): Promise<readonly Folder[]> {
  const data = await load();
  return data.folders;
}

export async function createFolder(name: string): Promise<Folder> {
  return withWriteLock(async () => {
    const data = await load();
    const folder: Folder = {
      id: "fld-" + randomBytes(6).toString("hex"),
      name,
      createdAt: Date.now(),
    };
    await save({ ...data, folders: [...data.folders, folder] });
    return folder;
  });
}

export async function renameFolder(id: string, name: string): Promise<void> {
  return withWriteLock(async () => {
    const data = await load();
    const oldFolder = data.folders.find((f) => f.id === id);
    if (!oldFolder) return;
    const oldName = oldFolder.name;
    await save({
      ...data,
      folders: data.folders.map((f) => (f.id === id ? { ...f, name } : f)),
      projects: data.projects.map((p) =>
        p.folder === oldName ? { ...p, folder: name, updatedAt: Date.now() } : p,
      ),
    });
  });
}

export async function deleteFolder(id: string): Promise<void> {
  return withWriteLock(async () => {
    const data = await load();
    const folder = data.folders.find((f) => f.id === id);
    if (!folder) return;
    await save({
      ...data,
      folders: data.folders.filter((f) => f.id !== id),
      projects: data.projects.map((p) =>
        p.folder === folder.name ? { ...p, folder: undefined, updatedAt: Date.now() } : p,
      ),
    });
  });
}

// ── Orchestration Run History ──────────────────────────────────────────────────

export interface OrchRunNodeResult {
  readonly projectId: string;
  readonly name: string;
  readonly status: "done" | "error" | "skipped" | "warning" | "inactive";
  readonly result?: string;
}

export interface OrchRun {
  readonly id: string;
  readonly workflowId: string;
  readonly orchProjectId: string;
  readonly task: string;
  readonly status: "done" | "error" | "cancelled";
  readonly nodeResults: readonly OrchRunNodeResult[];
  readonly logs: readonly string[];
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly duration: number;
  readonly parentRunId?: string;
  readonly feedback?: string;
  readonly iteration?: number;
  readonly workspaceDir?: string;
}

const HISTORY_PATH = path.join(STORE_DIR, "orch-history.json");
const MAX_RUNS = 50;

async function loadHistory(): Promise<readonly OrchRun[]> {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf-8");
    return JSON.parse(raw) as OrchRun[];
  } catch {
    return [];
  }
}

async function saveHistory(runs: readonly OrchRun[]): Promise<void> {
  await ensureDir();
  const trimmed = runs.slice(0, MAX_RUNS);
  const tmpPath = HISTORY_PATH + ".tmp." + randomBytes(4).toString("hex");
  await fs.writeFile(tmpPath, JSON.stringify(trimmed, null, 2), "utf-8");
  await fs.rename(tmpPath, HISTORY_PATH);
}

export async function getOrchRuns(workflowId?: string): Promise<readonly OrchRun[]> {
  const runs = await loadHistory();
  if (workflowId) return runs.filter((r) => r.workflowId === workflowId);
  return runs;
}

export async function saveOrchRun(run: Omit<OrchRun, "id">): Promise<OrchRun> {
  return withWriteLock(async () => {
    const runs = await loadHistory();
    const created: OrchRun = {
      ...run,
      id: "run-" + randomBytes(8).toString("hex"),
    };
    await saveHistory([created, ...runs]);
    return created;
  });
}

export async function deleteOrchRun(id: string): Promise<void> {
  return withWriteLock(async () => {
    const runs = await loadHistory();
    await saveHistory(runs.filter((r) => r.id !== id));
  });
}

export async function clearOrchRuns(workflowId?: string): Promise<void> {
  return withWriteLock(async () => {
    if (!workflowId) {
      await saveHistory([]);
      return;
    }
    const runs = await loadHistory();
    await saveHistory(runs.filter((r) => r.workflowId !== workflowId));
  });
}
