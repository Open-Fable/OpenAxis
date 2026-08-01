import { describe, it, expect } from "vitest";
import {
  sanitizeInterfaceContract,
  buildContractsFileContent,
  buildContractContextForAgent,
  type InterfaceContract,
} from "./orchestrator-contracts.js";

describe("sanitizeInterfaceContract", () => {
  it("accepts a valid contract", () => {
    const result = sanitizeInterfaceContract({
      name: "UserAPI",
      producers: ["agent-a"],
      consumers: ["agent-b"],
      definition: "interface User { id: string; name: string }",
    });
    expect(result).not.toBeNull();
    expect(result!.name).toBe("UserAPI");
    expect(result!.producers).toEqual(["agent-a"]);
    expect(result!.consumers).toEqual(["agent-b"]);
  });

  it("rejects null input", () => {
    expect(sanitizeInterfaceContract(null)).toBeNull();
  });

  it("rejects missing name", () => {
    expect(sanitizeInterfaceContract({ definition: "x", producers: ["a"] })).toBeNull();
  });

  it("rejects empty definition", () => {
    expect(
      sanitizeInterfaceContract({ name: "X", definition: "", producers: ["a"] }),
    ).toBeNull();
  });

  it("rejects no producers and no consumers", () => {
    expect(
      sanitizeInterfaceContract({
        name: "X",
        definition: "y",
        producers: [],
        consumers: [],
      }),
    ).toBeNull();
  });

  it("filters invalid producer entries", () => {
    const result = sanitizeInterfaceContract({
      name: "API",
      definition: "type X = string",
      producers: ["valid", 42, "", null],
      consumers: ["ok"],
    });
    expect(result!.producers).toEqual(["valid"]);
  });

  it("truncates definition to 8192 chars", () => {
    const long = "x".repeat(10000);
    const result = sanitizeInterfaceContract({
      name: "Big",
      definition: long,
      producers: ["a"],
      consumers: [],
    });
    expect(result!.definition).toHaveLength(8192);
  });
});

describe("buildContractsFileContent", () => {
  const contracts: InterfaceContract[] = [
    {
      name: "UserService",
      producers: ["backend"],
      consumers: ["frontend"],
      definition: "interface UserService { getUser(id: string): User }",
    },
    {
      name: "AuthToken",
      producers: ["auth"],
      consumers: ["backend", "frontend"],
      definition: "type AuthToken = { token: string; expiresAt: number }",
    },
  ];

  it("produces markdown with all contracts", () => {
    const content = buildContractsFileContent(contracts);
    expect(content).toContain("# Interface Contracts");
    expect(content).toContain("## UserService");
    expect(content).toContain("## AuthToken");
    expect(content).toContain("Producers: backend");
    expect(content).toContain("Consumers: frontend");
    expect(content).toContain("interface UserService");
  });

  it("returns empty string for empty contracts", () => {
    expect(buildContractsFileContent([])).toBe("");
  });
});

describe("buildContractContextForAgent", () => {
  const contracts: InterfaceContract[] = [
    {
      name: "DataSchema",
      producers: ["agent-db"],
      consumers: ["agent-api"],
      definition: "type Schema = { tables: Table[] }",
    },
    {
      name: "UIConfig",
      producers: ["agent-api"],
      consumers: ["agent-ui"],
      definition: "interface Config { theme: string }",
    },
  ];

  it("includes relevant contracts for a producer", () => {
    const ctx = buildContractContextForAgent("agent-db", contracts);
    expect(ctx).toContain("DataSchema");
    expect(ctx).toContain("PRODUCER");
    expect(ctx).not.toContain("UIConfig");
  });

  it("includes relevant contracts for a consumer", () => {
    const ctx = buildContractContextForAgent("agent-api", contracts);
    expect(ctx).toContain("DataSchema");
    expect(ctx).toContain("CONSUMER");
    expect(ctx).toContain("UIConfig");
    expect(ctx).toContain("PRODUCER");
  });

  it("returns empty string for unrelated agent", () => {
    expect(buildContractContextForAgent("agent-unknown", contracts)).toBe("");
  });
});
