import { promises as fs } from "node:fs";
import path from "node:path";
import type { Project } from "./project-store.js";
import { buildPhysicalFileTree } from "./orchestrator-prompts.js";
import { callLLMStructured } from "./orchestrator-llm.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveredCommand {
  readonly id: string;
  readonly argv: readonly string[];
  readonly source: string;
}

export interface ReconResult {
  readonly missionContext: string;
  readonly commands: readonly DiscoveredCommand[];
  readonly isBrownfield: boolean;
  readonly stack: string;
}

interface StackCommandRule {
  readonly stack: string;
  readonly detectFiles: readonly string[];
  readonly commands: (manifest: Record<string, unknown>) => readonly DiscoveredCommand[];
}

// ── Stack detection rules (DATA, not branching code) ─────────────────────────

function npmCommands(manifest: Record<string, unknown>): readonly DiscoveredCommand[] {
  const scripts = (manifest.scripts ?? {}) as Record<string, string>;
  const out: DiscoveredCommand[] = [];
  const npmOrYarn = "npm";

  const mapping: Record<string, string> = {
    test: "test",
    typecheck: "typecheck",
    lint: "lint",
    build: "build",
  };

  for (const [scriptName, id] of Object.entries(mapping)) {
    if (scripts[scriptName]) {
      out.push({ id, argv: [npmOrYarn, "run", scriptName], source: "package.json" });
    }
  }

  if (!scripts["typecheck"] && scripts["tsc"]) {
    out.push({
      id: "typecheck",
      argv: [npmOrYarn, "run", "tsc"],
      source: "package.json",
    });
  }

  if (!out.some((c) => c.id === "typecheck")) {
    const devDeps = (manifest.devDependencies ?? {}) as Record<string, string>;
    const deps = (manifest.dependencies ?? {}) as Record<string, string>;
    if (devDeps["typescript"] || deps["typescript"]) {
      out.push({
        id: "typecheck",
        argv: ["./node_modules/.bin/tsc", "--noEmit"],
        source: "package.json (inferred)",
      });
    }
  }

  return out;
}

function makefileCommands(): readonly DiscoveredCommand[] {
  return [
    { id: "build", argv: ["make"], source: "Makefile" },
    { id: "test", argv: ["make", "test"], source: "Makefile" },
  ];
}

function cargoCommands(): readonly DiscoveredCommand[] {
  return [
    { id: "build", argv: ["cargo", "build"], source: "Cargo.toml" },
    { id: "test", argv: ["cargo", "test"], source: "Cargo.toml" },
    { id: "lint", argv: ["cargo", "clippy"], source: "Cargo.toml" },
    { id: "typecheck", argv: ["cargo", "check"], source: "Cargo.toml" },
  ];
}

function pyprojectCommands(
  manifest: Record<string, unknown>,
): readonly DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  out.push({ id: "test", argv: ["python", "-m", "pytest"], source: "pyproject.toml" });

  const tool = manifest["tool"] as Record<string, unknown> | undefined;
  const ruff = tool?.["ruff"];
  if (ruff) {
    out.push({ id: "lint", argv: ["ruff", "check", "."], source: "pyproject.toml" });
  }

  return out;
}

const STACK_RULES: readonly StackCommandRule[] = [
  { stack: "node", detectFiles: ["package.json"], commands: npmCommands },
  {
    stack: "make",
    detectFiles: ["Makefile", "makefile", "GNUmakefile"],
    commands: makefileCommands,
  },
  { stack: "rust", detectFiles: ["Cargo.toml"], commands: cargoCommands },
  { stack: "python", detectFiles: ["pyproject.toml"], commands: pyprojectCommands },
];

// ── Command detection ────────────────────────────────────────────────────────

async function readManifest(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function detectCommands(
  workspaceDir: string,
): Promise<{ commands: readonly DiscoveredCommand[]; stack: string }> {
  const commands: DiscoveredCommand[] = [];
  const detectedStacks: string[] = [];

  for (const rule of STACK_RULES) {
    for (const detectFile of rule.detectFiles) {
      const filePath = path.join(workspaceDir, detectFile);
      if (await fileExists(filePath)) {
        detectedStacks.push(rule.stack);
        const manifest = await readManifest(filePath);
        const ruleCommands = rule.commands(manifest ?? {});
        for (const cmd of ruleCommands) {
          if (!commands.some((c) => c.id === cmd.id)) {
            commands.push(cmd);
          }
        }
        break;
      }
    }
  }

  return {
    commands,
    stack: detectedStacks.join("+") || "unknown",
  };
}

// ── Reconnaissance ───────────────────────────────────────────────────────────

const MISSION_CONTEXT_FILE = "MISSION_CONTEXT.md";
const MAX_FILE_READ_BYTES = 8192;
const READABLE_FILES = ["README.md", "README", "readme.md"];

async function readBoundedFile(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content.substring(0, MAX_FILE_READ_BYTES);
  } catch {
    return "";
  }
}

