/**
 * Parser for the Checkstyle-XML report format that PHPCS (and other lint tools
 * that speak the same de-facto dialect) emit via `--report=checkstyle`.
 *
 * This is DELIBERATELY NOT a general-purpose XML parser -- it is a regex scan over
 * exactly the shape these tools emit: a `<checkstyle>` root containing `<file
 * name="...">` blocks, each holding self-closing `<error .../>` children. It does
 * not resolve namespaces, CDATA, nested elements, or anything else arbitrary XML
 * permits. Do not reach for this on a document that isn't a Checkstyle report from
 * one of these tools -- write a real parser (or add a dependency) for that.
 *
 * PINNED ON A REAL CAPTURE, not a guess: `src/gate/__fixtures__/phpcs-checkstyle.xml`
 * was captured by actually running the polygon's PHPCS with `--report=checkstyle`
 * before this module was written. That discipline exists because of
 * `docs/gotchas/agent-ci-ndjson-keyed-by-event-not-type.md` -- a parser built
 * against a GUESSED external wire format was 100% green in its own tests and
 * 100% useless in production, because the real tool keyed its output differently.
 * Do not "clean up" that fixture or replace it with a hand-authored one; the whole
 * point is that it is the tool's actual output, warts included.
 */

export interface CheckstyleFinding {
  /** Exactly as PHPCS wrote it -- typically an ABSOLUTE, host-separator path (a
   *  Windows capture uses backslashes). Normalizing this to a worktree-relative,
   *  `/`-separated path is a LATER stage's job (the finding-filter, Task 3 of this
   *  plan), not this parser's -- this module only decodes what the tool said. */
  file: string;
  /** `null` when the tool OMITTED the `line` attribute entirely -- legitimately
   *  file-level (e.g. "missing file doc comment"). Never a fabricated `0`/`1`. A
   *  later stage treats a line-less finding differently (it can only ever be
   *  attributed to a brand-new file, never a specific added line), so inventing
   *  a number here would be a lie that stage would act on. A `line` attribute
   *  that IS present but does not parse to a positive integer is a different
   *  case entirely -- the parser THROWS rather than falling back to `null`,
   *  because silently downgrading a malformed line number to "file-level" risks
   *  the finding-filter dropping a real finding on an existing file. */
  line: number | null;
  /** PHPCS's exit code 1 (errors) and 2 (errors+warnings) are equally RED today --
   *  both severities are kept here. Deciding that one severity should NOT block is
   *  a policy choice for a later change, not something this parser gets to decide
   *  by silently dropping warnings. */
  severity: "error" | "warning";
  /** XML-entity-decoded. PHPCS routinely quotes code fragments inside the message
   *  (`&quot;class-&quot;`) -- leaving those escaped would show the worker mangled
   *  text instead of the actual message. */
  message: string;
  source: string;
}

// Order matters: `&lt; &gt; &quot; &apos;` and numeric entities (`&#10;`,
// `&#x27;`) first, `&amp;` LAST. If `&amp;` ran first, a message containing the
// literal substring `&amp;quot;` would decode in two passes ( `&amp;quot;` ->
// `&quot;` -> `"` ) and silently invent a quote character the tool never
// emitted. Decoding `&amp;` last means a literal `&amp;quot;` correctly stays
// `&quot;` (one real ampersand, followed by the still-escaped entity text)
// instead of being eaten twice. The same reasoning applies to numeric entities:
// `&amp;#10;` must stay `&#10;` (literal text), never become an actual newline.
function unescapeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex: string) => decodeCodePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec: string) => decodeCodePoint(parseInt(dec, 10), m))
    .replace(/&amp;/g, "&");
}

/** Is `codePoint` a character the XML spec actually permits in a document
 *  (production `Char`, https://www.w3.org/TR/xml/#charsets)? Two shapes slip
 *  past a bare range/`Number.isFinite` check and past `String.fromCodePoint`
 *  (which happily returns a value for both -- surrogate code points are
 *  valid arguments to it, just not valid standalone TEXT) -- R2-FIX5:
 *    - `0` (NUL) and the other C0 control codes below `0x20`, except the
 *      three the spec explicitly allows (tab, LF, CR).
 *    - A LONE surrogate (`0xD800`-`0xDFFF`) -- a numeric character reference
 *      names exactly ONE Unicode scalar value, so an entity like `&#55357;`
 *      (a bare UTF-16 high surrogate with no paired low surrogate) is not a
 *      legal reference in the first place, even though `String.fromCodePoint`
 *      will construct a string containing it without throwing. A lone
 *      surrogate is not valid UTF-8/well-formed Unicode text, and this
 *      module's output ends up in an LLM prompt -- injecting one there is
 *      exactly the "invented invalid character" this function exists to
 *      prevent. A genuine astral character (`&#x1F600;`) is unaffected: as a
 *      SINGLE code point it names one legal scalar value in the
 *      `0x10000`-`0x10FFFF` range, decoded to its (paired) UTF-16 form by
 *      `String.fromCodePoint` as normal. */
function isValidXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/** A numeric XML character reference decodes to the Unicode code point it
 *  names. Guard against out-of-range (beyond `0x10FFFF`, the maximum valid
 *  Unicode code point), otherwise-invalid values (`String.fromCodePoint`
 *  THROWS on those), and characters the XML spec itself forbids -- NUL and
 *  other disallowed control codes, and lone surrogates (`isValidXmlChar`
 *  above, R2-FIX5). A malformed entity in a tool's message is not worth
 *  failing the whole parse over, so the original entity text is left
 *  untouched (`m`) rather than invented or dropped. */
function decodeCodePoint(codePoint: number, original: string): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return original;
  if (!isValidXmlChar(codePoint)) return original;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return original;
  }
}

/**
 * Remove the two constructs whose contents are TEXT rather than markup — XML
 * comments and CDATA sections — returning only what a structural scan may read.
 *
 * A single left-to-right state machine, not a pair of regex counts (R7-FIX1/FIX2).
 * Counting `<!--`/`-->` and `<![CDATA[`/`]]>` occurrences independently cannot
 * know which construct is OPEN at each point, and got it wrong in both
 * directions: `<![CDATA[ literal <!-- marker ]]>` is valid XML (the `<!--` is
 * inside CDATA, so it is text) yet the comment counter saw an unterminated
 * comment and REJECTED a valid report; while `<!-- <![CDATA[ --> ]]>` balanced
 * both counters, passed, and then scrubbed as a comment — leaving a stray `]]>`
 * that no longer read as CDATA at all, so a malformed document parsed as CLEAN.
 * Only a scan that tracks the ACTIVE construct can tell text from markup.
 *
 * Throws on an unterminated section, and on a `]]>` in text position (XML forbids
 * it outside CDATA): both mean the document is not what it claims to be, and this
 * parser's contract is that "no findings" means the tool found none — never that
 * we failed to read them.
 */
function scrubTextSections(xml: string): string {
  // R8-FIX2: a removed region is replaced by a SPACE, never by nothing. Deleting
  // it outright lets the fragments on either side JOIN into markup that was never
  // in the document: `<fi<!--x-->le name="x.php"/>` collapses to a perfectly
  // valid-looking `<file name="x.php"/>`, and a CDATA opener inside an attribute
  // value does the same. A separator makes synthesis impossible -- the scrub can
  // then only ever destroy structure, never invent it, which is the direction
  // that matters here: an invented `<error>` would be a finding no tool reported,
  // and an invented `<file>` would silently change what is counted.
  const parts: string[] = [];
  let i = 0;
  let plainFrom = 0;
  while (i < xml.length) {
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end === -1) {
        throw new Error(
          `parseCheckstyle: report contains an unterminated XML comment -- the document is truncated. ` +
            `Everything after it is commented-out text, so accepting it would report a truncated document ` +
            `as CLEAN. First 200 chars: ${JSON.stringify(xml.slice(0, 200))}`,
        );
      }
      parts.push(xml.slice(plainFrom, i), " ");
      i = end + 3;
      plainFrom = i;
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (end === -1) {
        throw new Error(
          `parseCheckstyle: report contains an unterminated CDATA section -- the document is truncated. ` +
            `A </checkstyle> inside an unterminated CDATA is literal text, not a closed root, so accepting ` +
            `this would report a truncated document as CLEAN. First 200 chars: ${JSON.stringify(xml.slice(0, 200))}`,
        );
      }
      parts.push(xml.slice(plainFrom, i), " ");
      i = end + 3;
      plainFrom = i;
      continue;
    }
    if (xml.startsWith("]]>", i)) {
      throw new Error(
        `parseCheckstyle: report contains a "]]>" outside any CDATA section, which XML forbids -- the ` +
          `document is malformed (most likely a crossed comment/CDATA). Treating it as a clean report would ` +
          `hide whatever the tool actually wrote. First 200 chars: ${JSON.stringify(xml.slice(0, 200))}`,
      );
    }
    i += 1;
  }
  parts.push(xml.slice(plainFrom));
  return parts.join("");
}

