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
  return `[RELANCE — FICHIERS MANQUANTS]
Ta tâche était :
${node.task ?? "(non définie)"}

Les fichiers suivants sont ABSENTS du workspace ou trop petits (< ${MIN_FILE_BYTES} octets) :
${missing.map((f) => `- ${f}`).join("\n")}

CONSIGNE : Produis TOUS les fichiers manquants ci-dessus, en entier, avec le format \`\`\`<lang> filepath: <chemin>. Chaque fichier doit être COMPLET et FONCTIONNEL (> ${MIN_FILE_BYTES} octets).`;
}

export function buildTrivialResultPrompt(node: Project): string {
  return `[RELANCE — RÉSULTAT INSUFFISANT]
Ta tâche était :
${node.task ?? "(non définie)"}

Ton résultat précédent était trop court (< ${MIN_RESULT_CHARS} caractères) et ne constitue pas un livrable exploitable.

CONSIGNE : Produis un livrable COMPLET et EXHAUSTIF. Pas de résumé, pas de description — du contenu réel et actionnable. Utilise le format \`\`\`<lang> filepath: <chemin> pour chaque fichier.`;
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
  return `[RELANCE — CONTENU INSUFFISANT]
Ta tâche était :
${node.task ?? "(non définie)"}

Le livrable existe mais ne respecte PAS les contraintes de volume/structure suivantes :
${shortfalls.map((s) => `- ${s.sourceFile} : ${s.problem}`).join("\n")}

CONSIGNE : DÉVELOPPE le contenu en PROFONDEUR. Reproduis CHAQUE fichier concerné EN ENTIER (format \`\`\`<lang> filepath: <chemin>), nettement plus long et détaillé — ajoute des explications, des exemples concrets, des données chiffrées, des sous-sections. NE RÉSUME PAS, n'abrège pas, ne mets pas de "...". Vise à DÉPASSER chaque seuil indiqué.`;
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
        ? `Fichiers manquants (${missing.length}) — relance ${attempt}/${maxRetries}…`
        : unmet.length > 0
          ? `Contenu trop court (${unmet.length} contrainte(s)) — relance ${attempt}/${maxRetries}…`
          : `Résultat insuffisant — relance ${attempt}/${maxRetries}…`,
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
  return `${verifier.instructions || "Tu es un auditeur qualité senior."}

RÔLE : Tu audites le résultat GLOBAL d'une orchestration multi-agents. Tu vérifies que TOUS les livrables sont présents, complets, cohérents entre eux, et prêts à publier.

VERDICT : Réponds STRICTEMENT par un JSON valide :
{
  "pass": true ou false,
  "issues": [
    {"agent": "nom de l'agent", "issue": "description du problème", "fix": "action corrective précise"}
  ]
}

Si tout est correct, retourne {"pass": true, "issues": []}.
N'invente PAS de problèmes — signale uniquement ce qui est réellement incorrect ou manquant.`;
}

export interface QualityGateInputs {
  readonly globalTask: string;
  readonly nodeResultSummaries: string;
  readonly expectedFilesReport: string;
  readonly htmlHeads: string;
  readonly cssSnippets?: string;
  readonly brokenAssetsReport?: string;
}

