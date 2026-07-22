import { describe, it, expect } from "vitest";
import { addedLineNumbers } from "./diff-lines.js";

const DIFF = `diff --git a/includes/a.php b/includes/a.php
index 111..222 100644
--- a/includes/a.php
+++ b/includes/a.php
@@ -10,6 +10,7 @@ class A {
 	public function keep() {
 		return 1;
 	}
+	public function added() {}
 	public function tail() {
 	}
 }
`;

describe("addedLineNumbers", () => {
  it("records only ADDED lines, numbered in the NEW file", () => {
    const m = addedLineNumbers(DIFF).added;
    expect([...m.get("includes/a.php")!]).toEqual([13]);
  });

  it("handles several hunks in one file", () => {
    const d = `--- a/x.php
+++ b/x.php
@@ -1,2 +1,3 @@
 a
+b
 c
@@ -20,2 +21,3 @@
 d
+e
 f
`;
    expect([...addedLineNumbers(d).added.get("x.php")!]).toEqual([2, 22]);
  });

  it("treats a brand-new file as entirely added", () => {
    const d = `--- /dev/null
+++ b/new.php
@@ -0,0 +1,3 @@
+one
+two
+three
`;
    expect([...addedLineNumbers(d).added.get("new.php")!]).toEqual([1, 2, 3]);
  });

  it("a deletion-only hunk adds nothing and does not shift the cursor", () => {
    const d = `--- a/x.php
+++ b/x.php
@@ -1,3 +1,2 @@
 a
-b
 c
`;
    expect(addedLineNumbers(d).added.get("x.php") ?? new Set()).toEqual(new Set());
  });

  it("covers several files in one diff", () => {
    const d = `--- a/x.php
+++ b/x.php
@@ -1,1 +1,2 @@
 a
+b
--- a/y.php
+++ b/y.php
@@ -5,1 +5,2 @@
 c
+d
`;
    const m = addedLineNumbers(d).added;
    expect([...m.get("x.php")!]).toEqual([2]);
    expect([...m.get("y.php")!]).toEqual([6]);
  });

  it("survives CRLF line endings", () => {
    const d = "--- a/x.php\r\n+++ b/x.php\r\n@@ -1,1 +1,2 @@\r\n a\r\n+b\r\n";
    expect([...addedLineNumbers(d).added.get("x.php")!]).toEqual([2]);
  });

  it("ignores the +++ header, which also starts with a plus", () => {
    // The classic off-by-one in every hand-rolled diff parser.
    const m = addedLineNumbers(DIFF).added;
    expect(m.has("b/includes/a.php")).toBe(false);
    expect([...m.get("includes/a.php")!]).not.toContain(1);
  });

  it("FIX1: a content line whose own text begins with ++ is NOT mistaken for a file header", () => {
    // The added line's content is "++ b content" -- prefixed with the unified-diff
    // "+" marker it becomes "+++ b content" on the wire, textually indistinguishable
    // from a `+++ b/<path>` file header. Only trusting the hunk header's line counts
    // (not sniffing the body for header-shaped text) tells them apart.
    const d = ["--- a/x.php", "+++ b/x.php", "@@ -1,1 +1,2 @@", " a", "+++ b content"].join("\n");
    const m = addedLineNumbers(d).added;
    // currentPath must still be "x.php" -- not corrupted to "b content" or similar.
    expect([...m.get("x.php")!]).toEqual([2]);
  });

  it("FIX2: an unrecognized @@ hunk header (e.g. a combined/merge-diff @@@ header) THROWS naming the line", () => {
    const d = ["--- a/x.php", "+++ b/x.php", "@@@ -1,2 -1,2 +1,3 @@@", " a", "+b", " c"].join("\n");
    expect(() => addedLineNumbers(d)).toThrow(/@@@ -1,2 -1,2 \+1,3 @@@/);
  });

  it("FIX3: reports a brand-new file (--- /dev/null) in newFiles", () => {
    const d = `--- /dev/null
+++ b/new.php
@@ -0,0 +1,3 @@
+one
+two
+three
`;
    const { newFiles } = addedLineNumbers(d);
    expect(newFiles.has("new.php")).toBe(true);
  });

  it("FIX3: an existing (non-new) file is absent from newFiles", () => {
    const { newFiles } = addedLineNumbers(DIFF);
    expect(newFiles.has("includes/a.php")).toBe(false);
  });

  it("R2-FIX1: THROWS when a hunk ends still owing body lines (truncated diff)", () => {
    // The header declares 3 added lines but only 1 is delivered -- a killed
    // `git diff` or a clipped buffer. The overflow guard (trap #3 above) only
    // catches TOO MANY lines; without a symmetric underflow guard, lines 2 and
    // 3 are simply never recorded and a finding on either is silently dropped.
    const d = ["--- /dev/null", "+++ b/x.php", "@@ -0,0 +1,3 @@", "+one"].join("\n");
    expect(() => addedLineNumbers(d)).toThrow(/x\.php/);
  });

  it("R2-FIX1: THROWS naming how many lines were still owed", () => {
    const d = ["--- /dev/null", "+++ b/x.php", "@@ -0,0 +1,3 @@", "+one"].join("\n");
    expect(() => addedLineNumbers(d)).toThrow(/2/);
  });

  it("R2-FIX1: a hunk that is fully satisfied does NOT throw at end of input", () => {
    const d = ["--- /dev/null", "+++ b/x.php", "@@ -0,0 +1,1 @@", "+one"].join("\n");
    expect(() => addedLineNumbers(d)).not.toThrow();
  });

  it("R2-FIX1: an underflow in a NON-final hunk (followed by another file) is also caught", () => {
    // The shortfall must be detected the moment a new hunk/file header or EOF
    // closes out the still-owing hunk -- not only at true end-of-input.
    const d = [
      "--- /dev/null",
      "+++ b/x.php",
      "@@ -0,0 +1,3 @@",
      "+one",
      "--- a/y.php",
      "+++ b/y.php",
      "@@ -1,1 +1,1 @@",
      " a",
    ].join("\n");
    expect(() => addedLineNumbers(d)).toThrow(/x\.php/);
  });

  it("R2-FIX2: a git copy (copy from/copy to, old side NOT /dev/null) is recorded in newFiles", () => {
    const d = [
      "diff --git a/src.php b/copy.php",
      "copy from src.php",
      "copy to copy.php",
      "--- a/src.php",
      "+++ b/copy.php",
      "@@ -1,1 +1,2 @@",
      " a",
      "+b",
    ].join("\n");
    const { newFiles } = addedLineNumbers(d);
    expect(newFiles.has("copy.php")).toBe(true);
  });

  it("R2-FIX2: a git rename (rename from/rename to) is NOT treated as a new file", () => {
    // Content moved, not created -- its file-level findings are pre-existing.
    const d = [
      "diff --git a/old.php b/renamed.php",
      "rename from old.php",
      "rename to renamed.php",
      "--- a/old.php",
      "+++ b/renamed.php",
      "@@ -1,1 +1,2 @@",
      " a",
      "+b",
    ].join("\n");
    const { newFiles } = addedLineNumbers(d);
    expect(newFiles.has("renamed.php")).toBe(false);
  });

  it("R2-FIX2: 'new file mode' extended header also marks a file new", () => {
    const d = [
      "diff --git a/new.php b/new.php",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.php",
      "@@ -0,0 +1,1 @@",
      "+one",
    ].join("\n");
    const { newFiles } = addedLineNumbers(d);
    expect(newFiles.has("new.php")).toBe(true);
  });
});

