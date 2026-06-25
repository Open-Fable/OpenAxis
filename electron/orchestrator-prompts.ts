import { promises as fs } from "fs";
import path from "path";
import type { Project } from "./project-store.js";

// ── Context helpers ──────────────────────────────────────────────────────────

export async function buildWorkspaceContext(workspaceDir: string): Promise<string> {
  const indexPath = path.join(workspaceDir, "WORKSPACE_INDEX.md");
  try {
    const content = await fs.readFile(indexPath, "utf-8");
    const trimmed = content.substring(0, 24000);
    return `[WORKSPACE STATE]\n${trimmed}`;
  } catch {
    return "[WORKSPACE STATE]\nNo indexed files. The workspace is empty or uninitialized.";
  }
}

export function buildDependencyContext(
  node: Project,
  allProjects: readonly Project[],
  executionResults: ReadonlyMap<string, string>,
  // Optional per-dependency disk evidence (depId → real file content snippet).
  // Injected for the pure-LLM path, which has no disk access of its own. Backend
  // nodes (OpenCode) already read the workspace via their tools, so the caller
  // passes nothing for them.
  depDiskEvidence?: ReadonlyMap<string, string>,
): string {
  const deps = node.dependencies ?? [];
  if (deps.length === 0) return "";

  // Per-dep caps bound a single dependency, but a node depending on MANY agents
  // (e.g. a global verifier) sums to a huge context that inflates cost and dilutes
  // the verdict. Bound the cumulative size — above the largest single-dep cap
  // (design 60k) so one big authoritative dep is never truncated below its budget.
  const MAX_TOTAL_DEP_CONTEXT = 96_000;
  const blocks: string[] = [];
  let totalLen = 0;
  let hasAuthoritativeSource = false;
  let hasWebArtifacts = false;
  for (const depId of deps) {
    const depProject = allProjects.find((p) => p.id === depId);
    const result = executionResults.get(depId);
    if (!depProject) continue;
    if (
      depProject.type === "design" ||
      depProject.type === "work" ||
      depProject.type === "recherche"
    ) {
      hasAuthoritativeSource = true;
    }
    // Web artifacts = the design backend (always produces HTML/CSS mockups) OR a
    // dependency whose output actually contains an .html/.css file. Only then does
    // the mockup-specific fidelity mandate apply — otherwise it pollutes non-web
    // pipelines (a code library depending on a research spec, a data report, …).
    if (
      depProject.type === "design" ||
      (result && /filepath:\s*[^\n]*\.(html?|css)\b/i.test(result))
    ) {
      hasWebArtifacts = true;
    }

    const header = `--- Agent "${depProject.name}" (${depProject.type ?? "unknown"}) ---`;
    // Once the global budget is spent, name remaining deps without their content.
    const remaining = MAX_TOTAL_DEP_CONTEXT - totalLen;
    if (remaining <= 600) {
      const line = `${header} [content omitted — context budget reached; full file is on disk]`;
      blocks.push(line);
      totalLen += line.length;
      continue;
    }

    const perTypeCap = depProject.type === "design" ? 60_000 : 24_000;
    const maxLen = Math.min(perTypeCap, remaining);
    const resultSummary = result ? result.substring(0, maxLen) : "(not yet executed)";

    const evidence = depDiskEvidence?.get(depId);
    const evidenceBlock =
      evidence !== undefined && evidence.trim().length > 0
        ? `\nPRODUCED FILES (real on-disk content — AUTHORITATIVE) :\n${evidence}`
        : "";

    let block = `${header}\nTask: ${depProject.task ?? "undefined"}\nResult:\n${resultSummary}${evidenceBlock}`;
    if (totalLen + block.length > MAX_TOTAL_DEP_CONTEXT) {
      block =
        block.substring(0, Math.max(0, MAX_TOTAL_DEP_CONTEXT - totalLen)) +
        "\n[… dependency context truncated — global budget reached; full content on disk …]";
    }
    blocks.push(block);
    totalLen += block.length;
  }

  if (blocks.length === 0) return "";

  const reproduces = node.type === "code" || node.type === "work";
  // Neutral mandate for non-web pipelines: reuse the upstream contracts/data/
  // decisions faithfully, without any mockup/page/CSS vocabulary.
  const neutralMandate = `\n\n⚠️ FIDELITY MANDATE — NON-NEGOTIABLE :
The results from the agents above are AUTHORITATIVE. You MUST faithfully REUSE them — not "draw inspiration", not reinvent.
- Reproduce EXACTLY the decisions, contracts, schemas, names, structures and data already produced (e.g. data schema → access layer; specification → implementation; content → formatting).
- Do NOT invent any new name/identity or structure if a source already defines one; do not contradict upstream data.
- If sources CONTRADICT each other, pick ONE, apply it everywhere, note the contradiction in a comment — NEVER create a third version.`;
  const webMandate = `\n\n⚠️ FIDELITY MANDATE — NON-NEGOTIABLE :
The results above (mockups, design system, brand guidelines, content) are AUTHORITATIVE. You MUST reproduce them IDENTICALLY — not "draw inspiration", not redesign.
- FULL COVERAGE — CODE ALL PAGES: there must be a served page for EVERY mockups/*.html file (except components.html which is a demo gallery). If the mockup has 15 pages, the served site must have 15. Do NOT code only a subset (index/catalog/product): about_us, contact, cart, checkout, confirmation, product_detail, admin… must ALL exist.
- START FROM MOCKUP FILES, DO NOT REWRITE THEM: for each page, take the existing mockups/<page>.html as a base and copy it as-is into the served folder. Do not write new HTML from scratch.
- COHERENT NAVIGATION — ZERO DEAD LINKS: every <a href="X.html"> must point to a page that actually EXISTS in the served folder. Do not invent links (vision.html, etc.). Wire the purchase flow: cart.html → checkout.html → confirmation.html, and make checkout/confirmation REACHABLE from navigation (not orphan pages accessible only by direct URL).
- SERVED CSS TOKENS: if a stylesheet @imports a tokens.css, copy that tokens.css INTO the served folder and fix the path to be relative to the served folder (never ../design/… which leaves the site root). All var(--…) variables must resolve.
- CSS — REUSE THE MOCKUP'S CSS AS-IS: copy the mockup's CSS file(s) into the SAME folder as the pages and keep EXACTLY the same <link> as the mockup (if it links "styles.css", link "styles.css" — do not link tokens.css/layout.css directly, do not re-split, do not rename to style.css/main.css).
- IDENTICAL CLASS NAMES: keep STRICTLY the same class="..." as the mockup. Do NOT invent any new class (e.g. do not replace .product-card with .feature-card). Every class used in the HTML MUST have its CSS rule in the linked CSS — otherwise the page is unstyled and images appear in empty containers.
- Colors / tokens: reuse EXACTLY the same CSS variables and hex values. Do NOT invent any new color, any new theme (no dark if the mockup is light, etc.).
- Page structure / layout: reproduce the mockup's layout (header, sections, grid, footer).
- Identity / brand: reuse the SAME name (artist, product, brand) and SAME content (bio, texts) as the sources. Do NOT invent any new name or identity.
- IMAGES: keep EXACTLY the same <img> / src tags as the mockup (same URLs or same paths). Do not delete images, do not change their paths. NEVER use a gray SVG placeholder (data:image/svg+xml with a rectangle + text) instead of a real mockup image.
- Your role = make the mockup FUNCTIONAL (JS, cart, navigation) ON TOP OF it, without touching the visual rendering.
- If sources CONTRADICT each other (e.g. two different artist names), pick ONE, apply it everywhere, and note the contradiction in a comment — NEVER create a third version.
FORBIDDEN: starting from a blank page, rewriting HTML, renaming CSS classes, re-splitting/renaming CSS, changing the palette, renaming the identity, deleting images.`;
  const fidelityMandate = !reproduces
    ? ""
    : hasWebArtifacts
      ? webMandate
      : hasAuthoritativeSource
        ? neutralMandate
        : "";

  return `[PREVIOUS AGENT RESULTS]\nThe following agents have already completed their work. Use their results as a base.\n\n${blocks.join("\n\n")}${fidelityMandate}`;
}

