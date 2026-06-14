import { promises as fs } from "fs";
import path from "path";
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
}

export interface EnforceDeliverablesDeps {
  readonly relaunch: (prompt: string) => Promise<string>;
  readonly writeFiles: (text: string) => Promise<readonly string[]>;
  readonly onStatus: (msg: string) => void;
}

export async function enforceDeliverables(
  node: Project,
  expected: readonly string[],
  workspaceDir: string,
  initialResult: string,
  deps: EnforceDeliverablesDeps,
): Promise<EnforceDeliverablesResult> {
  // Clamp to a sane ceiling: maxRetries is persisted per-node and could otherwise be
  // set to a huge value, making a single node hammer the LLM/backend indefinitely.
  const MAX_RETRIES_CEILING = 5;
  const maxRetries = Math.min(Math.max(node.maxRetries ?? 2, 1), MAX_RETRIES_CEILING);
  let resultText = initialResult;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const { present, missing } =
      expected.length > 0
        ? await checkExpectedFiles(workspaceDir, expected)
        : { present: [] as string[], missing: [] as string[] };

    const trivial = isTrivialResult(resultText) && present.length === 0;

    if (missing.length === 0 && !trivial) {
      return { resultText, missing: [], trivial: false };
    }

    const prompt =
      missing.length > 0
        ? buildMissingFilesPrompt(node, missing)
        : buildTrivialResultPrompt(node);

    deps.onStatus(
      missing.length > 0
        ? `Fichiers manquants (${missing.length}) — relance ${attempt}/${maxRetries}…`
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

  return { resultText, missing: finalCheck.missing, trivial: finalTrivial };
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

  // Find served roots (public/, dist/, …) anywhere shallow in the workspace.
  let topEntries: import("fs").Dirent[];
  try {
    topEntries = await fs.readdir(workspaceDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots = topEntries
    .filter((e) => e.isDirectory() && SERVED_ROOT_NAMES.has(e.name.toLowerCase()))
    .map((e) => path.resolve(workspaceDir, e.name));
  // Fallback: some runs write the served site directly at the workspace root
  // (no public/dist wrapper). Scan the root too (mockups/ and design/ are
  // excluded inside walk) so these checks aren't silently skipped.
  if (roots.length === 0) roots.push(path.resolve(workspaceDir));
  for (const root of roots) {
    await scanRoot(root);
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
  let topEntries: import("fs").Dirent[];
  try {
    topEntries = await fs.readdir(workspaceDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const problems: ServedSiteProblem[] = [];

  const roots = topEntries
    .filter((e) => e.isDirectory() && SERVED_ROOT_NAMES.has(e.name.toLowerCase()))
    .map((e) => ({ dir: path.resolve(workspaceDir, e.name), label: `${e.name}/` }));
  // Fallback: site served directly from the workspace root (no public/dist).
  if (roots.length === 0) {
    roots.push({ dir: path.resolve(workspaceDir), label: "(racine)" });
  }

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