describe("R3-FIX1: git C-style quoted paths are unquoted before being used as map keys", () => {
  it("a +++ header quoting a path (brief's literal example: a space-containing path) is unquoted before the a//b/ prefix strip and the map key", () => {
    // Per the FIX brief's own literal example. (Empirically, real git on this
    // machine does NOT quote a path for a plain ASCII space alone -- only for
    // non-ASCII/control characters, confirmed separately below -- but the
    // decoder must handle whatever C-quoted form it is given, regardless of
    // which condition triggered the quoting.)
    const d = ['--- "a/path with spaces.php"', '+++ "b/path with spaces.php"', "@@ -1,1 +1,2 @@", " a", "+b"].join(
      "\n",
    );
    const m = addedLineNumbers(d).added;
    expect(m.has('"b/path with spaces.php"')).toBe(false);
    expect(m.has("b/path with spaces.php")).toBe(false);
    expect([...m.get("path with spaces.php")!]).toEqual([2]);
  });

  it("a +++ header quoting a NON-ASCII path with git's real octal-byte escapes decodes to the correct UTF-8 filename", () => {
    // Captured verbatim from a real `git diff` run against a file named
    // "файл.php" (Cyrillic) on this machine: `+++ "b/\321\204\320\260\320\271\320\273.php"`.
    // Each \NNN is a 3-digit OCTAL escape naming one raw UTF-8 byte -- decoding
    // must regroup the byte sequence and interpret it as UTF-8, not decode each
    // escape as an independent character.
    const d = [
      "--- /dev/null",
      '+++ "b/\\321\\204\\320\\260\\320\\271\\320\\273.php"',
      "@@ -0,0 +1,1 @@",
      "+one",
    ].join("\n");
    const { added, newFiles } = addedLineNumbers(d);
    expect([...added.get("файл.php")!]).toEqual([1]);
    expect(newFiles.has("файл.php")).toBe(true);
  });

  it("an unquoted plain path (the overwhelmingly common case) is completely unaffected by the new quote-decoding logic", () => {
    const m = addedLineNumbers(DIFF).added;
    expect([...m.get("includes/a.php")!]).toEqual([13]);
  });
});

