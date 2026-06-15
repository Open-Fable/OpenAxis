import { describe, it, expect, vi, beforeEach } from "vitest";

// On mocke fs intégralement : le module charge le store en SYNCHRONE à l'import
// (readFileSync) et planifie des écritures via fsp.writeFile. Sans ce mock, les
// tests écriraient dans ~/.config/openhub/cache-metrics.json du vrai utilisateur.
vi.mock("fs", () => ({
  readFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  recordCacheMetric,
  getCacheMetrics,
  resetCacheMetrics,
} from "./cache-metrics.js";

describe("cache-metrics", () => {
  beforeEach(() => {
    resetCacheMetrics();
  });

  it("démarre avec un store vide", () => {
    const { stats, records } = getCacheMetrics();
    expect(records).toEqual([]);
    expect(stats.total_requests).toBe(0);
    expect(stats.savings_ratio).toBe(0);
  });

  it("enregistre une métrique et agrège les tokens de prompt", () => {
    recordCacheMetric("claude-sonnet-4-6", "ws1", 1000, 500, 0);
    const { stats, records } = getCacheMetrics();
    expect(records).toHaveLength(1);
    expect(stats.total_requests).toBe(1);
    expect(stats.total_prompt_tokens).toBe(1500);
  });

  it("ventile les métriques par modèle et par workspace", () => {
    recordCacheMetric("modelA", "ws1", 100, 0, 0);
    recordCacheMetric("modelB", "ws2", 200, 0, 0);
    const { stats } = getCacheMetrics();
    expect(stats.breakdown_by_model["modelA"].requests).toBe(1);
    expect(stats.breakdown_by_model["modelB"].prompt_tokens).toBe(200);
    expect(stats.breakdown_by_workspace["ws1"].requests).toBe(1);
    expect(stats.breakdown_by_workspace["ws2"].prompt_tokens).toBe(200);
  });

  it("utilise le cache amont (upstream_cached) pour la première occurrence d'une paire", () => {
    recordCacheMetric("m", "w", 1000, 0, 300);
    const { stats } = getCacheMetrics();
    // Première occurrence : économies = upstream_cached brut (300)
    expect(stats.total_cached_tokens).toBe(300);
    expect(stats.savings_ratio).toBeCloseTo(0.3, 5);
  });

  it("estime 80% de cache système sur les répétitions d'une même paire modèle/workspace", () => {
    recordCacheMetric("m", "w", 1000, 0, 0); // 1re : 0 économie
    recordCacheMetric("m", "w", 1000, 0, 0); // répétition : max(0, 800) = 800
    const { stats } = getCacheMetrics();
    expect(stats.total_cached_tokens).toBe(800);
  });

  it("conserve la plus grande valeur entre cache amont et estimation 80% sur répétition", () => {
    recordCacheMetric("m", "w", 1000, 0, 0); // 1re
    recordCacheMetric("m", "w", 1000, 0, 900); // répétition : max(900, 800) = 900
    const { stats } = getCacheMetrics();
    expect(stats.total_cached_tokens).toBe(900);
  });

  it("réinitialise totalement le store", () => {
    recordCacheMetric("m", "w", 100, 100, 50);
    resetCacheMetrics();
    const { stats, records } = getCacheMetrics();
    expect(records).toEqual([]);
    expect(stats.total_requests).toBe(0);
  });

  it("ignore les valeurs de tokens NaN sans faire planter le calcul", () => {
    recordCacheMetric("m", "w", Number.NaN, 200, Number.NaN);
    const { stats } = getCacheMetrics();
    expect(stats.total_prompt_tokens).toBe(200);
    expect(Number.isNaN(stats.savings_ratio)).toBe(false);
  });
});
