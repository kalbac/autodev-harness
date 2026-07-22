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

  it("surfaces an ABSENT line attribute as null, never a fabricated number", () => {
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

  it("FIX4: THROWS on a truncated report that has a root but never closes it (killed process / half-written report)", () => {
    // Contains the `<checkstyle` root marker, so the OLD "no root at all" check
    // would pass it through and the regex scan would simply find zero <file>
    // blocks -- returning [] and reading as CLEAN downstream. A document that
    // never ended is not a legitimate empty report; it must throw.
    expect(() =>
      parseCheckstyle('<?xml version="1.0"?>\n<checkstyle version="3.13.5"><file name="x.php">'),
    ).toThrow(/checkstyle/i);
  });

  it("FIX4: a genuinely empty, well-CLOSED report still returns []", () => {
    expect(parseCheckstyle('<?xml version="1.0"?>\n<checkstyle version="3.13.5"></checkstyle>')).toEqual([]);
  });

  it("R3-FIX5: THROWS when the root is closed but a <file> block inside it is never closed", () => {
    // <checkstyle> ... </checkstyle> is present and well-formed, but the <file>
    // inside it has no matching </file> -- FILE_BLOCK_RE finds zero complete
    // blocks, so the OLD code returned [] (reads as CLEAN downstream) even
    // though a real <error> sits inside the unclosed block and was never
    // parsed at all.
    expect(() =>
      parseCheckstyle('<checkstyle><file name="x.php"><error line="1"/></checkstyle>'),
    ).toThrow(/checkstyle|file/i);
  });

  it("FIX5: an ABSENT line attribute is legitimately file-level -- null, not a throw", () => {
    const found = parseCheckstyle(
      '<checkstyle><file name="f.php"><error severity="error" message="no line here" source="s"/></file></checkstyle>',
    );
    expect(found[0]!.line).toBeNull();
  });

  it("FIX5: a PRESENT but unparseable line attribute (line=\"abc\") THROWS rather than silently becoming file-level", () => {
    expect(() =>
      parseCheckstyle(
        '<checkstyle><file name="f.php"><error line="abc" severity="error" message="m" source="s"/></file></checkstyle>',
      ),
    ).toThrow(/line/i);
  });

  it("FIX5: a PRESENT but non-positive line attribute (line=\"-1\") THROWS rather than silently becoming file-level", () => {
    expect(() =>
      parseCheckstyle(
        '<checkstyle><file name="f.php"><error line="-1" severity="error" message="m" source="s"/></file></checkstyle>',
      ),
    ).toThrow(/line/i);
  });

  it("FIX5: line=\"0\" also THROWS -- Checkstyle line numbers are 1-based, so 0 is not a legitimate value", () => {
    expect(() =>
      parseCheckstyle(
        '<checkstyle><file name="f.php"><error line="0" severity="error" message="m" source="s"/></file></checkstyle>',
      ),
    ).toThrow(/line/i);
  });

  it("FIX6: decodes decimal and hex numeric XML entities in the message", () => {
    const found = parseCheckstyle(
      '<checkstyle><file name="f.php"><error line="1" severity="error" message="a&#10;b&#x27;c" source="s"/></file></checkstyle>',
    );
    expect(found[0]!.message).toBe("a\nb'c");
  });

  it("FIX6: numeric-entity decoding still leaves &amp; for last -- a literal &amp;#10; does not double-decode", () => {
    const found = parseCheckstyle(
      '<checkstyle><file name="f.php"><error line="1" severity="error" message="a &amp;#10; b" source="s"/></file></checkstyle>',
    );
    expect(found[0]!.message).toBe("a &#10; b");
  });

  it("FIX6: an out-of-range numeric entity is left undecoded rather than producing an invalid character", () => {
    const found = parseCheckstyle(
      '<checkstyle><file name="f.php"><error line="1" severity="error" message="bad &#x110000; entity" source="s"/></file></checkstyle>',
    );
    expect(found[0]!.message).toBe("bad &#x110000; entity");
  });

  it("R2-FIX5: &#0; (NUL) is left undecoded -- not a legal XML character", () => {
    const found = parseCheckstyle(
      '<checkstyle><file name="f.php"><error line="1" severity="error" message="bad &#0; entity" source="s"/></file></checkstyle>',
    );
    expect(found[0]!.message).toBe("bad &#0; entity");
  });

  it("R2-FIX5: a lone high-surrogate numeric reference (&#55357;) is left undecoded, never becomes a lone surrogate", () => {
    // 0xD83D is a UTF-16 high surrogate with no paired low surrogate here --
    // String.fromCodePoint happily returns the raw lone-surrogate code unit,
    // which is not a legal standalone character and would land in an LLM
    // prompt downstream.
    const found = parseCheckstyle(
      '<checkstyle><file name="f.php"><error line="1" severity="error" message="bad &#55357; entity" source="s"/></file></checkstyle>',
    );
    expect(found[0]!.message).toBe("bad &#55357; entity");
  });

  it("R2-FIX5: a lone low-surrogate numeric reference (&#56833;) is also left undecoded", () => {
    const found = parseCheckstyle(
      '<checkstyle><file name="f.php"><error line="1" severity="error" message="bad &#56833; entity" source="s"/></file></checkstyle>',
    );
    expect(found[0]!.message).toBe("bad &#56833; entity");
  });

  it("R2-FIX5: a valid astral-plane code point (a surrogate PAIR forming one character) still decodes normally", () => {
    // 0x1F600 (grinning face emoji) requires a surrogate pair when represented
    // in UTF-16, but as a SINGLE numeric character reference it names one
    // legal Unicode scalar value -- must not be confused with the lone-
    // surrogate case above and must still decode.
    const found = parseCheckstyle(
      '<checkstyle><file name="f.php"><error line="1" severity="error" message="&#x1F600;" source="s"/></file></checkstyle>',
    );
    expect(found[0]!.message).toBe("\u{1F600}");
  });
});

