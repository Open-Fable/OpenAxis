// OpenHub — Self-update engine (no Apple Developer account required)
//
// Downloads a .zip from GitHub Releases, verifies its SHA-256 against a
// CI-published .sha256 sidecar file (U1), swaps the running .app via a
// detached helper script, and relaunches. The renderer never receives a
// disk path (U2) — it only calls parameterless IPC channels.

import { app, Notification, shell } from "electron";
import { spawn } from "child_process";
import { createHash } from "crypto";
import path from "path";
import { promises as fs, constants as fsConstants } from "fs";
import os from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateInfo {
  readonly version: string;
  readonly zipUrl: string;
  readonly shaUrl: string;
}

export type UpdateStatus =
  | { stage: "idle" }
  | { stage: "checking" }
  | { stage: "available"; version: string }
  | { stage: "downloading"; version: string; percent: number }
  | { stage: "ready"; version: string }
  | { stage: "error"; message: string };

export interface UpdaterDeps {
  getProcessManager: () => { stopAll: () => void } | null;
  onStatusChange: (status: UpdateStatus) => void;
  githubToken?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/Open-Fable/OpenHub/releases/latest";

const ALLOWED_HOSTS = new Set(["github.com", "objects.githubusercontent.com"]);

// ---------------------------------------------------------------------------
// Module state (U9: concurrency guard)
// ---------------------------------------------------------------------------

let inProgress = false;
let currentStatus: UpdateStatus = { stage: "idle" };
let latestInfo: UpdateInfo | null = null;
let deps: UpdaterDeps | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initUpdater(d: UpdaterDeps): void {
  deps = d;
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!app.isPackaged) return null; // U4
  if (inProgress) return latestInfo;

  setStatus({ stage: "checking" });
  try {
    const info = await fetchLatestRelease();
    if (info) {
      latestInfo = info;
      setStatus({ stage: "available", version: info.version });
    } else {
      setStatus({ stage: "idle" });
    }
    return info;
  } catch {
    setStatus({ stage: "idle" });
    return null;
  }
}

