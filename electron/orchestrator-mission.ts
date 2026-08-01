import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { gitInDir } from "./orchestrator-worktree.js";
import type { CommandOutcome } from "./orchestrator-commands.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MissionState {
  readonly runId: string;
  readonly workspaceDir: string;
  readonly mode: "scratch" | "brownfield";
  readonly branch?: string;
  readonly baselineRef?: string;
  readonly checkpoints: readonly string[];
  readonly commandOutcomes: readonly CommandOutcome[];
}

export interface MissionOpts {
  readonly enabled: boolean;
  readonly autonomy?: "supervised" | "autonomous";
}

// ── Safety guards ────────────────────────────────────────────────────────────

const FORBIDDEN_ROOTS = new Set([
  "/",
  "/System",
  "/Applications",
  "/Library",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/private",
  // Windows system roots
  "C:\\",
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
]);

function isForbiddenRoot(dir: string): boolean {
  const resolved = path.resolve(dir);
  for (const root of FORBIDDEN_ROOTS) {
    if (resolved === root || resolved === path.resolve(root)) return true;
  }
  const home = homedir();
  if (home && resolved === path.resolve(home)) return true;
  return false;
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isCleanRepo(dir: string): Promise<boolean> {
  const status = await gitInDir(["status", "--porcelain"], dir);
  return status.trim().length === 0;
}

// ── Branch management ────────────────────────────────────────────────────────

function buildBranchName(runId: string): string {
  const slug = runId.substring(0, 8);
  return `orch/mission-${slug}`;
}

export async function beginMission(
  workspaceDir: string,
  runId: string,
): Promise<MissionState> {
  const resolved = path.resolve(workspaceDir);

  if (isForbiddenRoot(resolved)) {
    throw new Error(
      `Cannot run a mission on "${resolved}" — this is a system-protected directory.`,
    );
  }

  if (!(await isGitRepo(resolved))) {
    throw new Error(
      `Cannot run a brownfield mission on "${resolved}" — it is not a git repository. Initialize git first or use scratch mode.`,
    );
  }

  if (!(await isCleanRepo(resolved))) {
    throw new Error(
      `Cannot run a brownfield mission on "${resolved}" — the working tree has uncommitted changes. Commit or stash them first.`,
    );
  }

  const baselineRef = (await gitInDir(["rev-parse", "HEAD"], resolved)).trim();
  const branch = buildBranchName(runId);

  await gitInDir(["checkout", "-b", branch], resolved);

  // Exclude orchestrator metadata from the user's repo without touching .gitignore
  const excludePath = path.join(resolved, ".git", "info", "exclude");
  const excludeEntries = [
    "MISSION_CONTEXT.md",
    "WORKSPACE_INDEX.md",
    "MISSION_REPORT.md",
    "INTERFACE_CONTRACTS.md",
    "reports/",
    ".orch-*",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "credentials.json",
  ];
  try {
    const existing = await fs.readFile(excludePath, "utf-8");
    const toAdd = excludeEntries.filter((e) => !existing.includes(e));
    if (toAdd.length > 0) {
      await fs.appendFile(excludePath, "\n" + toAdd.join("\n") + "\n");
    }
  } catch {
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.writeFile(excludePath, excludeEntries.join("\n") + "\n");
  }

  return {
    runId,
    workspaceDir: resolved,
    mode: "brownfield",
    branch,
    baselineRef,
    checkpoints: [],
    commandOutcomes: [],
  };
}

// ── Checkpoints ──────────────────────────────────────────────────────────────

export async function commitCheckpoint(
  state: MissionState,
  label: string,
  nodeIds: readonly string[],
): Promise<MissionState> {
  if (state.mode !== "brownfield" || !state.branch) return state;

  const dir = state.workspaceDir;

  const status = await gitInDir(["status", "--porcelain"], dir);
  if (status.trim().length === 0) return state;

  await gitInDir(["add", "-A"], dir);
  const safeLabel = label.replace(/[\n\r\0]/g, " ").substring(0, 200);
  const safeIds = nodeIds.map((id) => id.replace(/[\n\r\0]/g, "").substring(0, 60));
  const msg = `orch checkpoint: ${safeLabel} [${safeIds.join(", ")}]`;
  await gitInDir(["commit", "--no-verify", "-m", msg], dir);

  const sha = (await gitInDir(["rev-parse", "HEAD"], dir)).trim();

  return {
    ...state,
    checkpoints: [...state.checkpoints, sha],
  };
}

// ── Diff contract ────────────────────────────────────────────────────────────

export async function listPreexistingFiles(
  workspaceDir: string,
  baselineRef: string,
): Promise<ReadonlySet<string>> {
  const output = await gitInDir(
    ["ls-tree", "-r", "--name-only", baselineRef],
    workspaceDir,
  );
  return new Set(
    output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

export async function findUndeclaredDiffFiles(
  workspaceDir: string,
  baselineRef: string,
  declaredFiles: ReadonlySet<string>,
): Promise<readonly string[]> {
  const output = await gitInDir(
    ["diff", "--name-only", baselineRef + "..HEAD"],
    workspaceDir,
  );
  const changedFiles = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return changedFiles.filter((f) => !declaredFiles.has(f));
}

// ── Report ───────────────────────────────────────────────────────────────────

export async function buildMissionReport(
  state: MissionState,
  gatePass: boolean,
): Promise<string> {
  const sections: string[] = [];

  sections.push(`# Mission Report`);
  sections.push(`- Run ID: ${state.runId}`);
  sections.push(`- Mode: ${state.mode}`);
  sections.push(`- Branch: ${state.branch ?? "N/A"}`);
  sections.push(`- Baseline: ${state.baselineRef ?? "N/A"}`);
  sections.push(`- Checkpoints: ${state.checkpoints.length}`);
  sections.push(`- Gate: ${gatePass ? "PASS" : "FAIL"}`);
  sections.push("");

  if (state.mode === "brownfield" && state.baselineRef) {
    try {
      const diffStat = await gitInDir(
        ["diff", "--stat", state.baselineRef + "..HEAD"],
        state.workspaceDir,
      );
      sections.push("## Changes\n```\n" + diffStat.trim() + "\n```\n");

      const diffContent = await gitInDir(
        ["diff", state.baselineRef + "..HEAD"],
        state.workspaceDir,
      );
      const truncatedDiff = diffContent.substring(0, 50000);
      sections.push(
        "## Diff\n```diff\n" +
          truncatedDiff +
          (diffContent.length > 50000 ? "\n... (truncated)" : "") +
          "\n```\n",
      );
    } catch {
      sections.push("## Changes\n(could not generate diff)\n");
    }
  }

  if (state.commandOutcomes.length > 0) {
    sections.push("## Verification Commands");
    for (const o of state.commandOutcomes) {
      const status = o.ok ? "PASS" : "FAIL";
      const timeout = o.timedOut ? " (timed out)" : "";
      sections.push(
        `- \`${o.command.argv.join(" ")}\`: ${status}${timeout} (${o.durationMs}ms)`,
      );
    }
    sections.push("");
  }

  return sections.join("\n");
}

export async function endMission(
  state: MissionState,
  gatePass: boolean,
): Promise<string> {
  const report = await buildMissionReport(state, gatePass);
  const reportPath = path.join(state.workspaceDir, "MISSION_REPORT.md");
  await fs.writeFile(reportPath, report, "utf-8");

  if (state.mode === "brownfield" && state.baselineRef) {
    try {
      await gitInDir(["add", "-f", "MISSION_REPORT.md"], state.workspaceDir);
      await gitInDir(
        ["commit", "--no-verify", "-m", "orch: add mission report"],
        state.workspaceDir,
      );
    } catch {
      // report commit is best-effort
    }
  }

  return reportPath;
}

// ── Scratch mode factory ─────────────────────────────────────────────────────

export function createScratchMissionState(
  runId: string,
  workspaceDir: string,
): MissionState {
  return {
    runId,
    workspaceDir: path.resolve(workspaceDir),
    mode: "scratch",
    checkpoints: [],
    commandOutcomes: [],
  };
}
