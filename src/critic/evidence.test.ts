import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planEvidence,
  collectCriticEvidence,
  isDeclaredDocsOnlyChange,
  isAdditionsOnlyDiff,
  qualifiesForDocsNarrowing,
  summarizeEvidence,
  DEFAULT_EVIDENCE_LIMITS,
  MAX_EVIDENCE_BYTES_PER_FILE,
  MAX_EVIDENCE_BYTES_TOTAL,
  type EvidenceEntry,
} from "./evidence.js";

const sized = (path: string, bytes: number): EvidenceEntry => ({ path, kind: "sized", bytes });

describe("planEvidence (the single budget decision)", () => {
  it("plans every file that fits, in a stable path order", () => {
    const plan = planEvidence([sized("b.php", 2), sized("a.php", 1), sized("c.php", 3)]);
    expect(plan.read).toEqual([
      { path: "a.php", bytes: 1 },
      { path: "b.php", bytes: 2 },
      { path: "c.php", bytes: 3 },
    ]);
    expect(plan.omitted).toEqual([]);
  });

  it("OMITS an over-budget file whole -- it is never planned for a partial read", () => {
    const plan = planEvidence([sized("big.php", 100)], { perFileBytes: 10, totalBytes: 1000 });
    expect(plan.read).toEqual([]);
    expect(plan.omitted).toEqual([{ path: "big.php", reason: "too-large", bytes: 100 }]);
  });

  it("keeps scanning after a total-budget overflow, so a later small file still fits", () => {
    const plan = planEvidence([sized("a.php", 8), sized("b.php", 8), sized("c.php", 2)], {
      perFileBytes: 100,
      totalBytes: 10,
    });
    expect(plan.read.map((r) => r.path)).toEqual(["a.php", "c.php"]);
    expect(plan.omitted).toEqual([{ path: "b.php", reason: "budget-exhausted", bytes: 8 }]);
  });

  it("never plans more than the total budget, however many files are touched", () => {
    // The property that keeps the prompt bounded AND, since the plan is what gets
    // read, keeps memory bounded too (codex R1 finding 1: an earlier version read
    // everything first and budgeted afterwards).
    const many = Array.from({ length: 1000 }, (_, i) => sized(`f${String(i).padStart(4, "0")}.php`, 1000));
    const plan = planEvidence(many, { perFileBytes: 64000, totalBytes: 10000 });
    expect(plan.read).toHaveLength(10);
    expect(plan.read.reduce((n, r) => n + r.bytes, 0)).toBeLessThanOrEqual(10000);
    expect(plan.omitted).toHaveLength(990);
  });

  it("passes an already-decided omission through with its reason intact", () => {
    const plan = planEvidence([{ path: "gone.php", kind: "omit", reason: "absent", bytes: null }]);
    expect(plan.read).toEqual([]);
    expect(plan.omitted).toEqual([{ path: "gone.php", reason: "absent", bytes: null }]);
  });

  it("plans an EMPTY file rather than treating it as nothing", () => {
    // An empty file is real evidence ("this file is empty"), and `bytes: 0` must not
    // be confused with `bytes: null` ("size unknown").
    expect(planEvidence([sized("empty.php", 0)]).read).toEqual([{ path: "empty.php", bytes: 0 }]);
  });

  it("THROWS on a duplicate path instead of silently picking one version", () => {
    expect(() => planEvidence([sized("a.php", 1), sized("a.php", 2)])).toThrow(/duplicate path/);
  });

  it("ships budgets big enough for real source files and small enough to bound a run", () => {
    // Pins the MEASURED numbers (corpus files are 281-1412 bytes; the polygon's
    // largest PHP file is ~136 KB; codex digested an 88 KB prompt in the s57 gate).
    expect(MAX_EVIDENCE_BYTES_PER_FILE).toBe(65536);
    expect(MAX_EVIDENCE_BYTES_TOTAL).toBe(262144);
    expect(DEFAULT_EVIDENCE_LIMITS).toEqual({
      perFileBytes: MAX_EVIDENCE_BYTES_PER_FILE,
      totalBytes: MAX_EVIDENCE_BYTES_TOTAL,
    });
  });
});