export async function downloadAndInstall(): Promise<void> {
  if (!app.isPackaged) return; // U4
  if (inProgress) return; // U9
  if (!latestInfo) return;

  inProgress = true;
  let tmpDir: string | null = null;
  try {
    const staged = await downloadAndStage(latestInfo, (dir) => {
      tmpDir = dir;
    });
    await applyAndRelaunch(staged);
  } catch (err) {
    // Clean up the staging directory on any failure (R3)
    if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    setStatus({ stage: "error", message });
    inProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function setStatus(s: UpdateStatus): void {
  currentStatus = s;
  deps?.onStatusChange(s);
}

function isAllowedHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// Parse a simple "vX.Y.Z" tag into comparable parts.
function parseVersion(
  tag: string,
): { major: number; minor: number; patch: number } | null {
  const m = tag.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function isNewer(remote: string, local: string): boolean {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (!r || !l) return false;
  if (r.major !== l.major) return r.major > l.major;
  if (r.minor !== l.minor) return r.minor > l.minor;
  return r.patch > l.patch;
}

async function fetchLatestRelease(): Promise<UpdateInfo | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (deps?.githubToken) {
    headers["Authorization"] = `Bearer ${deps.githubToken}`;
  }
  const resp = await fetch(GITHUB_RELEASES_URL, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    tag_name?: string;
    assets?: Array<{
      name: string;
      browser_download_url: string;
    }>;
  };

  const tagName = data.tag_name;
  if (typeof tagName !== "string") return null;
  if (!isNewer(tagName, app.getVersion())) return null;

  const assets = data.assets;
  if (!Array.isArray(assets)) return null;

  // Anchor the asset name to a strict product+version pattern
  const version = tagName.replace(/^v/, "");
  const expectedZipName = `OpenHub-${version}-${process.arch}-mac.zip`;
  const zipAsset = assets.find((a) => a.name === expectedZipName);
  if (!zipAsset) return null;

  const shaAsset = assets.find((a) => a.name === `${expectedZipName}.sha256`);
  if (!shaAsset) return null;

  // U3: only allow known hosts
  if (!isAllowedHost(zipAsset.browser_download_url)) return null;
  if (!isAllowedHost(shaAsset.browser_download_url)) return null;

  return {
    version: tagName.replace(/^v/, ""),
    zipUrl: zipAsset.browser_download_url,
    shaUrl: shaAsset.browser_download_url,
  };
}

async function downloadAndStage(
  info: UpdateInfo,
  onTmpDir: (dir: string) => void,
): Promise<string> {
  setStatus({ stage: "downloading", version: info.version, percent: 0 });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openhub-update-"));
  onTmpDir(tmpDir);
  await fs.chmod(tmpDir, 0o700);

  const zipPath = path.join(tmpDir, "update.zip");
  const shaPath = path.join(tmpDir, "update.sha256");

  // Download .sha256 first (tiny)
  const shaResp = await fetch(info.shaUrl, { signal: AbortSignal.timeout(30_000) });
  if (!shaResp.ok) throw new Error(`SHA-256 download failed: ${shaResp.status}`);
  const expectedHash = (await shaResp.text()).trim().split(/\s/)[0].toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error("Invalid SHA-256 format in checksum file");
  }
  await fs.writeFile(shaPath, expectedHash, "utf8");

  // Download .zip with progress
  const zipResp = await fetch(info.zipUrl, { signal: AbortSignal.timeout(600_000) });
  if (!zipResp.ok) throw new Error(`ZIP download failed: ${zipResp.status}`);

  const contentLength = parseInt(zipResp.headers.get("content-length") ?? "0", 10);
  const reader = zipResp.body?.getReader();
  if (!reader) throw new Error("No response body");

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (contentLength > 0) {
      const percent = Math.round((received / contentLength) * 100);
      setStatus({ stage: "downloading", version: info.version, percent });
    }
  }
  const zipBuffer = Buffer.concat(chunks);

  // U1: verify SHA-256 (fail-closed)
  const actualHash = createHash("sha256").update(zipBuffer).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA-256 mismatch: expected ${expectedHash.slice(0, 12)}…, got ${actualHash.slice(0, 12)}…`,
    );
  }

  await fs.writeFile(zipPath, zipBuffer);

  // Unzip with ditto (preserves macOS symlinks, resource forks, and xattrs — U5)
  const extractDir = path.join(tmpDir, "extracted");
  await fs.mkdir(extractDir, { recursive: true });
  await execPromise("ditto", ["-x", "-k", zipPath, extractDir]);

  // Locate OpenHub.app inside the extracted folder (anchored name)
  const entries = await fs.readdir(extractDir);
  const appEntry = entries.find((e) => e === "OpenHub.app");
  if (!appEntry) throw new Error("No OpenHub.app found in zip");

  setStatus({ stage: "ready", version: info.version });
  return path.join(extractDir, appEntry);
}

async function applyAndRelaunch(newAppPath: string): Promise<void> {
  // U8: stop all child processes before swap
  const pm = deps?.getProcessManager();
  if (pm) pm.stopAll();
  // Small grace period for process cleanup
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Resolve current bundle root from process.execPath
  // e.g. /Applications/OpenHub.app/Contents/MacOS/OpenHub → /Applications/OpenHub.app
  const execPath = process.execPath;
  const contentsIdx = execPath.indexOf("/Contents/MacOS/");
  if (contentsIdx < 0) throw new Error("Cannot resolve .app bundle path");
  const bundlePath = execPath.substring(0, contentsIdx);
  if (!bundlePath.endsWith(".app")) {
    throw new Error(`Unexpected bundle path: ${bundlePath}`);
  }

  // U6: test writability of the parent directory
  const parentDir = path.dirname(bundlePath);
  try {
    await fs.access(parentDir, fsConstants.W_OK);
  } catch {
    // Fallback: open the Releases page in the browser
    shell.openExternal("https://github.com/Open-Fable/OpenHub/releases/latest");
    throw new Error(
      "Le dossier contenant OpenHub n'est pas modifiable. " +
        "La page des téléchargements a été ouverte dans votre navigateur.",
    );
  }

  const pid = process.pid;
  const oldApp = `${bundlePath}.old`;
  const tmpDir = path.dirname(newAppPath);

  // Shell-safe quoting: single quotes prevent all interpretation ($, `, ", \).
  // Embed a literal single quote via '\'' (end quote, escaped quote, reopen).
  const sq = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

  // Write the swap script (all paths shell-quoted — R2)
  const script = `#!/bin/bash
# Wait for the main process to exit
while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done
sleep 1

BUNDLE=${sq(bundlePath)}
OLD=${sq(oldApp)}
NEW=${sq(newAppPath)}
TMP=${sq(tmpDir)}

# Move-aside current → .old (U5)
if [ -d "$OLD" ]; then rm -rf "$OLD"; fi
mv "$BUNDLE" "$OLD"

# Place the new bundle — restore .old on failure (U5)
if ! mv "$NEW" "$BUNDLE"; then
  mv "$OLD" "$BUNDLE" 2>/dev/null || true
  open "$BUNDLE"
  exit 1
fi

# Strip quarantine just in case
xattr -dr com.apple.quarantine "$BUNDLE" 2>/dev/null || true

# Clean up old bundle and tmp
rm -rf "$OLD" 2>/dev/null || true
rm -rf "$TMP" 2>/dev/null || true

# Relaunch
open "$BUNDLE"
`;

  const scriptPath = path.join(tmpDir, "swap.sh");
  await fs.writeFile(scriptPath, script, { mode: 0o700 });

  // Launch the detached swap script
  const child = spawn("/bin/bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Show a brief notification before quitting
  if (Notification.isSupported()) {
    const n = new Notification({
      title: "OpenHub — Mise à jour",
      body: `Installation de la v${latestInfo?.version ?? "?"}. L'app va redémarrer.`,
      silent: true,
    });
    n.show();
  }

  app.quit();
}

function execPromise(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "ignore" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}