// ── Per-type agent rules ──────────────────────────────────────────────────────

// Shared CSS & image policy — #1 cause of broken rendering (pages without CSS,
// images that never display). Injected into every agent type producing HTML
// to ensure self-contained offline rendering.
const ASSET_POLICY = `CSS & IMAGE RULES (#1 CAUSE OF BROKEN RENDERING — STRICT) :
- IMAGES — ABSOLUTELY FORBIDDEN to use external image URLs (unsplash.com, images.unsplash.com, picsum.photos, placeholder.com, loremflickr, source.unsplash…). These IDs are INVENTED, return 404, and the image NEVER displays. Instead, for any illustration without a real image file in the workspace: insert an INLINE SVG (<svg viewBox> with brand-colored background, simple shape/icon and a short label). An inline SVG ALWAYS displays, offline, with zero dependencies. Only write an <img src="path"> tag if that file actually exists in the workspace with a correct relative path.
- CSS — each page must stay styled even when opened alone. A SINGLE entry CSS file named "styles.css", in the SAME folder as the HTML pages. Every page links it with EXACTLY <link rel="stylesheet" href="styles.css">. If you split CSS (tokens, layout…), "styles.css" aggregates them via @import (relative paths to the same folder) — pages NEVER link tokens.css/layout.css directly. One filename, one folder: never "style.css" here and "styles.css" there, never "css/" and "assets/css/" in parallel.
- FINAL CHECK: every local href/src points to a file that actually exists (or an inline SVG). Zero broken links, zero pages without CSS.`;

// Compact version of the asset policy — for the "light model" tier.
const ASSET_POLICY_COMPACT = `ASSETS (key): images → inline SVG (NEVER external URLs like unsplash/picsum, they 404). A single "styles.css" in the same folder as pages, linked by <link rel="stylesheet" href="styles.css">. Every local href/src points to a real file.`;

const QUALITY_RULES: Record<string, string> = {
  code: `QUALITY RULES :
- COMPLETE, PRODUCTION-READY code — no placeholders, no "// TODO", no "...", no shortcuts
- Strict TypeScript, no \`any\` except at serialization boundaries
- Functions < 50 lines, files < 400 lines
- Explicit error handling at every level
- No hardcoded secrets — use environment variables
- Include ALL necessary imports
- Write corresponding unit tests
- DEPTH: every file must be complete and functional — no empty functions, no "to be filled"
- VOLUME: if the task asks for N files, produce ALL of them in full
- Every component must be wired, imported, and usable without modification

IF YOU PRODUCE HTML PAGES (web deliverable) :
- REQUIRED SEO per page: unique <title> ≤60 chars, <meta name="description"> 120-160 chars, full Open Graph (og:title, og:description, og:image), appropriate schema.org JSON-LD, lang attribute on <html>, alt attributes on all images
- sitemap.xml and robots.txt if the site has multiple pages

IF YOU PRODUCE A LIBRARY / CLI / API / DATA (NOT a website) — IGNORE the HTML/CSS/SEO rules above :
- LIBRARY: clear documented public API, real unit tests (that verify behavior, not empty stubs), README with usage examples, packaging file (package.json / pyproject.toml…).
- CLI: executable entry point, argument parsing, help messages (--help), exit codes, examples in the README.
- API: IMPLEMENTED and FUNCTIONAL endpoints (not just described), input validation, error handling, request/response examples.
- DATA: VALID .json/.csv files (parseable JSON, consistent CSV columns), documented schema, reproducible generation script if relevant.
- The frontend/consumer must ACTUALLY use what you produce (import the module, read the data) — no dead code never referenced.
- EXACT API NAMES ACROSS FILES (CRITICAL): when importing from a module produced by another agent (seen in dependency context), use EXACTLY the function/class/constant name actually exported by that module — do not guess, do not invent a "likely" name. If you write the entry point (main.py, index.ts, cli…), re-read the actual exports of each imported module: an import must target a symbol that actually exists in the target module. One naming convention for the whole project (not "ErrorHandler" here and "ErrorTracker" there).
- CONSISTENT SIGNATURES: call imported functions with the right arguments and respect their return type (a generator is not a list: don't apply len()/direct serialization without consuming it first).
- BUILD/TEST CONFIG: if the deliverable is buildable/testable, provide the config to run it as-is (e.g. tsconfig.json + jest/vitest config for TypeScript, pyproject.toml/requirements if needed). The "build" and "test" commands must work without missing files.

IF MOCKUPS OR A DESIGN SYSTEM ALREADY EXIST (design/work dependencies OR workspace files) :
- READ existing design files (tokens.css, design_system/*, mockups/*.html, mockups/*.css, content/*.md) BEFORE writing a single line. They are AUTHORITATIVE.
- REPRODUCE them faithfully: same CSS variables and same hex values, same typography, same layout, same identity/brand. Do NOT redesign, do NOT invent a new theme or palette.
- NEVER invent a new artist/brand name or new content: reuse those from the sources. If sources contradict each other, pick ONE, apply it everywhere, note it in a comment.
- ASSET COLOCATION: place HTML, CSS, JS AND images/SVG in the SAME served folder. If a mockup links "styles.css", reuse that SAME name and SAME folder — do not rename, do not scatter into css/ + assets/css/.

INTEGRATION — THE FRONTEND MUST CONSUME WHAT WAS PRODUCED (no dead code) :
- Actually wire the produced JS: served pages must LOAD the written logic (cart, payment, stock) and data (e.g. content/products.json, data/*.json) — do not display hardcoded products if a data file exists.
- DO NOT REIMPLEMENT logic already written in another file (e.g. don't redo a mini-cart in app.js if cart_logic.js exists): import/reuse the existing module, and SERVE it (place it in the served folder or reference it correctly).
- If a backend was produced (API, models, schema), the frontend must call it (fetch to endpoints) OR, for a static site, read the corresponding data files. NEVER leave a backend or JS module written but never referenced by any page.

${ASSET_POLICY}`,

  design: `QUALITY RULES — VISUAL MOCKUPS (CRITICAL ROLE) :
You are the ONLY agent who creates visual mockups. The "code" agent will then code EXACTLY what you produce. If your mockup is incomplete or sloppy, the final site will be too.

NON-NEGOTIABLE REQUIREMENTS :
- COMPLETE functional HTML/CSS code — no textual descriptions, no summaries, actual CODE
- EACH requested page = a complete HTML file with all CSS embedded or linked
- REAL responsive design with media queries: mobile (< 768px), tablet (768-1024px), desktop (> 1024px)
- CSS variables for ALL tokens: colors, sizes, spacing, border-radius, shadows, transitions
- Design tokens documented in a dedicated file (design-tokens.css or tokens.json)

REQUIRED DEPTH :
- COMPLETE design system: tokens, reusable components, layouts, grids
- ALL interactive states: hover, focus, active, disabled, loading, error, empty, selected
- CSS transitions and animations (ease-in-out, consistent durations)
- Shadows, border-radius, micro-interactions for a PROFESSIONAL look
- Complete hierarchical typography (h1→h6, body, caption, button, link)
- Full color palette with variants (primary-50 to primary-900, neutral, accent, success, warning, error)

CONTENT :
- NEVER "Lorem ipsum", NEVER "Title here", NEVER placeholder
- REAL content consistent with the project
- Icons: inline SVG or sprite — no external CDN dependencies

COMPONENTS TO INCLUDE (if relevant) :
- Header with navigation (desktop + mobile hamburger)
- Complete footer (links, copyright, social media)
- Styled forms (inputs, selects, textareas, visual validation)
- Buttons (primary, secondary, ghost, danger, sizes S/M/L)
- Cards, modals, toasts/notifications, breadcrumbs, pagination
- Responsive tables, lists, badges, tags, tooltips

ACCESSIBILITY :
- Minimum WCAG AA contrast (4.5:1 text, 3:1 UI components)
- Visible distinct focus for keyboard navigation
- Aria-labels on interactive elements
- Semantic HTML (header, nav, main, section, article, footer)

DO NOT BE STINGY WITH TOKENS: a good mockup is LONG and DETAILED. The goal is a PRODUCTION-READY result that the code agent can faithfully implement.

${ASSET_POLICY}`,

  work: `QUALITY RULES :
- Semantic valid HTML (landmarks, hierarchical headings, aria-labels)
- Faithful integration with mockups/specifications
- Asset optimization (compressed images, lazy loading, srcset for responsive)
- DEPTH: each page must be COMPLETE — no truncated content or "coming soon" sections
- VOLUME: if the task mentions N pages/articles, produce all N in full with rich content
- Each article/page must have at least 500 words of real relevant content
- Do not produce generic content — personalize each element to the subject
- Brand guidelines: produce an exhaustive document (philosophy, complete palette with hex/HSL codes, typefaces with fallbacks, spacing scale, UI components)

IF YOU PRODUCE HTML PAGES :
- REQUIRED SEO per page: unique <title> ≤60 chars, <meta name="description"> 120-160 chars, full Open Graph (og:title, og:description, og:image), schema.org JSON-LD adapted to page type, canonical, lang attribute on <html>
- Descriptive alt attributes on ALL images
- sitemap.xml and robots.txt if multi-page

${ASSET_POLICY}`,

  verifier: `VERIFICATION RULES :
- Analyze each deliverable against objective measurable criteria
- Distinguish blocking errors (CRITICAL) from desirable improvements (WARNING)
- Provide concrete examples for each identified problem
- Propose a PRECISE fix for each error (what to change, where, success criterion) — without applying it yourself
- REPORT ONLY: you produce ONLY your audit report. You do NOT rewrite other agents' files and you NEVER claim to have fixed/reapplied/applied anything — the orchestrator routes fixes to the owning agents
- QUANTITATIVE CONSISTENCY: compare SHARED FACTS across files (prices, amounts, %, dates, quantities, names, units); the same quantity with two different values across files = CRITICAL error
- Check COMPLETENESS: does the deliverable cover EVERYTHING that was requested?
- Check DEPTH: is the content superficial or truly developed?
- Check PRESENCE of expected files (expected_files) for each agent
- Do not invent problems — only report what is actually incorrect
- Produce a concrete file → fix list for each problem

IF HTML PAGES ARE PRESENT :
- Check SEO of each page: <title> ≤60 chars, <meta description> 120-160, OG, JSON-LD, lang, alt
- Flag placeholder hot-links in production code`,

  recherche: `QUALITY RULES :
- Structure results with clear hierarchical sections
- Cite sources when applicable
- Distinguish facts from recommendations
- Prioritize actionable information
- Provide an executive summary at the start of the deliverable
- DEPTH: each section must be developed with examples, data, historical context if relevant
- VOLUME: do not skim — deepen each point with at least 3-5 paragraphs
- Provide concrete detailed recommendations, not generalities`,
};

