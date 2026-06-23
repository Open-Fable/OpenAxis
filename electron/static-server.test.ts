import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import path from "path";
import { startStaticServer, type StaticServerHandle } from "./static-server.js";

// ---------------------------------------------------------------------------
// Integration test — boots the real static SPA server on an ephemeral loopback
// port and verifies asset serving, security headers, the history-API fallback,
// and that express.static rejects path traversal. Uses a configurable port, so
// (unlike the proxy) it never collides with a running OpenAxis instance.
// ---------------------------------------------------------------------------

const PORT = 19987;
const BASE = `http://127.0.0.1:${PORT}`;

let rootDir: string;
let handle: StaticServerHandle;

beforeAll(async () => {
  rootDir = await fs.mkdtemp(path.join(tmpdir(), "openaxis-static-"));
  await fs.writeFile(
    path.join(rootDir, "index.html"),
    "<!doctype html><title>shell</title><div id=app></div>",
  );
  await fs.writeFile(path.join(rootDir, "app.js"), "console.warn('asset');");
  // A secret sibling OUTSIDE rootDir, to assert traversal cannot reach it.
  await fs.writeFile(path.join(tmpdir(), "openaxis-static-secret.txt"), "TOP SECRET");
  handle = await startStaticServer(rootDir, PORT);
}, 15_000);

afterAll(async () => {
  await handle?.close();
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe("startStaticServer", () => {
  it("serves a real static asset with its content", async () => {
    const res = await fetch(`${BASE}/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("asset");
  });

  it("serves index.html at the root", async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("shell");
  });

  it("falls back to index.html for an unknown client route (SPA history API)", async () => {
    const res = await fetch(`${BASE}/some/deep/client/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("shell");
  });

  it("sets hardening security headers on every response", async () => {
    const res = await fetch(`${BASE}/app.js`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("does not leak files outside the root via path traversal", async () => {
    // Encoded traversal that express.static must refuse. Even if routed to the
    // SPA fallback, the response must be the app shell, never the secret file.
    const res = await fetch(`${BASE}/..%2fopenaxis-static-secret.txt`);
    expect(await res.text()).not.toContain("TOP SECRET");
  });
});
