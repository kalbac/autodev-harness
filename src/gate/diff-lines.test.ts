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
    const m = addedLineNumbers(DIFF);
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
    expect([...addedLineNumbers(d).get("x.php")!]).toEqual([2, 22]);
  });

  it("treats a brand-new file as entirely added", () => {
    const d = `--- /dev/null
+++ b/new.php
@@ -0,0 +1,3 @@
+one
+two
+three
`;
    expect([...addedLineNumbers(d).get("new.php")!]).toEqual([1, 2, 3]);
  });

  it("a deletion-only hunk adds nothing and does not shift the cursor", () => {
    const d = `--- a/x.php
+++ b/x.php
@@ -1,3 +1,2 @@
 a
-b
 c
`;
    expect(addedLineNumbers(d).get("x.php") ?? new Set()).toEqual(new Set());
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
    const m = addedLineNumbers(d);
    expect([...m.get("x.php")!]).toEqual([2]);
    expect([...m.get("y.php")!]).toEqual([6]);
  });

  it("survives CRLF line endings", () => {
    const d = "--- a/x.php\r\n+++ b/x.php\r\n@@ -1,1 +1,2 @@\r\n a\r\n+b\r\n";
    expect([...addedLineNumbers(d).get("x.php")!]).toEqual([2]);
  });

  it("ignores the +++ header, which also starts with a plus", () => {
    // The classic off-by-one in every hand-rolled diff parser.
    const m = addedLineNumbers(DIFF);
    expect(m.has("b/includes/a.php")).toBe(false);
    expect([...m.get("includes/a.php")!]).not.toContain(1);
  });
});