// Compact rules (~50 % shorter, positively phrased, with a
// good/bad mini-example) for the "light model" tier. Security invariants are
// PRESERVED: secrets → env vars, identity consistency,
// asset path validity/colocation.
const QUALITY_RULES_COMPACT: Record<string, string> = {
  code: `RULES (essentials) :
- Deliver COMPLETE functional code — no "// TODO", no "...", no skeleton.
- Include ALL imports; every file must run as-is.
- Secrets → environment variables, NEVER hardcoded in code.
- If mockups/design exist (dependencies or workspace), READ and reproduce them identically: same colors, same identity/brand, same names. Do not invent a new theme or name.
- If the task asks for N files, produce ALL of them.

✅ GOOD: const key = process.env.API_KEY ; <img src="logo.svg"> (file exists)
❌ BAD: const key = "sk-123" ; <img src="https://unsplash.com/photo">

${ASSET_POLICY_COMPACT}`,

  design: `RULES (essentials) — you create the mockups the code agent will reproduce :
- Deliver COMPLETE HTML/CSS (code, not a description); one page = one file.
- Real responsive (mobile/tablet/desktop media queries); CSS variables for colors/spacing.
- ALL interactive states: hover, focus, active, disabled, loading, empty, error.
- REAL content (never "Lorem ipsum" or "Title here"), consistent with the project's identity.
- Accessibility: WCAG AA contrast, visible focus, semantic HTML.

✅ GOOD: --color-primary defined once and reused; button with :hover AND :focus
❌ BAD: hex colors repeated hardcoded; only default state

${ASSET_POLICY_COMPACT}`,

  work: `RULES (essentials) :
- Semantic valid HTML; each page COMPLETE (no "coming soon" section).
- If the task asks for N pages/articles, produce all N, each ≥ 500 words of real content.
- Personalize to the subject — no generic content.
- Reuse the identity/brand and colors from sources; do not invent a new name.
- HTML pages: unique <title>, <meta name="description">, alt attribute on every image.

✅ GOOD: 600-word article specific to the subject; <img alt="portrait of the artist">
❌ BAD: 3 generic lines; "lorem ipsum"

${ASSET_POLICY_COMPACT}`,

  recherche: `RULES (essentials) :
- Structure in clear sections, with an executive summary at the start.
- Cite sources; clearly distinguish facts from recommendations.
- Deepen each point (examples, data) — do not skim.
- End with concrete actionable recommendations.

✅ GOOD: "Source: X (2024). Fact: … → Recommendation: …"
❌ BAD: one vague paragraph, no source, no recommendation`,
};

function getQualityRules(type: string | undefined, compact = false): string {
  const key = type ?? "code";
  if (compact) {
    return QUALITY_RULES_COMPACT[key] ?? QUALITY_RULES[key] ?? QUALITY_RULES.code;
  }
  return QUALITY_RULES[key] ?? QUALITY_RULES.code;
}

