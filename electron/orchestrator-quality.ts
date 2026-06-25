import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import type { Project, OrchRun, OrchRunNodeResult } from "./project-store.js";

export const MIN_RESULT_CHARS = 200;
export const MIN_FILE_BYTES = 100;
export const MAX_AUTO_QUALITY_LOOPS = 2;

// ── A. Deliverable contracts ───────────────────────────────────────────────────

export function sanitizeExpectedFiles(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 200) continue;
    if (trimmed.startsWith("/") || trimmed.startsWith("\\") || trimmed.includes(".."))
      continue;
    if (trimmed.startsWith(".")) continue;
    if (trimmed.includes("\0")) continue;
    if (result.length >= 50) break;
    result.push(trimmed);
  }
  return result;
}

// Machine-checkable per-file constraints the planner declares (it FILLS the
// contract; the system ENFORCES it deterministically — the LLM never judges).
export interface FileChecks {
  readonly minWords?: number;
  readonly minItems?: number;
  readonly minSections?: number;
  readonly requiredSubstrings?: readonly string[];
  readonly format?: "json" | "csv" | "md";
}
export type ChecksMap = Readonly<Record<string, FileChecks>>;

// Defensive sanitizer for planner-declared `checks` (LLM output is untrusted).
// Keys are validated as workspace-relative paths via sanitizeExpectedFiles, so
// a hallucinated `../etc/passwd` key can never become a filesystem oracle.
export function sanitizeChecks(raw: unknown): ChecksMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, FileChecks> = {};
  const clamp = (n: unknown, max: number): number | undefined =>
    typeof n === "number" && Number.isFinite(n) && n > 0
      ? Math.min(Math.floor(n), max)
      : undefined;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 50) break;
    const safePath = sanitizeExpectedFiles([key])[0];
    if (!safePath || !val || typeof val !== "object") continue;
    const c = val as Record<string, unknown>;
    const subs = Array.isArray(c.requiredSubstrings)
      ? c.requiredSubstrings
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .slice(0, 20)
          .map((s) => s.slice(0, 200))
      : undefined;
    const checks: FileChecks = {
      minWords: clamp(c.minWords, 100000),
      minItems: clamp(c.minItems, 100000),
      minSections: clamp(c.minSections, 1000),
      requiredSubstrings: subs && subs.length > 0 ? subs : undefined,
      format:
        c.format === "json" || c.format === "csv" || c.format === "md"
          ? c.format
          : undefined,
    };
    const hasConstraint =
      checks.minWords !== undefined ||
      checks.minItems !== undefined ||
      checks.minSections !== undefined ||
      checks.format !== undefined ||
      (checks.requiredSubstrings?.length ?? 0) > 0;
    if (hasConstraint) out[safePath] = checks;
  }
  return out;
}

// Deterministic floor: even when the planner declares no checks, a prose
// deliverable (.md/.txt) gets a minimum word count so a 3-sentences-per-chapter
// guide is caught and relaunched. Never overrides a declared minWords; skips
// reports/audits (legitimately short). Keyed by file path like ChecksMap.
export const PROSE_FLOOR_WORDS = 400;
export function deriveFloorChecks(
  expectedFiles: readonly string[],
  declared: ChecksMap,
): ChecksMap {
  const out: Record<string, FileChecks> = { ...declared };
  for (const f of expectedFiles) {
    if (!/\.(md|txt)$/i.test(f)) continue;
    // Short-by-nature deliverables — don't impose a prose floor.
    if (/(^|\/)(reports?|audit|qa|review|seo|deploy)\//i.test(f)) continue;
    if (out[f]?.minWords !== undefined) continue; // respect a declared value
    out[f] = { ...(out[f] ?? {}), minWords: PROSE_FLOOR_WORDS };
  }
  return out;
}

export function isTrivialResult(text: string | undefined): boolean {
  if (!text) return true;
  return text.trim().length < MIN_RESULT_CHARS;
}

export async function checkExpectedFiles(
  workspaceDir: string,
  expected: readonly string[],
): Promise<{ readonly present: readonly string[]; readonly missing: readonly string[] }> {
  const present: string[] = [];
  const missing: string[] = [];
  for (const rel of expected) {
    const full = path.join(workspaceDir, rel);
    try {
      const stat = await fs.stat(full);
      if (stat.size >= MIN_FILE_BYTES) {
        present.push(rel);
      } else {
        missing.push(rel);
      }
    } catch {
      missing.push(rel);
    }
  }
  return { present, missing };
}

export function buildMissingFilesPrompt(
  node: Project,
  missing: readonly string[],
): string {
  return `[RETRY — MISSING FILES]
Your task was:
${node.task ?? "(undefined)"}

The following files are ABSENT from the workspace or too small (< ${MIN_FILE_BYTES} bytes) :
${missing.map((f) => `- ${f}`).join("\n")}

INSTRUCTION : Produce ALL missing files above, in full, with the \`\`\`<lang> filepath: <path> format. Each file must be COMPLETE and FUNCTIONAL (> ${MIN_FILE_BYTES} bytes).`;
}

export function buildTrivialResultPrompt(node: Project): string {
  return `[RETRY — INSUFFICIENT RESULT]
Your task was:
${node.task ?? "(undefined)"}

Your previous result was too short (< ${MIN_RESULT_CHARS} characters) and does not constitute a usable deliverable.

INSTRUCTION : Produce a COMPLETE and EXHAUSTIVE deliverable. No summary, no description — real and actionable content. Use the \`\`\`<lang> filepath: <path> format for each file.`;
}

// ── Enforce deliverables ────────────────────────────────────────────────────

export interface EnforceDeliverablesResult {
  readonly resultText: string;
  readonly missing: readonly string[];
  readonly trivial: boolean;
  // Declared content constraints (minWords/minSections/…) still unmet after retries.
  readonly unmetChecks: readonly string[];
}

export interface EnforceDeliverablesDeps {
  readonly relaunch: (prompt: string) => Promise<string>;
  readonly writeFiles: (text: string) => Promise<readonly string[]>;
  readonly onStatus: (msg: string) => void;
}

// Relaunch prompt when a deliverable exists but is too short/shallow vs its
// declared content checks (minWords/minSections/minItems). Pushes for DEPTH.
export function buildContentShortfallPrompt(
  node: Project,
  shortfalls: readonly ServedSiteProblem[],
): string {
  return `[RETRY — INSUFFICIENT CONTENT]
Your task was:
${node.task ?? "(undefined)"}

The deliverable exists but does NOT respect the following volume/structure constraints:
${shortfalls.map((s) => `- ${s.sourceFile} : ${s.problem}`).join("\n")}

INSTRUCTION : DEVELOP the content in DEPTH. Reproduce EACH affected file IN FULL (format \`\`\`<lang> filepath: <path>), significantly longer and more detailed — add explanations, concrete examples, data figures, sub-sections. Do NOT summarize, do not abbreviate, do not use "...". Aim to EXCEED each indicated threshold.`;
}

export async function enforceDeliverables(
  node: Project,
  expected: readonly string[],
  workspaceDir: string,
  initialResult: string,
  deps: EnforceDeliverablesDeps,
  checks: ChecksMap = {},
): Promise<EnforceDeliverablesResult> {
  // Clamp to a sane ceiling: maxRetries is persisted per-node and could otherwise be
  // set to a huge value, making a single node hammer the LLM/backend indefinitely.
  const MAX_RETRIES_CEILING = 5;
  const maxRetries = Math.min(Math.max(node.maxRetries ?? 2, 1), MAX_RETRIES_CEILING);
  const hasChecks = Object.keys(checks).length > 0;
  let resultText = initialResult;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const { present, missing } =
      expected.length > 0
        ? await checkExpectedFiles(workspaceDir, expected)
        : { present: [] as string[], missing: [] as string[] };

    const trivial = isTrivialResult(resultText) && present.length === 0;
    // Content depth: relaunch the agent when declared checks (word/section/item
    // counts) aren't met — turning "detected too short" into an actual fix.
    const unmet = hasChecks ? await validateDeclaredChecks(workspaceDir, checks) : [];

    if (missing.length === 0 && !trivial && unmet.length === 0) {
      return { resultText, missing: [], trivial: false, unmetChecks: [] };
    }

    const prompt =
      missing.length > 0
        ? buildMissingFilesPrompt(node, missing)
        : unmet.length > 0
          ? buildContentShortfallPrompt(node, unmet)
          : buildTrivialResultPrompt(node);

    deps.onStatus(
      missing.length > 0
        ? `Missing files (${missing.length}) — retry ${attempt}/${maxRetries}…`
        : unmet.length > 0
          ? `Content too short (${unmet.length} constraint(s)) — retry ${attempt}/${maxRetries}…`
          : `Insufficient result — retry ${attempt}/${maxRetries}…`,
    );

    const retryResult = await deps.relaunch(prompt);
    resultText += "\n\n" + retryResult;
    await deps.writeFiles(retryResult);
  }

  const finalCheck =
    expected.length > 0
      ? await checkExpectedFiles(workspaceDir, expected)
      : { present: [] as string[], missing: [] as string[] };
  const finalTrivial = isTrivialResult(resultText) && finalCheck.present.length === 0;
  const finalUnmet = hasChecks ? await validateDeclaredChecks(workspaceDir, checks) : [];

  return {
    resultText,
    missing: finalCheck.missing,
    trivial: finalTrivial,
    unmetChecks: finalUnmet.map((p) => `${p.sourceFile} : ${p.problem}`),
  };
}

