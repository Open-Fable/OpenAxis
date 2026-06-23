import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import { randomBytes, createHash } from "crypto";

export interface WorkspaceEntry {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly preset: string;
  readonly workspaceType: string;
  readonly displayName: string;
}

interface WorkspaceStoreData {
  readonly workspaces: readonly WorkspaceEntry[];
  readonly activeWorkspaceId: string | null;
}

const STORE_DIR = path.join(homedir(), ".config", "openaxis");
const STORE_PATH = path.join(STORE_DIR, "workspaces.json");

// In-memory cache for fast synchronous access
let workspaces: WorkspaceEntry[] = [
  {
    id: "openaxis-default",
    name: "OpenAxis",
    path: homedir(),
    preset: "default",
    workspaceType: "local",
    displayName: "OpenAxis",
  },
];
let activeWorkspaceId: string | null = "openaxis-default";

let writeLock = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeLock.then(fn, fn);
  writeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
}

export function isSafeWorkspacePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || !path.isAbsolute(p)) return false;
  const home = path.resolve(homedir());
  const resolved = path.resolve(p);
  if (resolved === home) return true;
  const rel = path.relative(home, resolved);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function getStableWorkspaceId(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  return `ws_${createHash("sha256").update(resolved).digest("hex").slice(0, 12)}`;
}

export function getStableRemoteWorkspaceId(baseUrl: string, directory?: string): string {
  const key = directory ? `remote::${baseUrl}::${directory}` : `remote::${baseUrl}`;
  return `ws_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

export async function initWorkspaces(): Promise<void> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<WorkspaceStoreData>;
    const loadedWorkspaces = Array.isArray(parsed.workspaces)
      ? (parsed.workspaces as WorkspaceEntry[])
      : [];
    const loadedActiveId =
      typeof parsed.activeWorkspaceId === "string"
        ? parsed.activeWorkspaceId
        : "openaxis-default";

    // Ensure openaxis-default workspace always exists
    const hasDefault = loadedWorkspaces.some((w) => w.id === "openaxis-default");
    const nextWorkspaces = hasDefault
      ? loadedWorkspaces
      : [
          {
            id: "openaxis-default",
            name: "OpenAxis",
            path: homedir(),
            preset: "default",
            workspaceType: "local",
            displayName: "OpenAxis",
          } as WorkspaceEntry,
          ...loadedWorkspaces,
        ];

    // Seed disk if default was missing
    if (!hasDefault) {
      await saveWorkspacesToDisk(nextWorkspaces, loadedActiveId);
    }

    workspaces = nextWorkspaces;
    activeWorkspaceId = loadedActiveId;
  } catch {
    // If the file doesn't exist or is corrupted, seed it
    const defaultWS: WorkspaceEntry = {
      id: "openaxis-default",
      name: "OpenAxis",
      path: homedir(),
      preset: "default",
      workspaceType: "local",
      displayName: "OpenAxis",
    };
    const seededWorkspaces = [defaultWS];
    const seededActiveId = "openaxis-default";
    try {
      await saveWorkspacesToDisk(seededWorkspaces, seededActiveId);
    } catch (err) {
      console.warn("[workspaces] Failed to write seed workspaces file", err);
    }
    workspaces = seededWorkspaces;
    activeWorkspaceId = seededActiveId;
  }
}

async function saveWorkspacesToDisk(
  nextWorkspaces: WorkspaceEntry[],
  nextActiveWorkspaceId: string | null,
): Promise<void> {
  await ensureDir();
  const data: WorkspaceStoreData = {
    workspaces: nextWorkspaces,
    activeWorkspaceId: nextActiveWorkspaceId,
  };
  const tmpPath = STORE_PATH + ".tmp." + randomBytes(4).toString("hex");
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmpPath, STORE_PATH);
}

export function getWorkspacesSync(): readonly WorkspaceEntry[] {
  return workspaces;
}

export function getActiveWorkspaceIdSync(): string | null {
  return activeWorkspaceId;
}

export function getActiveWorkspaceDirSync(): string {
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  if (!ws) return homedir();
  if (ws.workspaceType === "remote") return homedir();
  return ws.path ?? homedir();
}

export async function addWorkspace(entry: WorkspaceEntry): Promise<WorkspaceEntry> {
  if (entry.workspaceType === "local" && !isSafeWorkspacePath(entry.path)) {
    throw new Error(`Unsafe or invalid local workspace path: ${entry.path}`);
  }
  return withWriteLock(async () => {
    // Check if the workspace with this path or id already exists
    const existing = workspaces.find(
      (w) =>
        w.id === entry.id ||
        (w.workspaceType === "local" &&
          entry.workspaceType === "local" &&
          path.resolve(w.path) === path.resolve(entry.path)),
    );

    if (existing) {
      return existing;
    }

    const nextWorkspaces = [...workspaces, entry];
    await saveWorkspacesToDisk(nextWorkspaces, activeWorkspaceId);
    workspaces = nextWorkspaces;
    return entry;
  });
}

export async function setActiveWorkspaceId(id: string | null): Promise<void> {
  return withWriteLock(async () => {
    if (id && !workspaces.some((w) => w.id === id)) return;
    await saveWorkspacesToDisk(workspaces, id);
    activeWorkspaceId = id;
  });
}

export async function updateWorkspaceDisplayName(
  id: string,
  displayName: string,
): Promise<void> {
  return withWriteLock(async () => {
    const nextWorkspaces = workspaces.map((w) =>
      w.id === id ? { ...w, displayName, name: displayName } : w,
    );
    await saveWorkspacesToDisk(nextWorkspaces, activeWorkspaceId);
    workspaces = nextWorkspaces;
  });
}

export async function removeWorkspace(id: string): Promise<void> {
  return withWriteLock(async () => {
    const nextWorkspaces = workspaces.filter((w) => w.id !== id);
    let nextActiveId = activeWorkspaceId;
    if (activeWorkspaceId === id) {
      nextActiveId = nextWorkspaces[0]?.id ?? null;
    }
    await saveWorkspacesToDisk(nextWorkspaces, nextActiveId);
    workspaces = nextWorkspaces;
    activeWorkspaceId = nextActiveId;
  });
}