describe("R4-FIX4: the unclosed-<file> guard must not reject VALID reports", () => {
  it("accepts a self-closing <file/> -- a clean file, which several tools emit", () => {
    // Counting it as an opening awaiting a `</file>` rejected an entirely valid
    // report, bringing down the gate run for every task. A denial of service is
    // its own kind of broken gate, just in the other direction.
    const xml = '<?xml version="1.0"?><checkstyle version="3.13.5"><file name="clean.php"/></checkstyle>';
    expect(parseCheckstyle(xml)).toEqual([]);
  });

  it("accepts a mix of self-closed and populated file elements", () => {
    const xml =
      '<checkstyle><file name="clean.php"/><file name="dirty.php">' +
      '<error line="4" severity="error" message="boom" source="X.Y"/></file></checkstyle>';
    const found = parseCheckstyle(xml);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "dirty.php", line: 4 });
  });

  it("does not count a literal <file inside CDATA as an opening tag", () => {
    const xml =
      '<checkstyle><file name="x.php"><error line="1" severity="error" message="m" source="S"/></file>' +
      '<![CDATA[ literal <file name="fake.php"> text ]]></checkstyle>';
    expect(parseCheckstyle(xml)).toHaveLength(1);
  });

  it("STILL throws on a genuinely unclosed <file> -- the guarantee is intact", () => {
    const xml =
      '<checkstyle><file name="x.php"><error line="1" severity="error" message="m" source="S"/></checkstyle>';
    expect(() => parseCheckstyle(xml)).toThrow(/unclosed|closed/i);
  });
});