// ── B. Quality gate ─────────────────────────────────────────────────────────

export interface QualityIssue {
  readonly agent: string;
  readonly issue: string;
  readonly fix: string;
}

export interface QualityVerdict {
  readonly pass: boolean;
  readonly issues: readonly QualityIssue[];
}

export function buildQualityGateSystemPrompt(verifier: Project): string {
  return `${verifier.instructions || "You are a senior quality auditor."}

ROLE : You audit the GLOBAL result of a multi-agent orchestration. You verify that ALL deliverables are present, complete, consistent with each other, and ready to publish.

VERDICT : Respond STRICTLY with a valid JSON:
{
  "pass": true or false,
  "issues": [
    {"agent": "agent name", "issue": "problem description", "fix": "precise corrective action"}
  ]
}

If everything is correct, return {"pass": true, "issues": []}.
Do NOT invent problems — only report what is actually incorrect or missing.`;
}

export interface QualityGateInputs {
  readonly globalTask: string;
  readonly nodeResultSummaries: string;
  readonly expectedFilesReport: string;
  readonly htmlHeads: string;
  readonly cssSnippets?: string;
  readonly brokenAssetsReport?: string;
  readonly auditReports?: string;
}

export function buildQualityGateUserPrompt(inputs: QualityGateInputs): string {
  const sections = [
    `GLOBAL TASK :\n${inputs.globalTask}`,
    `EXPECTED FILES REPORT :\n${inputs.expectedFilesReport}`,
    `AGENT DELIVERABLE SUMMARIES :\n${inputs.nodeResultSummaries}`,
  ];

  if (inputs.auditReports && inputs.auditReports.trim()) {
    sections.push(
      `DISK AUDIT REPORTS (made by verifier agents, AUTHORITATIVE) :\n${inputs.auditReports}`,
    );
  }

  sections.push(`GENERIC AUDIT CRITERIA :
1. COMPLETENESS — Did each agent deliver EVERYTHING that was requested ? Expected files present ?
2. QUALITY — Is the content substantial (no placeholders, no Lorem ipsum, no "TODO") ?
3. QUANTITATIVE CONSISTENCY (CRITICAL) — Do SHARED FACTS agree across deliverables ? The same quantity must NEVER have two different values across files: prices, amounts, percentages, dates/deadlines, quantities, proper nouns / brand identity, identifiers, units. Actively compare figures from one file to another (e.g. a metric declared in a .json vs the detail in a .csv; a displayed price vs structured data; a threshold/breakeven whose assumptions exclude a cost nonetheless counted elsewhere). Any contradiction = an "issue" attributed to the agent owning the faulty file.
4. CORRECTED ERRORS — If an agent reported problems, have they been fixed ?`);

  if (inputs.htmlHeads.trim()) {
    sections.push(`WEB CRITERIA (HTML pages detected) :
<head> EXTRACTS :
${inputs.htmlHeads}

5. SEO — Each HTML page: unique <title> ≤60 chars, <meta name="description"> 120-160 chars, Open Graph (og:title, og:description, og:image), JSON-LD schema.org, lang attribute on <html> ?
6. ACCESSIBILITY — alt attributes on images ? Semantic HTML ? WCAG AA contrast ?
7. LINKS — Placeholder hot-links (picsum.photos, unsplash.com, via.placeholder.com) in production code ?`);
  }

  if (inputs.cssSnippets && inputs.cssSnippets.trim()) {
    sections.push(`CSS EXTRACTS :
${inputs.cssSnippets}

CSS CRITERIA — analyze the above sheets :
8. CONTRAST — Do text-on-background colors reach WCAG AA (≥ 4.5:1 normal text, ≥ 3:1 large text/components) ? Report any failing pair with hex values.
9. RESPONSIVE — Are there fixed widths/grids (e.g. minmax(300px,1fr)) that overflow under 360px ? Are there mobile/tablet/desktop media queries ?
10. PLACEHOLDERS — Are there dummy values, "TODO", "to integrate/to complete" comments, or tokens defined but never applied ?`);
  }

  if (inputs.brokenAssetsReport && inputs.brokenAssetsReport.trim()) {
    sections.push(`${inputs.brokenAssetsReport}

11. ASSETS — The above references point to ABSENT files on disk. This is a BLOCKING defect: every broken reference must be fixed (move/copy the asset to the right place, or fix the path). Include them in "issues" with the precise fix.
12. PAGE COVERAGE — If "MOCKUP PAGES NEVER CODED" are listed above, this is a BLOCKING defect: each mockup must have its equivalent served page, coded AND linked in the navigation. Add one "issue" per missing page with the fix "code page <X> from mockups/<X> and add it to the menu".
13. SERVED SITE — If "SERVED SITE DEFECTS" are listed above, this is BLOCKING: (a) gray SVG placeholder → replace with real mockup images; (b) resource escaping site root (../) → copy the resource (e.g. tokens.css) into the served folder and fix the path; (c) pages sharing no common CSS sheet → unify all pages on the SAME main sheet. Add one "issue" per defect.`);
  }

  return sections.join("\n\n");
}

export async function collectHtmlHeadSnippets(workspaceDir: string): Promise<string> {
  const MAX_FILES = 10;
  const MAX_HEAD_CHARS = 2000;
  const MAX_DEPTH = 3;
  const snippets: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || snippets.length >= MAX_FILES) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snippets.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules"
      ) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
        try {
          const content = await fs.readFile(full, "utf-8");
          const headMatch = content.match(/<head[\s>]([\s\S]*?)<\/head>/i);
          if (headMatch) {
            const rel = path.relative(workspaceDir, full);
            snippets.push(`--- ${rel} ---\n${headMatch[1].substring(0, MAX_HEAD_CHARS)}`);
          }
        } catch {
          /* skip unreadable */
        }
      }
    }
  }

  await walk(workspaceDir, 0);
  return snippets.join("\n\n");
}

export async function collectCssSnippets(workspaceDir: string): Promise<string> {
  const MAX_FILES = 8;
  const MAX_CSS_CHARS = 3000;
  const MAX_DEPTH = 3;
  const snippets: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || snippets.length >= MAX_FILES) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snippets.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules"
      ) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && /\.css$/i.test(entry.name)) {
        try {
          const content = await fs.readFile(full, "utf-8");
          const rel = path.relative(workspaceDir, full);
          snippets.push(`--- ${rel} ---\n${content.substring(0, MAX_CSS_CHARS)}`);
        } catch {
          /* skip unreadable */
        }
      }
    }
  }

  await walk(workspaceDir, 0);
  return snippets.join("\n\n");
}

// ── Deterministic asset / link validation ──────────────────────────────────

export interface BrokenAssetRef {
  readonly sourceFile: string;
  readonly ref: string;
}

const EXTERNAL_REF = /^(https?:)?\/\/|^(data|mailto|tel|javascript):|^#/i;

// Placeholder image hosts that LLMs hotlink with fabricated IDs — they 404 and
// never render. Treated as broken refs so the quality gate flags them.
const PLACEHOLDER_HOST =
  /(?:images\.)?unsplash\.com|source\.unsplash\.com|picsum\.photos|placehold(?:er)?\.(?:co|com|it)|loremflickr\.com|placekitten\.com|via\.placeholder\.com/i;

function extractLocalRefs(content: string): string[] {
  const refs = new Set<string>();
  const attrRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  const urlRe = /url\(\s*["']?([^"')]+?)["']?\s*\)/gi;
  for (const re of [attrRe, urlRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const raw = m[1].trim();
      if (!raw || EXTERNAL_REF.test(raw)) continue;
      const clean = raw.split("?")[0].split("#")[0];
      if (clean) refs.add(clean);
    }
  }
  return [...refs];
}

