import { describe, it, expect } from "vitest";
import {
  attributeDiffLines,
  excludeDeclaredDocs,
  zoneScopedLines,
  isDeclaredDoc,
  scanDiffPaths,
  unionDiffNamedPaths,
} from "./zone-scope.js";
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


/** Truncated mid-hunk: the strict walker throws on it. Shared, because three tests
 *  now assert three DIFFERENT fallbacks for the same unreadable input. */
const TRUNCATED_DIFF = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,4 +1,4 @@", "+only one line"].join("\n");

/** A 100%-similarity rename OUT of the zone: no `---`/`+++` pair, no hunk, no line to
 *  scan -- and `git diff --name-only` names only the destination (R3 finding). */
const PURE_RENAME_DIFF = [
  "diff --git a/includes/class-test-shipping-method-pickup.php b/docs/OVERVIEW.md",
  "similarity index 100%",
  "rename from includes/class-test-shipping-method-pickup.php",
  "rename to docs/OVERVIEW.md",
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
    const flat = diffAddedRemovedLines(TRUNCATED_DIFF);
    expect(attributeDiffLines(TRUNCATED_DIFF, flat)).toEqual([{ files: [], lines: flat }]);
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
    expect(namedPaths(deletion)).toEqual(["includes/class-test-shipping-method-pickup.php"]);
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

});

/** The paths, or a hard failure if the walk refused the diff. Every assertion below
 *  states which of the two it expects -- an empty list and "unreadable" are different
 *  answers, and conflating them is exactly the defect R3 found. */
function namedPaths(diffText: string): string[] {
  const scan = scanDiffPaths(diffText);
  if (!scan.readable) throw new Error("expected a readable diff");
  return scan.paths;
}

