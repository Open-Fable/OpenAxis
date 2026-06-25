// Pure parsers that turn an agent's raw text output into file writes / edits.
// No instance state, no I/O — kept separate from the execution engine so the
// (security-sensitive, fuzz-prone) parsing logic is isolated and unit-testable.

// ── Extract files from LLM output ────────────────────────────────────────────
/**
 * Parse ```lang filepath: path … ``` blocks from an agent response.
 *
 * Robust to nested fences of the same length: a file whose CONTENT contains its
 * own ``` (a README with code examples, a JSDoc `@example`) must not be
 * truncated. The naive regex `([\s\S]*?)````` closes on the FIRST internal fence
 * and cuts the file in half. Here, a block's content goes to the LAST closing
 * fence (length ≥ the opening one) before the next `filepath:` marker or end of
 * text — so internal fences are preserved as content.
 *
 * Line-by-line parsing (no mega-regex) → linear, no catastrophic backtracking
 * on adversarial LLM output in the main process.
 */
export function parseFilepathBlocks(
  text: string,
): ReadonlyArray<{ path: string; content: string }> {
  const lines = text.split("\n");
  // `(?![Ee][Dd][Ii][Tt]…)` reserves ```edit filepath: for surgical SEARCH/REPLACE
  // blocks (parseEditBlocks) — otherwise this would parse them as a full-file write
  // and dump the raw SEARCH/REPLACE markers into the file. Case-INSENSITIVE on
  // "edit": a ```Edit / ```EDIT fence must be excluded here too, exactly matching
  // parseEditBlocks' case-insensitive opener, or the markers corrupt the file.
  const openerRe =
    /^(`{3,})(?![Ee][Dd][Ii][Tt][ \t]+filepath:)[\w-]*[ \t]+filepath:[ \t]*(.+?)[ \t]*$/;
  const openers: Array<{ line: number; filePath: string; fence: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = openerRe.exec(lines[i]);
    if (m) openers.push({ line: i, filePath: m[2].trim(), fence: m[1].length });
  }

  const blocks: Array<{ path: string; content: string }> = [];
  for (let k = 0; k < openers.length; k++) {
    const { line: openLine, filePath, fence } = openers[k];
    const start = openLine + 1;
    const boundary = k + 1 < openers.length ? openers[k + 1].line : lines.length;
    const closeRe = new RegExp("^`{" + fence + ",}[ \\t]*$");
    let end = boundary;
    for (let j = boundary - 1; j >= start; j--) {
      if (closeRe.test(lines[j])) {
        end = j;
        break;
      }
    }
    blocks.push({ path: filePath, content: lines.slice(start, end).join("\n") });
  }
  return blocks;
}

// ── Surgical editing (SEARCH/REPLACE) ────────────────────────────────────────
export interface SearchReplaceEdit {
  readonly search: string;
  readonly replace: string;
}

const EDIT_SEARCH_MARK = "<<<<<<< SEARCH";
const EDIT_DIVIDER_MARK = "=======";
const EDIT_REPLACE_MARK = ">>>>>>> REPLACE";

function parseSearchReplacePairs(lines: readonly string[]): SearchReplaceEdit[] {
  const edits: SearchReplaceEdit[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() !== EDIT_SEARCH_MARK) {
      i++;
      continue;
    }
    i++;
    const search: string[] = [];
    while (i < lines.length && lines[i].trim() !== EDIT_DIVIDER_MARK)
      search.push(lines[i++]);
    if (i >= lines.length) break; // malformed: no divider
    i++;
    const replace: string[] = [];
    while (i < lines.length && lines[i].trim() !== EDIT_REPLACE_MARK)
      replace.push(lines[i++]);
    if (i >= lines.length) break; // malformed: no closing marker
    i++;
    edits.push({ search: search.join("\n"), replace: replace.join("\n") });
  }
  return edits;
}

/**
 * Parse ```edit filepath: path … ``` blocks whose content is a series of
 * SEARCH/REPLACE pairs. Allows an agent to MODIFY a few lines of an existing
 * file without re-emitting it in full:
 *
 *   ```edit filepath: index.html
 *   <<<<<<< SEARCH
 *   <h1>Old</h1>
 *   =======
 *   <h1>New</h1>
 *   >>>>>>> REPLACE
 *   ```
 *
 * Line-by-line parsing (no mega-regex) → linear, no catastrophic backtracking
 * on adversarial LLM output.
 */
