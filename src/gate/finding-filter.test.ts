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
    const result = filterFindings(findings, addedLines, "C:\\repo\\worktree");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "includes/a.php", line: 3, unattributed: false });
  });

  it("normalizes an absolute POSIX path under the worktree and matches it against the diff", () => {
    const findings = [finding({ file: "/repo/worktree/includes/a.php", line: 5, message: "posix finding" })];
    const addedLines = new Map([["includes/a.php", new Set([5])]]);
    const result = filterFindings(findings, addedLines, "/repo/worktree");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: "includes/a.php", line: 5, unattributed: false });
  });

  it("keeps a finding that lands on an ADDED line", () => {
    const findings = [finding({ file: "/wt/includes/a.php", line: 13 })];
    const addedLines = new Map([["includes/a.php", new Set([13, 14])]]);
    const result = filterFindings(findings, addedLines, "/wt");
    expect(result).toHaveLength(1);
    expect(result[0]!.line).toBe(13);
  });

  it("drops a finding on a line the diff did NOT add, in a file the diff DID touch", () => {
    // This is the pre-existing-debt case: the worker touched includes/a.php
    // (line 13 is added), but this finding sits on line 1, which the worker
    // never wrote -- that debt predates the task and must not block it.
    const findings = [finding({ file: "/wt/includes/a.php", line: 1 })];
    const addedLines = new Map([["includes/a.php", new Set([13])]]);
    const result = filterFindings(findings, addedLines, "/wt");
    expect(result).toHaveLength(0);
  });

  it("drops a finding in a file the diff never touched at all", () => {
    const findings = [finding({ file: "/wt/includes/untouched.php", line: 1 })];
    const addedLines = new Map([["includes/a.php", new Set([13])]]);
    const result = filterFindings(findings, addedLines, "/wt");
    expect(result).toHaveLength(0);
  });

  it("KEEPS and flags unattributed:true a finding whose path cannot be attributed to any changed file", () => {
    // Fail-closed (Principle 10): a path that does not even resolve to
    // something under the worktree must not be silently dropped -- that would
    // be fail-OPEN, ignoring a possibly-real violation on the worker's own
    // lines. It is kept and loudly flagged instead.
    const findings = [finding({ file: "D:\\somewhere\\else\\entirely.php", line: 1, message: "orphan" })];
    const addedLines = new Map([["includes/a.php", new Set([13])]]);
    const result = filterFindings(findings, addedLines, "C:\\repo\\worktree");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ unattributed: true, message: "orphan" });
    // The raw, un-normalizable path is preserved verbatim -- it is the only
    // diagnostic the operator has for why attribution failed.
    expect(result[0]!.file).toBe("D:\\somewhere\\else\\entirely.php");
  });

  it("keeps a line-less (file-level) finding when the file is ENTIRELY new", () => {
    // "Entirely new" is determined from the added-line set alone (no other
    // input tells us this): the set is exactly {1..N} with no gaps, which is
    // exactly what addedLineNumbers() produces for a brand-new file, and is
    // also literally the rule's own definition -- "every line of it is in the
    // added set".
    const findings = [finding({ file: "/wt/includes/new.php", line: null, message: "missing file doc comment" })];
    const addedLines = new Map([["includes/new.php", new Set([1, 2, 3])]]);
    const result = filterFindings(findings, addedLines, "/wt");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ line: null, unattributed: false });
  });

  it("drops a line-less (file-level) finding on an EXISTING file (added lines are a strict subset)", () => {
    const findings = [finding({ file: "/wt/includes/a.php", line: null, message: "missing file doc comment" })];
    // Only line 13 was added -- the file is not entirely new, so a file-level
    // finding is by definition pre-existing debt.
    const addedLines = new Map([["includes/a.php", new Set([13])]]);
    const result = filterFindings(findings, addedLines, "/wt");
    expect(result).toHaveLength(0);
  });

  it("drops a line-less (file-level) finding whose added set has a gap (not a contiguous 1..N run)", () => {
    // A modified existing file can, by coincidence, have its LAST added line
    // number equal the line count -- e.g. lines {2,3} added to a 3-line file.
    // The contiguity check (must start at 1, no gaps) is exactly what tells
    // these two shapes apart from a brand-new file's {1,2,3}.
    const findings = [finding({ file: "/wt/includes/a.php", line: null })];
    const addedLines = new Map([["includes/a.php", new Set([2, 3])]]);
    const result = filterFindings(findings, addedLines, "/wt");
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
    const result = filterFindings(findings, addedLines, "/wt");
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
    const result = filterFindings(findings, addedLines, "/wt");
    expect(result.map((f) => f.message)).toEqual(["kept: added line", "kept: unattributed"]);
    expect(result.find((f) => f.message === "kept: unattributed")!.unattributed).toBe(true);
    expect(result.find((f) => f.message === "kept: added line")!.unattributed).toBe(false);
  });

  it("returns [] when there are no findings", () => {
    expect(filterFindings([], new Map(), "/wt")).toEqual([]);
  });
});
