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
