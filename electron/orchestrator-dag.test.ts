import { describe, expect, it } from "vitest";
import { resolveDAG, resolveDAGWaves, findFailedDependency } from "./orchestrator-dag.js";
import type { Project } from "./project-store.js";

function makeNode(id: string, deps: string[] = []): Project {
  return {
    id,
    name: `Node ${id}`,
    instructions: "",
    color: "#000",
    dependencies: deps,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("resolveDAGWaves", () => {
  it("places independent nodes in a single wave", () => {
    const waves = resolveDAGWaves([makeNode("a"), makeNode("b"), makeNode("c")]);
    expect(waves).toHaveLength(1);
    expect(waves[0].map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("chains dependent nodes into separate waves", () => {
    const waves = resolveDAGWaves([
      makeNode("a"),
      makeNode("b", ["a"]),
      makeNode("c", ["b"]),
    ]);
    expect(waves).toHaveLength(3);
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("groups nodes with a shared dependency in one wave", () => {
    //   a → {b, c} → d
    const waves = resolveDAGWaves([
      makeNode("a"),
      makeNode("b", ["a"]),
      makeNode("c", ["a"]),
      makeNode("d", ["b", "c"]),
    ]);
    expect(waves).toHaveLength(3);
    expect(waves[0].map((n) => n.id)).toEqual(["a"]);
    expect(waves[1].map((n) => n.id).sort()).toEqual(["b", "c"]);
    expect(waves[2].map((n) => n.id)).toEqual(["d"]);
  });

  it("throws on a circular dependency", () => {
    expect(() => resolveDAGWaves([makeNode("a", ["b"]), makeNode("b", ["a"])])).toThrow(
      "Circular dependency",
    );
  });

  it("ignores dependencies on nodes outside the input set", () => {
    const waves = resolveDAGWaves([makeNode("a", ["external"]), makeNode("b", ["a"])]);
    expect(waves.map((w) => w.map((n) => n.id))).toEqual([["a"], ["b"]]);
  });

  it("returns an empty array for empty input", () => {
    expect(resolveDAGWaves([])).toEqual([]);
  });
});

describe("resolveDAG", () => {
  it("orders dependencies before dependents", () => {
    const order = resolveDAG([makeNode("c", ["b"]), makeNode("a"), makeNode("b", ["a"])]);
    const ids = order.map((n) => n.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
  });

  it("throws on a circular dependency", () => {
    expect(() => resolveDAG([makeNode("a", ["b"]), makeNode("b", ["a"])])).toThrow(
      "Circular dependency",
    );
  });
});

describe("findFailedDependency", () => {
  it("returns the id of a failed or skipped dependency", () => {
    const node = makeNode("x", ["a", "b"]);
    expect(findFailedDependency(node, { a: "done", b: "error" })).toBe("b");
    expect(findFailedDependency(node, { a: "skipped", b: "done" })).toBe("a");
  });

  it("returns null when all dependencies are clear", () => {
    const node = makeNode("x", ["a", "b"]);
    expect(findFailedDependency(node, { a: "done", b: "done" })).toBeNull();
    expect(findFailedDependency(makeNode("y"), {})).toBeNull();
  });
});
