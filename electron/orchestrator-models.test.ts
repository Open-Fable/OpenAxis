import { describe, it, expect } from "vitest";
import {
  resolveModelForRole,
  roleFromProjectType,
  ROLE_MODEL_TABLE,
  type RoleModelOverrides,
} from "./orchestrator-models.js";

describe("resolveModelForRole", () => {
  it("returns fallbackModel when no overrides", () => {
    expect(resolveModelForRole("planning", "gpt-4o")).toBe("gpt-4o");
  });

  it("returns strong override for planning role", () => {
    const overrides: RoleModelOverrides = { strong: "claude-opus", fast: "claude-haiku" };
    expect(resolveModelForRole("planning", "gpt-4o", overrides)).toBe("claude-opus");
  });

  it("returns fast override for execution_code role", () => {
    const overrides: RoleModelOverrides = { strong: "claude-opus", fast: "claude-haiku" };
    expect(resolveModelForRole("execution_code", "gpt-4o", overrides)).toBe(
      "claude-haiku",
    );
  });

  it("returns fast override for recon role", () => {
    const overrides: RoleModelOverrides = { strong: "claude-opus", fast: "claude-haiku" };
    expect(resolveModelForRole("recon", "gpt-4o", overrides)).toBe("claude-haiku");
  });

  it("falls back to fallbackModel when override tier is missing", () => {
    const overrides: RoleModelOverrides = { strong: "claude-opus" };
    expect(resolveModelForRole("execution_code", "gpt-4o", overrides)).toBe("gpt-4o");
  });

  it("returns undefined when no fallback and no override", () => {
    expect(resolveModelForRole("planning", undefined)).toBeUndefined();
  });
});

describe("roleFromProjectType", () => {
  it("maps code to execution_code", () => {
    expect(roleFromProjectType("code")).toBe("execution_code");
  });

  it("maps design to execution_code", () => {
    expect(roleFromProjectType("design")).toBe("execution_code");
  });

  it("maps verifier to verification", () => {
    expect(roleFromProjectType("verifier")).toBe("verification");
  });

  it("maps work to execution_llm", () => {
    expect(roleFromProjectType("work")).toBe("execution_llm");
  });

  it("maps recherche to execution_llm", () => {
    expect(roleFromProjectType("recherche")).toBe("execution_llm");
  });

  it("maps undefined to execution_llm", () => {
    expect(roleFromProjectType(undefined)).toBe("execution_llm");
  });
});

describe("ROLE_MODEL_TABLE", () => {
  it("covers all known roles", () => {
    const roles = ROLE_MODEL_TABLE.map((e) => e.role);
    expect(roles).toContain("planning");
    expect(roles).toContain("triage");
    expect(roles).toContain("verification");
    expect(roles).toContain("recon");
    expect(roles).toContain("execution_code");
    expect(roles).toContain("execution_llm");
  });

  it("planning and triage prefer strong tier", () => {
    const planning = ROLE_MODEL_TABLE.find((e) => e.role === "planning");
    const triage = ROLE_MODEL_TABLE.find((e) => e.role === "triage");
    expect(planning?.preferTier).toBe("strong");
    expect(triage?.preferTier).toBe("strong");
  });

  it("execution roles prefer fast tier", () => {
    const code = ROLE_MODEL_TABLE.find((e) => e.role === "execution_code");
    const llm = ROLE_MODEL_TABLE.find((e) => e.role === "execution_llm");
    expect(code?.preferTier).toBe("fast");
    expect(llm?.preferTier).toBe("fast");
  });
});