export function buildQualityGateUserPrompt(inputs: QualityGateInputs): string {
  const sections = [
    `TÂCHE GLOBALE :\n${inputs.globalTask}`,
    `RAPPORT DES FICHIERS ATTENDUS :\n${inputs.expectedFilesReport}`,
    `RÉSUMÉS DES LIVRABLES PAR AGENT :\n${inputs.nodeResultSummaries}`,
    `CRITÈRES D'AUDIT GÉNÉRIQUES :
1. COMPLÉTUDE — Chaque agent a-t-il livré TOUT ce qui était demandé ? Fichiers attendus présents ?
2. QUALITÉ — Le contenu est-il substantiel (pas de placeholders, pas de Lorem ipsum, pas de "TODO") ?
3. COHÉRENCE — Les livrables des différents agents sont-ils compatibles entre eux ?
4. ERREURS CORRIGÉES — Si un agent a signalé des problèmes, ont-ils été corrigés ?`,
  ];

  if (inputs.htmlHeads.trim()) {
    sections.push(`CRITÈRES WEB (pages HTML détectées) :
EXTRAITS <head> :
${inputs.htmlHeads}

5. SEO — Chaque page HTML : <title> unique ≤60 chars, <meta name="description"> 120-160 chars, Open Graph (og:title, og:description, og:image), JSON-LD schema.org, attribut lang sur <html> ?
6. ACCESSIBILITÉ — Attributs alt sur images ? HTML sémantique ? Contraste WCAG AA ?
7. LIENS — Hot-links placeholder (picsum.photos, unsplash.com, via.placeholder.com) dans du code de production ?`);
  }

  if (inputs.cssSnippets && inputs.cssSnippets.trim()) {
    sections.push(`EXTRAITS CSS :
${inputs.cssSnippets}

CRITÈRES CSS — analyse les feuilles ci-dessus :
8. CONTRASTE — Les couleurs de texte sur fond atteignent-elles WCAG AA (≥ 4.5:1 texte normal, ≥ 3:1 grand texte/composants) ? Signale toute paire qui échoue avec les valeurs hex.
9. RESPONSIVE — Existe-t-il des largeurs fixes / grilles (ex: minmax(300px,1fr)) qui débordent sous 360px ? Y a-t-il des media queries mobile/tablette/desktop ?
10. PLACEHOLDERS — Reste-t-il des valeurs factices, "TODO", commentaires "à intégrer/à compléter", ou des tokens définis mais jamais appliqués ?`);
  }

  if (inputs.brokenAssetsReport && inputs.brokenAssetsReport.trim()) {
    sections.push(`${inputs.brokenAssetsReport}

11. ASSETS — Les références ci-dessus pointent vers des fichiers ABSENTS du disque. C'est un défaut BLOQUANT : chaque référence cassée doit être corrigée (déplacer/copier l'asset au bon endroit, ou corriger le chemin). Inclus-les dans "issues" avec le fix précis.
12. COUVERTURE DES PAGES — Si des "PAGES MAQUETTÉES MAIS JAMAIS CODÉES" sont listées ci-dessus, c'est un défaut BLOQUANT : chaque maquette doit avoir sa page servie équivalente, codée ET reliée à la navigation. Ajoute une "issue" par page manquante avec pour fix "coder la page <X> à partir de mockups/<X> et l'ajouter au menu".
13. SITE SERVI — Si des "DÉFAUTS DU SITE SERVI" sont listés ci-dessus, c'est BLOQUANT : (a) placeholder SVG gris → remplacer par les vraies images de la maquette ; (b) ressource sortant de la racine du site (../) → copier la ressource (ex: tokens.css) dans le dossier servi et corriger le chemin ; (c) pages ne partageant aucune feuille CSS commune → unifier toutes les pages sur la MÊME feuille principale. Ajoute une "issue" par défaut.`);
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
  const lines = broken.map((b) => `  ✗ ${b.sourceFile} → "${b.ref}" (introuvable)`);
  return `RÉFÉRENCES CASSÉES (détection déterministe) :\n${lines.join("\n")}`;
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
async function collectFiles(
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
  return `CSV incohérent : en-tête ${header} colonnes, ligne(s) [${bad.join(", ")}] diffèrent`;
}

/**
 * COUCHE 1 — enforces the planner-declared per-file constraints (checksMap).
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
      if (words < checks.minWords) push(`${words} mots < ${checks.minWords} requis`);
    }
    if (checks.minSections !== undefined) {
      const secs = (content.match(/^#{2,3}\s+\S/gm) ?? []).length;
      if (secs < checks.minSections) {
        push(`${secs} section(s) (titres ##/###) < ${checks.minSections} requises`);
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
          push(`${len} élément(s) < ${checks.minItems} requis`);
        }
      } catch {
        /* invalid JSON is owned by findInvalidJsonFiles — no duplicate */
      }
    }
    if (checks.requiredSubstrings) {
      const lower = content.toLowerCase();
      for (const s of checks.requiredSubstrings) {
        if (!lower.includes(s.toLowerCase())) {
          push(`chaîne obligatoire absente : "${s.slice(0, 60)}"`);
        }
      }
    }
    if (checks.format === "json") {
      try {
        JSON.parse(content);
      } catch {
        push("format json attendu : le fichier ne parse pas");
      }
    } else if (checks.format === "csv") {
      const p = csvColumnProblem(content);
      if (p) push(`format csv : ${p}`);
    } else if (checks.format === "md") {
      if (!/^#{1,6}\s+\S/m.test(content)) push("format md attendu : aucun titre détecté");
    }
  }
  return problems;
}