// Detects external placeholder image hotlinks (unsplash, picsum…) which the
// local-ref scanner skips but which never display reliably.
function extractPlaceholderHotlinks(content: string): string[] {
  const refs = new Set<string>();
  const attrRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  const urlRe = /url\(\s*["']?([^"')]+?)["']?\s*\)/gi;
  for (const re of [attrRe, urlRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const raw = m[1].trim();
      if (raw && PLACEHOLDER_HOST.test(raw)) refs.add(raw.slice(0, 120));
    }
  }
  return [...refs];
}

/**
 * Scans served HTML/CSS files for local src/href/url() references that point to
 * files absent from disk. Fully deterministic — no LLM. Catches broken images,
 * missing stylesheets/scripts, etc. before deployment.
 */
export async function findBrokenAssetRefs(
  workspaceDir: string,
): Promise<readonly BrokenAssetRef[]> {
  const MAX_FILES = 150;
  const MAX_DEPTH = 5;
  const MAX_BROKEN = 50;
  const broken: BrokenAssetRef[] = [];
  let scanned = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || scanned >= MAX_FILES || broken.length >= MAX_BROKEN) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= MAX_FILES || broken.length >= MAX_BROKEN) return;
      const full = path.join(dir, entry.name);
      // Skip the design backend's scratch/mirror dir — it duplicates mockups/
      // and would exhaust the scan budget before the served site is reached.
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules" &&
        entry.name !== "design"
      ) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && /\.(html?|css)$/i.test(entry.name)) {
        scanned++;
        let content: string;
        try {
          content = await fs.readFile(full, "utf-8");
        } catch {
          continue;
        }
        const fileDir = path.dirname(full);
        const wsRoot = path.resolve(workspaceDir);
        for (const hotlink of extractPlaceholderHotlinks(content)) {
          broken.push({
            sourceFile: path.relative(workspaceDir, full),
            ref: `${hotlink} (hot-link placeholder — ne s'affichera pas, remplace par un SVG inline)`,
          });
          if (broken.length >= MAX_BROKEN) return;
        }
        for (const ref of extractLocalRefs(content)) {
          const target = path.resolve(fileDir, ref);
          // Never stat() a path that escapes the workspace — an LLM-authored ref like
          // `../../../../etc/passwd` must not become a filesystem existence oracle.
          if (target !== wsRoot && !target.startsWith(wsRoot + path.sep)) {
            continue;
          }
          try {
            await fs.stat(target);
          } catch {
            broken.push({ sourceFile: path.relative(workspaceDir, full), ref });
            if (broken.length >= MAX_BROKEN) return;
          }
        }
      }
    }
  }

  await walk(workspaceDir, 0);
  return broken;
}

export function buildBrokenAssetsReport(broken: readonly BrokenAssetRef[]): string {
  if (broken.length === 0) return "";
  const lines = broken.map((b) => `  ✗ ${b.sourceFile} → "${b.ref}" (not found)`);
  return `BROKEN REFERENCES (deterministic detection) :\n${lines.join("\n")}`;
}

/**
 * Format-agnostic deterministic validator: every *.json the run produced must
 * actually parse. This is the first non-web hard quality signal (data analysis,
 * business plan, API fixtures, config files all ship JSON). Skips the design
 * backend's *.artifact.json internals. Returns {sourceFile, problem} entries.
 */
export async function findInvalidJsonFiles(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const MAX_FILES = 200;
  const problems: ServedSiteProblem[] = [];
  let scanned = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5 || scanned >= MAX_FILES || problems.length >= 50) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "design"
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (
        !entry.isFile() ||
        !/\.json$/i.test(entry.name) ||
        /\.artifact\.json$/i.test(entry.name)
      ) {
        continue;
      }
      scanned++;
      let content: string;
      try {
        content = await fs.readFile(full, "utf-8");
      } catch {
        continue;
      }
      if (!content.trim()) continue;
      try {
        JSON.parse(content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        problems.push({
          sourceFile: path.relative(workspaceDir, full),
          problem: `JSON invalide — ne parse pas (${msg.slice(0, 80)})`,
        });
        if (problems.length >= 50) return;
      }
    }
  }

  await walk(path.resolve(workspaceDir), 0);
  return problems;
}

// ── Deterministic content validators (machine-checkable contract) ────────────
// These ENFORCE the contract instead of trusting the LLM's self-judgment, so a
// weak model that hallucinates or skimps is caught structurally.

// Bounded file collector shared by the content validators below. Skips dotdirs,
// node_modules and the design backend's scratch mirror — matches the existing
// detectors' exclusions. Does NOT touch the pre-existing per-detector walks.
export async function collectFiles(
  workspaceDir: string,
  match: (name: string) => boolean,
  maxFiles = 200,
  maxDepth = 5,
): Promise<Array<{ rel: string; full: string }>> {
  const out: Array<{ rel: string; full: string }> = [];
  const root = path.resolve(workspaceDir);
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "design"
      ) {
        continue;
      }
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && match(entry.name)) {
        out.push({ rel: path.relative(root, full), full });
      }
    }
  }
  await walk(root, 0);
  return out;
}

// Counts CSV columns on a line, respecting double-quoted fields ("a,b" = 1 col).
function countCsvColumns(line: string): number {
  let cols = 1;
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) cols++;
  }
  return cols;
}

// Returns a human message if CSV rows don't all match the header's column count.
function csvColumnProblem(content: string): string | null {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const header = countCsvColumns(lines[0]);
  const bad: number[] = [];
  for (let i = 1; i < lines.length && bad.length < 10; i++) {
    if (countCsvColumns(lines[i]) !== header) bad.push(i + 1);
  }
  if (bad.length === 0) return null;
  return `CSV inconsistent: header ${header} columns, line(s) [${bad.join(", ")}] differ`;
}

/**
 * LAYER 1 — enforces the planner-declared per-file constraints (checksMap).
 * Force-fail signal: returns one problem per violated constraint. Absent files
 * are skipped (their presence is already owned by checkExpectedFiles).
 */
