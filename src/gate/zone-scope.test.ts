import { describe, it, expect } from "vitest";
import { attributeDiffLines, excludeDeclaredDocs, zoneScopedLines, isDeclaredDoc } from "./zone-scope.js";
import type { ContractZone } from "./invariants.js";
import { diffAddedRemovedLines } from "./invariants.js";

function zone(over: Partial<ContractZone> = {}): ContractZone {
  return {
    id: "shipping-method-ids",
    why: "persisted shipping-method ids",
    auto_guardable: true,
    path_globs: ["includes/class-test-shipping-method-*.php"],
    grep_patterns: [],
    exact_strings: ["test_pickup", "test_courier"],
    ...over,
  };
}

/** A two-file diff: one PHP file under the zone's globs, one doc file outside them. */
const TWO_FILE_DIFF = [
  "diff --git a/includes/class-test-shipping-method-pickup.php b/includes/class-test-shipping-method-pickup.php",
  "--- a/includes/class-test-shipping-method-pickup.php",
  "+++ b/includes/class-test-shipping-method-pickup.php",
  "@@ -10,1 +10,2 @@",
  " $this->id = 'test_pickup';",
  "+$this->title = 'Pickup';",
  "diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md",
  "--- a/docs/OVERVIEW.md",
  "+++ b/docs/OVERVIEW.md",
  "@@ -3,0 +4,1 @@",
  "+The plugin registers test_pickup and test_courier.",
].join("\n");

/** The #140 shape exactly: the ONLY changed file is a doc that MENTIONS the values. */
const DOCS_ONLY_DIFF = [
  "diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md",
  "--- a/docs/OVERVIEW.md",
  "+++ b/docs/OVERVIEW.md",
  "@@ -3,0 +4,1 @@",
  "+The plugin registers test_pickup and test_courier.",
].join("\n");

describe("attributeDiffLines", () => {
  it("attributes each +/- content line to the file it came from", () => {
    const byFile = attributeDiffLines(TWO_FILE_DIFF, diffAddedRemovedLines(TWO_FILE_DIFF));
    expect(byFile).toEqual([
      { file: "includes/class-test-shipping-method-pickup.php", lines: ["+$this->title = 'Pickup';"] },
      { file: "docs/OVERVIEW.md", lines: ["+The plugin registers test_pickup and test_courier."] },
    ]);
  });

  it("never drops a line: every line the flat reader sees is still present somewhere", () => {
    // The two readings must not disagree about CONTENT, only about attribution --
    // a line that vanished in attribution would be a value the zone scan stops
    // seeing, which is a silent weakening of the gate.
    const flat = diffAddedRemovedLines(TWO_FILE_DIFF);
    const attributed = attributeDiffLines(TWO_FILE_DIFF, flat).flatMap((e) => e.lines);
    for (const l of flat) {
      expect(attributed).toContain(l);
    }
  });

  it("falls back to ONE unattributed bucket when the diff cannot be walked (fail closed)", () => {
    // Truncated mid-hunk: the strict walker throws. Scoping must then behave
    // exactly as it did before #140 -- every line in scope for every zone --
    // rather than propagating a new crash path into the gate (Principle 10).
    const truncated = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,4 +1,4 @@", "+only one line"].join("\n");
    const flat = diffAddedRemovedLines(truncated);
    expect(attributeDiffLines(truncated, flat)).toEqual([{ file: null, lines: flat }]);
  });

  it("leaves a deleted file's lines unattributed, so they stay in scope for every zone", () => {
    // A deletion's new side is `+++ /dev/null`, so there is no post-image path to
    // attribute to. Removing a documented contract value is exactly the shape
    // adr/007 refuses leniency for, so `null` (always in scope) is the right answer.
    const deletion = [
      "diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md",
      "--- a/docs/OVERVIEW.md",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-The plugin registers test_pickup.",
    ].join("\n");
    const byFile = attributeDiffLines(deletion, diffAddedRemovedLines(deletion));
    expect(byFile).toEqual([{ file: null, lines: ["-The plugin registers test_pickup."] }]);
  });
});

