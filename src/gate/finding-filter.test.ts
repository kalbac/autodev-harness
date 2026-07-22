import { describe, it, expect } from "vitest";
import { filterFindings } from "./finding-filter.js";
import type { CheckstyleFinding } from "./checkstyle.js";

// A minimal helper: build a finding without repeating severity/source noise in
// every case below.
function finding(over: Partial<CheckstyleFinding>): CheckstyleFinding {
  return {
    file: "unused.php",
    line: 1,
    severity: "error",
    message: "some message",
    source: "Some.Source",
    ...over,
  };
}

describe("filterFindings", () => {
  it("normalizes an absolute WINDOWS path under the worktree and matches it against the diff", () => {
    // Deliberately hardcoded (not built with node's `path` module) -- this must
    // behave identically no matter which host OS actually runs the test, which
    // is the whole point of not using the HOST path implementation to normalize
    // a path that could have been captured on a different OS entirely.
    const findings = [
      finding({ file: "C:\\repo\\worktree\\includes\\a.php", line: 3, message: "windows finding" }),
    ];
    const addedLines = new Map([["includes/a.php", new Set([3])]]);
    const result = filterFindings(findings, addedLines, "C:\\repo\\worktree", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "includes/a.php", line: 3, unattributed: false });
  });

  it("normalizes an absolute POSIX path under the worktree and matches it against the diff", () => {
    const findings = [finding({ file: "/repo/worktree/includes/a.php", line: 5, message: "posix finding" })];
    const addedLines = new Map([["includes/a.php", new Set([5])]]);
    const result = filterFindings(findings, addedLines, "/repo/worktree", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "includes/a.php", line: 5, unattributed: false });
  });

  it("keeps a finding that lands on an ADDED line", () => {
    const findings = [finding({ file: "/wt/includes/a.php", line: 13 })];
    const addedLines = new Map([["includes/a.php", new Set([13, 14])]]);
    const result = filterFindings(findings, addedLines, "/wt", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]!.line).toBe(13);
  });

  it("drops a finding on a line the diff did NOT add, in a file the diff DID touch", () => {
    // This is the pre-existing-debt case: the worker touched includes/a.php
    // (line 13 is added), but this finding sits on line 1, which the worker
    // never wrote -- that debt predates the task and must not block it.
    const findings = [finding({ file: "/wt/includes/a.php", line: 1 })];
    const addedLines = new Map([["includes/a.php", new Set([13])]]);
    const result = filterFindings(findings, addedLines, "/wt", new Set());
    expect(result).toHaveLength(0);
  });

  it("drops a finding in a file the diff never touched at all", () => {
    const findings = [finding({ file: "/wt/includes/untouched.php", line: 1 })];
    const addedLines = new Map([["includes/a.php", new Set([13])]]);
    const result = filterFindings(findings, addedLines, "/wt", new Set());
    expect(result).toHaveLength(0);
  });

  it("KEEPS and flags unattributed:true a finding whose path cannot be attributed to any changed file", () => {
    // Fail-closed (Principle 10): a path that does not even resolve to
    // something under the worktree must not be silently dropped -- that would
    // be fail-OPEN, ignoring a possibly-real violation on the worker's own
    // lines. It is kept and loudly flagged instead.
    const findings = [finding({ file: "D:\\somewhere\\else\\entirely.php", line: 1, message: "orphan" })];
    const addedLines = new Map([["includes/a.php", new Set([13])]]);
    const result = filterFindings(findings, addedLines, "C:\\repo\\worktree", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ unattributed: true, message: "orphan" });
    // The raw, un-normalizable path is preserved verbatim -- it is the only
    // diagnostic the operator has for why attribution failed.
    expect(result[0]!.file).toBe("D:\\somewhere\\else\\entirely.php");
  });

  it("keeps a line-less (file-level) finding when the file is ENTIRELY new (per the newFiles signal)", () => {
    // "Entirely new" comes straight from the diff's own `--- /dev/null` signal
    // (FIX3/FIX9) -- not reconstructed from the shape of the added-line set.
    const findings = [finding({ file: "/wt/includes/new.php", line: null, message: "missing file doc comment" })];
    const addedLines = new Map([["includes/new.php", new Set([1, 2, 3])]]);
    const result = filterFindings(findings, addedLines, "/wt", new Set(["includes/new.php"]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ line: null, unattributed: false });
  });

  it("drops a line-less (file-level) finding on an EXISTING file (not present in newFiles)", () => {
    const findings = [finding({ file: "/wt/includes/a.php", line: null, message: "missing file doc comment" })];
    // Only line 13 was added, and the file is not in newFiles -- a file-level
    // finding is by definition pre-existing debt.
    const addedLines = new Map([["includes/a.php", new Set([13])]]);
    const result = filterFindings(findings, addedLines, "/wt", new Set());
    expect(result).toHaveLength(0);
  });

  it("drops a line-less (file-level) finding on an EXISTING file even when its ENTIRE content was rewritten in one hunk", () => {
    // A modified existing file can, by coincidence, have every one of its lines
    // rewritten -- producing an added-line set shaped identically to a
    // brand-new file's {1..N}. FIX9 replaced the old shape-based heuristic
    // (which could not tell these two cases apart) with the diff's real
    // `--- /dev/null` signal: since this file is NOT in newFiles, it is
    // pre-existing debt regardless of what the added-line set looks like.
    const findings = [finding({ file: "/wt/includes/a.php", line: null })];
    const addedLines = new Map([["includes/a.php", new Set([1, 2, 3])]]);
    const result = filterFindings(findings, addedLines, "/wt", new Set());
    expect(result).toHaveLength(0);
  });

  it("keeps unrelated fields (severity, message, source) untouched on a surviving finding", () => {
    const findings = [
      finding({
        file: "/wt/includes/a.php",
        line: 13,
        severity: "warning",
        message: "Found precision alignment of 2 spaces.",
        source: "Universal.WhiteSpace.PrecisionAlignment.Found",
      }),
    ];
    const addedLines = new Map([["includes/a.php", new Set([13])]]);
    const result = filterFindings(findings, addedLines, "/wt", new Set());
    expect(result[0]).toMatchObject({
      severity: "warning",
      message: "Found precision alignment of 2 spaces.",
      source: "Universal.WhiteSpace.PrecisionAlignment.Found",
    });
  });

  it("processes several findings across several files independently", () => {
    const findings = [
      finding({ file: "/wt/includes/a.php", line: 13, message: "kept: added line" }),
      finding({ file: "/wt/includes/a.php", line: 1, message: "dropped: pre-existing" }),
      finding({ file: "/wt/includes/untouched.php", line: 1, message: "dropped: untouched file" }),
      finding({ file: "/elsewhere/x.php", line: 1, message: "kept: unattributed" }),
    ];
    const addedLines = new Map([["includes/a.php", new Set([13])]]);
    const result = filterFindings(findings, addedLines, "/wt", new Set());
    expect(result.map((f) => f.message)).toEqual(["kept: added line", "kept: unattributed"]);
    expect(result.find((f) => f.message === "kept: unattributed")!.unattributed).toBe(true);
    expect(result.find((f) => f.message === "kept: added line")!.unattributed).toBe(false);
  });

  it("returns [] when there are no findings", () => {
    expect(filterFindings([], new Map(), "/wt", new Set())).toEqual([]);
  });

  it("FIX7: a '..' escape passes the naive prefix check but must be KEPT unattributed, never dropped", () => {
    // worktreePath = C:\repo; finding path = C:\repo\..\outside.php. Folded to
    // "C:/repo/../outside.php", this literally starts with "C:/repo/" (the naive
    // prefix test), stripping the prefix would yield "../outside.php", and that
    // is absent from the added-line map -- the OLD behaviour silently dropped
    // it. It is not even genuinely inside the worktree, so dropping it would be
    // fail-open on a path that escaped containment entirely.
    const findings = [finding({ file: "C:\\repo\\..\\outside.php", line: 1, message: "escape attempt" })];
    const addedLines = new Map([["includes/a.php", new Set([1])]]);
    const result = filterFindings(findings, addedLines, "C:\\repo", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ unattributed: true, message: "escape attempt" });
  });

  it("FIX7: a '..' escape using forward slashes is also caught", () => {
    const findings = [finding({ file: "/repo/../outside.php", line: 1, message: "posix escape" })];
    const addedLines = new Map([["includes/a.php", new Set([1])]]);
    const result = filterFindings(findings, addedLines, "/repo", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ unattributed: true, message: "posix escape" });
  });

  it("FIX7: a legitimate path that merely CONTAINS the substring '..' inside a filename is unaffected", () => {
    // Guard against an overzealous fix that flags any path containing the
    // two-character substring "..": a filename with a literal ".." segment-free
    // substring (e.g. a version-like filename) must still attribute normally.
    const findings = [finding({ file: "/wt/includes/a..b.php", line: 3, message: "normal file" })];
    const addedLines = new Map([["includes/a..b.php", new Set([3])]]);
    const result = filterFindings(findings, addedLines, "/wt", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "includes/a..b.php", unattributed: false });
  });

  it("FIX8: a Windows path compares case-INsensitively against the worktree path (drive letter)", () => {
    const findings = [finding({ file: "c:\\repo\\src\\x.php", line: 3, message: "lowercase drive" })];
    const addedLines = new Map([["src/x.php", new Set([3])]]);
    const result = filterFindings(findings, addedLines, "C:\\Repo", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "src/x.php", unattributed: false });
  });

  it("FIX8: a UNC Windows path also compares case-insensitively", () => {
    const findings = [finding({ file: "\\\\SERVER\\Share\\src\\x.php", line: 1, message: "unc" })];
    const addedLines = new Map([["src/x.php", new Set([1])]]);
    const result = filterFindings(findings, addedLines, "\\\\server\\share", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "src/x.php", unattributed: false });
  });

  it("FIX8: a POSIX path stays genuinely case-SENSITIVE -- a.php and A.php are different files", () => {
    const findings = [finding({ file: "/wt/includes/A.php", line: 1, message: "wrong case" })];
    const addedLines = new Map([["includes/a.php", new Set([1])]]);
    const result = filterFindings(findings, addedLines, "/wt", new Set());
    // Path normalizes fine (both start with /wt/), but the normalized key
    // "includes/A.php" is not in addedLines (only "includes/a.php" is) -- dropped
    // as an untouched file, NOT kept as unattributed (case sensitivity on POSIX
    // means these are legitimately different files).
    expect(result).toHaveLength(0);
  });

  it("FIX9: uses the newFiles signal (not the contiguous-1..N heuristic) to decide a file-level finding is on a brand-new file", () => {
    const findings = [finding({ file: "/wt/includes/new.php", line: null, message: "missing file doc comment" })];
    const addedLines = new Map([["includes/new.php", new Set([1, 2, 3])]]);
    const result = filterFindings(findings, addedLines, "/wt", new Set(["includes/new.php"]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ line: null, unattributed: false });
  });

  it("FIX9: a file-level finding on an EXISTING file whose entire content was rewritten (added set IS a contiguous 1..N) is now DROPPED, because newFiles says it isn't new", () => {
    // This is the exact case the old heuristic could not distinguish: an
    // existing file's diff replaces every line (added set = {1,2,3}, shaped
    // identically to a brand-new file), but the diff's real --- /dev/null
    // signal (newFiles) says this file already existed. A file-level finding
    // on it is pre-existing debt and must be dropped, not kept.
    const findings = [finding({ file: "/wt/includes/rewritten.php", line: null, message: "missing file doc comment" })];
    const addedLines = new Map([["includes/rewritten.php", new Set([1, 2, 3])]]);
    const result = filterFindings(findings, addedLines, "/wt", new Set()); // NOT in newFiles
    expect(result).toHaveLength(0);
  });

  it("R2-FIX3: a Windows-shaped path whose remainder differs only in CASE from the diff's key still attributes (same fold governs prefix AND lookup)", () => {
    // The diff key is "src/Foo.php" (mixed case, as git/PHPCS might report
    // it), but the report's raw path is fully upper-case. The prefix check
    // (FIX8) already tolerates this case difference for the WORKTREE ROOT
    // portion -- but the REMAINDER after the prefix was sliced off in the
    // report's original case and then used for an exact-case Map lookup,
    // which misses "src/Foo.php" entirely and silently drops the finding.
    const findings = [finding({ file: "C:\\REPO\\SRC\\FOO.PHP", line: 3, message: "case-folded lookup" })];
    const addedLines = new Map([["src/Foo.php", new Set([3])]]);
    const result = filterFindings(findings, addedLines, "C:\\repo", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "src/Foo.php", line: 3, unattributed: false });
  });

  it("R2-FIX3: the same case-fold also governs the newFiles lookup for a file-level finding", () => {
    const findings = [
      finding({ file: "C:\\REPO\\SRC\\NEW.PHP", line: null, message: "missing file doc comment" }),
    ];
    const addedLines = new Map([["src/New.php", new Set([1, 2])]]);
    const result = filterFindings(findings, addedLines, "C:\\repo", new Set(["src/New.php"]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "src/New.php", line: null, unattributed: false });
  });

  it("R2-FIX3: a Windows-shaped path that does not case-insensitively match ANY added-file key is dropped as untouched, not kept unattributed", () => {
    const findings = [finding({ file: "C:\\REPO\\SRC\\OTHER.PHP", line: 1, message: "genuinely untouched" })];
    const addedLines = new Map([["src/Foo.php", new Set([1])]]);
    const result = filterFindings(findings, addedLines, "C:\\repo", new Set());
    expect(result).toHaveLength(0);
  });

  it("R2-FIX4: a Windows extended-length path (\\\\?\\C:\\...) normalizes and attributes normally", () => {
    const findings = [finding({ file: "\\\\?\\C:\\repo\\src\\x.php", line: 3, message: "extended-length" })];
    const addedLines = new Map([["src/x.php", new Set([3])]]);
    const result = filterFindings(findings, addedLines, "C:\\repo", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "src/x.php", unattributed: false });
  });

  it("R2-FIX4: a Windows extended-length UNC path (\\\\?\\UNC\\server\\share\\...) normalizes and attributes normally", () => {
    const findings = [
      finding({ file: "\\\\?\\UNC\\server\\share\\src\\x.php", line: 1, message: "extended-length unc" }),
    ];
    const addedLines = new Map([["src/x.php", new Set([1])]]);
    const result = filterFindings(findings, addedLines, "\\\\server\\share", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "src/x.php", unattributed: false });
  });

  it("R3-FIX3: when the diff has TWO case-colliding keys, a finding on a line only present under the OTHER key is still kept, not dropped", () => {
    // A repo created on a case-sensitive filesystem can legitimately hold both
    // "src/Foo.php" and "src/foo.php" as distinct files, both touched by the
    // same diff. findCaseInsensitiveKey used to return only the FIRST key
    // that folds to the match -- if line 9 was added only under "src/foo.php"
    // (added second in Map insertion order) and the report's Windows-shaped
    // path folds ambiguously to either, picking just "src/Foo.php" (added
    // first) loses line 9 entirely and the finding on it is silently dropped.
    const findings = [finding({ file: "C:\\repo\\src\\FOO.PHP", line: 9, message: "case-colliding" })];
    const addedLines = new Map([
      ["src/Foo.php", new Set([3])],
      ["src/foo.php", new Set([9])],
    ]);
    // R4-FIX5 SUPERSEDES the union this case originally pinned. The intent it
    // was written to protect -- "a finding under the other colliding key is NOT
    // silently dropped" -- still holds and is still asserted: the finding
    // survives. What changed is that it is no longer attributed to one of the
    // two files, because the report path genuinely cannot say which it meant.
    // Unioning made it look attributed, which was a confident wrong answer.
    const result = filterFindings(findings, addedLines, "C:\\repo", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ line: 9, unattributed: true });
  });

  it("R3-FIX3: the union also governs the newFiles membership test for a file-level finding", () => {
    // Only "src/foo.php" (not "src/Foo.php") is in newFiles -- picking the
    // FIRST case-colliding key alone (if it happens to be "src/Foo.php")
    // would wrongly report this file-level finding as pre-existing debt and
    // drop it, even though the diff's newFiles signal marks the colliding
    // path as genuinely new.
    const findings = [
      finding({ file: "C:\\repo\\src\\FOO.PHP", line: null, message: "missing file doc comment" }),
    ];
    const addedLines = new Map([
      ["src/Foo.php", new Set([3])],
      ["src/foo.php", new Set([9])],
    ]);
    // R4-FIX5 SUPERSEDES the union here too, and the original intent is intact:
    // the file-level finding is still NOT dropped as pre-existing debt. It is
    // now flagged instead of pinned to whichever colliding key happened to be
    // in `newFiles`, since the report cannot distinguish the two files.
    const result = filterFindings(findings, addedLines, "C:\\repo", new Set(["src/foo.php"]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ line: null, unattributed: true });
  });

  it("R3-FIX4: an ordinary POSIX path starting //?/ (a legal '?' filename character, not a Windows extended-length prefix) is NOT stripped into a coincidental false match", () => {
    // On POSIX, `?` is a perfectly legal filename character -- "//?/repo/src.php"
    // literally names a file under a directory called "?", not a Windows \\?\
    // escape. The OLD code stripped the "//?/" unconditionally, turning the
    // finding's path into the bare string "repo/src.php" -- which then
    // coincidentally collides with the unrelated worktree "repo" and gets
    // WRONGLY matched/attributed to "src.php" there, even though the raw path
    // never actually named anything under that worktree at all. The fix must
    // leave the "//?/" alone (it is neither a drive-letter nor a UNC form), so
    // the path correctly fails to resolve under the worktree and is kept,
    // flagged unattributed, instead of silently mismatched to the wrong file.
    const findings = [finding({ file: "//?/repo/src.php", line: 3, message: "literal question-mark dir" })];
    const addedLines = new Map([["src.php", new Set([3])]]);
    const result = filterFindings(findings, addedLines, "repo", new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ unattributed: true, message: "literal question-mark dir" });
  });
});

