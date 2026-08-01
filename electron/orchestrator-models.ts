// ── C13: Model-per-role resolution ──────────────────────────────────────────
// Smart defaults: strong model for planning/triage/verification, fast model for
// mechanical execution. The role→model mapping is DATA, not code branching.
// Everything falls back to the existing fallbackModel when no role override exists.

export type AgentRole =
  | "planning"
  | "triage"
  | "verification"
  | "execution_code"
  | "execution_llm"
  | "recon";

export interface RoleModelEntry {
  readonly role: AgentRole;
  readonly preferTier: "strong" | "fast";
  readonly description: string;
}

export const ROLE_MODEL_TABLE: readonly RoleModelEntry[] = [
  {
    role: "planning",
    preferTier: "strong",
    description: "Task decomposition and agent assignment",
  },
  {
    role: "triage",
    preferTier: "strong",
    description: "Mutation triage and feedback routing",
  },
  {
    role: "verification",
    preferTier: "strong",
    description: "Quality gate and output verification",
  },
  {
    role: "recon",
    preferTier: "fast",
    description: "Phase 0 reconnaissance and stack detection",
  },
  {
    role: "execution_code",
    preferTier: "fast",
    description: "Code/design agent execution",
  },
  { role: "execution_llm", preferTier: "fast", description: "Pure-LLM agent execution" },
];

export interface RoleModelOverrides {
  readonly strong?: string;
  readonly fast?: string;
}

export function resolveModelForRole(
  role: AgentRole,
  fallbackModel: string | undefined,
  overrides?: RoleModelOverrides,
): string | undefined {
  const entry = ROLE_MODEL_TABLE.find((e) => e.role === role);
  if (!entry) return fallbackModel;

  const tier = entry.preferTier;
  if (overrides) {
    const override = tier === "strong" ? overrides.strong : overrides.fast;
    if (override) return override;
  }

  return fallbackModel;
}

export function roleFromProjectType(projectType: string | undefined): AgentRole {
  if (projectType === "code" || projectType === "design") return "execution_code";
  if (projectType === "verifier") return "verification";
  return "execution_llm";
}