const TYPE_ROLE_HINTS: Record<string, string> = {
  recherche: "Research and data synthesis",
  work: "OpenWork — content/writing, structured data, and (for a site) design system, brand guidelines, HTML/CSS integration",
  design:
    "Open Design — DETAILED web visual mockups (HTML/CSS), ONLY if the deliverable has a UI. The code agent will faithfully reproduce them.",
  code: "OpenCode — development of the functional deliverable (app, library, API, CLI, scripts, data); reproduces mockups if they exist",
  verifier: "Testing and quality assurance",
};

// ── 1. Planning ──────────────────────────────────────────────────────────────

export function buildPlanningSystemPrompt(orchestrator: Project): string {
  const base = orchestrator.instructions || "";
  return `You are an AI project coordinator. You break down a global task into precise sub-tasks for specialized agents.

${base ? `CUSTOM INSTRUCTIONS:\n${base}\n` : ""}ROLE OF EACH AGENT TYPE :
- "recherche" → Investigation, data collection, state of the art
- "work" → OpenWork: design system (colors, typography, spacing), brand guidelines, content writing, HTML/CSS integration
- "design" → Open Design: visual mockups ONLY, based on the design system and content already produced by "work"/"recherche"
- "code" → OpenCode: coding the site/app from the mockups. Does NOT do the design system or content.
- "verifier" → Testing and quality assurance

RESPONSIBILITIES :
- Analyze the global task and identify ALL necessary deliverables
- Assign each agent a task matching their ROLE above
- Ensure consistency between tasks (no contradictions, no duplicates)
- Respect dependencies between agents

DECOMPOSITION RULES :
- Each task = ONE verifiable deliverable (not "do multiple things")
- Each task must be understandable without external context
- Specify the expected OUTPUT FORMAT (files to create, structure, conventions)
- Specify CONSTRAINTS (technologies, standards, compatibility)
- Specify SUCCESS CRITERIA (how to verify it's done well)
- Adapt the level of detail to the agent type

RESPONSE FORMAT :
Return STRICTLY a flat JSON object with no other text or markdown tags.
Keys are project IDs, values are structured tasks.`;
}

export function buildPlanningUserPrompt(
  globalTask: string,
  linkedProjects: readonly Project[],
  workspaceContext: string,
): string {
  const agentList = linkedProjects
    .map((p) => {
      const deps = p.dependencies ?? [];
      const depInfo =
        deps.length > 0
          ? ` | Depends on: ${deps.map((d) => linkedProjects.find((lp) => lp.id === d)?.name ?? d).join(", ")}`
          : "";
      const roleHint = TYPE_ROLE_HINTS[p.type ?? ""] ?? "General";
      return `- ID: "${p.id}" | Name: "${p.name}" | Type: ${p.type ?? "undefined"} (${roleHint})${depInfo}\n  Skills: ${p.instructions || "not specified"}`;
    })
    .join("\n");

  return `GLOBAL TASK :
"${globalTask}"

${workspaceContext}

AVAILABLE AGENTS :
${agentList}

INSTRUCTIONS :
Respect the roles per type — "work" handles colors/branding/content, "design" makes mockups AFTER, "code" codes FROM the mockups.
For each agent, generate a structured task containing:
1. OBJECTIVE — What the agent must concretely produce
2. CONTEXT — What it needs to know (dependencies, project constraints)
3. FORMAT — Expected files/deliverables with their structure
4. CRITERIA — How to verify the work is correct

EXAMPLE RESPONSE :
{
  "p1": "OBJECTIVE: Implement OAuth2 authentication API with refresh tokens.\\nCONTEXT: The application uses Express + PostgreSQL. Routes must be under /api/auth/.\\nFORMAT: Create src/auth/router.ts, src/auth/service.ts, src/auth/types.ts and tests/auth.test.ts.\\nCRITERIA: POST /login, POST /refresh and POST /logout endpoints must work. Unit tests with coverage > 80%.",
  "p2": "OBJECTIVE: Create the onboarding module's visual style guide.\\nCONTEXT: B2B web application, professional target, modern and clean style.\\nFORMAT: Create design/tokens.css (variables), design/onboarding.css (components), and a design/specs.md document describing choices.\\nCRITERIA: WCAG AA accessibility, mobile/desktop responsive, max 5 color palette."
}`;
}

// ── 2. Node execution ────────────────────────────────────────────────────────

export interface NodePromptOptions {
  readonly codeFenceFormat?: boolean;
  readonly compact?: boolean;
}

export function buildNodeSystemPrompt(
  node: Project,
  opts: NodePromptOptions = {},
): string {
  const { codeFenceFormat = true, compact = false } = opts;
  const identity = node.instructions || `Agent of type "${node.type ?? "general"}"`;
  const rules = getQualityRules(node.type, compact);

  const fileSection = codeFenceFormat
    ? `FILE FORMAT (REQUIRED) :
For every file you create, use EXACTLY this format:
\`\`\`<lang> filepath: <relative/path/to/file>
<full file content>
\`\`\`
Example:
\`\`\`html filepath: articles/01-intro.html
<!DOCTYPE html>
<html>...</html>
\`\`\`
NEVER put explanatory text between file blocks. Chain blocks directly one after another.`
    : `FILE TOOLS :
You have real file tools (write, edit). You do NOT have shell access (bash).
Explore with read/glob/grep, produce with write/edit.
Use ONLY RELATIVE paths from the workspace root (e.g. src/api/foo.py). NEVER absolute paths (/home/…, /Users/…).
Normal method = write/edit tools. LAST RESORT only (if a tool fails): \`\`\`lang filepath: path block.

EXECUTE IMMEDIATELY (CRITICAL) :
- DO NOT PLAN. DO NOT LIST steps. DO NOT DESCRIBE what you will do.
- Start IMMEDIATELY writing files with the tools (write/edit).
- Each file must be COMPLETE and FULL — no skeletons, no "to be completed".
- If you read existing files, do it quickly then PRODUCE without stopping.
- Your goal: by the end of this message, ALL requested files are written in the workspace.`;

  const behavior = compact
    ? `BEHAVIOR :
- Shared workspace: your deliverable serves directly as input to the following agents.
- Produce COMPLETE and professional content — no skeleton, no "to be completed".
- If your task mentions N items, produce ALL of them in full.
- Focus solely on YOUR assigned task.`
    : `EXPECTED BEHAVIOR :
- You work in a shared workspace with other agents — your deliverable will be used by subsequent agents
- Produce PROFESSIONAL QUALITY, exhaustive, production-ready content
- FORBIDDEN: superficial content, 2-line paragraphs, skeleton files, "to be completed later"
- REQUIRED: each file must be COMPLETE and FULL from start to finish
- If your task mentions N items (N pages, N components, N sections), produce ALL of them in full
- The quality of your work determines the quality of the final project — no shortcuts
- Focus solely on YOUR assigned task`;

  return `${identity}

${rules}

${behavior}

${fileSection}`;
}

