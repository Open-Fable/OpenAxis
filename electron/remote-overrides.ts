import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RemoteOverrideEntry {
  readonly hash: string;
  readonly types: ReadonlyArray<"css" | "js">;
}

interface RemoteManifest {
  readonly version: number;
  readonly overrides: Readonly<Record<string, Record<string, RemoteOverrideEntry>>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = "https://raw.githubusercontent.com/Open-Fable/OpenAxis/remote-overrides";

const CACHE_DIR = path.join(os.homedir(), ".config", "openaxis", "remote-overrides");

const MANIFEST_FILENAME = "manifest.json";
const FETCH_TIMEOUT_MS = 10_000;
const FILE_TIMEOUT_MS = 15_000;

const ALLOWED_APP_DIRS = new Set(["global", "openwork", "opencode", "open-design"]);
const OVERRIDE_NAME_RE = /^[a-z0-9_-]+$/i;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const ALLOWED_TYPES = new Set<string>(["css", "js"]);
const MAX_MANIFEST_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let synced = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Fetch the remote manifest and download changed files. Non-blocking — caller
 *  should fire-and-forget at startup. Errors are swallowed (offline = skip). */
export async function syncRemoteOverrides(): Promise<void> {
  if (synced) return;
  try {
    const manifest = await fetchManifest();
    if (!manifest) return;
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await syncFiles(manifest);
    await fs.writeFile(
      path.join(CACHE_DIR, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
    synced = true;
  } catch {
    // Offline or server error — silently use cached overrides
  }
}

/** Load cached remote overrides for a given app directory and file type.
 *  Returns an array of file contents (same contract as the bundled loader). */
export async function loadRemoteOverrides(
  appDir: string,
  type: "css" | "js",
): Promise<string[]> {
  const manifest = await readCachedManifest();
  if (!manifest) return [];

  const results: string[] = [];
  const section = manifest.overrides[appDir];
  if (!section) return results;

  for (const [name, entry] of Object.entries(section)) {
    if (!entry.types.includes(type)) continue;
    const filePath = safeRemotePath(appDir, name, type);
    if (!filePath) continue;
    try {
      results.push(await fs.readFile(filePath, "utf-8"));
    } catch {
      // File missing from cache — skip
    }
  }
  return results;
}

/** Remove all cached remote overrides. */
export async function clearRemoteCache(): Promise<void> {
  synced = false;
  await fs.rm(CACHE_DIR, { recursive: true, force: true });
}

// Exposed for testing
export { CACHE_DIR, BASE_URL, ALLOWED_APP_DIRS, SHA256_HEX_RE, validateManifest };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function safeRemotePath(appDir: string, name: string, type: string): string | null {
  if (!ALLOWED_APP_DIRS.has(appDir)) return null;
  if (!OVERRIDE_NAME_RE.test(name)) return null;
  if (!ALLOWED_TYPES.has(type)) return null;
  const full = path.resolve(CACHE_DIR, appDir, `${name}.${type}`);
  return full.startsWith(path.resolve(CACHE_DIR) + path.sep) ? full : null;
}

function validateManifest(data: unknown): RemoteManifest | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.version !== "number") return null;
  if (typeof obj.overrides !== "object" || obj.overrides === null) return null;

  const overrides = obj.overrides as Record<string, unknown>;
  const validated: Record<string, Record<string, RemoteOverrideEntry>> = {};

  for (const [appDir, entries] of Object.entries(overrides)) {
    if (!ALLOWED_APP_DIRS.has(appDir)) continue;
    if (typeof entries !== "object" || entries === null) continue;

    const section: Record<string, RemoteOverrideEntry> = {};
    for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (!OVERRIDE_NAME_RE.test(name)) continue;
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.hash !== "string" || !SHA256_HEX_RE.test(e.hash)) continue;
      if (!Array.isArray(e.types)) continue;
      const types = (e.types as unknown[]).filter(
        (t): t is "css" | "js" => typeof t === "string" && ALLOWED_TYPES.has(t),
      );
      if (types.length === 0) continue;
      section[name] = { hash: e.hash, types };
    }
    if (Object.keys(section).length > 0) validated[appDir] = section;
  }

  return { version: obj.version as number, overrides: validated };
}

async function fetchManifest(): Promise<RemoteManifest | null> {
  const url = `${BASE_URL}/${MANIFEST_FILENAME}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) return null;

  const lengthHeader = resp.headers.get("content-length");
  if (lengthHeader && parseInt(lengthHeader, 10) > MAX_MANIFEST_BYTES) return null;

  const text = await resp.text();
  if (text.length > MAX_MANIFEST_BYTES) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return validateManifest(raw);
}

async function readCachedManifest(): Promise<RemoteManifest | null> {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, MANIFEST_FILENAME), "utf-8");
    return validateManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function syncFiles(manifest: RemoteManifest): Promise<void> {
  for (const [appDir, entries] of Object.entries(manifest.overrides)) {
    if (!ALLOWED_APP_DIRS.has(appDir)) continue;
    const dir = path.resolve(CACHE_DIR, appDir);
    if (!dir.startsWith(path.resolve(CACHE_DIR) + path.sep)) continue;
    await fs.mkdir(dir, { recursive: true });

    for (const [name, entry] of Object.entries(entries)) {
      for (const type of entry.types) {
        await syncOneFile(appDir, name, type, entry.hash);
      }
    }
  }
}

async function syncOneFile(
  appDir: string,
  name: string,
  type: "css" | "js",
  expectedHash: string,
): Promise<void> {
  if (!SHA256_HEX_RE.test(expectedHash)) return;
  const localPath = safeRemotePath(appDir, name, type);
  if (!localPath) return;

  if (await hashMatches(localPath, expectedHash)) return;

  const url = `${BASE_URL}/${appDir}/${name}.${type}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  if (!resp.ok) return;

  const content = await resp.text();

  const actualHash = createHash("sha256").update(content, "utf-8").digest("hex");
  if (actualHash !== expectedHash) return;

  await fs.writeFile(localPath, content, "utf-8");
}

async function hashMatches(filePath: string, expectedHash: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const hash = createHash("sha256").update(content, "utf-8").digest("hex");
    return hash === expectedHash;
  } catch {
    return false;
  }
}
