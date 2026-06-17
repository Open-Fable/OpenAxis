import { describe, it, expect } from "vitest";
import {
  parseFilepathBlocks,
  parseEditBlocks,
  applyEdits,
  detectTruncation,
} from "./orchestrator-files.js";

// ---------------------------------------------------------------------------
// Pure deliverable parsers — security-sensitive, fuzz-prone, and historically
// the source of file-truncation bugs. These cover the extraction of full-file
// blocks, surgical SEARCH/REPLACE edits, their application, and the
// deterministic truncation detector.
// ---------------------------------------------------------------------------

describe("parseFilepathBlocks", () => {
  it("extracts a single full-file block", () => {
    const text = ["```js filepath: src/a.js", "const x = 1;", "```"].join("\n");
    const blocks = parseFilepathBlocks(text);
    expect(blocks).toEqual([{ path: "src/a.js", content: "const x = 1;" }]);
  });

  it("extracts multiple blocks", () => {
    const text = [
      "```js filepath: a.js",
      "1",
      "```",
      "prose between",
      "```css filepath: b.css",
      "body{}",
      "```",
    ].join("\n");
    const blocks = parseFilepathBlocks(text);
    expect(blocks.map((b) => b.path)).toEqual(["a.js", "b.css"]);
    expect(blocks[1].content).toBe("body{}");
  });

  it("preserves inner ``` fences instead of truncating at the first one", () => {
    // A README whose content embeds a triple-backtick code example must run to
    // the LAST closing fence before the next opener/EOF, not the first.
    const text = [
      "````md filepath: README.md",
      "# Title",
      "```",
      "example code",
      "```",
      "more docs",
      "````",
    ].join("\n");
    const blocks = parseFilepathBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("example code");
    expect(blocks[0].content).toContain("```");
  });

  it("does not parse ```edit filepath: blocks (reserved for parseEditBlocks)", () => {
    const text = [
      "```edit filepath: index.html",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "b",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n");
    expect(parseFilepathBlocks(text)).toEqual([]);
  });

  it("excludes ```Edit / ```EDIT case-insensitively", () => {
    const text = ["```EDIT filepath: x.txt", "stuff", "```"].join("\n");
    expect(parseFilepathBlocks(text)).toEqual([]);
  });

  it("trims surrounding whitespace from the path", () => {
    const text = ["```js filepath:    spaced/path.js   ", "y", "```"].join("\n");
    expect(parseFilepathBlocks(text)[0].path).toBe("spaced/path.js");
  });

  it("returns an empty array when there are no blocks", () => {
    expect(parseFilepathBlocks("just some prose\nno fences here")).toEqual([]);
  });

  it("captures content up to EOF when the closing fence is missing", () => {
    const text = ["```js filepath: a.js", "line1", "line2"].join("\n");
    const blocks = parseFilepathBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("line1\nline2");
  });
});

describe("parseEditBlocks", () => {
  it("parses a single SEARCH/REPLACE pair", () => {
    const text = [
      "```edit filepath: index.html",
      "<<<<<<< SEARCH",
      "<h1>Old</h1>",
      "=======",
      "<h1>New</h1>",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n");
    const blocks = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].path).toBe("index.html");
    expect(blocks[0].edits).toEqual([
      { search: "<h1>Old</h1>", replace: "<h1>New</h1>" },
    ]);
  });

  it("parses multiple pairs within one block", () => {
    const text = [
      "```edit filepath: a.js",
      "<<<<<<< SEARCH",
      "1",
      "=======",
      "one",
      ">>>>>>> REPLACE",
      "<<<<<<< SEARCH",
      "2",
      "=======",
      "two",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n");
    const blocks = parseEditBlocks(text);
    expect(blocks[0].edits).toHaveLength(2);
  });

  it("is case-insensitive on the ```Edit opener", () => {
    const text = [
      "```Edit filepath: a.js",
      "<<<<<<< SEARCH",
      "x",
      "=======",
      "y",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n");
    expect(parseEditBlocks(text)).toHaveLength(1);
  });

  it("drops a malformed block with no closing REPLACE marker", () => {
    const text = [
      "```edit filepath: a.js",
      "<<<<<<< SEARCH",
      "x",
      "=======",
      "y",
      "```",
    ].join("\n");
    expect(parseEditBlocks(text)).toEqual([]);
  });

  it("ignores non-edit filepath blocks", () => {
    const text = ["```js filepath: a.js", "const x=1", "```"].join("\n");
    expect(parseEditBlocks(text)).toEqual([]);
  });
});

describe("applyEdits", () => {
  it("applies a single edit when SEARCH matches exactly once", () => {
    const res = applyEdits("hello world", [{ search: "world", replace: "there" }]);
    expect(res.ok).toBe(true);
    expect(res.content).toBe("hello there");
  });

  it("applies edits sequentially", () => {
    const res = applyEdits("a b c", [
      { search: "a", replace: "X" },
      { search: "c", replace: "Z" },
    ]);
    expect(res.content).toBe("X b Z");
  });

  it("fails all-or-nothing when SEARCH is not found", () => {
    const res = applyEdits("hello", [{ search: "missing", replace: "x" }]);
    expect(res.ok).toBe(false);
    expect(res.content).toBe("hello");
    expect(res.failedSearch).toBe("missing");
  });

  it("fails when SEARCH matches more than once (ambiguous)", () => {
    const res = applyEdits("x x x", [{ search: "x", replace: "y" }]);
    expect(res.ok).toBe(false);
    expect(res.content).toBe("x x x");
  });

  it("rejects an empty SEARCH", () => {
    const res = applyEdits("anything", [{ search: "", replace: "x" }]);
    expect(res.ok).toBe(false);
  });

  it("treats replace as a literal (no $ pattern substitution)", () => {
    const res = applyEdits("price: AMOUNT", [{ search: "AMOUNT", replace: "$1.00" }]);
    expect(res.content).toBe("price: $1.00");
  });

  it("returns original content unchanged if a later edit fails", () => {
    const res = applyEdits("a b", [
      { search: "a", replace: "X" },
      { search: "zzz", replace: "Y" },
    ]);
    expect(res.ok).toBe(false);
    expect(res.content).toBe("a b");
  });
});

describe("detectTruncation", () => {
  it("flags empty content", () => {
    expect(detectTruncation("   \n  ")).toBe("fichier vide");
  });

  it("flags an unclosed code fence (odd number of ```)", () => {
    expect(detectTruncation("text\n```\ncode")).toBe("bloc de code non fermé");
  });

  it("passes balanced code fences", () => {
    expect(detectTruncation("```\ncode\n```\n")).toBeNull();
  });

  it("flags HTML with <html> but no </html>", () => {
    expect(detectTruncation("<html><body>hi")).toBe("balise </html> manquante");
  });

  it("passes complete HTML", () => {
    expect(detectTruncation("<html><body>hi</body></html>")).toBeNull();
  });

  it("flags prose ending mid-sentence", () => {
    const content =
      "This is a long paragraph that clearly stops abruptly without any closing";
    expect(detectTruncation(content)).toMatch(/milieu de phrase/);
  });

  it("does not flag a clean short deliverable", () => {
    expect(detectTruncation("# Title\n\nDone.")).toBeNull();
  });

  it("does not flag a markdown list item or header on the last line", () => {
    expect(detectTruncation("Some intro.\n- a final bullet point item here")).toBeNull();
    expect(
      detectTruncation("body\n# A Heading That Is Quite Long Indeed Yes"),
    ).toBeNull();
  });

  it("does not flag a short last line even without terminal punctuation", () => {
    expect(detectTruncation("Intro line.\nshort tail")).toBeNull();
  });
});