describe("R4-FIX5: an ambiguous case-colliding path is unattributed, not attributed", () => {
  const collide = () =>
    new Map([
      ["src/Foo.php", new Set([10])],
      ["SRC/foo.php", new Set([20])],
    ]);

  it("does not attribute a finding to one of two files that merely share a folded name", () => {
    // Round 3 unioned the two line sets, so a finding at line 10 was kept as if
    // it belonged to whichever key came first -- an answer the input cannot
    // support. Keep it (nothing lost) but flag it (nothing falsely pinned).
    const result = filterFindings(
      [finding({ file: "C:\\repo\\SRC\\FOO.PHP", line: 10, message: "ambiguous" })],
      collide(),
      "C:\\repo",
      new Set(),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ unattributed: true, message: "ambiguous" });
  });

  it("keeps an ambiguous file-level finding too, rather than resolving it by guess", () => {
    const result = filterFindings(
      [finding({ file: "C:\\repo\\SRC\\FOO.PHP", line: null, message: "file level" })],
      collide(),
      "C:\\repo",
      new Set(["src/Foo.php"]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ unattributed: true });
  });

  it("a SINGLE case-insensitive match still resolves normally", () => {
    const result = filterFindings(
      [finding({ file: "C:\\repo\\SRC\\FOO.PHP", line: 10, message: "unambiguous" })],
      new Map([["src/Foo.php", new Set([10])]]),
      "C:\\repo",
      new Set(),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "src/Foo.php", unattributed: false });
  });
});

