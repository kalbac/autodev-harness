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
  /** `null`, never a fabricated `0`/`1`, when the tool omitted or could not supply
   *  a line number. A later stage treats a line-less finding differently (it can
   *  only ever be attributed to a brand-new file, never a specific added line), so
   *  inventing a number here would be a lie that stage would act on. */
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

// Order matters: `&lt; &gt; &quot; &apos;` first, `&amp;` LAST. If `&amp;` ran
// first, a message containing the literal substring `&amp;quot;` would decode in
// two passes ( `&amp;quot;` -> `&quot;` -> `"` ) and silently invent a quote
// character the tool never emitted. Decoding `&amp;` last means a literal
// `&amp;quot;` correctly stays `&quot;` (one real ampersand, followed by the
// still-escaped entity text) instead of being eaten twice.
function unescapeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const FILE_BLOCK_RE = /<file\s+name="([^"]*)"\s*>([\s\S]*?)<\/file>/g;
const ERROR_TAG_RE = /<error\b([^>]*)\/>/g;
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
 * whether a change may merge. "Unparseable" is deliberately narrow here: only "no
 * `<checkstyle` root at all" is treated as unparseable (e.g. the tool crashed and
 * printed a shell error instead of a report). A well-formed root with zero `<file>`
 * blocks is a legitimate clean report and returns `[]`.
 */
export function parseCheckstyle(xml: string): CheckstyleFinding[] {
  if (!/<checkstyle(\s|>|\/)/.test(xml)) {
    throw new Error(
      `parseCheckstyle: input has no <checkstyle> root -- this is not a Checkstyle report ` +
        `(the tool likely crashed or printed something other than its --report=checkstyle ` +
        `output). Treating this as zero findings would silently turn a broken gate run into ` +
        `a PASS, so it throws instead. First 200 chars: ${JSON.stringify(xml.slice(0, 200))}`,
    );
  }

  const findings: CheckstyleFinding[] = [];
  for (const fileMatch of xml.matchAll(FILE_BLOCK_RE)) {
    const file = unescapeXmlEntities(fileMatch[1]!);
    const body = fileMatch[2]!;
    for (const errorMatch of body.matchAll(ERROR_TAG_RE)) {
      const attrs = parseAttrs(errorMatch[1]!);
      const lineAttr = attrs["line"];
      const lineNum = lineAttr === undefined ? NaN : Number(lineAttr);
      const severity = attrs["severity"] === "warning" ? "warning" : "error"; // PHPCS emits only these two; anything else is treated as the more conservative "error"
      findings.push({
        file,
        line: Number.isFinite(lineNum) ? lineNum : null,
        severity,
        message: unescapeXmlEntities(attrs["message"] ?? ""),
        source: attrs["source"] ?? "",
      });
    }
  }
  return findings;
}