describe("R5: malformed regions must never read as clean", () => {
  it("throws on an unterminated CDATA whose text contains a literal </checkstyle>", () => {
    // The root-close check would otherwise be satisfied by markup that is only
    // literal TEXT, so a document truncated mid-CDATA read as a well-formed,
    // finding-less report.
    expect(() => parseCheckstyle("<checkstyle><![CDATA[ literal </checkstyle>")).toThrow(/CDATA/i);
  });

  it("still accepts a properly terminated CDATA section", () => {
    const xml = '<checkstyle><![CDATA[ harmless ]]><file name="x.php"/></checkstyle>';
    expect(parseCheckstyle(xml)).toEqual([]);
  });

  it("throws on a non-self-closing <error> instead of skipping it", () => {
    // ERROR_TAG_RE only reads `<error .../>`, so this real finding was silently
    // dropped and the file reported as clean.
    const xml = '<checkstyle><file name="x.php"><error line="1" severity="error" message="boom"></file></checkstyle>';
    expect(() => parseCheckstyle(xml)).toThrow(/self-closing|malformed/i);
  });
});

describe("R6: comments and CDATA are TEXT, not markup", () => {
  it("does not count an <error> inside an XML comment -- a valid report must not be rejected", () => {
    const xml = '<checkstyle><file name="x.php"><!-- <error line="1"> --></file></checkstyle>';
    expect(parseCheckstyle(xml)).toEqual([]);
  });

  it("does not parse an <error/> inside CDATA as a genuine finding", () => {
    const xml =
      '<checkstyle><file name="x.php"><![CDATA[ <error line="1" severity="error" message="fake" source="s"/> ]]></file></checkstyle>';
    expect(parseCheckstyle(xml)).toEqual([]);
  });

  it("throws when the only </checkstyle> sits inside a CLOSED CDATA section", () => {
    // The section terminates, so the unterminated-CDATA guard does not fire --
    // but the text inside it is not a closed root, and the document really did
    // end early.
    expect(() => parseCheckstyle("<checkstyle><![CDATA[ </checkstyle> ]]>")).toThrow(/never closed/i);
  });

  it("throws on an unterminated XML comment", () => {
    expect(() => parseCheckstyle("<checkstyle><!-- oops </checkstyle>")).toThrow(/comment/i);
  });

  it("R7: accepts a <!-- that is INSIDE a CDATA section (it is text, not a comment)", () => {
    // Counting `<!--` and `-->` independently of which construct is open saw an
    // unterminated comment here and rejected an entirely valid report.
    const xml = "<checkstyle><![CDATA[ literal <!-- marker ]]></checkstyle>";
    expect(parseCheckstyle(xml)).toEqual([]);
  });

  it("R7: accepts a <![CDATA[ that is INSIDE a comment (it is text, not a section)", () => {
    const xml = "<checkstyle><!-- literal <![CDATA[ marker --></checkstyle>";
    expect(parseCheckstyle(xml)).toEqual([]);
  });

  it("R7: THROWS on crossed comment/CDATA rather than reading the wreckage as clean", () => {
    // Both raw counters balanced here, so the old check passed; the region then
    // scrubbed as a comment, leaving a stray `]]>` that no longer read as CDATA
    // at all -- and the document parsed as CLEAN.
    expect(() => parseCheckstyle("<checkstyle><!-- <![CDATA[ --> ]]> </checkstyle>")).toThrow(/\]\]>/);
  });

  it("still parses a real finding alongside a comment", () => {
    const xml =
      '<checkstyle><file name="x.php"><!-- note --><error line="2" severity="error" message="real" source="s"/></file></checkstyle>';
    const found = parseCheckstyle(xml);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 2, message: "real" });
  });
});

describe("R8-FIX2: a scrubbed region cannot JOIN fragments into markup", () => {
  it("does not let a comment inside a tag name collapse into a valid element", () => {
    // Deleting the region outright turned `<fi<!--x-->le name="x.php"/>` into a
    // perfectly valid-looking `<file name="x.php"/>` -- markup that was never in
    // the document. A separator makes synthesis impossible: the scrub can only
    // ever destroy structure, never invent it.
    const xml = '<checkstyle><fi<!--x-->le name="x.php"/></checkstyle>';
    expect(parseCheckstyle(xml)).toEqual([]);
  });

  it("does not let CDATA inside an attribute value collapse into a valid element", () => {
    const xml = '<checkstyle><file name="x<![CDATA[bogus]]>.php"/></checkstyle>';
    expect(parseCheckstyle(xml)).toEqual([]);
  });
});