export async function validateDeclaredChecks(
  workspaceDir: string,
  checksMap: ChecksMap,
): Promise<readonly ServedSiteProblem[]> {
  const problems: ServedSiteProblem[] = [];
  const wsRoot = path.resolve(workspaceDir);
  for (const [rel, checks] of Object.entries(checksMap)) {
    if (problems.length >= 50) break;
    const full = path.resolve(wsRoot, rel);
    // Containment guard — never read outside the workspace.
    if (full !== wsRoot && !full.startsWith(wsRoot + path.sep)) continue;
    let content: string;
    try {
      content = await fs.readFile(full, "utf-8");
    } catch {
      continue;
    }
    const push = (problem: string): void => {
      if (problems.length < 50) problems.push({ sourceFile: rel, problem });
    };

    if (checks.minWords !== undefined) {
      const words = content.trim().split(/\s+/).filter(Boolean).length;
      if (words < checks.minWords) push(`${words} words < ${checks.minWords} required`);
    }
    if (checks.minSections !== undefined) {
      const secs = (content.match(/^#{2,3}\s+\S/gm) ?? []).length;
      if (secs < checks.minSections) {
        push(`${secs} section(s) (##/### headings) < ${checks.minSections} required`);
      }
    }
    if (checks.minItems !== undefined) {
      try {
        const parsed: unknown = JSON.parse(content);
        const items =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>).items
            : undefined;
        const len = Array.isArray(parsed)
          ? parsed.length
          : Array.isArray(items)
            ? items.length
            : null;
        if (len !== null && len < checks.minItems) {
          push(`${len} item(s) < ${checks.minItems} required`);
        }
      } catch {
        /* invalid JSON is owned by findInvalidJsonFiles — no duplicate */
      }
    }
    if (checks.requiredSubstrings) {
      const lower = content.toLowerCase();
      for (const s of checks.requiredSubstrings) {
        if (!lower.includes(s.toLowerCase())) {
          push(`required string missing: "${s.slice(0, 60)}"`);
        }
      }
    }
    if (checks.format === "json") {
      try {
        JSON.parse(content);
      } catch {
        push("expected json format: file does not parse");
      }
    } else if (checks.format === "csv") {
      const p = csvColumnProblem(content);
      if (p) push(`format csv : ${p}`);
    } else if (checks.format === "md") {
      if (!/^#{1,6}\s+\S/m.test(content)) push("expected md format: no heading detected");
    }
  }
  return problems;
}

/**
 * LAYER 2 — always-on. Flags CSV files whose rows don't match the header's
 * column count. Force-fail. Low false-positive risk.
 */
export async function findCsvColumnProblems(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const files = await collectFiles(workspaceDir, (n) => /\.csv$/i.test(n));
  const problems: ServedSiteProblem[] = [];
  for (const { rel, full } of files) {
    if (problems.length >= 50) break;
    let content: string;
    try {
      content = await fs.readFile(full, "utf-8");
    } catch {
      continue;
    }
    const p = csvColumnProblem(content);
    if (p) problems.push({ sourceFile: rel, problem: p });
  }
  return problems;
}

const PLACEHOLDER_MARKERS = [
  "lorem ipsum",
  "[à compléter]",
  "[a completer]",
  "[à remplir]",
  "[a remplir]",
  "[placeholder]",
  "<placeholder>",
  "à rédiger",
  "a rediger",
  "coming soon",
];

/**
 * LAYER 2 — always-on. Flags text DELIVERABLES (.md/.txt/.csv/.json/.rst) that
 * are near-empty or contain placeholder markers. Force-fail with density guards.
 * Scoped to non-code extensions so a legit `// TODO` in code is never flagged.
 */
export async function findPlaceholderDeliverables(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const files = await collectFiles(
    workspaceDir,
    (n) => /\.(md|txt|csv|json|rst)$/i.test(n) && !/\.artifact\.json$/i.test(n),
  );
  const problems: ServedSiteProblem[] = [];
  for (const { rel, full } of files) {
    if (problems.length >= 50) break;
    let content: string;
    try {
      content = await fs.readFile(full, "utf-8");
    } catch {
      continue;
    }
    const trimmed = content.trim();
    if (trimmed.length === 0) continue; // empty: owned by checkExpectedFiles
    if (trimmed.length < MIN_FILE_BYTES) {
      problems.push({
        sourceFile: rel,
        problem: `livrable quasi-vide (${trimmed.length} octets)`,
      });
      continue;
    }
    const lower = content.toLowerCase();
    const isProse = /\.(md|txt)$/i.test(rel);
    const markers = isProse ? [...PLACEHOLDER_MARKERS, "todo:"] : PLACEHOLDER_MARKERS;
    const hit = markers.find((m) => lower.includes(m));
    if (!hit) continue;
    // Density guard: only block if the file is short OR the marker recurs — a
    // long document mentioning "lorem ipsum" once is not a botched deliverable.
    const isShort = trimmed.length < MIN_FILE_BYTES * 2;
    const occurrences = lower.split(hit).length - 1;
    if (isShort || occurrences >= 3) {
      problems.push({
        sourceFile: rel,
        problem: `placeholder / incomplete content detected ("${hit}")`,
      });
    }
  }
  return problems;
}

const ENTRY_POINT_RE = /^(index|main|app|server|cli)\.|\.config\./i;

/**
 * LAYER 2 — WARNING only (high false-positive risk). Flags produced JS/TS
 * modules that nothing else references (dead code / "backend mort"). Excludes
 * tests, entry points, and dist/build. Loose basename match → errs toward NOT
 * flagging, so a weak model isn't blocked on noise (never wired to force-fail).
 */
export async function findUnreferencedModules(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const all = await collectFiles(workspaceDir, (n) =>
    /\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(n),
  );
  const contents = new Map<string, string>();
  for (const { rel, full } of all) {
    try {
      contents.set(rel, await fs.readFile(full, "utf-8"));
    } catch {
      /* unreadable — skip */
    }
  }
  const problems: ServedSiteProblem[] = [];
  for (const { rel } of all) {
    if (problems.length >= 50) break;
    const name = path.basename(rel);
    if (/\.(test|spec)\./i.test(name)) continue;
    if (ENTRY_POINT_RE.test(name)) continue;
    if (/(^|\/)(dist|build)(\/|$)/i.test(rel)) continue;
    const base = name.replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/i, "");
    let referenced = false;
    for (const [otherRel, content] of contents) {
      if (otherRel === rel) continue;
      if (content.includes(base)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) {
      problems.push({
        sourceFile: rel,
        problem: "module never referenced/imported (potentially dead code)",
      });
    }
  }
  return problems;
}

// Basenames that LEGITIMATELY recur across locations (one per served root /
// package / module). Excluding them keeps the divergent-duplicate scan focused
// on genuine content deliverables, not boilerplate.
const MULTI_LOCATION_BASENAMES = new Set([
  "index.html",
  "styles.css",
  "style.css",
  "main.css",
  "package.json",
  "package-lock.json",
  "readme.md",
  "robots.txt",
  "sitemap.xml",
  "manifest.json",
  "tsconfig.json",
  "__init__.py",
  "mod.ts",
  "index.ts",
  "index.js",
]);

const CONTENT_EXT = /\.(md|json|csv|txt)$/i;

// Normalizes line endings and trailing whitespace before hashing so trivial
// formatting differences don't register as content divergence.
function normalizeForHash(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

// Groups content files (.md/.json/.csv/.txt) by lowercased basename, excluding
// legitimately-recurring boilerplate and files inside NAMED served roots
// (public/, dist/, presentation/…), where same-basename files (index.html,
// styles.css) are expected. The "(racine)" fallback is ignored — excluding it
// would skip the whole tree. Shared by the divergent (Problem 1) and scattered
// (Problem 2) duplicate scans.
async function groupContentFilesByBasename(
  workspaceDir: string,
): Promise<Map<string, Array<{ rel: string; full: string }>>> {
  const servedRoots = (await discoverServedRoots(workspaceDir))
    .filter((r) => r.label !== "(racine)")
    .map((r) => r.dir);
  const inServedRoot = (full: string): boolean =>
    servedRoots.some((d) => full === d || full.startsWith(d + path.sep));

  const files = await collectFiles(workspaceDir, (n) => CONTENT_EXT.test(n));
  const groups = new Map<string, Array<{ rel: string; full: string }>>();
  for (const f of files) {
    const base = path.basename(f.rel).toLowerCase();
    if (MULTI_LOCATION_BASENAMES.has(base)) continue;
    if (inServedRoot(f.full)) continue;
    const arr = groups.get(base);
    if (arr) arr.push(f);
    else groups.set(base, [f]);
  }
  return groups;
}

// Hashes each member's normalized content → map of hash → occurrences (with
// byte sizes). Unreadable files are skipped.
async function hashGroupMembers(
  members: ReadonlyArray<{ rel: string; full: string }>,
): Promise<Map<string, Array<{ rel: string; size: number }>>> {
  const byHash = new Map<string, Array<{ rel: string; size: number }>>();
  for (const m of members) {
    let content: string;
    try {
      content = await fs.readFile(m.full, "utf-8");
    } catch {
      continue;
    }
    const hash = createHash("sha1").update(normalizeForHash(content)).digest("hex");
    const size = Buffer.byteLength(content, "utf-8");
    const arr = byHash.get(hash);
    if (arr) arr.push({ rel: m.rel, size });
    else byHash.set(hash, [{ rel: m.rel, size }]);
  }
  return byHash;
}

/**
 * LAYER 2 — WARNING only. Flags content files (.md/.json/.csv/.txt) that share
 * the same basename across ≥2 locations whose CONTENT DIVERGES (different hash
 * after whitespace normalization). This is the worst duplication class: no
 * single source of truth (e.g. regulations_2026.md kept in 4 different versions).
 *
 * Trade-off: kept WARNING, not force-fail — a divergent basename can sometimes
 * be legitimate (per-section versions), and served-site boilerplate
 * (index.html, package.json…) legitimately recurs, so those are excluded. The
 * scan is also restricted to content extensions outside named served roots.
 */
export async function findDivergentDuplicates(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const groups = await groupContentFilesByBasename(workspaceDir);
  const problems: ServedSiteProblem[] = [];
  for (const members of groups.values()) {
    if (problems.length >= 30) break;
    if (members.length < 2) continue;
    const byHash = await hashGroupMembers(members);
    if (byHash.size < 2) continue; // identical (or single readable) → not divergent
    const listed = [...byHash.values()]
      .flat()
      .map((e) => `${e.rel} (${e.size} o)`)
      .join(", ");
    problems.push({
      sourceFile: members[0].rel,
      problem: `duplicate file with divergent content: ${listed} — one single source of truth, delete/merge the copies`,
    });
  }
  return problems;
}

/**
 * LAYER 2 — WARNING only (Problem 2 — scattering). Flags content files
 * whose IDENTICAL content is copied across ≥3 locations: same deliverable
 * scattered at the root + research/ + reports/ + legal/ without a canonical
 * home. Complements findDivergentDuplicates (which flags DIFFERING copies) and
 * shares its grouping + exclusions. Threshold ≥3 keeps it stricter than the
 * divergent scan, since a single legitimate copy-pair is common.
 */
export async function findScatteredDuplicates(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const groups = await groupContentFilesByBasename(workspaceDir);
  const problems: ServedSiteProblem[] = [];
  for (const members of groups.values()) {
    if (problems.length >= 30) break;
    if (members.length < 3) continue;
    const byHash = await hashGroupMembers(members);
    for (const occ of byHash.values()) {
      if (occ.length < 3) continue;
      const listed = occ.map((e) => `${e.rel} (${e.size} o)`).join(", ");
      problems.push({
        sourceFile: occ[0].rel,
        problem: `identical content scattered across ${occ.length} locations: ${listed} — choose ONE canonical location and delete the copies`,
      });
      break; // at most one problem per basename group
    }
  }
  return problems;
}

// Web-deployment artifacts that only make sense for a real website. package.json
// is deliberately EXCLUDED — it's legitimate for library/CLI/code deliverables,
// so flagging it would false-positive on non-web code.
const WEB_SCAFFOLDING_RE =
  /(^|\/)(sitemap\.xml|robots\.txt|manifest\.json|site\.webmanifest)$/i;
const SEO_DIR_RE = /(^|\/)seo\//i;

// True if the workspace contains a substantial SERVED HTML page (not just a
// mockup) — i.e. it really is a website. Gates the scaffolding warning so
// sitemap/robots stay legitimate when a real site exists.
async function hasSubstantialServedSite(workspaceDir: string): Promise<boolean> {
  const htmls = await collectFiles(workspaceDir, (n) => /\.html?$/i.test(n));
  for (const { rel, full } of htmls) {
    if (/(^|\/)(mockups?|wireframes?)\//i.test(rel)) continue;
    let content: string;
    try {
      content = await fs.readFile(full, "utf-8");
    } catch {
      continue;
    }
    // A real page has a <body> and meaningful markup, not a 3-line stub.
    if (content.trim().length >= 500 && /<body[\s>]/i.test(content)) return true;
  }
  return false;
}

/**
 * LAYER 2 — WARNING only (Problem 3). Flags web scaffolding (sitemap.xml,
 * robots.txt, seo/, manifest.json) produced when the deliverable is NOT a real
 * website — e.g. a market study or guide whose output is documents/data. The
 * scaffolding isn't "wrong", just off-topic and polluting. Fully suppressed when
 * a substantial served HTML page exists (then it's legitimate).
 */
export async function findUnwantedWebScaffolding(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  if (await hasSubstantialServedSite(workspaceDir)) return [];
  const all = await collectFiles(workspaceDir, (n) =>
    /\.(xml|txt|json|webmanifest)$/i.test(n),
  );
  const problems: ServedSiteProblem[] = [];
  for (const { rel } of all) {
    if (problems.length >= 30) break;
    const lower = rel.toLowerCase();
    if (WEB_SCAFFOLDING_RE.test(lower) || SEO_DIR_RE.test(lower)) {
      problems.push({
        sourceFile: rel,
        problem:
          "web scaffolding off-topic — the deliverable is not a website (no substantial served HTML page); remove this SEO/deployment file",
      });
    }
  }
  return problems;
}

const DESIGN_ARTIFACT_RE = /(maquette|mockup|wireframe|style[_-]?guide)/i;

/**
 * LAYER 2 — WARNING only (Problem 5). Flags design artifacts (mockup HTML,
 * style-guide CSS) produced for a deliverable that has NO web interface — the
 * workspace is purely documentary and no substantial served site exists. A
 * residual web bias: a "design" agent spun up for a text guide/report. Matches
 * only design-named files / mockup dirs, so a legit lone styles.css is spared.
 */
export async function findUselessDesignArtifacts(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  if (await hasSubstantialServedSite(workspaceDir)) return [];
  const files = await collectFiles(workspaceDir, (n) => /\.(html?|css)$/i.test(n));
  const problems: ServedSiteProblem[] = [];
  for (const { rel } of files) {
    if (problems.length >= 30) break;
    const isMockupDir = /(^|\/)(mockups?|wireframes?)\//i.test(rel);
    if (isMockupDir || DESIGN_ARTIFACT_RE.test(path.basename(rel))) {
      problems.push({
        sourceFile: rel,
        problem:
          "useless design artifact — the deliverable has no web interface (documentary workspace); a mockup/style guide has no reason to exist",
      });
    }
  }
  return problems;
}

/**
 * Compares mockup pages (mockups/*.html) against the actually-coded/served pages
 * (*.html anywhere outside mockups/ and the design backend's nested re-export).
 * Returns mockup page basenames with no coded counterpart — i.e. designs that
 * were never turned into a real page. Fully deterministic, no LLM.
 */
export async function findUncodedMockups(
  workspaceDir: string,
): Promise<readonly string[]> {
  const MAX_DEPTH = 5;
  const mockupPages = new Set<string>();
  const codedPages = new Set<string>();

  async function walk(dir: string, depth: number, underMockups: boolean): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip the design backend's nested re-export to avoid double-counting.
        if (entry.name === "design") continue;
        await walk(full, depth + 1, underMockups || entry.name === "mockups");
      } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
        (underMockups ? mockupPages : codedPages).add(entry.name.toLowerCase());
      }
    }
  }

  await walk(path.resolve(workspaceDir), 0, false);
  if (mockupPages.size === 0) return [];
  return [...mockupPages].filter((p) => !codedPages.has(p)).sort();
}

