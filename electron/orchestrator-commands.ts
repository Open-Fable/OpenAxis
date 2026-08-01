import { execFile } from "node:child_process";
import path from "node:path";
import type { DiscoveredCommand } from "./orchestrator-recon.js";
import type { Project } from "./project-store.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CommandOutcome {
  readonly command: DiscoveredCommand;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface QualityIssue {
  readonly agent: string;
  readonly issue: string;
  readonly fix: string;
}

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 8192;
const SAFE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "USER",
  "SHELL",
  "TMPDIR",
  "NODE_ENV",
  "CI",
]);

export function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  env["CI"] = "1";
  return env;
}

function truncateOutput(raw: string): string {
  if (raw.length <= MAX_OUTPUT_BYTES) return raw;
  const half = Math.floor(MAX_OUTPUT_BYTES / 2);
  return (
    raw.substring(0, half) +
    "\n\n--- [truncated: middle omitted, showing start + end] ---\n\n" +
    raw.substring(raw.length - half)
  );
}

// ── CommandRunner ────────────────────────────────────────────────────────────

export class CommandRunner {
  private readonly whitelist: ReadonlyMap<string, DiscoveredCommand>;
  private readonly cwd: string;
  private readonly timeoutMs: number;

  constructor(
    commands: readonly DiscoveredCommand[],
    cwd: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    const map = new Map<string, DiscoveredCommand>();
    for (const cmd of commands) {
      if (!map.has(cmd.id)) map.set(cmd.id, cmd);
    }
    this.whitelist = map;
    this.cwd = path.resolve(cwd);
    this.timeoutMs = timeoutMs;
  }

  availableIds(): readonly string[] {
    return [...this.whitelist.keys()];
  }

  has(id: string): boolean {
    return this.whitelist.has(id);
  }

  async run(id: string, signal?: AbortSignal): Promise<CommandOutcome> {
    const cmd = this.whitelist.get(id);
    if (!cmd) {
      throw new Error(
        `Command "${id}" is not in the whitelist. Available: ${[...this.whitelist.keys()].join(", ")}`,
      );
    }

    const [executable, ...args] = cmd.argv;
    const start = Date.now();

    return new Promise<CommandOutcome>((resolve) => {
      const child = execFile(
        executable,
        args,
        {
          cwd: this.cwd,
          timeout: this.timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES * 2,
          env: buildSafeEnv(),
        },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - start;
          const timedOut = err !== null && "killed" in err && err.killed === true;

          const exitCode =
            err !== null && "code" in err && typeof err.code === "number"
              ? err.code
              : err
                ? 1
                : 0;

          resolve({
            command: cmd,
            ok: !err,
            exitCode,
            stdout: truncateOutput(stdout ?? ""),
            stderr: truncateOutput(stderr ?? ""),
            durationMs,
            timedOut,
          });
        },
      );

      if (signal) {
        const onAbort = (): void => {
          child.kill("SIGTERM");
        };
        if (signal.aborted) {
          child.kill("SIGTERM");
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          child.on("exit", () => signal.removeEventListener("abort", onAbort));
        }
      }
    });
  }

  async runAll(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly CommandOutcome[]> {
    const outcomes: CommandOutcome[] = [];
    for (const id of ids) {
      if (signal?.aborted) break;
      if (!this.has(id)) continue;
      outcomes.push(await this.run(id, signal));
    }
    return outcomes;
  }
}

// ── Defect attribution ───────────────────────────────────────────────────────

const TSC_ERROR_RE = /^(.+?)\(\d+,\d+\):\s*error\s+TS\d+/;
const ESLINT_ERROR_RE = /^\s*(.+?):\d+:\d+\s/;
const GENERIC_FILE_RE = /(?:^|\s)([\w./\\-]+\.(?:ts|tsx|js|jsx|py|rs|go|css|html))/;

function extractFilePaths(output: string): readonly string[] {
  const files = new Set<string>();
  for (const line of output.split("\n")) {
    const tsc = TSC_ERROR_RE.exec(line);
    if (tsc) {
      files.add(tsc[1]);
      continue;
    }
    const eslint = ESLINT_ERROR_RE.exec(line);
    if (eslint) {
      files.add(eslint[1]);
      continue;
    }
    const generic = GENERIC_FILE_RE.exec(line);
    if (generic) files.add(generic[1]);
  }
  return [...files];
}

export function buildCommandDefects(
  outcomes: readonly CommandOutcome[],
  fileOwner: (file: string) => string,
  linked: readonly Project[],
): readonly QualityIssue[] {
  const issues: QualityIssue[] = [];

  for (const outcome of outcomes) {
    if (outcome.ok) continue;

    const errorOutput = outcome.stderr || outcome.stdout;
    const filePaths = extractFilePaths(errorOutput);

    if (filePaths.length > 0) {
      const byAgent = new Map<string, string[]>();
      for (const file of filePaths) {
        const owner = fileOwner(file);
        const existing = byAgent.get(owner) ?? [];
        byAgent.set(owner, [...existing, file]);
      }

      for (const [agent, files] of byAgent) {
        const fileList = files.slice(0, 10).join(", ");
        const truncatedOutput = errorOutput.substring(0, 2000);
        issues.push({
          agent,
          issue: `${outcome.command.id} failed — errors in: ${fileList}`,
          fix: `Fix the errors reported by \`${outcome.command.argv.join(" ")}\`:\n${truncatedOutput}`,
        });
      }
    } else {
      const agentName =
        linked.length === 1 ? (linked[0].name ?? "integration") : "integration";
      const truncatedOutput = errorOutput.substring(0, 2000);
      issues.push({
        agent: agentName,
        issue: `${outcome.command.id} failed (exit ${outcome.exitCode}${outcome.timedOut ? ", timed out" : ""})`,
        fix: `Fix the errors reported by \`${outcome.command.argv.join(" ")}\`:\n${truncatedOutput}`,
      });
    }
  }

  return issues;
}
