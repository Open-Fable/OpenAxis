import path from "path";
import { promises as fs } from "fs";
import type { Browser } from "@playwright/test";
import { discoverServedRoots, type ServedSiteProblem } from "./orchestrator-quality.js";

const MAX_PAGES = 8;
const NAV_TIMEOUT_MS = 5_000;

// Collects up to MAX_PAGES served HTML pages across all served roots, putting
// index pages first so the entry point is always checked.
async function collectServedPages(
  workspaceDir: string,
): Promise<Array<{ rel: string; full: string }>> {
  const roots = await discoverServedRoots(workspaceDir);
  const pages: Array<{ rel: string; full: string }> = [];
  for (const { dir } of roots) {
    if (pages.length >= MAX_PAGES) break;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const htmls = entries
      .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
      .map((e) => path.join(dir, e.name))
      .sort(
        (a, b) => Number(/index\.html?$/i.test(b)) - Number(/index\.html?$/i.test(a)),
      );
    for (const full of htmls) {
      if (pages.length >= MAX_PAGES) break;
      pages.push({ rel: path.relative(workspaceDir, full), full });
    }
  }
  return pages;
}

/**
 * Problème 8 — OPTIONAL, BEST-EFFORT headless render check. Opens each served
 * page in headless Chromium and flags blank pages, JS console errors, and
 * navigation failures that the static (regex) checks cannot see.
 *
 * Playwright is a devDependency pruned at packaging, so it's loaded via dynamic
 * import inside a try/catch: absent (packaged app) → silent skip. WARNING only,
 * NEVER force-fail (flakiness + the dependency is not guaranteed). Works in dev
 * only — in the packaged app this is a no-op by design.
 */
export async function findRenderProblems(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const pages = await collectServedPages(workspaceDir);
  if (pages.length === 0) return [];

  // Load Playwright lazily; absent (packaged app) → skip silently.
  let chromium: typeof import("@playwright/test").chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch {
    return [];
  }

  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    return []; // browser binary not installed → skip
  }

  const problems: ServedSiteProblem[] = [];
  try {
    for (const { rel, full } of pages) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(`file://${full}`, {
          timeout: NAV_TIMEOUT_MS,
          waitUntil: "domcontentloaded",
        });
        // Runs in the browser; reference document via globalThis so this file
        // doesn't need the DOM lib in its tsconfig.
        const visibleText = await page.evaluate(() => {
          const body = (globalThis as { document?: { body?: { innerText?: string } } })
            .document?.body;
          return body?.innerText ?? "";
        });
        const visibleLen = visibleText.trim().length;
        if (visibleLen < 1) {
          problems.push({
            sourceFile: rel,
            problem: "page blanche — aucun contenu visible dans <body> au rendu",
          });
        } else if (/\b(undefined|NaN)\b/.test(visibleText)) {
          const matchedText = visibleText.match(/\b(undefined|NaN)\b/)?.[0] || "erronée";
          problems.push({
            sourceFile: rel,
            problem: `valeur erronée détectée au rendu dans le texte visible : "${matchedText}"`,
          });
        } else if (errors.length > 0) {
          problems.push({
            sourceFile: rel,
            problem: `erreur(s) console au rendu : ${errors.slice(0, 2).join(" | ").slice(0, 200)}`,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        problems.push({
          sourceFile: rel,
          problem: `échec du rendu (${msg.slice(0, 120)})`,
        });
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return problems;
}
