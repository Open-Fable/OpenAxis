// ── C8: Diff review before delivery ─────────────────────────────────────────
// LLM code-review pass on the run's diff (baseline..HEAD), not the full repo.
// Checks logic, edge cases, consistency. Issues routed to agents via fileOwner.

import { execFile } from "node:child_process";
import { callLLMStructured, type StructuredTool } from "./orchestrator-llm.js";
import { buildSafeEnv, type QualityIssue } from "./orchestrator-commands.js";
import type { Project } from "./project-store.js";

export interface DiffReviewResult {
  readonly issues: readonly QualityIssue[];
  readonly reviewSummary: string;
}

const MAX_DIFF_CHARS = 64_000;
const SHA_RE = /^[0-9a-f]{4,40}$/i;

export async function getRunDiff(
  workspaceDir: string,
  baselineRef: string,
): Promise<string> {
  if (!SHA_RE.test(baselineRef)) return "";

  const safeEnv = buildSafeEnv();
  safeEnv["GIT_CONFIG_NOSYSTEM"] = "1";
  safeEnv["GIT_ATTR_NOSYSTEM"] = "1";

  return new Promise((resolve) => {
    execFile(
      "git",
      ["diff", `${baselineRef}..HEAD`, "--stat", "--patch", "--no-color"],
      {
        cwd: workspaceDir,
        maxBuffer: 1024 * 1024 * 4,
        timeout: 30_000,
        env: safeEnv,
      },
      (err, stdout) => {
        if (err) {
          resolve("");
          return;
        }
        resolve(stdout.substring(0, MAX_DIFF_CHARS));
      },
    );
  });
}

const REVIEW_TOOL: StructuredTool = {
  name: "submit_review",
  description: "Submit the code review results",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Brief overall assessment (1-3 sentences)",
      },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string", description: "File path" },
            issue: { type: "string", description: "Description of the issue" },
            severity: {
              type: "string",
              enum: ["critical", "high", "medium", "low"],
            },
            fix: { type: "string", description: "Suggested fix" },
          },
          required: ["file", "issue", "severity", "fix"],
        },
      },
    },
    required: ["summary", "issues"],
  },
};

function buildReviewPrompt(diff: string, task: string): string {
  return `You are a senior code reviewer. Review the following diff produced by an automated multi-agent system.

TASK: ${task}

DIFF (baseline..HEAD):
\`\`\`
${diff}
\`\`\`

Review for:
1. Logic errors, bugs, or incorrect implementations
2. Edge cases not handled
3. Consistency issues between files changed by different agents
4. Security issues (injection, XSS, hardcoded secrets)
5. Missing error handling at system boundaries

Only report REAL issues — no style nits, no "consider adding tests", no generic advice.
If the diff looks correct, return an empty issues array.

Call the submit_review tool with your findings.`;
}

interface ReviewToolResult {
  summary: string;
  issues: Array<{
    file: string;
    issue: string;
    severity: string;
    fix: string;
  }>;
}

export async function reviewRunDiff(
  workspaceDir: string,
  baselineRef: string,
  task: string,
  fileOwner: (file: string) => string,
  orchestrator: Project,
  signal?: AbortSignal,
  fallbackModel?: string,
  fallbackReasoningEffort?: string,
): Promise<DiffReviewResult> {
  const diff = await getRunDiff(workspaceDir, baselineRef);
  if (!diff.trim()) {
    return { issues: [], reviewSummary: "No diff to review." };
  }

  const userPrompt = buildReviewPrompt(diff, task);

  try {
    const raw = await callLLMStructured(
      orchestrator,
      "You are a senior code reviewer for a multi-agent orchestration system.",
      userPrompt,
      REVIEW_TOOL,
      signal,
      fallbackModel,
      fallbackReasoningEffort,
    );

    let result: ReviewToolResult;
    try {
      result = JSON.parse(raw) as ReviewToolResult;
    } catch {
      return {
        issues: [],
        reviewSummary: raw.substring(0, 200) || "Review produced no structured output.",
      };
    }

    if (!result.issues || !Array.isArray(result.issues)) {
      return {
        issues: [],
        reviewSummary: result.summary ?? "Review produced no issues.",
      };
    }

    const qualityIssues: QualityIssue[] = result.issues
      .filter(
        (i: ReviewToolResult["issues"][number]) =>
          i.severity === "critical" || i.severity === "high",
      )
      .map((i: ReviewToolResult["issues"][number]) => ({
        agent: fileOwner(i.file),
        issue: `[${i.severity.toUpperCase()}] ${i.file}: ${i.issue}`,
        fix: i.fix,
      }));

    return {
      issues: qualityIssues,
      reviewSummary: result.summary,
    };
  } catch {
    return { issues: [], reviewSummary: "Diff review failed (non-blocking)." };
  }
}
