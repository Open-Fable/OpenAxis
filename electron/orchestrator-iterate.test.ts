import { describe, it, expect } from "vitest";
import { buildFixTask } from "./orchestrator-iterate.js";

describe("buildFixTask", () => {
  it("embeds the user feedback and the requested fix", () => {
    const out = buildFixTask("Corrige le header", "Le header est cassé");
    expect(out).toContain("[ITÉRATION CORRECTIVE]");
    expect(out).toContain("Le header est cassé");
    expect(out).toContain("Corrige le header");
  });

  it("omits the previous-result block when no previous result is given", () => {
    const out = buildFixTask("fix", "feedback");
    expect(out).not.toContain("TON RÉSULTAT PRÉCÉDENT");
  });

  it("includes the previous-result block when provided", () => {
    const out = buildFixTask("fix", "feedback", "ancien résultat");
    expect(out).toContain("TON RÉSULTAT PRÉCÉDENT");
    expect(out).toContain("ancien résultat");
  });

  it("truncates the previous result to 4000 characters", () => {
    const huge = "p".repeat(5000);
    const out = buildFixTask("fix", "feedback", huge);
    expect(out).toContain("p".repeat(4000));
    expect(out).not.toContain("p".repeat(4001));
  });

  it("always restates the critical rules about modifying existing files", () => {
    const out = buildFixTask("fix", "feedback");
    expect(out).toContain("RÈGLES CRITIQUES");
    expect(out).toContain("MODIFIE-les");
  });
});