export function buildPageCoverageReport(uncoded: readonly string[]): string {
  if (uncoded.length === 0) return "";
  const lines = uncoded.map((p) => `  ✗ ${p}`);
  return `MOCKUP PAGES NEVER CODED (deterministic detection) — each mockup must have its equivalent served page, coded and accessible from navigation:\n${lines.join("\n")}`;
}

export interface ServedSiteProblem {
  readonly sourceFile: string;
  readonly problem: string;
}

// Directory names that conventionally hold the deployable/served site root.
const SERVED_ROOT_NAMES = new Set([
  "public",
  "dist",
  "build",
  "www",
  "site",
  "out",
  "htdocs",
]);

// Directories that are never the served site (scratch / source) — excluded from
// served-root discovery so they don't false-flag.
const NON_SERVED_DIR = /^(node_modules|design|mockups|wireframes?)$/i;

async function dirHasHtml(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.some((e) => e.isFile() && /\.html?$/i.test(e.name));
  } catch {
    return false;
  }
}

// Discovers served roots: the known names (public/, dist/, …) PLUS any shallow
// directory that actually contains HTML (e.g. presentation/), so the web checks
// no longer silently skip ad-hoc folders. Falls back to the workspace root when
// the site is served directly there. Returns sibling dirs (no nesting overlap).
export async function discoverServedRoots(
  workspaceDir: string,
): Promise<Array<{ dir: string; label: string }>> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(workspaceDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const subdirRoots: Array<{ dir: string; label: string }> = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || NON_SERVED_DIR.test(e.name))
      continue;
    const dir = path.resolve(workspaceDir, e.name);
    if (SERVED_ROOT_NAMES.has(e.name.toLowerCase()) || (await dirHasHtml(dir))) {
      subdirRoots.push({ dir, label: `${e.name}/` });
    }
  }
  if (subdirRoots.length > 0) return subdirRoots;
  // No served subdir → the site (if any) is at the workspace root.
  return [{ dir: path.resolve(workspaceDir), label: "(racine)" }];
}

