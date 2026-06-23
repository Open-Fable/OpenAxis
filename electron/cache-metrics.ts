import * as fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { homedir } from "os";

const CACHE_FILE = path.join(homedir(), ".config", "openaxis", "cache-metrics.json");
const MAX_RECORDS = 5000;

interface CacheRecord {
  model: string;
  workspace: string;
  system_tokens: number;
  non_system_tokens: number;
  upstream_cached: number;
  timestamp: number;
  // legacy fields (pre-refactor)
  prompt_tokens?: number;
  cached_tokens?: number;
}

interface BreakdownEntry {
  requests: number;
  prompt_tokens: number;
  cached_tokens: number;
}

interface CacheMetricsData {
  total_requests: number;
  total_prompt_tokens: number;
  total_cached_tokens: number;
  savings_ratio: number;
  breakdown_by_model: Record<string, BreakdownEntry>;
  breakdown_by_workspace: Record<string, BreakdownEntry>;
}

interface CacheStore {
  records: CacheRecord[];
}

function loadStoreSync(): CacheStore {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.records)) {
      // Migration: convert old-format records (with prompt_tokens/cached_tokens)
      // to new format (system_tokens/non_system_tokens/upstream_cached)
      for (const r of parsed.records) {
        if (
          typeof r.system_tokens === "undefined" &&
          typeof r.prompt_tokens === "number"
        ) {
          r.system_tokens = r.prompt_tokens;
          r.non_system_tokens = 0;
          r.upstream_cached = r.cached_tokens || 0;
        }
        r.system_tokens = safeNum(r.system_tokens);
        r.non_system_tokens = safeNum(r.non_system_tokens);
        r.upstream_cached = safeNum(r.upstream_cached);
      }
      return parsed;
    }
  } catch {}
  return { records: [] };
}

function safeNum(v: unknown): number {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  return 0;
}

const store: CacheStore = loadStoreSync();

let writeScheduled = false;
function scheduleWrite() {
  if (writeScheduled) return;
  writeScheduled = true;
  setImmediate(async () => {
    writeScheduled = false;
    try {
      await fsp.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      await fsp.writeFile(CACHE_FILE, JSON.stringify(store), "utf-8");
    } catch {}
  });
}

function computeMetrics(): CacheMetricsData {
  const records = store.records;
  const total_requests = records.length;

  const byModel: Record<string, BreakdownEntry> = {};
  const byWorkspace: Record<string, BreakdownEntry> = {};

  let total_prompt_tokens = 0;
  let total_cached_tokens = 0;
  const seenPair = new Set<string>();

  for (const r of records) {
    const t = safeNum(r.system_tokens) + safeNum(r.non_system_tokens);
    total_prompt_tokens += t;

    const upstream = safeNum(r.upstream_cached);
    const sysTokens = safeNum(r.system_tokens);
    const pairKey = `${r.model}::${r.workspace}`;
    const isRepeat = seenPair.has(pairKey);
    seenPair.add(pairKey);

    const recordSavings = isRepeat
      ? Math.max(upstream, Math.round(sysTokens * 0.8))
      : upstream;
    total_cached_tokens += recordSavings;

    if (!byModel[r.model])
      byModel[r.model] = { requests: 0, prompt_tokens: 0, cached_tokens: 0 };
    byModel[r.model].requests++;
    byModel[r.model].prompt_tokens += t;
    byModel[r.model].cached_tokens += recordSavings;

    if (!byWorkspace[r.workspace])
      byWorkspace[r.workspace] = { requests: 0, prompt_tokens: 0, cached_tokens: 0 };
    byWorkspace[r.workspace].requests++;
    byWorkspace[r.workspace].prompt_tokens += t;
    byWorkspace[r.workspace].cached_tokens += recordSavings;
  }

  const savings_ratio =
    total_prompt_tokens > 0 ? total_cached_tokens / total_prompt_tokens : 0;

  return {
    total_requests,
    total_prompt_tokens,
    total_cached_tokens,
    savings_ratio,
    breakdown_by_model: byModel,
    breakdown_by_workspace: byWorkspace,
  };
}

export function recordCacheMetric(
  model: string,
  workspace: string,
  system_tokens: number,
  non_system_tokens: number,
  upstream_cached: number,
): void {
  store.records.push({
    model,
    workspace,
    system_tokens,
    non_system_tokens,
    upstream_cached,
    timestamp: Date.now(),
  });

  if (store.records.length > MAX_RECORDS) {
    store.records = store.records.slice(-MAX_RECORDS);
  }

  scheduleWrite();
}

export function getCacheMetrics(): {
  stats: CacheMetricsData;
  records: CacheRecord[];
} {
  return { stats: computeMetrics(), records: store.records };
}

export function resetCacheMetrics(): void {
  store.records = [];
  scheduleWrite();
}