export function buildNodeUserPrompt(
  node: Project,
  workspaceContext: string,
  dependencyContext: string,
  expectedFiles: readonly string[] = [],
  opts?: { codeFenceFormat?: boolean },
): string {
  const task = node.task || "No task defined.";

  const sections = [`TASK :\n${task}`];

  if (expectedFiles.length > 0) {
    sections.push(
      `FILE CONTRACT — REQUIRED :\nYou MUST produce EXACTLY the following files with these exact paths:\n${expectedFiles.map((f) => `- ${f}`).join("\n")}\nA missing file or wrong path = task failed.`,
    );
  }

  if (workspaceContext) {
    sections.push(workspaceContext);
  }

  if (dependencyContext) {
    sections.push(dependencyContext);
  }

  const useCodeFence = opts?.codeFenceFormat !== false;
  const reminder = useCodeFence
    ? "CRITICAL REMINDER : Produce an EXHAUSTIVE and PROFESSIONAL deliverable. No placeholders, no summaries, no superficial content. Each file must be COMPLETE from start to finish — no shortcuts. If your task mentions N files or N pages, produce ALL of them in full. Use the ```<lang> filepath: path/file format for each file — the system will automatically extract and write the files to disk."
    : "CRITICAL REMINDER : Produce an EXHAUSTIVE and PROFESSIONAL deliverable. No placeholders, no summaries, no superficial content. Each file must be COMPLETE from start to finish — no shortcuts. If your task mentions N files or N pages, produce ALL of them in full. Create files DIRECTLY with write/edit tools at the EXACT RELATIVE paths from the FILE CONTRACT (never absolute paths). Normal method = write/edit tools; as a last resort (if a tool fails), use the ```lang filepath: path format — it will still be recovered. You do not have shell access (bash).";
  sections.push(reminder);

  return sections.join("\n\n");
}

// ── 3. Continuation ──────────────────────────────────────────────────────────

export function buildContinuationPrompt(
  node: Project,
  previousText: string,
  attempt: number,
  maxRetries: number,
): string {
  const tail = previousText.slice(-500);
  return `Your previous generation was interrupted (attempt ${attempt}/${maxRetries}).

ORIGINAL TASK :
${node.task || "undefined"}

END OF YOUR LAST RESPONSE :
"""
...${tail}
"""

INSTRUCTION : Resume EXACTLY where you left off. Do not repeat what you already wrote. Continue directly from the interruption point above.`;
}

// ── 3b. Multi-turn iteration ────────────────────────────────────────────────

export function buildCompletenessCheckPrompt(
  node: Project,
  accumulatedText: string,
): string {
  const tail = accumulatedText.slice(-3000);
  return `ASSIGNED TASK :
${node.task || "undefined"}

WORK PRODUCED SO FAR (end) :
"""
...${tail}
"""

QUESTION : Is the task FULLY completed ? Check:
- Have all requested files been created ?
- Is the content complete (no empty sections, no placeholders) ?
- Is the quality production-ready ?

Respond STRICTLY with JSON:
{"complete": true} or {"complete": false, "missing": "precise description of what is missing"}`;
}

export function buildIterationPrompt(
  node: Project,
  accumulatedText: string,
  missing: string,
  iteration: number,
  maxIterations: number,
): string {
  const tail = accumulatedText.slice(-8000);
  return `ITERATION ${iteration}/${maxIterations} — CONTINUATION OF YOUR TASK

ORIGINAL TASK :
${node.task || "undefined"}

WHAT HAS BEEN PRODUCED SO FAR (end) :
"""
...${tail}
"""

WHAT IS STILL MISSING :
${missing}

INSTRUCTION : Produce ONLY what is missing. Do NOT repeat what has already been produced. Use the \`\`\`<lang> filepath: path/file format for each new file. If you need to complete an existing file, reproduce it IN FULL with the additions.`;
}

// ── 4. Pre-execution verification ────────────────────────────────────────────

export function buildVerifyPromptsSystemPrompt(verifier: Project): string {
  return `${verifier.instructions || "You are an instruction quality verifier."}

ROLE: Analyze a set of instructions generated for AI agents and verify their quality BEFORE execution.

You evaluate according to a STRICT CHECKLIST. Each criterion is scored OK or PROBLEM.`;
}

export function buildVerifyPromptsUserPrompt(
  globalTask: string,
  promptsMap: Record<string, string>,
  linkedProjects: readonly Project[],
): string {
  const projectContext = linkedProjects
    .map((p) => `- "${p.id}" = "${p.name}" (${p.type ?? "undefined"})`)
    .join("\n");

  return `GLOBAL TASK : "${globalTask}"

AGENTS :
${projectContext}

GENERATED INSTRUCTIONS :
${JSON.stringify(promptsMap, null, 2)}

VERIFICATION CHECKLIST :
1. COVERAGE — Is every aspect of the global task covered by at least one agent ?
2. COHERENCE — Do instructions not contradict each other across agents ?
3. CLARITY — Is each instruction understandable without extra context ?
4. COMPLETENESS — Does each instruction specify the objective, format, and success criteria ?
5. DEPENDENCIES — Do dependent agents have the necessary information ?
6. FEASIBILITY — Is each task achievable by a single agent ?

Respond STRICTLY with a valid JSON:
{
  "valid": true or false,
  "checks": {
    "coverage": {"ok": true/false, "detail": "..."},
    "coherence": {"ok": true/false, "detail": "..."},
    "clarity": {"ok": true/false, "detail": "..."},
    "completeness": {"ok": true/false, "detail": "..."},
    "dependencies": {"ok": true/false, "detail": "..."},
    "feasibility": {"ok": true/false, "detail": "..."}
  },
  "reason": "Global summary if invalid"
}`;
}

// ── 5. Post-execution verification ───────────────────────────────────────────

export function buildVerifyOutputSystemPrompt(verifier: Project): string {
  return `${verifier.instructions || "You are a code and deliverable reviewer."}

ROLE: Verify that a deliverable produced by an AI agent meets the expectations of its assigned task.

You evaluate according to objective criteria. You do NOT validate by default — you actively look for problems.`;
}

export function buildVerifyOutputUserPrompt(
  node: Project,
  resultText: string,
  diskEvidence = "",
): string {
  const typeChecks: Record<string, string> = {
    code: `SPECIFIC CRITERIA (code) :
- Is the code syntactically correct ?
- Are imports present and consistent ?
- Is error handling present ?
- Are there unresolved placeholders or TODOs ?
- Are files named with their path ?`,
    design: `SPECIFIC CRITERIA (design) :
- Are the CSS styles complete and valid ?
- Are design variables defined ?
- Is accessibility taken into account ?
- Is responsive addressed ?`,
    work: `SPECIFIC CRITERIA (integration) :
- Is the HTML semantic and valid ?
- Does the integration match the specifications ?
- Are assets referenced correctly ?`,
    verifier: `SPECIFIC CRITERIA (verification) :
- Is the analysis structured and objective ?
- Are the identified problems real and documented ?
- Are corrections proposed ?`,
    recherche: `SPECIFIC CRITERIA (research) :
- Are results structured ?
- Are sources cited ?
- Are recommendations actionable ?`,
  };

  const specificChecks = typeChecks[node.type ?? "code"] ?? typeChecks.code;

  const MAX_EXCERPT = 6000;
  let excerpt: string;
  if (resultText.length <= MAX_EXCERPT) {
    excerpt = resultText;
  } else {
    const headLen = Math.floor(MAX_EXCERPT * 0.6);
    const tailLen = MAX_EXCERPT - headLen;
    excerpt =
      resultText.substring(0, headLen) +
      `\n\n[… ${resultText.length - headLen - tailLen} characters omitted …]\n\n` +
      resultText.substring(resultText.length - tailLen);
  }

  const diskSection = diskEvidence.trim()
    ? `FILES ACTUALLY ON DISK (GROUND TRUTH) :
Here are the expected files, read directly from the workspace. This is the real state of the deliverable — judge FROM THIS, not from the agent's message below.
✓ = present, ✗ = absent.
---
${diskEvidence}
---
RULE: A file marked ✓ EXISTS — never declare it "missing". A file whose content is readable here is NOT "truncated" even if the agent's message seemed cut off. Base your judgment ONLY on the files above for presence and completeness.

`
    : "";

  return `AGENT : "${node.name}" (type: ${node.type ?? "undefined"})
ASSIGNED TASK : "${node.task ?? "undefined"}"
TOTAL AGENT MESSAGE LENGTH : ${resultText.length} characters

${diskSection}AGENT MESSAGE (context — may be a summary or excerpt, NOT authoritative) :
---
${excerpt}
---

IMPORTANT : ${diskEvidence.trim() ? "The files on disk above are authoritative. The agent's message is only context." : `If the message exceeds ${MAX_EXCERPT} characters, you see an excerpt (beginning + end). DO NOT report "truncated" or "incomplete" simply because the middle is omitted — evaluate the overall structure (opening, closing, coherence).`}

GENERAL CRITERIA :
- Does the deliverable meet the assigned task ?
- Is the deliverable complete (no visible missing sections in the excerpt) ?
- Is the deliverable usable as-is ?
- Are there obvious errors ?

${specificChecks}

Respond STRICTLY with a valid JSON:
{
  "valid": true or false,
  "score": 0-100,
  "issues": [{"severity": "critical|warning|info", "description": "..."}],
  "reason": "Summary if invalid"
}`;
}