export function parseEditBlocks(
  text: string,
): ReadonlyArray<{ path: string; edits: readonly SearchReplaceEdit[] }> {
  const lines = text.split("\n");
  // Case-insensitive on "edit"/"filepath" so ```Edit / ```EDIT are still routed
  // here (and excluded from parseFilepathBlocks) instead of corrupting the file.
  const openerRe = /^(`{3,})edit[ \t]+filepath:[ \t]*(.+?)[ \t]*$/i;
  const openers: Array<{ line: number; filePath: string; fence: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = openerRe.exec(lines[i]);
    if (m) openers.push({ line: i, filePath: m[2].trim(), fence: m[1].length });
  }

  const blocks: Array<{ path: string; edits: readonly SearchReplaceEdit[] }> = [];
  for (let k = 0; k < openers.length; k++) {
    const { line: openLine, filePath, fence } = openers[k];
    const start = openLine + 1;
    const boundary = k + 1 < openers.length ? openers[k + 1].line : lines.length;
    const closeRe = new RegExp("^`{" + fence + ",}[ \\t]*$");
    let end = boundary;
    for (let j = boundary - 1; j >= start; j--) {
      if (closeRe.test(lines[j])) {
        end = j;
        break;
      }
    }
    const edits = parseSearchReplacePairs(lines.slice(start, end));
    if (edits.length > 0) blocks.push({ path: filePath, edits });
  }
  return blocks;
}

/**
 * Applies a series of SEARCH/REPLACE pairs to content. ALL-OR-NOTHING: each
 * SEARCH must match EXACTLY once; otherwise the entire edit fails and the
 * original content is returned unchanged (the caller falls back to full file
 * re-emission). The unique match avoids editing the wrong occurrence; `replace`
 * is treated as literal (no pattern $).
 */
export function applyEdits(
  original: string,
  edits: readonly SearchReplaceEdit[],
): { ok: boolean; content: string; failedSearch?: string } {
  let content = original;
  for (const { search, replace } of edits) {
    if (search.length === 0)
      return { ok: false, content: original, failedSearch: search };
    const first = content.indexOf(search);
    const last = content.lastIndexOf(search);
    if (first === -1 || first !== last) {
      return { ok: false, content: original, failedSearch: search };
    }
    content = content.slice(0, first) + replace + content.slice(first + search.length);
  }
  return { ok: true, content };
}

// ── Deterministic truncation detector ────────────────────────────────────────
/**
 * Returns a short reason when a file's content looks cut off, else null.
 *
 * The output verifier used to GUESS truncation from a chat preview, and the
 * audit's own display cap was mistaken for disk truncation — wrongly failing
 * complete files and triggering destructive corrective cycles. This is the
 * factual signal that replaces the guess. Deliberately CONSERVATIVE (only
 * high-confidence cases) so it never raises a false alarm on a legitimately
 * short, clean deliverable.
 */
export function detectTruncation(content: string): string | null {
  const trimmed = content.replace(/\s+$/, "");
  if (trimmed.length === 0) return "empty file";

  // An odd number of ``` fences means a code block was opened but never closed.
  const fenceCount = trimmed.split("```").length - 1;
  if (fenceCount % 2 !== 0) return "unclosed code block";

  // HTML that opens <html> but never closes it.
  if (/<html[\s>]/i.test(trimmed) && !/<\/html\s*>/i.test(trimmed)) {
    return "missing </html> tag";
  }

  // Ends mid-sentence: the last non-empty line is prose that stops on a letter
  // or comma, with no terminal punctuation and no structural marker. Conservative
  // length/shape guards avoid flagging headers, list items, table rows or files
  // that simply close on a bracket/quote.
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  const endsClean = /[.!?:;)\]}>"\x60*|_]$/.test(lastLine) || /^[#\-*|>]/.test(lastLine);
  if (!endsClean && lastLine.length > 30 && /[\p{L},]$/u.test(lastLine)) {
    return `ends mid-sentence: "…${lastLine.slice(-40)}"`;
  }

  return null;
}