describe("collectCriticEvidence (filesystem pass)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adh-evidence-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("attaches the COMPLETE current content of a touched file", async () => {
    writeFileSync(join(root, "a.php"), "<?php\nconst X = 1;\n");
    const ev = await collectCriticEvidence(root, ["a.php"]);
    expect(ev.attached).toEqual([{ path: "a.php", bytes: 19, content: "<?php\nconst X = 1;\n" }]);
    expect(ev.omitted).toEqual([]);
  });

  it("reports a DELETED file as `absent`, never as `unreadable`", async () => {
    // The ordinary case for a deletion hunk. Folding it into "could not read" would
    // hide a real, reportable fact behind an infrastructure-sounding one.
    const ev = await collectCriticEvidence(root, ["deleted.php"]);
    expect(ev.omitted).toEqual([{ path: "deleted.php", reason: "absent", bytes: null }]);
  });

  it("refuses a directory and a symlink as not-a-regular-file", async () => {
    mkdirSync(join(root, "adir"));
    writeFileSync(join(root, "real.php"), "x\n");
    let symlinked = true;
    try {
      symlinkSync(join(root, "real.php"), join(root, "link.php"));
    } catch {
      symlinked = false; // Windows without link privileges
    }
    const paths = symlinked ? ["adir", "link.php"] : ["adir"];
    const ev = await collectCriticEvidence(root, paths);
    expect(ev.attached).toEqual([]);
    expect(ev.omitted.every((o) => o.reason === "not-a-regular-file")).toBe(true);
    expect(ev.omitted).toHaveLength(paths.length);
  });

  it("refuses binary content instead of handing the critic control bytes", async () => {
    writeFileSync(join(root, "img.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const ev = await collectCriticEvidence(root, ["img.bin"]);
    expect(ev.attached).toEqual([]);
    expect(ev.omitted[0]!.reason).toBe("not-text");
  });

  it("refuses invalid UTF-8 rather than substituting replacement characters", async () => {
    // A lossy decode would attach a file that DIFFERS from the one on disk -- the
    // critic would then be reviewing bytes nobody wrote.
    writeFileSync(join(root, "bad.php"), Buffer.from([0x61, 0x80, 0x62]));
    const ev = await collectCriticEvidence(root, ["bad.php"]);
    expect(ev.attached).toEqual([]);
    expect(ev.omitted[0]!.reason).toBe("not-text");
  });

  it("omits a file it cannot prove lives inside the worktree", async () => {
    writeFileSync(join(root, "a.php"), "x\n");
    const ev = await collectCriticEvidence(root, ["a.php"], [], DEFAULT_EVIDENCE_LIMITS, {
      contains: async () => false,
    });
    expect(ev.attached).toEqual([]);
    expect(ev.omitted).toEqual([{ path: "a.php", reason: "unreadable", bytes: null }]);
  });

  it("refuses an over-size file WITHOUT reading it, reporting its real size", async () => {
    writeFileSync(join(root, "big.php"), "x".repeat(50));
    const ev = await collectCriticEvidence(root, ["big.php"], [], { perFileBytes: 10, totalBytes: 1000 });
    expect(ev.omitted).toEqual([{ path: "big.php", reason: "too-large", bytes: 50 }]);
  });

  it("keeps a UTF-8 BOM instead of silently stripping it (byte-exact attachment)", async () => {
    // MEASURED: the DEFAULT TextDecoder strips a leading BOM, so a 4-byte file
    // decoded to 1 character -- the attachment would have differed from the file on
    // disk, and its reported size would have disagreed with the budgeted one. Both
    // halves of "the attachment IS the file" depend on `ignoreBOM: true`.
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61]);
    writeFileSync(join(root, "bom.php"), bytes);
    const ev = await collectCriticEvidence(root, ["bom.php"]);
    expect(ev.attached).toHaveLength(1);
    expect(ev.attached[0]!.bytes).toBe(4);
    expect(Buffer.from(ev.attached[0]!.content, "utf8")).toEqual(bytes);
  });

  it("reads a multi-chunk file WHOLE -- the reported size always equals the content", async () => {
    // The no-truncation rule has to hold for a file big enough that one `read` call
    // is not guaranteed to return all of it (codex R1 finding 2: a short read used to
    // be accepted as the complete file and labelled "complete" in the prompt).
    const body = "x".repeat(300_000);
    writeFileSync(join(root, "big.php"), body);
    const ev = await collectCriticEvidence(root, ["big.php"], [], { perFileBytes: 400_000, totalBytes: 400_000 });
    expect(ev.omitted).toEqual([]);
    expect(ev.attached[0]!.content).toBe(body);
    expect(ev.attached[0]!.bytes).toBe(Buffer.byteLength(ev.attached[0]!.content, "utf8"));
  });

  it("never reads more than the total budget, however many files the diff touches", async () => {
    // The memory property, end to end: 40 files of 1 KB with a 4 KB budget must read
    // four of them, not forty (codex R1 finding 1).
    for (let i = 0; i < 40; i++) writeFileSync(join(root, `f${String(i).padStart(2, "0")}.php`), "x".repeat(1000));
    const paths = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, "0")}.php`);
    const ev = await collectCriticEvidence(root, paths, [], { perFileBytes: 64_000, totalBytes: 4000 });
    expect(ev.attached).toHaveLength(4);
    expect(ev.attached.reduce((n, a) => n + a.bytes, 0)).toBeLessThanOrEqual(4000);
    expect(ev.omitted).toHaveLength(36);
    expect(ev.omitted.every((o) => o.reason === "budget-exhausted")).toBe(true);
  });

  it("skips a blank path instead of resolving it to the worktree ROOT", async () => {
    // `resolve(root, "")` is the root directory itself
    // (docs/gotchas/empty-path-resolves-to-repo-root.md) -- a blank entry must never
    // reach the reader, and there is nothing to tell the critic about it either.
    const ev = await collectCriticEvidence(root, ["", "   "]);
    expect(ev).toEqual({ attached: [], omitted: [], declaredDocsOnly: false });
  });

  it("a REJECTING containment seam omits that file, it does not abort the collection", async () => {
    // `NEVER throws` has to be true of the paths AROUND the try/catch too, not just
    // inside it (docs/gotchas/never-throws-catch-block-logging.md). An injected seam
    // that rejects used to escape and kill the whole evidence set (codex R2 finding 2).
    writeFileSync(join(root, "a.php"), "x\n");
    writeFileSync(join(root, "b.php"), "y\n");
    const ev = await collectCriticEvidence(root, ["a.php", "b.php"], [], DEFAULT_EVIDENCE_LIMITS, {
      contains: async (_root, candidate) => {
        if (candidate.endsWith("a.php")) throw new Error("seam blew up");
        return true;
      },
    });
    expect(ev.attached.map((a) => a.path)).toEqual(["b.php"]);
    expect(ev.omitted).toEqual([{ path: "a.php", reason: "unreadable", bytes: null }]);
  });

  it("one unreadable file does not cost the critic the evidence for the others", async () => {
    writeFileSync(join(root, "good.php"), "ok\n");
    const ev = await collectCriticEvidence(root, ["good.php", "missing.php"]);
    expect(ev.attached.map((a) => a.path)).toEqual(["good.php"]);
    expect(ev.omitted.map((o) => o.path)).toEqual(["missing.php"]);
  });
});

describe("isDeclaredDocsOnlyChange (adr/007 — a declaration, not a detection)", () => {
  const DOCS = ["docs/**", "README.md"];

  it("qualifies a change whose every path the operator declared as documentation", () => {
    expect(isDeclaredDocsOnlyChange(["docs/OVERVIEW.md", "README.md"], DOCS)).toBe(true);
    expect(isDeclaredDocsOnlyChange(["docs/deep/nested/guide.md"], DOCS)).toBe(true);
  });

  it("refuses when the project declared nothing — the default is no leniency anywhere", () => {
    // `contract.docPaths: []` is the shipped default, and it must reproduce the
    // pre-adr/007 gate exactly. A project that never opts in loses nothing.
    expect(isDeclaredDocsOnlyChange(["docs/OVERVIEW.md"], [])).toBe(false);
    expect(isDeclaredDocsOnlyChange(["docs/OVERVIEW.md"], ["", "   "])).toBe(false);
  });

  it("refuses a change that touches ANY path outside the declaration", () => {
    // The whole point: docs-plus-code is a code change. One unmatched path is enough.
    expect(isDeclaredDocsOnlyChange(["docs/OVERVIEW.md", "includes/class-x.php"], DOCS)).toBe(false);
    // A `.md` that was NOT declared gets nothing either -- the extension is not the
    // test any more, which is precisely what replaced the unclosable marker blacklist.
    expect(isDeclaredDocsOnlyChange(["notes/scratch.md"], DOCS)).toBe(false);
  });

  it("refuses a blank or non-string path instead of filtering it away", () => {
    // A blank entry names nothing, so no declaration can vouch for it. Dropping it
    // silently would let this list qualify on the strength of the ONE path it did
    // read -- the same shape as `empty-path-resolves-to-repo-root`, one layer up.
    expect(isDeclaredDocsOnlyChange(["", "docs/OVERVIEW.md"], DOCS)).toBe(false);
    expect(isDeclaredDocsOnlyChange(["   ", "docs/OVERVIEW.md"], DOCS)).toBe(false);
    expect(isDeclaredDocsOnlyChange([null as unknown as string, "docs/OVERVIEW.md"], DOCS)).toBe(false);
  });

  it("refuses an empty change set — there is nothing to vouch for", () => {
    expect(isDeclaredDocsOnlyChange([], DOCS)).toBe(false);
  });

  it("does not grant leniency on CONTENT, only on the declared path", () => {
    // The predicate never looks at bytes. This is the whole difference from the parked
    // first attempt, whose extension+marker blacklist lost three review rounds to three
    // different markers it had not thought of. A declared doc path stays declared
    // whatever is written inside it; if a project's toolchain DOES execute that file,
    // the operator's remedy is to not declare it (or to fence it via
    // `contract.constitutionPaths`), which is a decision only the project can make.
    expect(isDeclaredDocsOnlyChange(["docs/RUNBOOK.md"], DOCS)).toBe(true);
  });

  it("R1 blocker 2 regression: a traversal segment is REFUSED, not textually matched", () => {
    // `globMatch("docs/**", x)` compiles to `^docs/.*$`, which the string
    // `docs/../src/index.php` satisfies while naming a file outside `docs/` entirely.
    // Git never emits such a path, so this is not reachable through the conductor --
    // but an exported predicate guarding an oracle decision does not get to rely on
    // its callers being well-behaved.
    expect(isDeclaredDocsOnlyChange(["docs/../src/index.php"], ["docs/**"])).toBe(false);
    expect(isDeclaredDocsOnlyChange(["docs\..\src\index.php"], ["docs/**"])).toBe(false);
    expect(isDeclaredDocsOnlyChange(["docs/a/../b.md"], ["docs/**"])).toBe(false);
    // A path merely CONTAINING dots is fine -- only a `..` SEGMENT is refused.
    expect(isDeclaredDocsOnlyChange(["docs/v1..2/notes.md"], ["docs/**"])).toBe(true);
  });

  it("refuses an absolute or drive-anchored path", () => {
    expect(isDeclaredDocsOnlyChange(["/docs/a.md"], ["**"])).toBe(false);
    expect(isDeclaredDocsOnlyChange(["D:/docs/a.md"], ["**"])).toBe(false);
  });

  it("R1 major hardening: a non-array argument declines instead of throwing", () => {
    // The 3rd positional parameter makes a mis-ordered call plausible, and a throw out
    // of this predicate would turn "no leniency" into "evidence collection died".
    expect(() =>
      isDeclaredDocsOnlyChange(["docs/a.md"], { perFileBytes: 10 } as unknown as string[]),
    ).not.toThrow();
    expect(isDeclaredDocsOnlyChange(["docs/a.md"], { perFileBytes: 10 } as unknown as string[])).toBe(false);
    expect(isDeclaredDocsOnlyChange(null as unknown as string[], ["docs/**"])).toBe(false);
  });

  it("matches with the harness's own glob semantics, not a substring test", () => {
    // `*` is segment-local, `**` crosses segments -- parity with the dirty-file fence
    // and `constitutionPaths`, so one mental model covers every declared-path field.
    expect(isDeclaredDocsOnlyChange(["docs/a/b.md"], ["docs/*"])).toBe(false);
    expect(isDeclaredDocsOnlyChange(["docs/a.md"], ["docs/*"])).toBe(true);
    expect(isDeclaredDocsOnlyChange(["xdocs/a.md"], ["docs/**"])).toBe(false);
  });
});

describe("isAdditionsOnlyDiff (adr/007 — the added-vs-modified half, decided in code)", () => {
  const ADD_ONLY = `diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md