// ── 6. Brand compliance ──────────────────────────────────────────────────────

export function buildBrandComplianceSystemPrompt(verifier: Project): string {
  return `${verifier.instructions || "You are the brand guidelines guardian."}

ROLE: Verify that the produced deliverables respect the project's style guide and brand guidelines.

You compare deliverables against brand specifications and report any deviations.`;
}

export function buildBrandComplianceUserPrompt(brandGuidelines: string): string {
  return `STYLE AND BRAND GUIDE :
---
${brandGuidelines}
---

EVALUATION GRID :
1. COLORS — Do the used colors match the defined palette ?
2. TYPOGRAPHY — Are fonts and sizes compliant ?
3. SPACING — Do margins and padding follow the grid ?
4. TONE — Is the editorial tone consistent with the brand ?
5. COMPONENTS — Do UI components respect the defined patterns ?

Respond STRICTLY with a valid JSON:
{
  "valid": true or false,
  "checks": {
    "colors": {"ok": true/false, "detail": "..."},
    "typography": {"ok": true/false, "detail": "..."},
    "spacing": {"ok": true/false, "detail": "..."},
    "tone": {"ok": true/false, "detail": "..."},
    "components": {"ok": true/false, "detail": "..."}
  },
  "reason": "Explanation of brand deviations"
}`;
}

// ── 7. Indexeur workspace ────────────────────────────────────────────────────

export function buildWorkspaceIndexSystemPrompt(): string {
  return "You are a project documentation analyst. You extract information about created or modified files from an agent's result and format it for a workspace registry.";
}

export function buildWorkspaceIndexUserPrompt(node: Project, resultText: string): string {
  return `AGENT : "${node.name}" (type: ${(node.type ?? "code").toUpperCase()})

AGENT RESULT :
---
${resultText.substring(0, 3000)}
---

INSTRUCTION :
Analyze the result above and extract:
1. NEW FILES created (path + one-line function)
2. A CHANGELOG LINE summarizing what the agent did

Respond STRICTLY with a valid JSON:
{
  "newFiles": "| path/to/file | Short function |\\n| other/path | Function |",
  "changelogLine": "| ${new Date().toLocaleDateString("en-US")} | ${node.name} | modified files | Description of changes |"
}

If no files were created, set "newFiles" to "".`;
}

// ── 8. Decomposition into sub-steps ──────────────────────────────────────────

export interface SubStep {
  readonly index: number;
  readonly title: string;
  readonly focus: string;
  readonly deliverable: string;
}

export interface SubStepResult {
  readonly index: number;
  readonly title: string;
  readonly output: string;
}

export function buildDecomposeSystemPrompt(node: Project, compact = false): string {
  const identity = node.instructions || `Agent of type "${node.type ?? "general"}"`;
  const rules = getQualityRules(node.type, compact);

  return `${identity}

${rules}

CURRENT ROLE: You must analyze a complex task and break it into sequential steps before executing it.

Each step must be:
- FOCUSED on a single aspect or deliverable
- SEQUENTIAL — steps execute in order, each step can build on previous ones
- CONCRETE — describes what must be produced, not a vague intention`;
}

export function buildDecomposeUserPrompt(
  node: Project,
  workspaceContext: string,
  depContext: string,
  compact = false,
): string {
  const sections = [`TASK TO DECOMPOSE :\n"${node.task ?? "undefined"}"`];

  if (workspaceContext) sections.push(workspaceContext);
  if (depContext) sections.push(depContext);

  const granularity = compact
    ? `Break this task into FINE steps: 1 step = 1 single deliverable (e.g. 1 page, 1 file, 1 component). Each step will be executed independently by the same agent, with previous steps' results in context.`
    : `Break this task into 2 to 8 sequential steps. Each step will be executed independently by the same agent, with previous steps' results in context.`;

  sections.push(`INSTRUCTION :
${granularity}

Respond STRICTLY with a valid JSON (array), with no other text or markdown tags:
[
  {
    "title": "Short step title",
    "focus": "Precise description of what this step must accomplish",
    "deliverable": "The concrete expected deliverable (files, code, document...)"
  }
]

RULES :
- Minimum 2 steps, maximum 8
- Each step = ONE verifiable deliverable
- Steps must cover 100% of the original task
- Order steps logically (foundations first, finishing touches last)
- The last step should finalize/integrate the work`);

  return sections.join("\n\n");
}

export function buildSubStepUserPrompt(
  _node: Project,
  step: SubStep,
  totalSteps: number,
  previousResults: readonly SubStepResult[],
  workspaceContext: string,
  depContext: string,
): string {
  const sections = [
    `STEP ${step.index + 1}/${totalSteps} : ${step.title}`,
    `FOCUS :\n${step.focus}`,
    `EXPECTED DELIVERABLE :\n${step.deliverable}`,
  ];

  if (previousResults.length > 0) {
    const prevBlocks = previousResults.map(
      (r) => `--- Step ${r.index + 1} : ${r.title} ---\n${r.output.substring(0, 6000)}`,
    );
    sections.push(`[PREVIOUS STEPS RESULTS]\n${prevBlocks.join("\n\n")}`);
  }

  if (workspaceContext) sections.push(workspaceContext);
  if (depContext) sections.push(depContext);

  sections.push(
    "REMINDER : Produce the deliverable for THIS STEP only. Complete code/content, no placeholders.",
  );

  return sections.join("\n\n");
}

export function buildSynthesisSystemPrompt(node: Project): string {
  const identity = node.instructions || `Agent of type "${node.type ?? "general"}"`;

  return `${identity}

CURRENT ROLE: You must merge the results of multiple sub-steps into a coherent and complete final deliverable.

RULES :
- Merge results without redundancy or contradiction
- The final deliverable must be usable as-is
- If files were produced, consolidate them with their full path
- Fix inconsistencies between steps if needed
- Do not lose any important content from sub-steps`;
}