/**
 * COUCHE 2 — always-on. Flags CSV files whose rows don't match the header's
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
 * COUCHE 2 — always-on. Flags text DELIVERABLES (.md/.txt/.csv/.json/.rst) that
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
    // long document mentioning "lorem ipsum" once is not a bâclé deliverable.
    const isShort = trimmed.length < MIN_FILE_BYTES * 2;
    const occurrences = lower.split(hit).length - 1;
    if (isShort || occurrences >= 3) {
      problems.push({
        sourceFile: rel,
        problem: `placeholder / contenu incomplet détecté ("${hit}")`,
      });
    }
  }
  return problems;
}

const ENTRY_POINT_RE = /^(index|main|app|server|cli)\.|\.config\./i;

/**
 * COUCHE 2 — WARNING only (high false-positive risk). Flags produced JS/TS
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
        problem: "module jamais référencé/importé (code potentiellement mort)",
      });
    }
  }
  return problems;
}

// ── Cross-module symbol resolution (Couche 1 — force-fail) ─────────────────────
// The #1 multi-agent failure mode is incoherent APIs across files: agent A's
// entry point imports `sort_data` from B, but B (written by another agent)
// exports a `DataSorter` class instead → the program never even imports. This is
// invisible to a text-judging LLM verifier and to per-file checks. We catch it
// with a STATIC parse (no code execution → safe in the main process) of the
// import graph, for Python and TS/JS. Two problem classes:
//   • broken import — a NAMED import resolved to a local module that doesn't
//     define/export that symbol → the deliverable can't run.
//   • orphan module — a non-entry, non-test source file that exports symbols but
//     that no other file imports → unintegrated agent output / dead code.

type ModuleLang = "py" | "ts";

const TS_SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

interface ModuleInfo {
  // Names this module provides to importers.
  readonly exports: Set<string>;
  // True when the module re-exports an unknown set (export * / from x import *) —
  // we then can't prove a name is missing, so we skip name checks against it.
  readonly wildcardExports: boolean;
  // Local + external imports (spec kept raw; resolved later against the file set).
  readonly imports: ReadonlyArray<{
    readonly spec: string;
    readonly names: readonly string[];
    readonly checkNames: boolean;
  }>;
}

function parsePythonModule(content: string): ModuleInfo {
  const exports = new Set<string>();
  let wildcardExports = false;
  const imports: Array<{ spec: string; names: string[]; checkNames: boolean }> = [];

  for (const raw of content.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    let m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line);
    if (m) {
      exports.add(m[1]);
      continue;
    }
    m = /^class\s+([A-Za-z_]\w*)/.exec(line);
    if (m) {
      exports.add(m[1]);
      continue;
    }
    // Module-level binding `NAME = …` / `NAME: type = …` (col 0, not ==/+=).
    m = /^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/.exec(line);
    if (m) {
      exports.add(m[1]);
      continue;
    }
    m = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/.exec(line);
    if (m) {
      const spec = m[1];
      const rest = m[2].trim();
      if (rest.startsWith("*")) {
        wildcardExports = true; // `from X import *` re-exports an unknown set
        imports.push({ spec, names: [], checkNames: false });
        continue;
      }
      const names = rest
        .replace(/[()]/g, "")
        .split(",")
        .map((s) =>
          s
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        )
        .filter(Boolean);
      for (const n of names) exports.add(n); // re-exported → provided here too
      imports.push({ spec, names, checkNames: true });
      continue;
    }
    m = /^\s*import\s+([.\w]+)/.exec(line);
    if (m) imports.push({ spec: m[1], names: [], checkNames: false });
  }
  return { exports, wildcardExports, imports };
}

function parseTsModule(content: string): ModuleInfo {
  const exports = new Set<string>();
  let wildcardExports = false;
  const imports: Array<{ spec: string; names: string[]; checkNames: boolean }> = [];
  const src = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  for (const m of src.matchAll(
    /export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    exports.add(m[1]);
  }
  if (/export\s+default\b/.test(src)) exports.add("default");

  // export { a, b as c }  — local named exports; `… from '…'` makes it a re-export.
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g)) {
    const parts = m[1]
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, ""))
      .filter(Boolean);
    for (const p of parts) {
      const seg = p.split(/\s+as\s+/);
      exports.add((seg[1] ?? seg[0]).trim());
    }
    const fromSpec = m[2];
    if (fromSpec) {
      const srcNames = parts.map((p) => p.split(/\s+as\s+/)[0].trim()).filter(Boolean);
      imports.push({ spec: fromSpec, names: srcNames, checkNames: true });
    }
  }
  for (const m of src.matchAll(
    /export\s*\*\s*(?:as\s+[\w$]+\s+)?from\s*['"]([^'"]+)['"]/g,
  )) {
    wildcardExports = true;
    imports.push({ spec: m[1], names: [], checkNames: false });
  }
  for (const m of src.matchAll(/import\s+([^'"]+?)\s+from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const spec = m[2];
    if (/\*\s+as\s+/.test(clause)) {
      imports.push({ spec, names: [], checkNames: false }); // namespace import
      continue;
    }
    const braces = /\{([^}]*)\}/.exec(clause);
    const named = braces
      ? braces[1]
          .split(",")
          .map((p) => p.trim().replace(/^type\s+/, ""))
          .filter(Boolean)
          .map((p) => p.split(/\s+as\s+/)[0].trim())
      : [];
    imports.push({ spec, names: named, checkNames: named.length > 0 });
  }
  for (const m of src.matchAll(/import\s*['"]([^'"]+)['"]/g)) {
    imports.push({ spec: m[1], names: [], checkNames: false }); // side-effect import
  }
  return { exports, wildcardExports, imports };
}

function resolveLocalModule(
  spec: string,
  fromRel: string,
  byRel: ReadonlySet<string>,
  lang: ModuleLang,
): string | null {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const fromDir = path.posix.dirname(norm(fromRel));

  if (lang === "ts") {
    if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // npm package
    const base = norm(
      spec.startsWith("/") ? spec.slice(1) : path.posix.join(fromDir, spec),
    );
    const candidates: string[] = [];
    if (path.posix.extname(base)) candidates.push(base);
    else {
      for (const ext of TS_SOURCE_EXTS) candidates.push(base + ext);
      for (const ext of TS_SOURCE_EXTS) candidates.push(`${base}/index${ext}`);
    }
    for (const c of candidates) if (byRel.has(c)) return c;
    return null;
  }

  // Python: dotted module, optional leading dots for relative imports.
  const lead = /^\.+/.exec(spec);
  let dotted = spec;
  let dir = fromDir;
  if (lead) {
    dotted = spec.slice(lead[0].length);
    for (let i = 0; i < lead[0].length - 1; i++) dir = path.posix.dirname(dir);
  }
  const relPath = dotted.replace(/\./g, "/") + ".py";
  const candidates = lead
    ? [norm(path.posix.join(dir, relPath))]
    : [relPath, `src/${relPath}`];
  for (const c of candidates) if (byRel.has(c)) return c;
  // Fallback: match by basename anywhere (sys.path hacks are common in scripts).
  const baseName = (dotted.split(".").pop() ?? "") + ".py";
  for (const rel of byRel) if (path.posix.basename(rel) === baseName) return rel;
  return null;
}

const ORPHAN_SKIP_RE =
  /^(index|main|app|server|cli|setup|conftest|__main__|__init__)\.|\.config\.|\.d\.ts$/i;
// Test files are entry points for the test runner — never imported by source, so
// they must not be flagged as orphans (JS `.test.`/`.spec.` + Python test_*/*_test).
const TEST_FILE_RE = /(\.(test|spec)\.|^test_.*\.py$|_test\.py$|^test\.py$)/i;