describe("scanDiffPaths -- the touched-file list, read off the diff headers (R2/R3 findings)", () => {
  // The gate derives its file list from `git diff --name-only`; this one has only
  // the diff text. Every shape below names a file while producing NO `+`/`-` line,
  // so a list read off the attributed content buckets reports it untouched and the
  // two layers then disagree about the same diff (invariant 9).

  it("sees a 100%-similarity rename, which has no hunk at all", () => {
    expect(namedPaths(PURE_RENAME_DIFF)).toEqual(["includes/class-test-shipping-method-pickup.php", "docs/OVERVIEW.md"]);
  });

  it("sees a mode-only change, which stops after the `diff --git` header", () => {
    const modeOnly = [
      "diff --git a/includes/class-test-shipping-method-pickup.php b/includes/class-test-shipping-method-pickup.php",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    expect(namedPaths(modeOnly)).toEqual(["includes/class-test-shipping-method-pickup.php"]);
  });

  it("sees a binary change, which has no hunk body either", () => {
    const binary = [
      "diff --git a/includes/logo.png b/includes/logo.png",
      "index 1a2b3c4..5d6e7f8 100644",
      "Binary files a/includes/logo.png and b/includes/logo.png differ",
    ].join("\n");
    expect(namedPaths(binary)).toEqual(["includes/logo.png"]);
  });

  it("sees a binary DELETION by its pre-image path", () => {
    const binaryDeletion = [
      "diff --git a/includes/logo.png b/includes/logo.png",
      "deleted file mode 100644",
      "index 1a2b3c4..0000000",
      "Binary files a/includes/logo.png and /dev/null differ",
    ].join("\n");
    expect(namedPaths(binaryDeletion)).toEqual(["includes/logo.png"]);
  });

  it("sees a copy DESTINATION, which is the only side a copy changes", () => {
    const copy = [
      "diff --git a/includes/class-test-shipping-method-pickup.php b/includes/class-copy.php",
      "similarity index 100%",
      "copy from includes/class-test-shipping-method-pickup.php",
      "copy to includes/class-copy.php",
    ].join("\n");
    expect(namedPaths(copy)).toEqual(["includes/class-copy.php"]);
  });

  it("still sees an ordinary text diff, both sides of every section", () => {
    expect(namedPaths(TWO_FILE_DIFF)).toEqual(["includes/class-test-shipping-method-pickup.php", "docs/OVERVIEW.md"]);
    expect(namedPaths(RENAME_DIFF)).toEqual(["includes/class-test-shipping-method-pickup.php", "docs/OVERVIEW.md"]);
  });

  it("reports a diff it cannot parse as UNREADABLE, never as an empty path list", () => {
    // R3 review finding. `[]` would mean "this diff names no files", and the caller
    // would then drop the path arm of the zone check entirely while the gate still
    // has git's list -- two answers to one question. `readable: false` forces every
    // caller to state what it does when there is no answer.
    expect(scanDiffPaths(TRUNCATED_DIFF)).toEqual({ readable: false });
  });

  it("distinguishes UNREADABLE from a diff that genuinely names nothing", () => {
    expect(scanDiffPaths("")).toEqual({ readable: true, paths: [] });
  });
});

describe("scanDiffPaths -- what is NOT touched, and what is not an answer (R4 findings)", () => {
  it("does NOT report a copy's SOURCE as touched -- the diff leaves it unchanged", () => {
    // R4 review finding. A rename's pre-image IS touched (the file stops existing
    // there), which is why R1 added it. A COPY's is not: `git diff --name-only`
    // names only the destination, and nothing moved out of the source's zone.
    // Reporting it would demand a mutation-verified guard for a file nobody
    // edited -- #140's complaint, one shape over.
    const copy = [
      "diff --git a/includes/class-test-shipping-method-pickup.php b/docs/contract.md",
      "similarity index 100%",
      "copy from includes/class-test-shipping-method-pickup.php",
      "copy to docs/contract.md",
    ].join("\n");
    expect(namedPaths(copy)).toEqual(["docs/contract.md"]);
  });

  it("does not attribute a modified copy's lines to the source file either", () => {
    const copyWithEdits = [
      "diff --git a/includes/class-test-shipping-method-pickup.php b/docs/contract.md",
      "similarity index 80%",
      "copy from includes/class-test-shipping-method-pickup.php",
      "copy to docs/contract.md",
      "--- a/includes/class-test-shipping-method-pickup.php",
      "+++ b/docs/contract.md",
      "@@ -10,1 +10,1 @@",
      "-        $this->id = 'test_pickup';",
      "+The plugin registers test_pickup.",
    ].join("\n");
    const byFile = attributeDiffLines(copyWithEdits, diffAddedRemovedLines(copyWithEdits));
    expect(byFile.map((e) => e.files)).toEqual([["docs/contract.md"]]);
    expect(namedPaths(copyWithEdits)).toEqual(["docs/contract.md"]);
  });

  it("a RENAME's source is still touched -- the copy rule must not weaken that", () => {
    expect(namedPaths(PURE_RENAME_DIFF)).toEqual([
      "includes/class-test-shipping-method-pickup.php",
      "docs/OVERVIEW.md",
    ]);
  });

  it("reports a headerless hunk as UNREADABLE, not as a diff that names no files", () => {
    // R4 review finding: this parses without error (the hunk's counts are
    // consistent), so it used to yield `readable: true, paths: []` -- which the
    // conductor read as "touches nothing" while the gate still had git's list.
    const headerless = ["@@ -1,0 +1,1 @@", "+unrelated"].join("\n");
    expect(scanDiffPaths(headerless)).toEqual({ readable: false });
  });

  it("reports an EMPTY headerless hunk as unreadable too (R6 review finding)", () => {
    // `@@ -1,0 +1,0 @@` records no content line at all, so a flag set only when a
    // line is attributed never fires -- and `paths: []` then reads as a confident
    // "this diff names no files" while the gate still has git's list.
    expect(scanDiffPaths("@@ -1,0 +1,0 @@")).toEqual({ readable: false });
  });

  it("the gate keeps git's list for that same headerless hunk", () => {
    const headerless = ["@@ -1,0 +1,1 @@", "+unrelated"].join("\n");
    expect(unionDiffNamedPaths(["includes/class-test-shipping-method-pickup.php"], headerless)).toEqual([
      "includes/class-test-shipping-method-pickup.php",
    ]);
  });
});

describe("unionDiffNamedPaths -- the gate's file list (R3 review finding)", () => {
  it("adds the PRE-image path git's --name-only omits for a rename", () => {
    // `git diff --name-only` reports POST-IMAGE paths, so for this diff it reports
    // the destination alone. Without the union, the zone globbing the SOURCE sees no
    // changed file and no lines either (the section has no hunk), so the gate calls
    // it untouched while the conductor calls it touched -- invariant 9.
    expect(unionDiffNamedPaths(["docs/OVERVIEW.md"], PURE_RENAME_DIFF)).toEqual([
      "docs/OVERVIEW.md",
      "includes/class-test-shipping-method-pickup.php",
    ]);
  });

  it("adds nothing and drops nothing for an ordinary diff whose two lists already agree", () => {
    const gitList = ["includes/class-test-shipping-method-pickup.php", "docs/OVERVIEW.md"];
    expect(unionDiffNamedPaths(gitList, TWO_FILE_DIFF)).toEqual(gitList);
  });

  it("falls back to git's list ALONE when the diff cannot be walked -- never to nothing", () => {
    // The pre-adr/008 gate exactly: unreadable input never removes a file from the
    // check, and never turns a diff-shape problem into a gate crash either.
    expect(unionDiffNamedPaths(["includes/class-test-shipping-method-pickup.php"], TRUNCATED_DIFF)).toEqual([
      "includes/class-test-shipping-method-pickup.php",
    ]);
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