index 111..222 100644
--- a/docs/OVERVIEW.md
+++ b/docs/OVERVIEW.md
@@ -1,2 +1,4 @@
 existing line
 another existing line
+## Shipping method ids
+The plugin registers \`test_pickup\`.
`;

  it("accepts a pure append", () => {
    expect(isAdditionsOnlyDiff(ADD_ONLY)).toBe(true);
  });

  it("REFUSES a diff that removes a line — the attack the carve-out exists to stop", () => {
    // This is the finding R1 raised as a blocker: before this predicate the scope was
    // stated in the prompt and applied by the model. Now a rewrite never reaches it.
    expect(isAdditionsOnlyDiff(ADD_ONLY.replace(" another existing line", "-another existing line"))).toBe(false);
  });

  it("is not fooled by a removed line whose CONTENT is a dash run", () => {
    // A removed line containing `--` renders as `---`, which a naive prefix match reads
    // as a `--- a/file` header and skips. Hunk-state tracking is what makes this safe.
    const rewrite = `diff --git a/docs/A.md b/docs/A.md
--- a/docs/A.md
+++ b/docs/A.md
@@ -1,2 +1,2 @@
---
+new line
`;
    expect(isAdditionsOnlyDiff(rewrite)).toBe(false);
  });

  it("refuses a diff with no hunks at all — a rename has nothing to be lenient about", () => {
    const rename = `diff --git a/docs/A.md b/docs/B.md
similarity index 100%
rename from docs/A.md
rename to docs/B.md
`;
    expect(isAdditionsOnlyDiff(rename)).toBe(false);
  });

  it("refuses an empty, blank or non-string diff", () => {
    expect(isAdditionsOnlyDiff("")).toBe(false);
    expect(isAdditionsOnlyDiff("   \n  ")).toBe(false);
    expect(isAdditionsOnlyDiff(null as unknown as string)).toBe(false);
  });

  it("refuses a hunk body line it cannot classify, instead of assuming it is context", () => {
    expect(isAdditionsOnlyDiff("@@ -1,1 +1,2 @@\n+ok\n?? what is this\n")).toBe(false);
  });

  it("handles a multi-file diff: additions in one file, a removal in another", () => {
    const twoFiles =
      ADD_ONLY +
      `diff --git a/docs/B.md b/docs/B.md
--- a/docs/B.md
+++ b/docs/B.md
@@ -1,2 +1,1 @@
-the documented contract
 kept line
`;
    expect(isAdditionsOnlyDiff(twoFiles)).toBe(false);
  });

  it("tolerates CRLF and the no-newline marker", () => {
    const crlf = ADD_ONLY.split("\n").join("\r\n") + "\\ No newline at end of file\r\n";
    expect(isAdditionsOnlyDiff(crlf)).toBe(true);
  });
});

