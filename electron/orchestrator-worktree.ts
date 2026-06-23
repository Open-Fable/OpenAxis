import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Git-worktree isolation for parallel backend (code/design) agents. Each agent
// gets its own checkout so two opencode sessions writing the same workspace
// can't clobber each other; results are merged back after the wave.
//
// SAFETY: worktrees are ONLY ever created for scratch workspaces under ~/_orch/.
// The orchestrator never runs git against a user's real project directory.

const SCRATCH_ROOT = path.join(homedir(), "_orch");
const GIT_TIMEOUT_MS = 60_000;
// Orchestrator-managed shared files live only in the main workspace; ignoring
// them keeps the tracked tree clean so per-agent merges never conflict on them.
// node_modules/ and agent metadata are excluded too: a `npm install` inside a
// worktree would otherwise stage thousands of files, making commits/merges slow
// and prone to spurious conflicts.
const GITIGNORE_BODY = [
  "WORKSPACE_INDEX.md",
  "reports/",
  ".orch-*",
  "node_modules/",
  ".opencode/",
  // Defense-in-depth: never bake an agent-written credential into the persisted
  // ~/_orch/<name>/.git history (commits survive even after the file is deleted).
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "*.secret",
  "",
].join("\n");

export interface WorktreeHandle {
  readonly nodeId: string;
  readonly dir: string;
  readonly branch: string;
}

export interface MergeResult {
  readonly ok: boolean;
  readonly conflicts: readonly string[];
}

function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args as string[],
      { cwd, timeout: GIT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}

// A path is a usable scratch workspace only if it sits strictly inside ~/_orch/.
// Lexical check (no symlink resolution) — see isScratchWorkspaceReal for the
// guard actually used before any git mutation.
export function isScratchWorkspace(dir: string): boolean {
  const rel = path.relative(path.resolve(SCRATCH_ROOT), path.resolve(dir));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Symlink-aware scratch check: resolves real paths so a symlink planted at
// ~/_orch/<name> pointing into a real user repo can't slip past the lexical
// check and let git run against that repo. This mirrors the file writer's
// isContainedRealPath defense. Conservative: any realpath failure → not safe.
export async function isScratchWorkspaceReal(dir: string): Promise<boolean> {
  if (!isScratchWorkspace(dir)) return false;
  try {
    const realDir = await fs.realpath(dir);
    const realRoot = await fs.realpath(SCRATCH_ROOT);
    const rel = path.relative(realRoot, realDir);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

export async function isGitAvailable(): Promise<boolean> {
  try {
    await git(["--version"], homedir());
    return true;
  } catch {
    return false;
  }
}

const sanitize = (nodeId: string): string =>
  nodeId.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 64);

// Init the repo (idempotent) and commit the current workspace state so each
// worktree branches from a known baseline. --allow-empty guarantees a HEAD even
// if every file is gitignored, so `worktree add` always has a commit to fork.
export async function ensureGitBaseline(mainDir: string): Promise<void> {
  const gitDir = path.join(mainDir, ".git");
  const alreadyRepo = await fs
    .access(gitDir)
    .then(() => true)
    .catch(() => false);
  if (!alreadyRepo) {
    await git(["init", "-q"], mainDir);
    await git(["config", "user.email", "orchestrator@openaxis.local"], mainDir);
    await git(["config", "user.name", "OpenAxis Orchestrator"], mainDir);
  }
  await fs.writeFile(path.join(mainDir, ".gitignore"), GITIGNORE_BODY, "utf-8");
  await git(["add", "-A"], mainDir);
  await git(["commit", "-q", "--allow-empty", "-m", "orch baseline"], mainDir);
}

// Create an isolated worktree (sibling dir, never nested in the repo tree) on a
// fresh branch forked from the current HEAD.
export async function addWorktree(
  mainDir: string,
  nodeId: string,
): Promise<WorktreeHandle> {
  const safe = sanitize(nodeId);
  const branch = `orch/${safe}`;
  const dir = path.join(`${mainDir}.worktrees`, safe);
  // Best-effort cleanup of a stale worktree/branch from a previous aborted run.
  await git(["worktree", "remove", "--force", dir], mainDir).catch(() => {});
  await git(["branch", "-D", branch], mainDir).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await git(["worktree", "add", "-q", "-b", branch, dir, "HEAD"], mainDir);
  return { nodeId, dir, branch };
}

// Commit whatever the agent produced in its worktree. Returns false when the
// agent wrote nothing (clean tree) so the caller can skip a no-op merge.
export async function commitWorktree(handle: WorktreeHandle): Promise<boolean> {
  await git(["add", "-A"], handle.dir);
  const status = await git(["status", "--porcelain"], handle.dir);
  if (status.trim().length === 0) return false;
  await git(["commit", "-q", "-m", `orch ${handle.nodeId}`], handle.dir);
  return true;
}

// Merge the agent's branch back into the main workspace. On conflict, collect
// the conflicted paths, abort the merge (leaving main untouched), and report —
// never silently drop a version.
export async function mergeWorktree(
  mainDir: string,
  handle: WorktreeHandle,
): Promise<MergeResult> {
  try {
    await git(["merge", "--no-ff", "--no-edit", handle.branch], mainDir);
    return { ok: true, conflicts: [] };
  } catch {
    const conflicts = (
      await git(["diff", "--name-only", "--diff-filter=U"], mainDir).catch(() => "")
    )
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    await git(["merge", "--abort"], mainDir).catch(() => {});
    return { ok: false, conflicts };
  }
}

// Tear down a worktree and its branch. Best-effort: failures here never abort
// the orchestration.
export async function removeWorktree(
  mainDir: string,
  handle: WorktreeHandle,
): Promise<void> {
  await git(["worktree", "remove", "--force", handle.dir], mainDir).catch(() => {});
  await git(["branch", "-D", handle.branch], mainDir).catch(() => {});
  await fs.rm(handle.dir, { recursive: true, force: true }).catch(() => {});
}
