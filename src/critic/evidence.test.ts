import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planEvidence,
  isProseOnlyChange,
  collectCriticEvidence,
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
    const ev = await collectCriticEvidence(root, ["a.php"], DEFAULT_EVIDENCE_LIMITS, {
      contains: async () => false,
    });
    expect(ev.attached).toEqual([]);
    expect(ev.omitted).toEqual([{ path: "a.php", reason: "unreadable", bytes: null }]);
  });

  it("refuses an over-size file WITHOUT reading it, reporting its real size", async () => {
    writeFileSync(join(root, "big.php"), "x".repeat(50));
    const ev = await collectCriticEvidence(root, ["big.php"], { perFileBytes: 10, totalBytes: 1000 });
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
    const ev = await collectCriticEvidence(root, ["big.php"], { perFileBytes: 400_000, totalBytes: 400_000 });
    expect(ev.omitted).toEqual([]);
    expect(ev.attached[0]!.content).toBe(body);
    expect(ev.attached[0]!.bytes).toBe(Buffer.byteLength(ev.attached[0]!.content, "utf8"));
  });

  it("never reads more than the total budget, however many files the diff touches", async () => {
    // The memory property, end to end: 40 files of 1 KB with a 4 KB budget must read
    // four of them, not forty (codex R1 finding 1).
    for (let i = 0; i < 40; i++) writeFileSync(join(root, `f${String(i).padStart(2, "0")}.php`), "x".repeat(1000));
    const paths = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, "0")}.php`);
    const ev = await collectCriticEvidence(root, paths, { perFileBytes: 64_000, totalBytes: 4000 });
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
    expect(ev).toEqual({ attached: [], omitted: [] });
  });

  it("a REJECTING containment seam omits that file, it does not abort the collection", async () => {
    // `NEVER throws` has to be true of the paths AROUND the try/catch too, not just
    // inside it (docs/gotchas/never-throws-catch-block-logging.md). An injected seam
    // that rejects used to escape and kill the whole evidence set (codex R2 finding 2).
    writeFileSync(join(root, "a.php"), "x\n");
    writeFileSync(join(root, "b.php"), "y\n");
    const ev = await collectCriticEvidence(root, ["a.php", "b.php"], DEFAULT_EVIDENCE_LIMITS, {
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

describe("summarizeEvidence", () => {
  it("names every omitted file and its reason, so a log line is actionable", () => {
    const line = summarizeEvidence({
      attached: [{ path: "a.php", bytes: 10, content: "x" }],
      omitted: [{ path: "b.png", reason: "not-text", bytes: null }],
    });
    expect(line).toContain("attached 1 file(s), 10 byte(s)");
    expect(line).toContain("b.png (not-text)");
  });
});

describe("isProseOnlyChange (the mechanical gate on adr/007's leniency)", () => {
  const add = (path: string, ...body: string[]): string =>
    [`diff --git a/${path} b/${path}`, `+++ b/${path}`, ...body.map((l) => `+${l}`)].join("\n");

  it("accepts a change that touches only prose files", () => {
    expect(isProseOnlyChange(["docs/OVERVIEW.md"], add("docs/OVERVIEW.md", "some prose"))).toBe(true);
    expect(isProseOnlyChange(["NOTES.txt", "docs/a.rst"], add("NOTES.txt", "x"))).toBe(true);
  });

  it("REFUSES as soon as one changed file is not prose", () => {
    // The determination is about the whole change, not the file the critic happens to
    // be looking at: one code file means the normal mandate applies to all of it.
    expect(isProseOnlyChange(["docs/a.md", "includes/x.php"], add("docs/a.md", "x"))).toBe(false);
  });

  it("REFUSES an unknown extension rather than assuming it is safe", () => {
    // Fail-closed: `.yml` (a workflow), `.sql` (a migration), `.env.example`, or no
    // extension at all are all "unknown risk", never "no risk".
    for (const p of [".github/workflows/ci.yml", "db/001.sql", "Makefile", "scripts/run"]) {
      expect(isProseOnlyChange([p], add(p, "x"))).toBe(false);
    }
  });

  it("REFUSES a prose file that adds a FENCED code block", () => {
    // codex's concrete counter-example against the first version of adr/007: a `.md`
    // whose fenced shell block a CI step executes is a code change wearing a prose
    // extension. Blunter than "does anything run this" -- and blunt in the safe direction.
    expect(isProseOnlyChange(["docs/ci.md"], add("docs/ci.md", "run:", "```sh", "./deploy.sh", "```"))).toBe(false);
    expect(isProseOnlyChange(["docs/ci.md"], add("docs/ci.md", "~~~python", "os.system('x')", "~~~"))).toBe(false);
    // Indented inside a list item -- still a fence.
    expect(isProseOnlyChange(["docs/ci.md"], add("docs/ci.md", "  - step:", "    ```sh", "    x", "    ```"))).toBe(false);
  });

  it("does not mistake a FILE HEADER for an added line", () => {
    // `+++ b/<path>` starts with `+` but is a header; treating it as content would be
    // the same class of bug `diff-lines.ts` documents at length.
    expect(isProseOnlyChange(["docs/a.md"], add("docs/a.md", "plain prose"))).toBe(true);
  });

  it("REFUSES an empty or blank path set — 'I do not know what changed' is not leniency", () => {
    expect(isProseOnlyChange([], "")).toBe(false);
    expect(isProseOnlyChange(["", "   "], "")).toBe(false);
  });

  it("matches the extension case-insensitively", () => {
    expect(isProseOnlyChange(["docs/README.MD"], add("docs/README.MD", "x"))).toBe(true);
  });
});
