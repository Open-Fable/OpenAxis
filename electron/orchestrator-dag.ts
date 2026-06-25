import type { Project } from "./project-store.js";

// Pure graph algorithms for the orchestrator's dependency DAG. No instance
// state — kept separate from the execution engine so the scheduling logic is
// independently testable and the runner stays focused on execution.

type NodeStatus = "done" | "error" | "skipped" | "inactive";

const CIRCULAR_DEP_ERROR = "Circular dependency detected in the project graph.";

/**
 * Depth-first topological sort: dependencies come before their dependents.
 * Throws on a cycle. Dependencies pointing outside `nodes` are ignored.
 */
export function resolveDAG(nodes: readonly Project[]): Project[] {
  const visited = new Set<string>();
  const tempVisited = new Set<string>();
  const order: Project[] = [];

  const visit = (node: Project): void => {
    if (visited.has(node.id)) return;
    if (tempVisited.has(node.id)) {
      const cycle = [...tempVisited, node.id];
      const names = cycle.map((id) => {
        const n = nodes.find((p) => p.id === id);
        return n ? `"${n.name}" (${id})` : id;
      });
      console.error(`[orchestrator] Circular dependency detected: ${names.join(" → ")}`);
      throw new Error(CIRCULAR_DEP_ERROR);
    }

    tempVisited.add(node.id);
    for (const depId of node.dependencies ?? []) {
      const depNode = nodes.find((n) => n.id === depId);
      if (depNode) visit(depNode);
    }
    tempVisited.delete(node.id);
    visited.add(node.id);
    order.push(node);
  };

  for (const node of nodes) visit(node);
  return order;
}

/**
 * Kahn-based topological sort that groups nodes into execution waves.
 * Wave N contains only nodes whose dependencies all completed in waves < N.
 * Stable intra-wave order (insertion order preserved). Throws on a cycle.
 */
export function resolveDAGWaves(nodes: readonly Project[]): Project[][] {
  const nodeMap = new Map<string, Project>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const inDegree = new Map<string, number>();
  for (const n of nodes) {
    if (!inDegree.has(n.id)) inDegree.set(n.id, 0);
    for (const depId of n.dependencies ?? []) {
      if (!nodeMap.has(depId)) continue;
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1);
    }
  }

  const waves: Project[][] = [];
  const remaining = new Set(nodes.map((n) => n.id));

  while (remaining.size > 0) {
    const wave: Project[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) === 0) wave.push(nodeMap.get(id)!);
    }

    if (wave.length === 0) {
      const stuck = [...remaining].map((id) => {
        const n = nodeMap.get(id);
        return n ? `"${n.name}" (${id})` : id;
      });
      console.error(
        `[orchestrator] Circular dependency detected among: ${stuck.join(", ")}`,
      );
      throw new Error(CIRCULAR_DEP_ERROR);
    }

    waves.push(wave);
    for (const n of wave) {
      remaining.delete(n.id);
      for (const other of nodes) {
        if ((other.dependencies ?? []).includes(n.id)) {
          inDegree.set(other.id, (inDegree.get(other.id) ?? 1) - 1);
        }
      }
    }
  }

  return waves;
}

/**
 * Returns the id of a dependency that failed or was skipped (so the dependent
 * must be skipped too), or null if all dependencies are clear.
 */
export function findFailedDependency(
  node: Project,
  statuses: Readonly<Record<string, NodeStatus>>,
): string | null {
  for (const depId of node.dependencies ?? []) {
    if (statuses[depId] === "error" || statuses[depId] === "skipped") return depId;
  }
  return null;
}