describe("R5-FIX1: a new file with NO added lines still owns its file-level findings", () => {
  it("keeps a file-level finding on a new but EMPTY file (no hunk, so no added lines)", () => {
    // A binary addition has no hunk at all, and neither does a new zero-byte
    // file -- both land in newFiles with no entry in addedLines. The `!added`
    // bail used to run first and discard the finding for a file the worker had
    // just created.
    const result = filterFindings(
      [finding({ file: "C:\\repo\\includes\\empty.php", line: null, message: "missing file doc comment" })],
      new Map(),
      "C:\\repo",
      new Set(["includes/empty.php"]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "includes/empty.php", unattributed: false });
  });

  it("still drops a file-level finding on an untouched file", () => {
    const result = filterFindings(
      [finding({ file: "C:\\repo\\includes\\old.php", line: null, message: "pre-existing" })],
      new Map(),
      "C:\\repo",
      new Set(),
    );
    expect(result).toEqual([]);
  });
});

describe("R6-FIX1: a new file present only in newFiles resolves case-insensitively", () => {
  it("keeps a file-level finding whose report path differs in case from the newFiles key", () => {
    const result = filterFindings(
      [finding({ file: "C:\\repo\\ASSET.PHP", line: null, message: "missing file doc comment" })],
      new Map(),
      "C:\\repo",
      new Set(["asset.php"]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "asset.php", unattributed: false });
  });
});