// Gray "box with a label" the code agent substitutes for real photos — an <img>
// whose source is an inline SVG data-URI. Legit inline icons use <svg> tags, not
// <img src="data:...">, so this is a high-signal placeholder marker.
const SVG_PLACEHOLDER_IMG = /<img\b[^>]*\bsrc\s*=\s*["']data:image\/svg\+xml[^"']*["']/gi;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']([^"')]+)["']/gi;

/**
 * Detects two CRITICAL defects in the served site that the plain broken-ref scan
 * misses: (1) <img> tags using inline gray SVG placeholders instead of the real
 * images from the mockup, and (2) refs/@imports that escape the served root via
 * "../" — they resolve on disk in dev but 404 once the served folder is deployed
 * as the web root (e.g. checkout linking ../design/tokens.css → unstyled page).
 * Fully deterministic, scoped to served roots (public/, dist/, …).
 */
export async function findServedSiteProblems(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const MAX_FILES = 150;
  const MAX_PROBLEMS = 50;
  const problems: ServedSiteProblem[] = [];
  let scanned = 0;

  async function scanRoot(servedRoot: string): Promise<void> {
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 5 || scanned >= MAX_FILES || problems.length >= MAX_PROBLEMS) return;
      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        // Never treat the design backend's scratch dir or the source mockups as
        // part of the served site (they aren't deployed and would false-flag).
        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "design" ||
          entry.name === "mockups"
        ) {
          continue;
        }
        if (scanned >= MAX_FILES || problems.length >= MAX_PROBLEMS) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (entry.isFile() && /\.(html?|css)$/i.test(entry.name)) {
          scanned++;
          let content: string;
          try {
            content = await fs.readFile(full, "utf-8");
          } catch {
            continue;
          }
          const rel = path.relative(workspaceDir, full);
          const placeholders = content.match(SVG_PLACEHOLDER_IMG)?.length ?? 0;
          if (placeholders > 0) {
            problems.push({
              sourceFile: rel,
              problem: `${placeholders} gray SVG placeholder image(s) (data:image/svg+xml) — replace with the real mockup images`,
            });
          }
          // Collect every local ref + @import and flag those escaping the root.
          const refs = new Set<string>(extractLocalRefs(content));
          let m: RegExpExecArray | null;
          CSS_IMPORT.lastIndex = 0;
          while ((m = CSS_IMPORT.exec(content)) !== null) {
            const raw = m[1].trim();
            if (raw && !EXTERNAL_REF.test(raw)) refs.add(raw.split("?")[0].split("#")[0]);
          }
          for (const ref of refs) {
            if (!ref.includes("../")) continue;
            const target = path.resolve(path.dirname(full), ref);
            if (target !== servedRoot && !target.startsWith(servedRoot + path.sep)) {
              problems.push({
                sourceFile: rel,
                problem: `"${ref}" escapes the site root (${path.basename(servedRoot)}/) — broken at deploy time, copy the resource into the site`,
              });
              if (problems.length >= MAX_PROBLEMS) return;
            }
          }
        }
      }
    }
    await walk(servedRoot, 0);
  }

  for (const { dir } of await discoverServedRoots(workspaceDir)) {
    await scanRoot(dir);
  }
  return problems;
}

export function buildServedSiteReport(problems: readonly ServedSiteProblem[]): string {
  if (problems.length === 0) return "";
  const lines = problems.map((p) => `  ✗ ${p.sourceFile} → ${p.problem}`);
  return `SERVED SITE DEFECTS (deterministic detection) :\n${lines.join("\n")}`;
}

const STYLESHEET_LINK = /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi;
const HREF_IN_LINK = /\bhref\s*=\s*["']([^"']+)["']/i;

/**
 * Flags CSS fragmentation: when storefront pages in a served root don't share a
 * common stylesheet, each was styled by a different agent with its own sheet
 * (e.g. index→css/style.css but checkout→styles.css), giving an inconsistent
 * look across pages. Admin sub-sections are excluded (they legitimately differ).
 * Returns ServedSiteProblem entries so it folds into the served-site report.
 */