export function buildSynthesisUserPrompt(
  node: Project,
  subStepResults: readonly SubStepResult[],
): string {
  const MAX_RESULT_PER_STEP = 6000;
  const resultBlocks = subStepResults.map(
    (r) =>
      `--- Step ${r.index + 1} : ${r.title} ---\n${r.output.substring(0, MAX_RESULT_PER_STEP)}`,
  );

  return `ORIGINAL TASK :
"${node.task ?? "undefined"}"

RESULTS OF ${subStepResults.length} SUB-STEPS :

${resultBlocks.join("\n\n")}

INSTRUCTION :
Produce the FINAL deliverable by merging all results above. The result must be complete, coherent, and ready to use without referencing the sub-steps.`;
}

// ── 9. Iterative planning (agentic loop) ────────────────────────────────────

export function buildIterativePlanningSystemPrompt(orchestrator: Project): string {
  const base = orchestrator.instructions || "";
  return `You are the coordinator of an AI agent team. You plan tasks iteratively using the provided tools.

${base ? `CUSTOM INSTRUCTIONS :\n${base}\n` : ""}ROLE OF EACH AGENT TYPE (CRITICAL — respect this distribution) :
- "recherche" → Investigation, data collection, state of the art, monitoring. Produces synthesis documents, plans, recommendations.
- "work" → OpenWork: production of CONTENT and assets — writing (articles, documents, ebook, marketing), structured data (.md/.json/.csv), and for a site: design system (colors, typo, spacing), brand guidelines, HTML/CSS integration. For a visual deliverable, this agent defines the colors, not the designer.
- "design" → Open Design: creation of web visual MOCKUPS (HTML/CSS) ONLY, relevant ONLY if the deliverable has a UI. It does NOT choose colors or the design system — it RECEIVES them from "work"/"recherche" agents. Only assign a "design" agent for a web site/app.
- "code" → OpenCode: development and coding. Produces the functional deliverable: application, library, API, CLI, scripts, or data structuring. If mockups exist, it reproduces them faithfully; otherwise it codes from the specification, data, or provided content.
- "verifier" → Testing and quality assurance. Verifies deliverables from other agents.

AGENT ECONOMY (STRONG RULE) : ONLY create the agents and deliverables actually needed for the requested deliverable. NO parasitic scaffolding (tests, scripts, SEO, mockups, ancillary data) if the request does not explicitly imply it. Fewer parasitic agents = better coherence and less workspace pollution. When in doubt about an agent/deliverable's usefulness, DO NOT create it.

ESTABLISH DEPENDENCIES BASED ON ACTUAL DELIVERABLES (not a fixed pipeline) :
- Create agents and dependencies that the DELIVERABLE actually needs. Do NOT insert a "design"/mockup agent or a dependency to it if the deliverable has no visual interface (e.g. code library, API, report, ebook, data, resume).
- DO NOT give content writing to a "code" agent → that's the "work" role
- DO NOT give final coding to a "work" agent → that's the "code" role
- If a "design" agent produces mockups, then the "code" agent implementing them must depend on it; otherwise, make "code" depend on what actually feeds it (specification, data, schema, content).
- An agent depends on those who produce what it needs as input — deduce this from the deliverable, do not impose it by default.

IF THE TASK IS A WEB SITE/APP — IMPORTANCE OF THE DESIGN AGENT (example web pipeline) :
The "design" agent produces HTML/CSS mockups that serve as VISUAL REFERENCE for the "code" agent. For a site, this is a CRITICAL role.
- Give VERY DETAILED instructions: pages to create, components to include, expected style, content to integrate
- EXPLICITLY require completeness: all states (hover, focus, error, empty, loading), responsive (mobile/tablet/desktop), navigation components
- The design agent iterates automatically to improve its mockups — give it a rich specification to work with
- Do NOT hold back on volume — a complete mockup is 500+ lines of HTML/CSS per page, that's normal

DESIGN AGENT = IF AND ONLY IF WEB INTERFACE: only assign a "design" agent if the final deliverable is a web site/app or UI. For a document, report, guide, ebook or data (text/structured deliverable without an interface), assign NO design agent: the output is in .md (or, if visual formatting is explicitly requested, a single simple HTML via a "work" agent), NEVER through a mockup or a visual style guide.

PROCESS :
1. Analyze the global task and identify necessary deliverables
2. Think about the optimal distribution respecting the roles above
3. For each agent, use assign_task to assign a structured task
4. If a task is complex, provide sub-steps via the "steps" parameter
5. When ALL agents have a task, call finish_planning

TASK QUALITY :
Each assigned task MUST be EXHAUSTIVE and DETAILED. You do NOT give a vague instruction — you give a complete specification.
Each task MUST contain these 4 sections:
- OBJECTIVE — What the agent must concretely produce, with the expected VOLUME (number of files, number of pages, minimum length)
- CONTEXT — What it needs to know (constraints, dependencies, standards, target audience, tone, style)
- FORMAT — The EXHAUSTIVE LIST of expected files/deliverables with their structure and minimum content
- CRITERIA — MEASURABLE quality criteria (minimum word count, coverage, accessibility, SEO, etc.)

DELIVERABLE CONTRACT (expected_files) — CRITICAL :
For each work/code/design agent, use the "expected_files" parameter of assign_task to list the files the agent MUST produce.
It's a CONTRACT: a missing file = failed task + automatic retry. Be exhaustive.
Example: expected_files: ["src/index.html", "src/styles/main.css", "src/components/header.html"]
This is GENERIC — works for any deliverable type (.py, .md, .json, .css, .html, etc.).
UNIQUE CANONICAL LOCATION — each logical deliverable has ONE SINGLE canonical path. NEVER write the same content in multiple folders (e.g. at the root + research/ + reports/ + legal/): it destroys the source of truth. If multiple agents need the same file, ONE SINGLE agent produces it (declared in its expected_files) and the others DEPEND on it (depends_on) instead of copying it.

VERIFICATION CONTRACT (checks) — MACHINE-VERIFIABLE, DO NOT TRUST THE LLM :
For each QUANTIFIED CRITERION in the request, emit it in the "checks" parameter of assign_task (indexed by file path). The SYSTEM verifies it automatically after execution and RETRIES the agent if not met — this is the deterministic guarantee that even a small model produces the right volume.
Available constraints: minWords, minItems (length of a JSON array), minSections (## / ### headings), requiredSubstrings (required strings), format (json|csv|md).
Example :
  checks: {
    "content/guide.md": { "minSections": 8, "minWords": 4000 },
    "data/products.json": { "format": "json", "minItems": 12 },
    "data/clients.csv": { "format": "csv" }
  }
DERIVE thresholds from the request CRITERIA ("12 products" → minItems:12 ; "8 chapters" → minSections:8 ; "≥500 words/article" → minWords:500). Do NOT invent thresholds; if a file has no quantified criteria, do not emit checks for it.

MEASURABLE CRITERIA — REQUIRED :
Each assigned task must have MEASURABLE success criteria:
- BAD: "complete result", "detailed code"
- GOOD: "10 HTML pages", "≥ 500 words per article", "test coverage > 80%", "3 CSS files"
Vague terms ALONE ("complete", "detailed", "professional") are INSUFFICIENT — ALWAYS add a concrete threshold.

WEB SCAFFOLDING — ONLY FOR A REAL SITE: NEVER assign SEO, sitemap.xml, robots.txt, seo/ folder, manifest.json or site package.json if the deliverable is a document, report, guide, data or any other deliverable WITHOUT a served web interface. These artifacts are ONLY valuable for a real web site/app.

REQUIRED COVERAGE BY DELIVERABLE DOMAIN (apply the relevant block) :
- IF WEB SITE/APP → SEO (sitemap.xml, robots.txt, JSON-LD, title/meta/OG per page); SECURITY (fix vulnerabilities in delivered code if user data); DEDICATED BACKEND if persistence/API/auth; WCAG AA ACCESSIBILITY (contrast, alt, aria, focus).
- IF LIBRARY / CLI / API (no frontend) → in expected_files: COMPLETE source code, real UNIT TESTS, a README with usage examples, and (CLI) an executable entry point / (API) an endpoint spec. No SEO/mockup.
- IF LONG DOCUMENT (ebook, business plan, course plan, wiki, CV) → table of contents/structure, N explicit sections/chapters, minimum length per section, sources if relevant (+ for a course: exercises AND solutions).
- IF DATA / ANALYSIS → distinguish two cases. (a) DOCUMENT containing figures/tables (market study, report, synthesis): .md/.csv/.json SUFFICE — do NOT assign a code agent, nor scripts, nor tests. (b) EXPLICITLY REQUESTED REPRODUCIBLE TECHNICAL ANALYSIS (processing pipeline, model, reusable programmatic computation): only then a code agent with script + data + interpretation. By default, consider it case (a) unless the user explicitly requests programmatic processing.
- IF PRESENTATION / SLIDES → N explicit slides with titles + real content (no empty slides) and, if useful, presenter notes.
- IF MARKETING CONTENT (emails, posts, pages) → cross-channel consistency (same offer/tone/CTA everywhere), explicit piece count per channel.

REQUIRED DEPTH :
- The goal of a multi-agent system is to produce a result SUPERIOR to what a single agent would do
- Each agent must produce an EXHAUSTIVE deliverable in its domain — not an overview
- Example: a "brand guidelines" agent does not produce 1 CSS file — it produces a complete brand guide (philosophy, detailed palette, typefaces with fallbacks, spacing scale, components, states, animations, documentation)
- Example: a "writing" agent does not produce 2 paragraphs per article — it produces 500+ words per article with introduction, structured development, conclusion
- If you think an agent could produce 10 files, ask it for 10 files explicitly

SUB-AGENTS (create_sub_agent) :
You can create SUB-AGENTS to divide a parent agent's work.
- Use create_sub_agent when an agent has a task too broad to be done in a single flow
- Each sub-agent has its own type, its own task, and executes BEFORE its parent
- The parent will receive its sub-agents' results as dependency context
- Example: the "Work" agent has 3 distinct tasks (brand guidelines, content writing, HTML integration) → create 3 sub-agents of type "work" under it
- Example: the "Code" agent must code the frontend AND the backend → create 2 sub-agents of type "code"
- Sub-agents can have their own dependencies (depends_on)
- IMPORTANT: each sub-agent is a real agent with multi-turn — it makes MULTIPLE LLM calls to complete its task
- Prefer sub-agents over sub-steps (steps) for large tasks — sub-agents are independent and can leverage multi-turn

LONG DOCUMENT — ONE SUB-AGENT PER CHAPTER/SECTION (STRONG RULE) :
- For a long documentary deliverable (guide, ebook, N-chapter/section report, course), do NOT create a single agent that writes everything (it produces 3-4 sentences per chapter then stops). Create ONE sub-agent PER chapter/section, each with its own file in expected_files AND its own checks.minWords (e.g. 500-900 words/chapter depending on the request). Each sub-agent thus has its full budget to develop its chapter in depth.
- FINAL CONSOLIDATION AGENT: if there is a "final assembly/layout" step, its role is to INCLUDE the FULL content of each source chapter (copy-paste the complete text), NEVER to summarize or skeletonize it. Its final file must have a checks.minWords ≥ sum of chapters. Give this instruction explicitly in its task.
- "SHARED PLAN" PATTERN (recommended for long documents): create a first "plan/skeleton" sub-agent that produces the document structure (table of contents, scope of each chapter, common thread, terminology). ALL chapter sub-agents DEPEND on this plan (depends_on) instead of chaining to each other (ch1→ch2→ch3). Each chapter thus receives the complete plan and knows what others cover — it does not repeat their content and can reference them ("as seen in chapter 3"). Result: chapters execute IN PARALLEL (same wave) while remaining coherent, and the deliverable is produced much faster.

WHEN TO ADD SUB-STEPS (steps) vs SUB-AGENTS :
- Sub-agents: when tasks are INDEPENDENT and can be parallelized (e.g. writing 3 different articles)
- Sub-steps: when tasks are SEQUENTIAL and each depends on the previous (e.g. analysis → design → production)
- Maximum 8 sub-steps per agent, no strict limit on sub-agents

DEPENDENCIES (depends_on) :
- Use the depends_on parameter to indicate which agents must finish BEFORE another
- Example: an "Integration" agent that depends on "Design" and "Writing" → depends_on: [id_design, id_writing]
- Agents without depends_on execute first
- ALWAYS specify depends_on when an agent needs another's result

IDENTITY COHERENCE — CRITICAL :
The project has ONE single identity (brand/artist/product name, positioning, tone, language). You must FIX it once and PROPAGATE it to ALL tasks.
- If the global task specifies a name/brand, reuse it as-is everywhere.
- Otherwise, CHOOSE a unique name and write it EXPLICITLY in EACH task (work, design, code): "The artist/brand is called « X »".
- Also fix the deliverable LANGUAGE (that of the global task) and impose it on all agents (no mixing languages).
- Downstream agents do NOT have the right to invent another identity: this is the #1 cause of inconsistency (two different names between mockup and content).
- The agent that defines the visual identity (work) defines it first; design and code receive it and respect it IDENTICALLY.

RULES :
- Start with agents without dependencies, then those that have them
- Ensure consistency between tasks (same identity, same language, no contradictions, no duplicates)
- Adapt the level of detail to the agent type
- You can assign agents in any order, one by one or in groups`;
}

