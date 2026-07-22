import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseCheckstyle } from "./checkstyle.js";

// Read the REAL fixture from disk -- never an inline hand-written string. See
// `docs/gotchas/agent-ci-ndjson-keyed-by-event-not-type.md`: a parser tested only
// against a self-authored guess of an external tool's wire format was 100% green
// and 100% useless in production, because the real tool keyed its output
// differently than the guess. This fixture was captured by actually running the
// polygon's PHPCS with `--report=checkstyle` before this parser was written.
const xml = readFileSync(new URL("./__fixtures__/phpcs-checkstyle.xml", import.meta.url), "utf8");

describe("parseCheckstyle (pinned on a REAL PHPCS report)", () => {
  it("extracts every finding from the real report", () => {
    // The fixture has exactly 17 <error> elements (verified against the file on
    // disk, not guessed) -- pinning the count catches a regex that silently
    // drops or double-counts findings.
    const found = parseCheckstyle(xml);
    expect(found).toHaveLength(17);
  });

  it("extracts file, line, severity, message and source for the first finding", () => {
    const found = parseCheckstyle(xml);
    expect(found[0]).toMatchObject({
      // Absolute WINDOWS path, backslashes and all -- this is what the real
      // PHPCS emits; normalizing it to a worktree-relative path is a LATER
      // stage's job (finding-filter.ts, Task 3), not this parser's.
      file: "C:\\Users\\maksi\\AppData\\Local\\Temp\\tmp.e3mbbP7xGX\\bad.php",
      line: 1,
      severity: "error",
      source: "WordPress.Files.FileName.InvalidClassFileName",
    });
  });

  it("unescapes XML entities in the message", () => {
    const found = parseCheckstyle(xml);
    expect(found[0]!.message).toContain('"class-"');
    expect(found[0]!.message).not.toContain("&quot;");
  });

  it("unescapes &amp; LAST so a literal &amp;quot; does not double-unescape to a bare quote", () => {
    // If &amp; were unescaped BEFORE &quot;, then a message containing the
    // literal substring "&amp;quot;" would first become "&quot;" and then a
    // SECOND pass would turn that into `"` -- silently inventing a quote
    // character the tool never emitted. None of the real findings in the
    // fixture happen to contain this sequence, so this is a synthetic probe
    // of the unescape ORDER itself, not a re-assertion of the fixture's content.
    expect(parseCheckstyle('<checkstyle><file name="f.php"><error line="1" severity="error" message="a &amp;amp; b" source="s"/></file></checkstyle>')[0]!.message).toBe(
      "a &amp; b",
    );
  });

  it("keeps warnings, not only errors -- both are equally RED (PHPCS exit 1 and 2)", () => {
    const found = parseCheckstyle(xml);
    const warnings = found.filter((f) => f.severity === "warning");
    // Verified by grep against the fixture on disk: exactly 2 severity="warning" rows.
    expect(warnings).toHaveLength(2);
    expect(found.some((f) => f.severity === "error")).toBe(true);
  });

  it("surfaces a missing/unparseable line attribute as null, never a fabricated number", () => {
    const found = parseCheckstyle(
      '<checkstyle><file name="f.php"><error severity="error" message="no line here" source="s"/></file></checkstyle>',
    );
    expect(found[0]!.line).toBeNull();
  });

  it("returns [] for a report with no findings", () => {
    expect(parseCheckstyle('<?xml version="1.0"?>\n<checkstyle version="3.13.5"/>')).toEqual([]);
  });

  it("THROWS on unparseable output rather than reporting zero findings", () => {
    // Zero findings means "clean" downstream -- so a parse failure that returned
    // [] would silently turn a broken/misconfigured gate into a PASS. That is a
    // fail-OPEN in the component whose entire job is deciding whether a change
    // may merge, so an unparseable document must be UNRUNNABLE, not "clean".
    expect(() => parseCheckstyle("phpcs: command not found")).toThrow(/checkstyle/i);
  });

  it("THROWS on an empty string", () => {
    expect(() => parseCheckstyle("")).toThrow(/checkstyle/i);
  });
});