export async function findCssConsistencyProblems(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const problems: ServedSiteProblem[] = [];
  const roots = await discoverServedRoots(workspaceDir);

  for (const { dir: root, label } of roots) {
    // Collect storefront pages (top level of the served root, excluding admin/).
    let pages: import("fs").Dirent[];
    try {
      pages = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const pageSheets: Array<{ page: string; sheets: Set<string> }> = [];
    for (const p of pages) {
      if (!p.isFile() || !/\.html?$/i.test(p.name)) continue;
      let html: string;
      try {
        html = await fs.readFile(path.join(root, p.name), "utf-8");
      } catch {
        continue;
      }
      const sheets = new Set<string>();
      const links = html.match(STYLESHEET_LINK) ?? [];
      for (const link of links) {
        const href = link.match(HREF_IN_LINK)?.[1]?.trim();
        if (!href || EXTERNAL_REF.test(href)) continue;
        const rel = path.relative(root, path.resolve(root, href.split("?")[0]));
        sheets.add(rel);
      }
      if (sheets.size > 0) pageSheets.push({ page: p.name, sheets });
    }

    if (pageSheets.length < 2) continue;
    // Common stylesheet shared by ALL storefront pages?
    const [first, ...rest] = pageSheets;
    const shared = [...first.sheets].filter((s) => rest.every((ps) => ps.sheets.has(s)));
    if (shared.length === 0) {
      const examples = pageSheets
        .slice(0, 3)
        .map((ps) => `${ps.page}: ${[...ps.sheets].join("+")}`)
        .join(" ; ");
      problems.push({
        sourceFile: label,
        problem: `pages share NO common CSS sheet → inconsistent rendering (${examples}). Unify all pages on the SAME main sheet.`,
      });
    }
  }
  return problems;
}

function countContentWords(content: string, isHtml: boolean): number {
  const text = isHtml ? content.replace(/<[^>]+>/g, " ") : content;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * A4 — flags a "final/consolidated" deliverable that is much shorter than the
 * sum of the content sources it should aggregate (the LLM summarized instead of
 * including the full content — observed: final guide 1049 words vs 3547 sources).
 * Conservative: only fires when the final file is clearly a consolidation AND the
 * content sources (content/*.md) are identifiable. Force-fail.
 */
export async function findConsolidationShrinkage(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const all = await collectFiles(workspaceDir, (n) => /\.(md|html?)$/i.test(n));
  const sources = all.filter(
    ({ rel }) => /(^|\/)content\//i.test(rel) && /\.md$/i.test(rel),
  );
  if (sources.length < 2) return [];
  const finals = all.filter(
    ({ rel }) =>
      /(^|\/)final\//i.test(rel) ||
      /(complet|consolid|guide_complet|full)/i.test(path.basename(rel)),
  );
  if (finals.length === 0) return [];

  const wordsOf = async (full: string, isHtml: boolean): Promise<number> => {
    try {
      return countContentWords(await fs.readFile(full, "utf-8"), isHtml);
    } catch {
      return 0;
    }
  };
  let sourceWords = 0;
  for (const s of sources) sourceWords += await wordsOf(s.full, false);
  if (sourceWords < 300) return [];

  const problems: ServedSiteProblem[] = [];
  for (const f of finals) {
    const fw = await wordsOf(f.full, /\.html?$/i.test(f.rel));
    if (fw < 0.8 * sourceWords) {
      problems.push({
        sourceFile: f.rel,
        problem: `incomplete consolidation: ${fw} words vs ~${sourceWords} in content/ sources — INCLUDE the full content of each source, do not summarize`,
      });
    }
  }
  return problems;
}

// Utility-class heuristic (Tailwind-like, BEM modifiers, JS state hooks) — these
// legitimately have no own CSS rule, so they must NOT be flagged as "unstyled".
const UTILITY_CLASS =
  /[:/]|^(is-|has-|js-|active|open|hidden|show|selected|disabled|loading|error|sr-only)/i;

/**
 * B2 — flags HTML classes that have NO matching rule in any linked/imported CSS
 * (the "CSS not linked / page unstyled" symptom). Force-fail only when a page is
 * massively unstyled (≥3 classes AND ≥30% unmatched AND no framework sheet);
 * otherwise warning-grade. Conservative to avoid false positives.
 */
export async function findUnstyledClasses(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const problems: ServedSiteProblem[] = [];
  for (const { dir, label } of await discoverServedRoots(workspaceDir)) {
    const pages = await collectFiles(dir, (n) => /\.html?$/i.test(n), 40, 3);
    for (const { rel, full } of pages) {
      if (problems.length >= 50) break;
      let html: string;
      try {
        html = await fs.readFile(full, "utf-8");
      } catch {
        continue;
      }
      // Gather the CSS rules reachable from this page (linked sheets + @imports).
      const sheetRefs = new Set<string>();
      let m: RegExpExecArray | null;
      STYLESHEET_LINK.lastIndex = 0;
      const links = html.match(STYLESHEET_LINK) ?? [];
      for (const link of links) {
        const href = link.match(HREF_IN_LINK)?.[1]?.trim();
        if (href && !EXTERNAL_REF.test(href)) sheetRefs.add(href.split("?")[0]);
      }
      let usesFramework = links.some((l) => /https?:\/\//i.test(l)); // CDN framework
      let cssText = "";
      // inline <style> blocks count as rules too
      for (const style of html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? []) {
        cssText += " " + style;
      }
      const fileDir = path.dirname(full);
      for (const ref of sheetRefs) {
        const target = path.resolve(fileDir, ref);
        try {
          cssText += " " + (await fs.readFile(target, "utf-8"));
        } catch {
          /* missing sheet already caught by findBrokenAssetRefs */
        }
      }
      // Follow one level of @import within the linked sheets.
      CSS_IMPORT.lastIndex = 0;
      while ((m = CSS_IMPORT.exec(cssText)) !== null) {
        const ref = m[1].trim();
        if (!ref || EXTERNAL_REF.test(ref)) {
          if (ref && /https?:\/\//i.test(ref)) usesFramework = true;
          continue;
        }
        const target = path.resolve(fileDir, ref.split("?")[0]);
        try {
          cssText += " " + (await fs.readFile(target, "utf-8"));
        } catch {
          /* ignore */
        }
      }
      if (usesFramework) continue; // framework utilities define classes elsewhere

      // Extract class tokens used in the HTML.
      const used = new Set<string>();
      const classAttr = /\bclass\s*=\s*["']([^"']+)["']/gi;
      while ((m = classAttr.exec(html)) !== null) {
        for (const cls of m[1].split(/\s+/)) {
          if (cls && !UTILITY_CLASS.test(cls)) used.add(cls);
        }
      }
      if (used.size < 3) continue;

      const definedClasses = new Set<string>();
      const selRe = /\.([a-zA-Z_][\w-]*)/g;
      while ((m = selRe.exec(cssText)) !== null) definedClasses.add(m[1]);

      const unmatched = [...used].filter((c) => !definedClasses.has(c));
      const ratio = unmatched.length / used.size;
      if (unmatched.length >= 3 && ratio >= 0.3) {
        problems.push({
          sourceFile: `${label}${rel}`,
          problem: `${unmatched.length}/${used.size} classes without CSS rule (page unstyled/insufficiently styled) — e.g. ${unmatched
            .slice(0, 5)
            .map((c) => "." + c)
            .join(", ")}. Check that the correct CSS is linked.`,
        });
      }
    }
  }
  return problems;
}

/**
 * Flags stylesheet/script files that NO served HTML references — directly or via
 * an @import chain. These are leftovers from a superseded design pass (e.g. an
 * old `styles.css` left beside the `style.css` the page actually links). Scoped
 * to served roots, so the design daemon's scratch under design/ is ignored. The
 * orphan check needs ≥1 HTML in the root (otherwise nothing references anything).
 */
export async function findOrphanStylesheets(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const roots = await discoverServedRoots(workspaceDir);
  const problems: ServedSiteProblem[] = [];
  const linkRe = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const importRe = /@import\s+(?:url\(\s*)?["']([^"')]+)["']/gi;

  for (const { dir, label } of roots) {
    const assets: string[] = [];
    const htmls: string[] = [];
    async function walk(d: string, depth: number): Promise<void> {
      if (depth > 5) return;
      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        // Skip dotfiles + scratch/source dirs (design daemon mirror, mockups…) so
        // the root fallback never descends into the design backend's scratch.
        if (e.name.startsWith(".") || NON_SERVED_DIR.test(e.name)) continue;
        const full = path.resolve(d, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (/\.(css|m?js)$/i.test(e.name)) assets.push(full);
        else if (/\.html?$/i.test(e.name)) htmls.push(full);
      }
    }
    await walk(dir, 0);
    if (assets.length === 0 || htmls.length === 0) continue;

    const referenced = new Set<string>();
    const queue: string[] = [];
    const addRef = (fromDir: string, ref: string): void => {
      if (EXTERNAL_REF.test(ref)) return;
      const abs = path.resolve(fromDir, ref.split(/[?#]/)[0]);
      if (!referenced.has(abs)) {
        referenced.add(abs);
        queue.push(abs);
      }
    };
    for (const html of htmls) {
      let content: string;
      try {
        content = await fs.readFile(html, "utf-8");
      } catch {
        continue;
      }
      for (const m of content.matchAll(linkRe)) addRef(path.dirname(html), m[1].trim());
      for (const m of content.matchAll(scriptRe)) addRef(path.dirname(html), m[1].trim());
    }
    // Follow @import chains within referenced CSS so a sheet pulled in indirectly
    // isn't mislabeled an orphan.
    while (queue.length > 0) {
      const css = queue.shift();
      if (css === undefined || !/\.css$/i.test(css)) continue;
      let content: string;
      try {
        content = await fs.readFile(css, "utf-8");
      } catch {
        continue;
      }
      for (const m of content.matchAll(importRe)) addRef(path.dirname(css), m[1].trim());
    }

    for (const asset of assets) {
      if (!referenced.has(asset)) {
        problems.push({
          sourceFile: path.relative(workspaceDir, asset),
          problem: `orphan stylesheet/script — not referenced by any HTML page in ${label} (likely duplicate from a previous design pass): integrate it into a page or delete it`,
        });
      }
    }
  }
  return problems.slice(0, 30);
}

// Collects { rel, content } for every HTML file under a served root (depth ≤ 5,
// skipping dotfiles / node_modules / scratch dirs). Shared by the HTML checks.
async function collectHtmlUnderRoot(
  root: string,
  workspaceDir: string,
): Promise<Array<{ rel: string; content: string }>> {
  const out: Array<{ rel: string; content: string }> = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5 || out.length >= 80) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || NON_SERVED_DIR.test(e.name)) continue;
      const full = path.resolve(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (/\.html?$/i.test(e.name)) {
        try {
          out.push({
            rel: path.relative(workspaceDir, full),
            content: await fs.readFile(full, "utf-8"),
          });
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }
  await walk(root, 0);
  return out;
}

// Visible filler phrases an unfinished page keeps (theme-agnostic, multilingual).
// Deliberately NOT "loading"/"chargement" alone — those are legit runtime states.
const HTML_FILLER_RE =
  /\b(lorem ipsum|coming soon|bient[oô]t disponible|content goes here|your (?:text|content|image) here|votre (?:texte|contenu) ici|to be (?:improved|added|completed|done)|placeholder text|sample text|texte d['e ]exemple)\b/i;
// A container element whose class/id literally says "placeholder" (NOT the legit
// <input placeholder="…"> hint, which uses the placeholder ATTRIBUTE, not class/id).
const PLACEHOLDER_CONTAINER_RE =
  /\b(?:class|id)\s*=\s*["'][^"']*\bplaceholder\b[^"']*["']/i;

/**
 * Flags served HTML pages that still contain visible filler: a "placeholder"
 * container left unfilled, or generic filler phrases (lorem ipsum, "coming soon",
 * "to be improved", …). Generic across themes; ignores the design daemon scratch.
 * Catches a maquette that looks done but ships placeholder blocks.
 */
export async function findServedHtmlPlaceholders(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const roots = await discoverServedRoots(workspaceDir);
  const problems: ServedSiteProblem[] = [];
  for (const { dir } of roots) {
    for (const { rel, content } of await collectHtmlUnderRoot(dir, workspaceDir)) {
      if (problems.length >= 30) break;
      if (PLACEHOLDER_CONTAINER_RE.test(content)) {
        problems.push({
          sourceFile: rel,
          problem:
            "unreplaced « placeholder » container (class/id placeholder): replace with final content",
        });
        continue;
      }
      const m = HTML_FILLER_RE.exec(content);
      if (m !== null) {
        problems.push({
          sourceFile: rel,
          problem: `filler text detected (« ${m[1]} »): replace with final content`,
        });
      }
    }
  }
  return problems.slice(0, 30);
}

function collectJsonLdPrices(value: unknown, out: Set<number>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectJsonLdPrices(v, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^price$/i.test(k) && (typeof v === "number" || typeof v === "string")) {
        const n = parseFloat(String(v));
        if (!Number.isNaN(n) && n > 0) out.add(n);
      } else {
        collectJsonLdPrices(v, out);
      }
    }
  }
}

// Matches a price value in free text with a flexible separator and optional
// trailing-zero on the cents (14.90 → "14,90" / "14.9" / "14.90"), guarded so
// "14" doesn't match inside "114" or "14.95".
function buildPriceRegex(val: number): RegExp {
  const intPart = Math.floor(val);
  const cents = Math.round((val - intPart) * 100);
  if (cents === 0) return new RegExp("(?<![\\d.,])" + intPart + "(?![\\d.,])");
  const cc = String(cents).padStart(2, "0");
  const ccTrim = cc.replace(/0+$/, "") || cc;
  const dec = cc === ccTrim ? cc : `${cc}|${ccTrim}`;
  return new RegExp("(?<![\\d.,])" + intPart + "[.,](?:" + dec + ")(?![\\d])");
}

/**
 * Flags a page whose structured-data (JSON-LD) price never appears in the page's
 * VISIBLE content — a real, theme-agnostic inconsistency (the schema advertises a
 * price the user never sees; bad for rich results). Multi-tier pricing is fine as
 * long as the JSON-LD price is one of the displayed prices. Fully deterministic.
 */
export async function findStructuredDataMismatch(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const roots = await discoverServedRoots(workspaceDir);
  const problems: ServedSiteProblem[] = [];
  const ldRe =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const { dir } of roots) {
    for (const { rel, content } of await collectHtmlUnderRoot(dir, workspaceDir)) {
      if (problems.length >= 30) break;
      const prices = new Set<number>();
      for (const m of content.matchAll(ldRe)) {
        try {
          collectJsonLdPrices(JSON.parse(m[1].trim()), prices);
        } catch {
          /* malformed JSON-LD — covered by findInvalidJsonFiles elsewhere */
        }
      }
      if (prices.size === 0) continue;
      // Visible text = page minus JSON-LD blocks minus tags.
      const visible = content.replace(ldRe, " ").replace(/<[^>]+>/g, " ");
      const missing = [...prices].filter((p) => !buildPriceRegex(p).test(visible));
      if (missing.length > 0) {
        problems.push({
          sourceFile: rel,
          problem: `JSON-LD structured price (${missing.join(", ")}) absent from visible content — align the structured data with the actually displayed price`,
        });
      }
    }
  }
  return problems.slice(0, 30);
}

/**
 * Deterministic repair of WORKSPACE_INDEX.md corruption: an LLM that rewrites the
 * whole index each turn duplicates file-map rows (the same path listed 2-3×). We
 * drop duplicate rows WITHIN file-map tables only (header's first cell is
 * Fichier/File/Chemin/Path), keeping the first. Changelog tables (first cell =
 * Date) are left untouched — dates legitimately repeat. A heading ends a table;
 * blank lines do not, so row groups split by blanks still dedupe together.
 */
export function sanitizeWorkspaceIndex(content: string): string {
  const isRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l: string): boolean => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const firstCell = (l: string): string => (l.split("|")[1] ?? "").trim();
  const out: string[] = [];
  let inFileMap = false;
  let seen = new Set<string>();
  for (const line of content.split("\n")) {
    if (isRow(line)) {
      if (isSep(line)) {
        out.push(line);
        continue;
      }
      const fc = firstCell(line).toLowerCase();
      if (/^(fichier|file|chemin|path)$/i.test(fc)) {
        inFileMap = true;
        seen = new Set();
        out.push(line);
        continue;
      }
      if (inFileMap && fc.length > 0) {
        if (seen.has(fc)) continue; // duplicate file-map row → drop
        seen.add(fc);
      }
      out.push(line);
    } else {
      if (/^#{1,6}\s/.test(line)) inFileMap = false; // a heading ends the table
      out.push(line);
    }
  }
  return out.join("\n");
}

/**
 * Extracts the first balanced top-level JSON object from an LLM response.
 *
 * LLM verdicts often wrap the JSON in ```json fences or surround it with prose
 * ("Voici mon analyse : { … }. En conclusion…"). A naive `JSON.parse` on the raw
 * text then throws, and the caller silently treats the verdict as missing. We
 * strip fences, then scan for the first brace-balanced span (string-aware, so
 * braces inside quoted reasons don't fool it). Returns null only when there is
 * genuinely no object — letting the caller fail CLOSED instead of guessing.
 */
export function extractJsonObject(raw: string): string | null {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return cleaned.substring(start, i + 1);
    }
  }
  return null;
}

export function parseQualityVerdict(raw: string): QualityVerdict | null {
  const json = extractJsonObject(raw);
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as { pass?: boolean; issues?: QualityIssue[] };
    if (typeof parsed.pass !== "boolean") return null;
    return {
      pass: parsed.pass,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    };
  } catch {
    return null;
  }
}

export function buildAutoFeedback(verdict: QualityVerdict): string {
  const lines = verdict.issues.map((i) => `- [${i.agent}] ${i.issue} → ${i.fix}`);
  return `[AUTO QUALITY CYCLE]\nThe verifier identified the following issues to fix:\n${lines.join("\n")}`;
}

export function buildSyntheticRun(
  task: string,
  orchId: string,
  statuses: Readonly<Record<string, "done" | "error" | "skipped" | "inactive">>,
  results: ReadonlyMap<string, string>,
  linked: readonly Project[],
): OrchRun {
  const nodeResults: OrchRunNodeResult[] = linked.map((p) => ({
    projectId: p.id,
    name: p.name,
    status: (statuses[p.id] ?? "done") as OrchRunNodeResult["status"],
    result: results.get(p.id),
  }));
  return {
    id: "synthetic",
    workflowId: "",
    orchProjectId: orchId,
    task,
    status: "done",
    nodeResults,
    logs: [],
    startedAt: Date.now(),
    finishedAt: Date.now(),
    duration: 0,
  };
}

export async function buildExpectedFilesReport(
  expectedFilesMap: Readonly<Record<string, readonly string[]>>,
  workspaceDir: string,
  linked: readonly Project[],
): Promise<string> {
  const lines: string[] = [];
  for (const [agentId, files] of Object.entries(expectedFilesMap)) {
    if (files.length === 0) continue;
    const agent = linked.find((p) => p.id === agentId);
    const { present, missing } = await checkExpectedFiles(workspaceDir, files);
    lines.push(`Agent "${agent?.name ?? agentId}" :`);
    for (const f of present) lines.push(`  ✓ ${f}`);
    for (const f of missing) lines.push(`  ✗ ${f} (MANQUANT)`);
  }
  return lines.length > 0 ? lines.join("\n") : "Aucun contrat de fichiers attendus.";
}

export async function findBrandConsistencyProblems(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const problems: ServedSiteProblem[] = [];
  const roots = await discoverServedRoots(workspaceDir);

  // 1. Try to find the brand defined in JSON files (e.g. design-system.json or catalogue.json)
  let brandName = "";
  const jsonFiles = await collectFiles(workspaceDir, (n) => /\.json$/i.test(n), 30, 3);
  for (const f of jsonFiles) {
    if (
      /(^|\/)(node_modules|design|mockups|dist|build|package\.json|package-lock\.json|tsconfig\.json|opencode\.json)/i.test(
        f.rel,
      )
    )
      continue;
    try {
      const content = await fs.readFile(f.full, "utf-8");
      const obj = JSON.parse(content);
      const possibleBrand = obj.brand || obj.brandName || obj.brand_name;
      if (typeof possibleBrand === "string" && possibleBrand.trim().length > 0) {
        brandName = possibleBrand.trim();
        break;
      }
    } catch {
      // ignore
    }
  }

  // 2. If not found in JSON, look in research/recommendation files
  if (!brandName) {
    const mdFiles = await collectFiles(workspaceDir, (n) => /\.md$/i.test(n), 30, 3);
    const brandRe = /nom de marque recommandé\s*:\s*\*\*([^\*]+)\*\*/i;
    for (const f of mdFiles) {
      if (
        /(^|\/)(node_modules|design|mockups|dist|build|WORKSPACE_INDEX\.md)/i.test(f.rel)
      )
        continue;
      try {
        const content = await fs.readFile(f.full, "utf-8");
        const m = content.match(brandRe);
        if (m) {
          brandName = m[1].trim();
          break;
        }
      } catch {
        // ignore
      }
    }
  }

  if (!brandName) return []; // No brand name found

  // 3. Scan HTML files under the served root and ensure the brand is present
  if (brandName.length >= 2) {
    const normalizedBrand = brandName.toLowerCase().replace(/\s+/g, " ");
    for (const { dir } of roots) {
      const htmls = await collectHtmlUnderRoot(dir, workspaceDir);
      for (const { rel, content } of htmls) {
        const stripped = content.replace(/<!--[\s\S]*?-->/g, "");
        const normalizedContent = stripped.toLowerCase().replace(/\s+/g, " ");
        if (!normalizedContent.includes(normalizedBrand)) {
          problems.push({
            sourceFile: rel,
            problem: `brand inconsistency — the site uses a different name or omits the official name "${brandName}" defined in the database/design system`,
          });
        }
      }
    }
  }

  return problems;
}