const FILE_BLOCK_RE = /<file\s+name="([^"]*)"\s*>([\s\S]*?)<\/file>/g;
const FILE_OPEN_RE = /<file\b/g;
/** A `<file ... />` element that closes itself -- a file with no findings, which
 *  several tools emit for a clean file. It is a complete element, so it must not
 *  be counted as an opening awaiting a `</file>`. */
const FILE_SELF_CLOSED_RE = /<file\b[^>]*\/>/g;
const ERROR_TAG_RE = /<error\b([^>]*)\/>/g;
/** Any `<error` opening, self-closing or not. Counted against `ERROR_TAG_RE` so a
 *  malformed non-self-closed `<error ...>` cannot be skipped in silence. */
const ERROR_OPEN_RE = /<error\b/g;
const ATTR_RE = /([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"/g;

/** Parse one self-closing tag's attribute list (`line="1" column="1" ...`) into a
 *  plain key/value map. XML-escapes `"` inside an attribute value as `&quot;`, so
 *  a bare `[^"]*` between the quotes is safe -- a literal `"` byte cannot appear
 *  there in valid Checkstyle output. */
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    attrs[m[1]!] = m[2]!;
  }
  return attrs;
}

/**
 * Parse a Checkstyle-XML report into findings.
 *
 * FAIL-CLOSED by design: an unparseable document THROWS rather than returning
 * `[]`. Zero findings reads as "clean" everywhere downstream, so a parse failure
 * that returned `[]` would silently convert a broken/misconfigured tool run into
 * a PASS verdict -- a fail-open in exactly the component whose job is deciding
 * whether a change may merge. Two shapes are treated as unparseable:
 *
 *   1. No `<checkstyle` root at all (e.g. the tool crashed and printed a shell
 *      error instead of a report).
 *   2. A root that never ENDS -- no `</checkstyle>` closing tag, and the root
 *      open tag is not itself self-closed (`<checkstyle .../>`). A killed
 *      process or a half-written report can produce exactly `<checkstyle
 *      version="..."><file name="x.php">` and then just stop: the root marker
 *      IS present, so a check for the root alone would pass this through, the
 *      `<file>`/`<error>` regex scan would find no complete blocks, and the
 *      result would be `[]` -- reading as CLEAN downstream for a report that
 *      never finished. Requiring evidence the document actually ended is what
 *      tells a genuinely empty, well-formed report (`<checkstyle .../>` or
 *      `<checkstyle>...</checkstyle>` with zero `<file>` blocks -- a legitimate
 *      clean report, returns `[]`) apart from a truncated one.
 */