async function countEntries(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length;
  } catch {
    return 0;
  }
}

const REPORT_TOOL = {
  name: "report_mission_context",
  description: "Report the reconnaissance findings for the target workspace.",
  parameters: {
    type: "object" as const,
    properties: {
      summary: {
        type: "string" as const,
        description:
          "A concise description of the project, its stack, architecture, and current state relative to the mission objective.",
      },
      conventions: {
        type: "string" as const,
        description:
          "Observed coding conventions (naming, structure, patterns) relevant for new code.",
      },
      relevant_files: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Key existing files that agents will likely need to read or modify.",
      },
    },
    required: ["summary", "conventions", "relevant_files"],
  },
} as const;

interface LLMReconReport {
  readonly summary: string;
  readonly conventions: string;
  readonly relevant_files: readonly string[];
}

function buildDeterministicContext(
  tree: string,
  stack: string,
  commands: readonly DiscoveredCommand[],
  isBrownfield: boolean,
  readme: string,
): string {
  const commandsSection =
    commands.length > 0
      ? commands.map((c) => `- ${c.id}: \`${c.argv.join(" ")}\` (${c.source})`).join("\n")
      : "(none detected)";

  const mode = isBrownfield
    ? "brownfield (existing codebase)"
    : "greenfield (empty workspace)";

  return [
    `# Mission Context (Phase 0 — Reconnaissance)`,
    ``,
    `## Mode: ${mode}`,
    `## Detected stack: ${stack}`,
    ``,
    `## Verification commands`,
    commandsSection,
    ``,
    `## File tree`,
    tree,
    readme ? `\n## README (truncated)\n${readme}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runReconnaissance(
  workspaceDir: string,
  task: string,
  orchestrator: Project,
  signal?: AbortSignal,
  fallbackModel?: string,
  fallbackReasoningEffort?: string,
): Promise<ReconResult> {
  const tree = await buildPhysicalFileTree(workspaceDir, {
    maxDepth: 5,
    maxEntries: 400,
  });
  const entryCount = await countEntries(workspaceDir);
  const isBrownfield = entryCount > 0;

  const { commands, stack } = await detectCommands(workspaceDir);

  let readme = "";
  for (const name of READABLE_FILES) {
    readme = await readBoundedFile(path.join(workspaceDir, name));
    if (readme) break;
  }

  const deterministicContext = buildDeterministicContext(
    tree,
    stack,
    commands,
    isBrownfield,
    readme,
  );

  let missionContext = deterministicContext;

  try {
    const systemPrompt = [
      "You are a project reconnaissance agent. Analyze the workspace below and report your findings.",
      "Focus on: what the project is, its architecture, coding conventions, and which files are most relevant to the mission task.",
      "Be concise and factual. Do not speculate about things you cannot observe.",
    ].join("\n");

    const userPrompt = [`Mission task: "${task}"`, "", deterministicContext].join("\n");

    const raw = await callLLMStructured(
      orchestrator,
      systemPrompt,
      userPrompt,
      REPORT_TOOL,
      signal,
      fallbackModel,
      fallbackReasoningEffort,
    );

    if (raw) {
      const parsed = JSON.parse(raw) as LLMReconReport;
      if (parsed.summary) {
        missionContext = [
          deterministicContext,
          "",
          "## Analysis",
          parsed.summary,
          "",
          parsed.conventions ? `## Conventions\n${parsed.conventions}` : "",
          parsed.relevant_files?.length
            ? `## Key files\n${parsed.relevant_files.map((f) => `- ${f}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
    }
  } catch {
    // LLM failure is non-blocking — deterministic context is always sufficient
    console.warn(
      "[orchestrator] Recon LLM enrichment failed, using deterministic context only.",
    );
  }

  await fs.writeFile(
    path.join(workspaceDir, MISSION_CONTEXT_FILE),
    missionContext,
    "utf-8",
  );

  return { missionContext, commands, isBrownfield, stack };
}
