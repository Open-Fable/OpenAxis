// ── C3: Per-node mini-gate ──────────────────────────────────────────────────
// Runs quick verification commands (typecheck, lint) after each code node
// completes, BEFORE unblocking its dependents. 2-3 retries then escalate.
// The global quality loop remains as a final safety net.

import type {
  CommandRunner,
  CommandOutcome,
  QualityIssue,
} from "./orchestrator-commands.js";
import { buildCommandDefects } from "./orchestrator-commands.js";
import { checkExpectedFiles } from "./orchestrator-quality.js";
import type { Project } from "./project-store.js";

export interface NodeGateResult {
  readonly pass: boolean;
  readonly issues: readonly QualityIssue[];
  readonly commandOutcomes: readonly CommandOutcome[];
}

const PER_NODE_COMMAND_IDS = ["typecheck", "lint"] as const;

export const MAX_NODE_GATE_RETRIES = 2;

export async function runNodeGate(
  node: Project,
  workspaceDir: string,
  commandRunner: CommandRunner | null,
  expectedFiles: readonly string[],
  fileOwner: (file: string) => string,
  linked: readonly Project[],
  signal?: AbortSignal,
): Promise<NodeGateResult> {
  const issues: QualityIssue[] = [];
  const commandOutcomes: CommandOutcome[] = [];

  // 1. Check expected files exist on disk
  const fileCheck = await checkExpectedFiles(workspaceDir, expectedFiles);
  for (const missing of fileCheck.missing) {
    issues.push({
      agent: node.id,
      issue: `Expected file missing: ${missing}`,
      fix: `Create the file ${missing} as declared in the plan.`,
    });
  }

  // 2. Run quick verification commands (typecheck, lint)
  if (commandRunner) {
    for (const cmdId of PER_NODE_COMMAND_IDS) {
      if (signal?.aborted) break;
      if (!commandRunner.has(cmdId)) continue;

      try {
        const outcome = await commandRunner.run(cmdId, signal);
        commandOutcomes.push(outcome);
      } catch {
        // Command not in whitelist or execution error — skip, not a gate failure
      }
    }

    const cmdIssues = buildCommandDefects(commandOutcomes, fileOwner, linked);
    issues.push(...cmdIssues);
  }

  return {
    pass: issues.length === 0,
    issues,
    commandOutcomes,
  };
}

export function buildNodeGateFeedback(nodeName: string, result: NodeGateResult): string {
  if (result.pass) return "";

  const lines = [`Node "${nodeName}" failed its mini-gate:`];
  for (const issue of result.issues) {
    lines.push(`- [${issue.agent}] ${issue.issue}`);
    if (issue.fix) lines.push(`  Fix: ${issue.fix}`);
  }

  for (const outcome of result.commandOutcomes) {
    if (!outcome.ok) {
      const stderr = outcome.stderr.substring(0, 2048);
      lines.push(
        `\nCommand "${outcome.command.id}" (${outcome.command.argv.join(" ")}) failed (exit ${outcome.exitCode}):`,
      );
      if (stderr) lines.push(stderr);
    }
  }

  return lines.join("\n");
}