export function parseCheckstyle(xml: string): CheckstyleFinding[] {
  // R5-FIX4: an UNTERMINATED CDATA section must be caught before the root-close
  // check below, because that check would otherwise be satisfied by a
  // `</checkstyle>` sitting INSIDE the unterminated CDATA -- where it is literal
  // text, not markup. `<checkstyle><![CDATA[ literal </checkstyle>` then reads as
  // a well-formed, file-less, finding-less report: CLEAN, for a document that was
  // truncated mid-section. Counting openings against terminators catches it.
  const markup = scrubTextSections(xml);

  const rootMatch = /<checkstyle\b[^>]*>/.exec(markup);
  if (!rootMatch) {
    throw new Error(
      `parseCheckstyle: input has no <checkstyle> root -- this is not a Checkstyle report ` +
        `(the tool likely crashed or printed something other than its --report=checkstyle ` +
        `output). Treating this as zero findings would silently turn a broken gate run into ` +
        `a PASS, so it throws instead. First 200 chars: ${JSON.stringify(xml.slice(0, 200))}`,
    );
  }

  const rootSelfClosed = rootMatch[0].endsWith("/>");
  if (!rootSelfClosed && !/<\/checkstyle\s*>/.test(markup)) {
    throw new Error(
      `parseCheckstyle: <checkstyle> root was never closed -- no </checkstyle> and the root tag ` +
        `is not self-closed. This looks like a truncated report (killed process, or output cut ` +
        `off mid-write): zero findings would parse out of a document like this and read as CLEAN ` +
        `downstream, so it throws instead. First 200 chars: ${JSON.stringify(xml.slice(0, 200))}`,
    );
  }

  // R3-FIX5: the two checks above only prove the ROOT closed -- they say
  // nothing about a `<file>` block INSIDE it that never closed. Given
  // `<checkstyle><file name="x.php"><error line="1"/></checkstyle>`, the root
  // is well-formed (closed by `</checkstyle>`), but `FILE_BLOCK_RE` requires a
  // literal `</file>` it never finds, so the scan below would silently match
  // zero blocks and return `[]` -- CLEAN, for a document with an unparsed
  // `<error>` sitting right there. Counting `<file` openings against the
  // number of blocks `FILE_BLOCK_RE` actually matched catches this directly:
  // a `<file>` that never closed can never be captured by that regex, so any
  // shortfall means at least one block is being silently dropped rather than
  // parsed.
  // R4-FIX4: two ways that count was WRONG in the rejecting direction, each of
  // which fails a perfectly valid report and so brings down the gate run for
  // every task -- a denial of service, which is its own kind of broken gate.
  //   - `<file name="x.php"/>` is a self-closed element for a file with no
  //     findings, which several tools emit. It counts as an opening but can
  //     never match `FILE_BLOCK_RE` (that pattern requires a literal `</file>`),
  //     so a clean report was rejected outright.
  //   - A literal `<file` inside a CDATA section is text, not markup.
  // Both are excluded here; a genuinely unclosed `<file>` still throws, which is
  // the guarantee this check exists for.
  const scanned = markup;
  const selfClosedFileCount = [...scanned.matchAll(FILE_SELF_CLOSED_RE)].length;
  const fileOpenCount = [...scanned.matchAll(FILE_OPEN_RE)].length - selfClosedFileCount;
  const fileBlockCount = [...scanned.matchAll(FILE_BLOCK_RE)].length;
  if (fileBlockCount < fileOpenCount) {
    throw new Error(
      `parseCheckstyle: found ${fileOpenCount} <file> opening tag(s) but only ${fileBlockCount} closed ` +
        `with a matching </file> -- at least one <file> block is unclosed (a truncated or malformed ` +
        `report). Treating the unparsed region as zero findings would silently turn a broken gate run ` +
        `into a PASS, so it throws instead. First 200 chars: ${JSON.stringify(xml.slice(0, 200))}`,
    );
  }

  const findings: CheckstyleFinding[] = [];
  for (const fileMatch of markup.matchAll(FILE_BLOCK_RE)) {
    const file = unescapeXmlEntities(fileMatch[1]!);
    const body = fileMatch[2]!;

    // R5-FIX5: the same shortfall discipline the `<file>` count applies, one
    // level down. `ERROR_TAG_RE` only recognizes a SELF-CLOSING `<error .../>`,
    // so a malformed `<error line="1" ...>` (no `/`) was skipped in silence and
    // a report carrying a real finding parsed as zero -- CLEAN. An unparsed
    // element inside a document we accepted is never ignorable here: this
    // parser's entire contract is that "no findings" means the tool found none,
    // not that we failed to read them.
    const errorOpenCount = [...body.matchAll(ERROR_OPEN_RE)].length;
    const errorTagCount = [...body.matchAll(ERROR_TAG_RE)].length;
    if (errorTagCount < errorOpenCount) {
      throw new Error(
        `parseCheckstyle: file block for ${JSON.stringify(file)} has ${errorOpenCount} <error> tag(s) but ` +
          `only ${errorTagCount} in the self-closing form this parser can read -- the report is malformed. ` +
          `Skipping the unreadable ones would report a file with real findings as clean, so it throws instead`,
      );
    }

    for (const errorMatch of body.matchAll(ERROR_TAG_RE)) {
      const attrs = parseAttrs(errorMatch[1]!);
      const lineAttr = attrs["line"];
      let line: number | null = null;
      if (lineAttr !== undefined) {
        // PRESENT but unparseable or non-positive means the report is not
        // trustworthy -- Checkstyle line numbers are 1-based, so anything
        // that doesn't parse to a positive integer is malformed input, not a
        // legitimate file-level finding. Silently falling back to `null` here
        // (as an ABSENT attribute legitimately does) would make a malformed
        // `line="abc"`/`line="-1"` read as file-level, which on an EXISTING
        // file means the finding-filter DROPS it -- a finding the worker may
        // have actually written, silently discarded.
        const n = Number(lineAttr);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(
            `parseCheckstyle: <error> has an unparseable or non-positive line attribute ` +
              `(line=${JSON.stringify(lineAttr)}) in file ${JSON.stringify(file)} -- a PRESENT line ` +
              `attribute that isn't a positive integer means the report is not trustworthy, and ` +
              `treating it as file-level (null) would risk silently dropping a real finding on an ` +
              `existing file.`,
          );
        }
        line = n;
      }
      const severity = attrs["severity"] === "warning" ? "warning" : "error"; // PHPCS emits only these two; anything else is treated as the more conservative "error"
      findings.push({
        file,
        line,
        severity,
        message: unescapeXmlEntities(attrs["message"] ?? ""),
        source: attrs["source"] ?? "",
      });
    }
  }
  return findings;
}