describe("zoneScopedLines -- #140 (a): path_globs is the SCOPE, not an OR-arm", () => {
  it("gives a globbed zone only the lines from files its globs match", () => {
    const byFile = attributeDiffLines(TWO_FILE_DIFF, diffAddedRemovedLines(TWO_FILE_DIFF));
    expect(zoneScopedLines(zone(), byFile)).toEqual(["+$this->title = 'Pickup';"]);
  });

  it("gives a globbed zone NOTHING when the diff touches only files outside its globs", () => {
    // This is #140 itself: documenting a contract value is not touching it.
    const byFile = attributeDiffLines(DOCS_ONLY_DIFF, diffAddedRemovedLines(DOCS_ONLY_DIFF));
    expect(zoneScopedLines(zone(), byFile)).toEqual([]);
  });

  it("gives a zone with NO path_globs every line -- unchanged, whole-diff semantics", () => {
    // A zone that declares no scope has not told the harness where its contract
    // lives, so the string scan stays repository-wide exactly as before.
    const byFile = attributeDiffLines(DOCS_ONLY_DIFF, diffAddedRemovedLines(DOCS_ONLY_DIFF));
    expect(zoneScopedLines(zone({ path_globs: [] }), byFile)).toEqual([
      "+The plugin registers test_pickup and test_courier.",
    ]);
  });

  it("keeps unattributed lines in scope for a globbed zone (fail closed)", () => {
    const byFile = [
      { file: "docs/OVERVIEW.md", lines: ["+mentions test_pickup"] },
      { file: null, lines: ["-removed test_courier"] },
    ];
    expect(zoneScopedLines(zone(), byFile)).toEqual(["-removed test_courier"]);
  });
});

describe("excludeDeclaredDocs -- #140 (b): a declared doc path is outside zone checking", () => {
  it("drops the lines of a file matched by contract.docPaths", () => {
    const byFile = attributeDiffLines(TWO_FILE_DIFF, diffAddedRemovedLines(TWO_FILE_DIFF));
    expect(excludeDeclaredDocs(byFile, ["docs/**", "README.md"])).toEqual([
      { file: "includes/class-test-shipping-method-pickup.php", lines: ["+$this->title = 'Pickup';"] },
    ]);
  });

  it("changes nothing when the project declares no doc paths (the shipped default)", () => {
    const byFile = attributeDiffLines(TWO_FILE_DIFF, diffAddedRemovedLines(TWO_FILE_DIFF));
    expect(excludeDeclaredDocs(byFile, [])).toEqual(byFile);
  });

  it("keeps unattributed lines -- a declared doc's DELETION is not exempt (adr/007 parity)", () => {
    const byFile = [{ file: null, lines: ["-The plugin registers test_pickup."] }];
    expect(excludeDeclaredDocs(byFile, ["docs/**"])).toEqual(byFile);
  });
});

describe("isDeclaredDoc", () => {
  it("matches a declared glob and a declared literal", () => {
    expect(isDeclaredDoc("docs/OVERVIEW.md", ["docs/**", "README.md"])).toBe(true);
    expect(isDeclaredDoc("README.md", ["docs/**", "README.md"])).toBe(true);
  });

  it("does not match a path outside the declaration", () => {
    expect(isDeclaredDoc("includes/class-foo.php", ["docs/**", "README.md"])).toBe(false);
  });

  it("declares nothing when the list is empty", () => {
    expect(isDeclaredDoc("docs/OVERVIEW.md", [])).toBe(false);
  });

  it("refuses a traversing or anchored path instead of normalizing it (adr/007 parity)", () => {
    // `globMatch` is textual, so `docs/**` would otherwise match
    // `docs/../includes/class-foo.php` and hand a code file the docs exemption.
    expect(isDeclaredDoc("docs/../includes/class-foo.php", ["docs/**"])).toBe(false);
    expect(isDeclaredDoc("/docs/OVERVIEW.md", ["docs/**", "/docs/**"])).toBe(false);
    expect(isDeclaredDoc("C:/docs/OVERVIEW.md", ["**"])).toBe(false);
  });
});