describe("R3-FIX2: a binary/copy new file with no +++ line still reaches newFiles", () => {
  it("a git COPY's binary destination (copy to, no +++ line at all) is recorded in newFiles from the 'copy to' header directly", () => {
    // Real shape of a binary copy: no --- /+++ pair, no hunk -- just
    // "Binary files ... differ". The OLD code only ever populated newFiles
    // inside the +++ branch, so a binary copy's destination never reached it.
    const d = [
      "diff --git a/src.png b/copy.png",
      "similarity index 100%",
      "copy from src.png",
      "copy to copy.png",
      "Binary files a/src.png and b/copy.png differ",
    ].join("\n");
    const { newFiles } = addedLineNumbers(d);
    expect(newFiles.has("copy.png")).toBe(true);
  });

  it("a genuinely NEW binary file (new file mode, no +++ line at all) is recorded in newFiles from the diff --git line's new-side path", () => {
    // Real shape of a binary addition: `new file mode` is present, but there
    // is no --- /+++ pair and no hunk -- git prints "Binary files /dev/null
    // and b/x.png differ" instead. sawNewFileSignal alone never turns into a
    // newFiles entry because nothing ever reaches the +++ branch that
    // consumes it.
    const d = [
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "index 0000000..1111111",
      "Binary files /dev/null and b/logo.png differ",
    ].join("\n");
    const { newFiles } = addedLineNumbers(d);
    expect(newFiles.has("logo.png")).toBe(true);
  });

  it("a genuinely NEW binary file whose path needs C-style quoting (non-ASCII) is still recorded, via the quoted diff --git line", () => {
    // Captured verbatim from a real `git diff` run against a new binary file
    // named "картинка.png" (Cyrillic): both the old and new tokens on the
    // `diff --git` line are independently quoted (and, for a brand-new file,
    // always identical once decoded -- there is no rename involved).
    const d = [
      'diff --git "a/\\320\\272\\320\\260\\321\\200\\321\\202\\320\\270\\320\\275\\320\\272\\320\\260.png" "b/\\320\\272\\320\\260\\321\\200\\321\\202\\320\\270\\320\\275\\320\\272\\320\\260.png"',
      "new file mode 100644",
      "index 0000000..0c62808",
      'Binary files /dev/null and "b/\\320\\272\\320\\260\\321\\200\\321\\202\\320\\270\\320\\275\\320\\272\\320\\260.png" differ',
    ].join("\n");
    const { newFiles } = addedLineNumbers(d);
    expect(newFiles.has("картинка.png")).toBe(true);
  });

  it("does NOT invent a newFiles entry for a plain rename (old != new, and rename never carries 'new file mode')", () => {
    const d = ["diff --git a/old.php b/renamed.php", "rename from old.php", "rename to renamed.php"].join("\n");
    const { newFiles } = addedLineNumbers(d);
    expect(newFiles.size).toBe(0);
  });
});