describe("isAdditionsOnlyDiff — R2 regressions (hunk counts, not prefix guessing)", () => {
  it("R2 major 1: a bare `diff --git` INSIDE a hunk body no longer hides a later removal", () => {
    // The prefix parser ended a hunk on the next `diff --git `, so this input reset the
    // state and the `-rewritten contract` line was never examined. Counting body lines
    // from the hunk header means the parser is never guessing where a hunk ends.
    //
    // R3 minor: this input is rejected at the unclassifiable `diff --git` body line,
    // BEFORE the removal is reached, so on its own it cannot distinguish "detects the
    // removal" from "rejected early". The two tests below carry that weight.
    const evil = `@@ -1,1 +1,2 @@
+new assertion
diff --git a/docs/contract.md b/docs/contract.md
-rewritten contract
`;
    expect(isAdditionsOnlyDiff(evil)).toBe(false);
  });

  it("R3 major: a removal BETWEEN hunks, reached via an under-declared count, is caught", () => {
    // The counting parser exited the first hunk correctly (its declared 1/1 was consumed
    // by ` context`), and the outer loop then skipped every non-`@@` line -- including
    // `-removed` -- until the next header. The fix is an ALLOW-LIST outside hunks: only a
    // recognized git file header may be skipped, everything else declines.
    const evil = `diff --git a/docs/x.md b/docs/x.md
--- a/docs/x.md
+++ b/docs/x.md
@@ -1,1 +1,1 @@
 context
-removed
@@ -2,0 +2,1 @@
+added
`;
    expect(isAdditionsOnlyDiff(evil)).toBe(false);
    expect(
      qualifiesForDocsNarrowing(evil, {
        attached: [{ path: "docs/x.md", bytes: 1, content: "x" }],
        omitted: [],
        declaredDocsOnly: true,
      }),
    ).toBe(false);
  });

  it("REACHES a removal that follows a fully-consumed hunk in the SAME file", () => {
    // The positive control for the test above: nothing rejects this input early -- every
    // line up to the removal is either a valid header or a correctly-counted body line.
    const evil = `diff --git a/docs/x.md b/docs/x.md
--- a/docs/x.md
+++ b/docs/x.md
@@ -1,1 +1,2 @@
 context
+added
-sneaked in after the count was spent
`;
    expect(isAdditionsOnlyDiff(evil)).toBe(false);
  });

  it("R4 high: a removed line whose CONTENT is `-- ` is not mistaken for a `--- ` header", () => {
    // R3's flat allow-list accepted any header prefix anywhere outside a hunk, and
    // `--- ` is one. A removal rendering as `--- `, landing after a consumed hunk, was
    // skipped as structure. Position is what decides now: `--- ` is a header only inside
    // the block a `diff --git` line opens.
    const evil = `diff --git a/docs/x.md b/docs/x.md
--- a/docs/x.md
+++ b/docs/x.md
@@ -1,1 +1,2 @@
 context
+added
---
`;
    expect(isAdditionsOnlyDiff(evil)).toBe(false);
  });

  it("R4: the same collision via `+++ `, `index ` and a bare `\\\\ ` after a hunk", () => {
    const mk = (trailer: string) => `diff --git a/docs/x.md b/docs/x.md
--- a/docs/x.md
+++ b/docs/x.md
@@ -1,1 +1,2 @@
 context
+added
${trailer}
`;
    // `+++ ` and `index ` are headers only in the opening block -- after a hunk they are
    // content the parser has no business skipping.
    expect(isAdditionsOnlyDiff(mk("+++ b/elsewhere"))).toBe(false);
    expect(isAdditionsOnlyDiff(mk("index deadbeef..cafe 100644"))).toBe(false);
    // `\\ No newline at end of file` genuinely does trail a hunk, and cannot be a removal.
    expect(isAdditionsOnlyDiff(mk("\\ No newline at end of file"))).toBe(true);
  });

  it("R4: a `--- ` line before any `diff --git` block is refused, not read as a header", () => {
    expect(isAdditionsOnlyDiff("--- a/docs/x.md\n+++ b/docs/x.md\n@@ -1,1 +1,2 @@\n c\n+a\n")).toBe(false);
  });

  it("still accepts a well-formed MULTI-hunk, multi-file additions-only diff", () => {
    // The allow-list must not break the ordinary case it guards -- a strictness fix that
    // rejects every real diff would silently disable the narrowing rather than scope it.
    const ok = `diff --git a/docs/a.md b/docs/a.md
index 111..222 100644
--- a/docs/a.md
+++ b/docs/a.md
@@ -1,1 +1,2 @@
 first
+added to a
@@ -10,1 +11,2 @@
 tenth
+also added to a
diff --git a/docs/b.md b/docs/b.md
new file mode 100644
--- /dev/null
+++ b/docs/b.md
@@ -0,0 +1,1 @@
+brand new
`;
    expect(isAdditionsOnlyDiff(ok)).toBe(true);
  });

  it("declines a binary change rather than guessing whether it removed anything", () => {
    const bin = `diff --git a/docs/logo.png b/docs/logo.png
index 111..222 100644
Binary files a/docs/logo.png and b/docs/logo.png differ
diff --git a/docs/a.md b/docs/a.md
--- a/docs/a.md
+++ b/docs/a.md
@@ -1,1 +1,2 @@
 first
+added
`;
    expect(isAdditionsOnlyDiff(bin)).toBe(false);
  });

  it("refuses a hunk whose body is shorter than its declared counts", () => {
    expect(isAdditionsOnlyDiff("@@ -1,5 +1,6 @@\n+one\n")).toBe(false);
  });

  it("refuses an unparseable hunk header instead of skipping it", () => {
    expect(isAdditionsOnlyDiff("@@ garbage @@\n+one\n")).toBe(false);
    expect(isAdditionsOnlyDiff("@@@ -1,1 -1,1 +1,2 @@@\n++combined\n")).toBe(false);
  });

  it("accepts the single-line hunk form where the size is omitted", () => {
    expect(isAdditionsOnlyDiff("@@ -1 +1,2 @@\n context\n+added\n")).toBe(true);
  });

  it("accepts a hunk header carrying a section heading after the second @@", () => {
    expect(isAdditionsOnlyDiff("@@ -1,1 +1,2 @@ class Foo\n context\n+added\n")).toBe(true);
  });

  it("counts an ADDED line that merely looks like a header as content, not as structure", () => {
    // This repo commits `.diff` fixtures, so a doc really can gain a line reading
    // `diff --git ...` or `@@ ... @@`. Inside a hunk body it arrives prefixed.
    expect(isAdditionsOnlyDiff("@@ -1,1 +1,3 @@\n context\n+diff --git a/x b/x\n+@@ -1 +1 @@\n")).toBe(true);
  });

  it("still refuses a diff whose only hunk adds nothing", () => {
    expect(isAdditionsOnlyDiff("@@ -1,1 +1,1 @@\n unchanged\n")).toBe(false);
  });
});

