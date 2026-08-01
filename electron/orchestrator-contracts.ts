// ── C9: Interface contracts — a priori prevention of cross-agent mismatches ──
// The planner declares shared interfaces (types, signatures, schemas) that each
// code agent receives as a constraint. Moves from "detect disagreement at gate
// time" (module-graph, a posteriori) to "make it impossible" (a priori).
//
// The contract is a PLANNING-TIME artifact: one block per shared boundary,
// written to INTERFACE_CONTRACTS.md in the workspace and injected into each
// agent's dependency context.

import { promises as fs } from "node:fs";
import path from "node:path";

export interface InterfaceContract {
  readonly name: string;
  readonly producers: readonly string[];
  readonly consumers: readonly string[];
  readonly definition: string;
}

export interface ContractsMap {
  readonly contracts: readonly InterfaceContract[];
}

export function sanitizeInterfaceContract(raw: unknown): InterfaceContract | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) return null;
  if (typeof r.definition !== "string" || !r.definition.trim()) return null;

  const producers = Array.isArray(r.producers)
    ? r.producers.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : [];
  const consumers = Array.isArray(r.consumers)
    ? r.consumers.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : [];

  if (producers.length === 0 && consumers.length === 0) return null;

  return {
    name: r.name.trim(),
    producers,
    consumers,
    definition: r.definition.trim().substring(0, 8192),
  };
}

export function buildContractsFileContent(
  contracts: readonly InterfaceContract[],
): string {
  if (contracts.length === 0) return "";

  const sections = contracts.map((c) => {
    const producerList =
      c.producers.length > 0
        ? `Producers: ${c.producers.join(", ")}`
        : "Producers: (none declared)";
    const consumerList =
      c.consumers.length > 0
        ? `Consumers: ${c.consumers.join(", ")}`
        : "Consumers: (none declared)";
    return `## ${c.name}\n${producerList}\n${consumerList}\n\n\`\`\`\n${c.definition}\n\`\`\``;
  });

  return `# Interface Contracts\n\nThese interfaces are shared boundaries between agents. Producers MUST implement them exactly. Consumers MUST import/use them as-is — never redefine.\n\n${sections.join("\n\n---\n\n")}\n`;
}

export async function writeContractsFile(
  workspaceDir: string,
  contracts: readonly InterfaceContract[],
): Promise<string | null> {
  if (contracts.length === 0) return null;
  const content = buildContractsFileContent(contracts);
  const filePath = path.join(workspaceDir, "INTERFACE_CONTRACTS.md");
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

export function buildContractContextForAgent(
  agentId: string,
  contracts: readonly InterfaceContract[],
): string {
  const relevant = contracts.filter(
    (c) => c.producers.includes(agentId) || c.consumers.includes(agentId),
  );
  if (relevant.length === 0) return "";

  const blocks = relevant.map((c) => {
    const role = c.producers.includes(agentId)
      ? "PRODUCER — you MUST implement this interface exactly"
      : "CONSUMER — you MUST use this interface as-is, do not redefine";
    return `### ${c.name} (${role})\n\`\`\`\n${c.definition}\n\`\`\``;
  });

  return `\n[INTERFACE CONTRACTS]\nThe following shared interfaces are declared for this run. Violating them will cause cross-agent integration failures.\n\n${blocks.join("\n\n")}\n`;
}