describe("R4-FIX1: an unterminated or malformed C-quoted path THROWS rather than being accepted as literal", () => {
  it("a +++ header quoting a path with NO closing quote at all (truncated diff) throws", () => {
    const d = ['--- a/x.php', '+++ "b/x.php', "@@ -1,1 +1,2 @@", " a", "+b"].join("\n");
    expect(() => addedLineNumbers(d)).toThrow(/unterminated|quot/i);
  });

  it("a path whose apparent trailing quote is itself ESCAPED (\\\") is not a real terminator -- throws", () => {
    // `"b/x\"` -- the last two characters are the escape sequence for a
    // literal quote, not a closing delimiter, so there is in fact no real
    // terminator anywhere in this token.
    const d = ['--- a/x.php', '+++ "b/x\\"', "@@ -1,1 +1,2 @@", " a", "+b"].join("\n");
    expect(() => addedLineNumbers(d)).toThrow(/unterminated|quot/i);
  });

  it("a path legitimately ending in an escaped backslash IS properly terminated and still decodes", () => {
    // `"b/x\\"` -- content is `x` followed by one escaped backslash, then the
    // REAL closing quote. This is the boundary the critic checked and found
    // correct: it must NOT be treated as unterminated.
    const d = ['--- /dev/null', '+++ "b/x\\\\"', "@@ -0,0 +1,1 @@", "+one"].join("\n");
    const { added } = addedLineNumbers(d);
    expect([...added.get("x\\")!]).toEqual([1]);
  });

  it("a truncated octal escape at the very end of a quoted path (only 2 of 3 digits) throws", () => {
    // `"b/x\12"` -- \12 is short one digit; git never emits a non-3-digit
    // octal escape, so this can only be a truncated/corrupt diff. The OLD
    // decoder fell back to keeping "\12" as literal text, silently producing
    // the wrong key.
    const d = ['--- a/x.php', '+++ "b/x\\12"', "@@ -1,1 +1,2 @@", " a", "+b"].join("\n");
    expect(() => addedLineNumbers(d)).toThrow(/octal|truncat/i);
  });
});

describe("R4-FIX2: invalid UTF-8 inside a quoted path THROWS rather than becoming U+FFFD", () => {
  it("a lone continuation byte (\\200) decodes to invalid UTF-8 and throws, instead of silently becoming the replacement character", () => {
    const d = ['--- a/x.php', '+++ "b/x\\200.php"', "@@ -1,1 +1,2 @@", " a", "+b"].join("\n");
    expect(() => addedLineNumbers(d)).toThrow(/utf-8|invalid/i);
  });
});

describe("R4-FIX3: a malformed hunk body line THROWS instead of being silently consumed as context", () => {
  it("a stray line with no +/-/space/backslash prefix while the hunk still owes lines throws, naming the line", () => {
    const d = ["--- a/x.php", "+++ b/x.php", "@@ -1,2 +1,2 @@", " a", "xyz malformed"].join("\n");
    expect(() => addedLineNumbers(d)).toThrow(/xyz malformed/);
  });

  it("a genuinely blank (empty-string) context line is STILL accepted, not treated as malformed", () => {
    const d = ["--- a/x.php", "+++ b/x.php", "@@ -1,2 +1,2 @@", "", " b"].join("\n");
    expect(() => addedLineNumbers(d)).not.toThrow();
    expect(addedLineNumbers(d).added.get("x.php") ?? new Set()).toEqual(new Set());
  });
});

describe("new-file signals do not leak across file sections", () => {
  it("a binary new file with no hunk body does not mark the NEXT file as new", () => {
    // The signal is normally consumed by the next `+++` header, but a binary
    // addition never has a hunk body -- so without a reset at the `diff --git`
    // boundary the flag survives and marks an ordinary modified file as new,
    // misattributing that file's pre-existing file-level findings to the worker.
    const d = [
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "index 0000000..1111111",
      "Binary files /dev/null and b/logo.png differ",
      "diff --git a/existing.php b/existing.php",
      "index 222..333 100644",
      "--- a/existing.php",
      "+++ b/existing.php",
      "@@ -1,1 +1,2 @@",
      " a",
      "+b",
      "",
    ].join(String.fromCharCode(10));
    const r = addedLineNumbers(d);
    expect([...r.added.get("existing.php")!]).toEqual([2]);
    expect(r.newFiles.has("existing.php")).toBe(false);
  });
});

describe("R5-FIX3: an empty quoted path is refused", () => {
  it("throws rather than seeding the map with an empty key that can never match", () => {
    const d = ["--- /dev/null", '+++ ""', "@@ -0,0 +1,1 @@", "+one", ""].join(String.fromCharCode(10));
    expect(() => addedLineNumbers(d)).toThrow(/empty quoted path/i);
  });
});

describe("R6-FIX4: a diff truncated right after a hunk header is caught", () => {
  it("throws instead of letting the split artifact discharge the hunk", () => {
    const d = ["diff --git a/x.php b/x.php", "--- a/x.php", "+++ b/x.php", "@@ -1,1 +1,1 @@", ""].join(
      String.fromCharCode(10),
    );
    expect(() => addedLineNumbers(d)).toThrow(/still owe|truncated|malformed/i);
  });

  it("a genuinely blank final context line is still accepted", () => {
    const d = ["--- a/x.php", "+++ b/x.php", "@@ -1,2 +1,3 @@", " a", "+b", "", ""].join(
      String.fromCharCode(10),
    );
    expect([...addedLineNumbers(d).added.get("x.php")!]).toEqual([2]);
  });
});