describe("qualifiesForDocsNarrowing — the two readings must describe ONE change", () => {
  const docsDiff = `diff --git a/docs/OVERVIEW.md b/docs/OVERVIEW.md
--- a/docs/OVERVIEW.md
+++ b/docs/OVERVIEW.md
@@ -1,1 +1,2 @@
 existing
+added assertion
`;
  const ev = (paths: string[], declaredDocsOnly: boolean) => ({
    attached: paths.map((p) => ({ path: p, bytes: 1, content: "x" })),
    omitted: [],
    declaredDocsOnly,
  });

  it("qualifies when the flag, the diff and the evidence all agree", () => {
    expect(qualifiesForDocsNarrowing(docsDiff, ev(["docs/OVERVIEW.md"], true))).toBe(true);
  });

  it("R2 major 2: refuses when the diff names a file the evidence never saw", () => {
    // The flag comes from `worktree.diffFiles`, the additions check from the diff TEXT.
    // In production they agree by construction -- but nothing REQUIRED them to, and a
    // stale or mismatched flag would have granted leniency to a diff touching code.
    const codeDiff = `diff --git a/src/index.php b/src/index.php
--- a/src/index.php
+++ b/src/index.php
@@ -1,1 +1,2 @@
 <?php
+unreviewed behavior
`;
    expect(qualifiesForDocsNarrowing(codeDiff, ev(["docs/OVERVIEW.md"], true))).toBe(false);
  });

  it("refuses when the flag is false, whatever the diff looks like", () => {
    expect(qualifiesForDocsNarrowing(docsDiff, ev(["docs/OVERVIEW.md"], false))).toBe(false);
  });

  it("refuses when there is no evidence at all", () => {
    expect(qualifiesForDocsNarrowing(docsDiff, undefined)).toBe(false);
  });

  it("refuses a diff whose headers name nothing it can parse", () => {
    expect(qualifiesForDocsNarrowing("@@ -1,1 +1,2 @@\n x\n+y\n", ev(["docs/OVERVIEW.md"], true))).toBe(false);
  });

  it("counts an OMITTED file as known — omission is an evidence fact, not an unknown file", () => {
    const omittedOnly = {
      attached: [],
      omitted: [{ path: "docs/OVERVIEW.md", reason: "too-large" as const, bytes: 99999 }],
      declaredDocsOnly: true,
    };
    expect(qualifiesForDocsNarrowing(docsDiff, omittedOnly)).toBe(true);
  });

  it("treats /dev/null in a new-file diff as no path, and matches on the real side", () => {
    const newFile = `diff --git a/docs/NEW.md b/docs/NEW.md
new file mode 100644
--- /dev/null
+++ b/docs/NEW.md
@@ -0,0 +1,1 @@
+brand new prose
`;
    expect(qualifiesForDocsNarrowing(newFile, ev(["docs/NEW.md"], true))).toBe(true);
  });
});