/**
 * COUCHE 1 — force-fail. Static import-graph analysis (Python + TS/JS). Returns
 * broken cross-module imports (a named symbol imported from a local module that
 * doesn't provide it) and orphan modules (exporting files no one imports). Both
 * are deterministic and attributed to the owning agent by the caller, so the
 * corrective cycle routes the fix. No code is executed.
 */
export async function findModuleGraphProblems(
  workspaceDir: string,
): Promise<readonly ServedSiteProblem[]> {
  const problems: ServedSiteProblem[] = [];
  const seen = new Set<string>(); // dedupe identical (file, problem) pairs
  const MAX_PROBLEMS = 60;
  const push = (sourceFile: string, problem: string): void => {
    const key = `${sourceFile}::${problem}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ sourceFile, problem });
  };

  const groups: ReadonlyArray<{
    lang: ModuleLang;
    files: Array<{ rel: string; full: string }>;
  }> = [
    { lang: "py", files: await collectFiles(workspaceDir, (n) => /\.py$/i.test(n)) },
    {
      lang: "ts",
      files: await collectFiles(
        workspaceDir,
        (n) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(n) && !/\.d\.ts$/i.test(n),
      ),
    },
  ];

  for (const { lang, files } of groups) {
    if (files.length === 0) continue;
    const byRel = new Set(files.map((f) => f.rel.replace(/\\/g, "/")));
    const info = new Map<string, ModuleInfo>();
    for (const f of files) {
      try {
        const content = await fs.readFile(f.full, "utf-8");
        info.set(
          f.rel.replace(/\\/g, "/"),
          lang === "py" ? parsePythonModule(content) : parseTsModule(content),
        );
      } catch {
        /* unreadable — skip */
      }
    }

    // (1) Broken named imports.
    const importedTargets = new Set<string>();
    for (const f of files) {
      const relN = f.rel.replace(/\\/g, "/");
      const mod = info.get(relN);
      if (!mod) continue;
      for (const imp of mod.imports) {
        const target = resolveLocalModule(imp.spec, relN, byRel, lang);
        if (!target) continue;
        importedTargets.add(target);
        if (!imp.checkNames || problems.length >= MAX_PROBLEMS) continue;
        const targetMod = info.get(target);
        if (!targetMod || targetMod.wildcardExports) continue;
        for (const name of imp.names) {
          if (name === "default" || targetMod.exports.has(name)) continue;
          push(
            f.rel,
            `importe « ${name} » depuis ${target}, mais ce module ne définit/exporte pas « ${name} » — API incohérente entre agents (le livrable ne s'exécutera pas).`,
          );
          if (problems.length >= MAX_PROBLEMS) break;
        }
      }
    }

    // (2) Orphan modules — only meaningful when several files are expected to
    // wire together; conservative to avoid flagging legitimate standalone files.
    if (files.length >= 3) {
      for (const f of files) {
        if (problems.length >= MAX_PROBLEMS) break;
        const relN = f.rel.replace(/\\/g, "/");
        const name = path.posix.basename(relN);
        if (ORPHAN_SKIP_RE.test(name) || TEST_FILE_RE.test(name)) continue;
        if (/(^|\/)(dist|build)(\/|$)/i.test(relN)) continue;
        const mod = info.get(relN);
        if (!mod || mod.exports.size === 0) continue; // no API to integrate
        if (importedTargets.has(relN)) continue;
        push(
          f.rel,
          "module jamais importé par les autres fichiers — sortie d'agent non intégrée (code mort). Câble-le dans le point d'entrée ou supprime-le.",
        );
      }
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
// would skip the whole tree. Shared by the divergent (Problème 1) and scattered
// (Problème 2) duplicate scans.
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
 * COUCHE 2 — WARNING only. Flags content files (.md/.json/.csv/.txt) that share
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
      problem: `fichier dupliqué avec contenus divergents : ${listed} — une seule source de vérité, supprime/fusionne les copies`,
    });
  }
  return problems;
}

