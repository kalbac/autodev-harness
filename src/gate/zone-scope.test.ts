import { describe, it, expect } from "vitest";
import { attributeDiffLines, excludeDeclaredDocs, zoneScopedLines, isDeclaredDoc, diffPaths } from "./zone-scope.js";
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

/** A rename OUT of the zone into a declared documentation path, removing a contract
 *  value on the way -- the shape the R1 review gate used to break post-image-only
 *  attribution. `git diff` reports it as one section whose two sides differ. */
const RENAME_DIFF = [
  "diff --git a/includes/class-test-shipping-method-pickup.php b/docs/OVERVIEW.md",
  "similarity index 60%",
  "rename from includes/class-test-shipping-method-pickup.php",
  "rename to docs/OVERVIEW.md",
  "--- a/includes/class-test-shipping-method-pickup.php",
  "+++ b/docs/OVERVIEW.md",
  "@@ -10,1 +10,1 @@",
  "-        $this->id = 'test_pickup';",
  "+The plugin used to register test_pickup.",
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
      { files: ["includes/class-test-shipping-method-pickup.php"], lines: ["+$this->title = 'Pickup';"] },
      { files: ["docs/OVERVIEW.md"], lines: ["+The plugin registers test_pickup and test_courier."] },
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
    expect(attributeDiffLines(truncated, flat)).toEqual([{ files: [], lines: flat }]);
  });

  it("attributes a DELETED file's lines to its pre-image path, not to nothing", () => {
    // R1 review finding: a deletion's new side is `+++ /dev/null`, so a
    // post-image-only reading loses the very path whose contract changed.
    const deletion = [
      "diff --git a/includes/class-test-shipping-method-pickup.php b/includes/class-test-shipping-method-pickup.php",
      "--- a/includes/class-test-shipping-method-pickup.php",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-        $this->id = 'test_pickup';",
    ].join("\n");
    const byFile = attributeDiffLines(deletion, diffAddedRemovedLines(deletion));
    expect(byFile).toEqual([
      {
        files: ["includes/class-test-shipping-method-pickup.php"],
        lines: ["-        $this->id = 'test_pickup';"],
      },
    ]);
    expect(diffPaths(byFile)).toEqual(["includes/class-test-shipping-method-pickup.php"]);
  });

  it("attributes a RENAME to BOTH paths, pre-image first", () => {
    // R1 review finding: the removed lines belong to the OLD file. Attributing
    // them to the new path alone lets `git mv` carry a contract value out of the
    // zone that governs it.
    const byFile = attributeDiffLines(RENAME_DIFF, diffAddedRemovedLines(RENAME_DIFF));
    expect(byFile).toEqual([
      {
        files: ["includes/class-test-shipping-method-pickup.php", "docs/OVERVIEW.md"],
        lines: ["-        $this->id = 'test_pickup';", "+The plugin used to register test_pickup."],
      },
    ]);
  });

  it("a section with neither header known is attributed to no path at all", () => {
    const byFile = [{ files: [], lines: ["+orphan line"] }];
    expect(diffPaths(byFile)).toEqual([]);
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
      { files: ["docs/OVERVIEW.md"], lines: ["+mentions test_pickup"] },
      { files: [], lines: ["-removed test_courier"] },
    ];
    expect(zoneScopedLines(zone(), byFile)).toEqual(["-removed test_courier"]);
  });

  it("a rename OUT of the zone stays in the zone's scope (ANY path matches, not the post-image one)", () => {
    // R1 review finding: the zone globs the OLD path only, and the removal of its
    // contract value lives on the OLD side. Scoping by post-image alone hides it.
    const byFile = attributeDiffLines(RENAME_DIFF, diffAddedRemovedLines(RENAME_DIFF));
    expect(zoneScopedLines(zone(), byFile)).toEqual([
      "-        $this->id = 'test_pickup';",
      "+The plugin used to register test_pickup.",
    ]);
  });
});

describe("excludeDeclaredDocs -- #140 (b): a declared doc path is outside zone checking", () => {
  it("drops the lines of a file matched by contract.docPaths", () => {
    const byFile = attributeDiffLines(TWO_FILE_DIFF, diffAddedRemovedLines(TWO_FILE_DIFF));
    expect(excludeDeclaredDocs(byFile, ["docs/**", "README.md"])).toEqual([
      { files: ["includes/class-test-shipping-method-pickup.php"], lines: ["+$this->title = 'Pickup';"] },
    ]);
  });

  it("changes nothing when the project declares no doc paths (the shipped default)", () => {
    const byFile = attributeDiffLines(TWO_FILE_DIFF, diffAddedRemovedLines(TWO_FILE_DIFF));
    expect(excludeDeclaredDocs(byFile, [])).toEqual(byFile);
  });

  it("does NOT exempt a rename out of the zone into a declared doc path (EVERY path must be declared)", () => {
    // R1 review finding, the sharper half: taking the union here would make
    // `git mv includes/class-x.php docs/x.md` a way to carry contract values out
    // of their zone -- one declared path would buy the whole section an exemption.
    const byFile = attributeDiffLines(RENAME_DIFF, diffAddedRemovedLines(RENAME_DIFF));
    expect(excludeDeclaredDocs(byFile, ["docs/**"])).toEqual(byFile);
  });

  it("never exempts a section with no known path -- an exemption must be earned by a declaration", () => {
    const byFile = [{ files: [], lines: ["-removed test_pickup"] }];
    expect(excludeDeclaredDocs(byFile, ["docs/**", "**"])).toEqual(byFile);
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