export function buildIterativePlanningUserPrompt(
  globalTask: string,
  linkedProjects: readonly Project[],
  workspaceContext: string,
): string {
  const agentList = linkedProjects
    .map((p) => {
      const deps = p.dependencies ?? [];
      const depInfo =
        deps.length > 0
          ? ` | Depends on: ${deps.map((d) => linkedProjects.find((lp) => lp.id === d)?.name ?? d).join(", ")}`
          : "";
      const roleHint = TYPE_ROLE_HINTS[p.type ?? ""] ?? "General";
      return `- ID: "${p.id}" | Name: "${p.name}" | Type: ${p.type ?? "undefined"} (${roleHint})${depInfo}\n  Skills: ${p.instructions || "not specified"}`;
    })
    .join("\n");

  return `GLOBAL TASK TO DISTRIBUTE :
"${globalTask}"

${workspaceContext}

AVAILABLE AGENTS (${linkedProjects.length}) :
${agentList}

REMINDER : Adapt the pipeline to the deliverable type.
- WEB/APP deliverable (interface, site, SPA) → work (design system + content) → design (mockups) → code (faithful implementation from mockups).
- NON-WEB deliverable (library, API, CLI, report, ebook, data, slides, marketing) → Do NOT impose a design agent or visual pipeline. Assign the relevant roles directly (research, work, code) based on what the deliverable actually needs.

Analyze the task, then assign a structured task to each agent with assign_task. When all have a task, call finish_planning.`;
}
