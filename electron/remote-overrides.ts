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

const BASE_URL = "https://raw.githubusercontent.com/1zalt/OpenHub/remote-overrides";

const CACHE_DIR = path.join(os.homedir(), ".config", "openhub", "remote-overrides");

const MANIFEST_FILENAME = "manifest.json";
const FETCH_TIMEOUT_MS = 10_000;
const FILE_TIMEOUT_MS = 15_000;

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
    const filePath = path.join(CACHE_DIR, appDir, `${name}.${type}`);
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
export { CACHE_DIR, BASE_URL };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function fetchManifest(): Promise<RemoteManifest | null> {
  const url = `${BASE_URL}/${MANIFEST_FILENAME}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) return null;

  const data = (await resp.json()) as RemoteManifest;
  if (typeof data.version !== "number" || !data.overrides) return null;
  return data;
}

async function readCachedManifest(): Promise<RemoteManifest | null> {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, MANIFEST_FILENAME), "utf-8");
    return JSON.parse(raw) as RemoteManifest;
  } catch {
    return null;
  }
}

async function syncFiles(manifest: RemoteManifest): Promise<void> {
  for (const [appDir, entries] of Object.entries(manifest.overrides)) {
    const dir = path.join(CACHE_DIR, appDir);
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
  const localPath = path.join(CACHE_DIR, appDir, `${name}.${type}`);

  // Skip download if cached file matches expected hash
  if (await hashMatches(localPath, expectedHash)) return;

  const url = `${BASE_URL}/${appDir}/${name}.${type}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  if (!resp.ok) return;

  const content = await resp.text();

  // Verify integrity before writing
  const actualHash = createHash("sha256").update(content, "utf-8").digest("hex");
  if (!actualHash.startsWith(expectedHash) && expectedHash !== actualHash) return;

  await fs.writeFile(localPath, content, "utf-8");
}

async function hashMatches(filePath: string, expectedHash: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const hash = createHash("sha256").update(content, "utf-8").digest("hex");
    return hash === expectedHash || hash.startsWith(expectedHash);
  } catch {
    return false;
  }
}
