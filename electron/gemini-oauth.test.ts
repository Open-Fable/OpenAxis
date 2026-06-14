import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  base64url,
  buildPkce,
  buildAuthUrl,
  normalizeProjectId,
  formatRefreshParts,
} from "./gemini-oauth.js";

describe("formatRefreshParts", () => {
  it("returns the bare refresh token when no project nor managed id", () => {
    expect(formatRefreshParts({ refreshToken: "tok" })).toBe("tok");
  });

  it("treats empty-string segments as absent", () => {
    expect(
      formatRefreshParts({ refreshToken: "tok", projectId: "", managedProjectId: "" }),
    ).toBe("tok");
  });

  it("packs a managed-project-only token with an empty middle segment", () => {
    expect(
      formatRefreshParts({ refreshToken: "tok", managedProjectId: "managed-123" }),
    ).toBe("tok||managed-123");
  });

  it("packs project and managed ids", () => {
    expect(
      formatRefreshParts({
        refreshToken: "tok",
        projectId: "proj",
        managedProjectId: "managed",
      }),
    ).toBe("tok|proj|managed");
  });

  it("produces a string the proxy can split back: managed id is segment index 2", () => {
    // The proxy reads parts[2] as the managed project id. Guard that contract.
    const packed = formatRefreshParts({
      refreshToken: "tok",
      managedProjectId: "managed-123",
    });
    const parts = packed.split("|");
    expect(parts[0]).toBe("tok");
    expect(parts[2]).toBe("managed-123");
  });
});

describe("normalizeProjectId", () => {
  it("returns undefined for undefined", () => {
    expect(normalizeProjectId(undefined)).toBeUndefined();
  });

  it("returns undefined for empty or whitespace strings", () => {
    expect(normalizeProjectId("")).toBeUndefined();
    expect(normalizeProjectId("   ")).toBeUndefined();
  });

  it("trims and returns a non-empty string", () => {
    expect(normalizeProjectId("  proj-1  ")).toBe("proj-1");
  });

  it("extracts and trims the id from an object", () => {
    expect(normalizeProjectId({ id: " proj-2 " })).toBe("proj-2");
  });

  it("returns undefined for an object with empty or missing id", () => {
    expect(normalizeProjectId({ id: "  " })).toBeUndefined();
    expect(normalizeProjectId({})).toBeUndefined();
  });
});

describe("base64url", () => {
  it("produces a url-safe string with no +, / or = padding", () => {
    // 0xFB 0xFF 0xFE encodes to "+/+" / "=" in standard base64 → exercises all replacements.
    const out = base64url(Buffer.from([0xfb, 0xff, 0xfe, 0xff, 0xff]));
    expect(out).not.toMatch(/[+/=]/);
  });
});

describe("buildPkce", () => {
  it("derives the challenge as base64url(sha256(verifier))", () => {
    const { verifier, challenge } = buildPkce();
    const expected = base64url(createHash("sha256").update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it("generates a fresh verifier each call", () => {
    expect(buildPkce().verifier).not.toBe(buildPkce().verifier);
  });
});

describe("buildAuthUrl", () => {
  it("sets the OAuth + PKCE query parameters Google requires for offline access", () => {
    const url = new URL(buildAuthUrl("CHALLENGE_X", "STATE_Y"));
    const p = url.searchParams;

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe("http://localhost:8085/oauth2callback");
    expect(p.get("code_challenge")).toBe("CHALLENGE_X");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("STATE_Y");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("client_id")).toBeTruthy();
    expect(p.get("scope")).toContain("https://www.googleapis.com/auth/cloud-platform");
  });
});