describe("collectCriticEvidence — the adr/007 flag", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adr007-"));
    mkdirSync(join(root, "docs"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("sets the flag from the DIFF's file list, not from what survived the budget", async () => {
    writeFileSync(join(root, "docs", "OVERVIEW.md"), "# Overview\n");
    const ev = await collectCriticEvidence(root, ["docs/OVERVIEW.md"], ["docs/**"]);
    expect(ev.declaredDocsOnly).toBe(true);
    expect(ev.attached.map((a) => a.path)).toEqual(["docs/OVERVIEW.md"]);
  });

  it("a declared doc file too large to attach still qualifies — the path is the declaration", async () => {
    // Omission is an EVIDENCE fact (the critic will not see the bytes); the mandate
    // narrowing is a PATH fact. Conflating them would silently withdraw the operator's
    // declaration for a large file, for a reason that has nothing to do with it.
    writeFileSync(join(root, "docs", "BIG.md"), "x".repeat(50));
    const ev = await collectCriticEvidence(root, ["docs/BIG.md"], ["docs/**"], {
      perFileBytes: 10,
      totalBytes: 1000,
    });
    expect(ev.attached).toEqual([]);
    expect(ev.omitted[0]!.reason).toBe("too-large");
    expect(ev.declaredDocsOnly).toBe(true);
  });

  it("REGRESSION: a blank path in the diff list denies leniency, though it never reaches the evidence", async () => {
    // `collectCriticEvidence` filters blanks before measuring, so `attached`/`omitted`
    // would show a clean all-docs set. Deriving the flag from those lists (rather than
    // from `relPaths`) is therefore a live way to grant leniency to a change the
    // harness did not fully inspect -- this test is what pins the flag to the
    // authoritative list.
    writeFileSync(join(root, "docs", "OVERVIEW.md"), "# Overview\n");
    const ev = await collectCriticEvidence(root, ["", "docs/OVERVIEW.md"], ["docs/**"]);
    expect(ev.attached.map((a) => a.path)).toEqual(["docs/OVERVIEW.md"]);
    expect(ev.omitted).toEqual([]);
    expect(ev.declaredDocsOnly).toBe(false);
  });

  it("defaults to no leniency when no declaration is passed at all", async () => {
    writeFileSync(join(root, "docs", "OVERVIEW.md"), "# Overview\n");
    const ev = await collectCriticEvidence(root, ["docs/OVERVIEW.md"]);
    expect(ev.declaredDocsOnly).toBe(false);
  });

  it("a mixed docs+code change does not qualify", async () => {
    writeFileSync(join(root, "docs", "OVERVIEW.md"), "# Overview\n");
    writeFileSync(join(root, "plugin.php"), "<?php\n");
    const ev = await collectCriticEvidence(root, ["docs/OVERVIEW.md", "plugin.php"], ["docs/**"]);
    expect(ev.declaredDocsOnly).toBe(false);
  });
});

describe("summarizeEvidence", () => {
  it("names every omitted file and its reason, so a log line is actionable", () => {
    const line = summarizeEvidence({
      attached: [{ path: "a.php", bytes: 10, content: "x" }],
      omitted: [{ path: "b.png", reason: "not-text", bytes: null }],
      declaredDocsOnly: false,
    });
    expect(line).toContain("attached 1 file(s), 10 byte(s)");
    expect(line).toContain("b.png (not-text)");
  });
});