/**
 * COUCHE 2 — WARNING only (Problème 2 — éparpillement). Flags content files
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
        problem: `contenu identique éparpillé dans ${occ.length} emplacements : ${listed} — choisis UN emplacement canonique et supprime les copies`,
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
 * COUCHE 2 — WARNING only (Problème 3). Flags web scaffolding (sitemap.xml,
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
          "scaffolding web hors-sujet — le livrable n'est pas un site web (aucune page HTML servie substantielle) ; supprime ce fichier de SEO/déploiement",
      });
    }
  }
  return problems;
}

const DESIGN_ARTIFACT_RE = /(maquette|mockup|wireframe|style[_-]?guide)/i;

/**
 * COUCHE 2 — WARNING only (Problème 5). Flags design artifacts (mockup HTML,
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
          "artefact design inutile — le livrable n'a pas d'interface web (workspace documentaire) ; une maquette/charte n'a pas lieu d'être",
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
  return `PAGES MAQUETTÉES MAIS JAMAIS CODÉES (détection déterministe) — chaque maquette doit avoir sa page servie équivalente, codée et accessible depuis la navigation :\n${lines.join("\n")}`;
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
              problem: `${placeholders} image(s) en placeholder SVG gris (data:image/svg+xml) — remplace par les vraies images de la maquette`,
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
                problem: `"${ref}" sort de la racine du site (${path.basename(servedRoot)}/) — cassé au déploiement, copie la ressource dans le site`,
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
  return `DÉFAUTS DU SITE SERVI (détection déterministe) :\n${lines.join("\n")}`;
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
        problem: `les pages ne partagent AUCUNE feuille CSS commune → rendu incohérent (${examples}). Unifie toutes les pages sur la MÊME feuille principale.`,
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
        problem: `consolidation incomplète : ${fw} mots vs ~${sourceWords} dans les sources content/ — INCLURE le contenu intégral de chaque source, ne pas résumer`,
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
          problem: `${unmatched.length}/${used.size} classes sans règle CSS (page non/insuffisamment stylée) — ex: ${unmatched
            .slice(0, 5)
            .map((c) => "." + c)
            .join(", ")}. Vérifie que le bon CSS est lié.`,
        });
      }
    }
  }
  return problems;
}

export function parseQualityVerdict(raw: string): QualityVerdict | null {
  try {
    const cleaned = raw
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    const parsed = JSON.parse(cleaned) as { pass?: boolean; issues?: QualityIssue[] };
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
  return `[CYCLE QUALITÉ AUTOMATIQUE]\nLe vérificateur a identifié les problèmes suivants à corriger :\n${lines.join("\n")}`;
}

export function buildSyntheticRun(
  task: string,
  orchId: string,
  statuses: Readonly<Record<string, "done" | "error" | "skipped">>,
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
