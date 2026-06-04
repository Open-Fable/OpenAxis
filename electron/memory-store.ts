import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

export interface MemoryFact {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

export interface MemoryData {
  readonly enabled: boolean;
  readonly profile: string;
  readonly facts: readonly MemoryFact[];
  readonly maxFactTokens: number;
}

const STORE_DIR = path.join(homedir(), ".config", "openhub");
const STORE_PATH = path.join(STORE_DIR, "memory.json");

const MAX_FACTS = 50;
const DEFAULT_MAX_TOKENS = 150;
const ARCHIVE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

let cache: MemoryData | null = null;

async function ensureDir(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
}

async function load(): Promise<MemoryData> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf-8");
    cache = JSON.parse(raw) as MemoryData;
    return cache;
  } catch {
    cache = { enabled: true, profile: "", facts: [], maxFactTokens: DEFAULT_MAX_TOKENS };
    return cache;
  }
}

async function save(data: MemoryData): Promise<void> {
  await ensureDir();
  cache = data;
  await fs.writeFile(STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export async function getMemory(): Promise<MemoryData> {
  return load();
}

export async function setEnabled(enabled: boolean): Promise<void> {
  const data = await load();
  await save({ ...data, enabled });
}

export async function setProfile(profile: string): Promise<void> {
  const data = await load();
  await save({ ...data, profile });
}

export async function addFact(text: string, tags: readonly string[]): Promise<MemoryFact> {
  const data = await load();

  const duplicate = data.facts.find(
    (f) => f.text.toLowerCase() === text.toLowerCase(),
  );
  if (duplicate) return duplicate;

  const now = Date.now();
  const fact: MemoryFact = {
    id: randomBytes(6).toString("hex"),
    text,
    tags,
    createdAt: now,
    lastUsedAt: now,
  };

  const pruned = pruneStale([...data.facts, fact]);
  const capped = pruned.length > MAX_FACTS ? pruned.slice(-MAX_FACTS) : pruned;

  await save({ ...data, facts: capped });
  return fact;
}

export async function removeFact(id: string): Promise<void> {
  const data = await load();
  await save({ ...data, facts: data.facts.filter((f) => f.id !== id) });
}

export async function updateFact(
  id: string,
  patch: { text?: string; tags?: readonly string[] },
): Promise<void> {
  const data = await load();
  await save({
    ...data,
    facts: data.facts.map((f) =>
      f.id === id
        ? { ...f, ...patch, lastUsedAt: Date.now() }
        : f,
    ),
  });
}

function pruneStale(facts: readonly MemoryFact[]): MemoryFact[] {
  const cutoff = Date.now() - ARCHIVE_AFTER_MS;
  return facts.filter((f) => f.lastUsedAt > cutoff) as MemoryFact[];
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export async function buildMemoryBlock(): Promise<string | null> {
  const data = await load();
  if (!data.enabled) return null;
  if (!data.profile && data.facts.length === 0) return null;

  const parts: string[] = ["<memory>"];

  if (data.profile) {
    parts.push(`profile: ${data.profile}`);
  }

  if (data.facts.length > 0) {
    let tokenBudget = data.maxFactTokens;
    const sorted = [...data.facts].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    const lines: string[] = [];

    for (const fact of sorted) {
      const line = `- ${fact.text}`;
      const cost = approxTokens(line);
      if (cost > tokenBudget) continue;
      tokenBudget -= cost;
      lines.push(line);
    }

    if (lines.length > 0) {
      parts.push("facts:");
      parts.push(...lines);
    }
  }

  if (parts.length === 1) return null;

  parts.push("</memory>");
  return parts.join("\n");
}
