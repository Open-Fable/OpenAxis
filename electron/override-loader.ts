import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { SlotName } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_DIR = path.join(__dirname, "overrides");

type OverrideIndex = Record<string, Record<string, boolean>>;

async function readIndex(): Promise<OverrideIndex> {
  const raw = await fs.readFile(path.join(OVERRIDES_DIR, "index.json"), "utf-8");
  return JSON.parse(raw) as OverrideIndex;
}

export async function loadOverrides(
  slot: Exclude<SlotName, "config" | "chat" | "projects">,
  type: "css" | "js",
): Promise<string[]> {
  const index = await readIndex();
  const results: string[] = [];

  // Global overrides apply to all slots
  for (const [name, enabled] of Object.entries(index["global"] ?? {})) {
    if (!enabled) continue;
    const content = await readFileSafe(
      path.join(OVERRIDES_DIR, "global", `${name}.${type}`),
    );
    if (content) results.push(content);
  }

  // Slot-specific overrides
  const appName = slotToAppName(slot);
  for (const [name, enabled] of Object.entries(index[appName] ?? {})) {
    if (!enabled) continue;
    const content = await readFileSafe(
      path.join(OVERRIDES_DIR, appName, `${name}.${type}`),
    );
    if (content) results.push(content);
  }

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
