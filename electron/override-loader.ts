import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { SlotName } from "./types.js";
import { loadRemoteOverrides } from "./remote-overrides.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_DIR = path.join(__dirname, "overrides");

// Override names come from index.json keys; constrain them so a crafted key like
// "../../something" can never escape OVERRIDES_DIR and load arbitrary files.
const OVERRIDE_NAME_RE = /^[a-z0-9_-]+$/i;

type OverrideIndex = Record<string, Record<string, boolean>>;

function safeOverridePath(
  subdir: string,
  name: string,
  type: "css" | "js",
): string | null {
  if (!OVERRIDE_NAME_RE.test(name)) return null;
  const full = path.resolve(OVERRIDES_DIR, subdir, `${name}.${type}`);
  const root = path.resolve(OVERRIDES_DIR);
  return full.startsWith(root + path.sep) ? full : null;
}

async function readIndex(): Promise<OverrideIndex> {
  const raw = await fs.readFile(path.join(OVERRIDES_DIR, "index.json"), "utf-8");
  return JSON.parse(raw) as OverrideIndex;
}

// Override files (index.json + the CSS/JS assets) are static at runtime: they
// ship with the app and never change while it runs. loadOverrides is called on
// EVERY navigation, including the frequent did-navigate-in-page events fired by
// the SPAs — without this cache each route change re-read index.json plus every
// override file from disk. Memoize the assembled result per slot+type so the
// hot path stays in memory.
const overridesCache = new Map<string, string[]>();

// Drops the in-memory override cache so the next loadOverrides re-reads from
// disk. Used by tests and after update:apps rewrites the override files.
export function clearOverridesCache(): void {
  overridesCache.clear();
}

export async function loadOverrides(
  slot: Exclude<SlotName, "config" | "chat" | "projects">,
  type: "css" | "js",
): Promise<string[]> {
  const cacheKey = `${slot}:${type}`;
  const cached = overridesCache.get(cacheKey);
  if (cached) return cached;

  const index = await readIndex();
  const results: string[] = [];

  // Global overrides apply to all slots
  for (const [name, enabled] of Object.entries(index["global"] ?? {})) {
    if (!enabled) continue;
    const safePath = safeOverridePath("global", name, type);
    if (!safePath) {
      console.warn(`[overrides] Rejected unsafe override name: ${name}`);
      continue;
    }
    const content = await readFileSafe(safePath);
    if (content) results.push(content);
  }

  // Slot-specific overrides
  const appName = slotToAppName(slot);
  for (const [name, enabled] of Object.entries(index[appName] ?? {})) {
    if (!enabled) continue;
    const safePath = safeOverridePath(appName, name, type);
    if (!safePath) {
      console.warn(`[overrides] Rejected unsafe override name: ${name}`);
      continue;
    }
    const content = await readFileSafe(safePath);
    if (content) results.push(content);
  }

  // Layer remote overrides on top of bundled ones (additions + replacements)
  const globalRemote = await loadRemoteOverrides("global", type);
  const slotRemote = await loadRemoteOverrides(appName, type);
  results.push(...globalRemote, ...slotRemote);

  overridesCache.set(cacheKey, results);
  return results;
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null; // file doesn't exist for this type — normal
  }
}

function slotToAppName(slot: Exclude<SlotName, "config" | "chat" | "projects">): string {
  const map: Record<Exclude<SlotName, "config" | "chat" | "projects">, string> = {
    work: "openwork",
    code: "opencode",
    design: "open-design",
  };
  return map[slot];
}
