import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectEvidence,
  collectCriticEvidence,
  summarizeEvidence,
  DEFAULT_EVIDENCE_LIMITS,
  MAX_EVIDENCE_BYTES_PER_FILE,
  MAX_EVIDENCE_BYTES_TOTAL,
  type EvidenceCandidate,
} from "./evidence.js";

const text = (path: string, content: string): EvidenceCandidate => ({ path, kind: "text", content });

describe("selectEvidence (pure budget pass)", () => {
  it("attaches everything that fits, in a stable path order", () => {
    const ev = selectEvidence([text("b.php", "bb"), text("a.php", "a"), text("c.php", "ccc")]);
    expect(ev.attached.map((a) => a.path)).toEqual(["a.php", "b.php", "c.php"]);
    expect(ev.omitted).toEqual([]);
    // Byte counts are measured from the CONTENT, which is what the prompt renders.
    expect(ev.attached.map((a) => a.bytes)).toEqual([1, 2, 3]);
  });

  it("measures bytes as UTF-8, not as string length", () => {
    // "é" is one JS char but two UTF-8 bytes -- budgeting on `.length` would let a
    // file through that is nearly twice the size the critic actually receives.
    const ev = selectEvidence([text("a.php", "ééé")], { perFileBytes: 5, totalBytes: 100 });
    expect(ev.attached).toEqual([]);
    expect(ev.omitted).toEqual([{ path: "a.php", reason: "too-large", bytes: 6 }]);
  });

  it("OMITS an over-budget file whole -- it is never truncated", () => {
    const ev = selectEvidence([text("big.php", "x".repeat(100))], { perFileBytes: 10, totalBytes: 1000 });
    expect(ev.attached).toEqual([]);
    expect(ev.omitted).toEqual([{ path: "big.php", reason: "too-large", bytes: 100 }]);
    // The point of the rule: no partial content anywhere in the result.
    expect(JSON.stringify(ev)).not.toContain("xxx");
  });

  it("keeps scanning after a total-budget overflow, so a later small file still fits", () => {
    const ev = selectEvidence(
      [text("a.php", "x".repeat(8)), text("b.php", "x".repeat(8)), text("c.php", "xx")],
      { perFileBytes: 100, totalBytes: 10 },
    );
    expect(ev.attached.map((a) => a.path)).toEqual(["a.php", "c.php"]);
    expect(ev.omitted).toEqual([{ path: "b.php", reason: "budget-exhausted", bytes: 8 }]);
  });

  it("passes an already-decided omission through with its reason intact", () => {
    const ev = selectEvidence([{ path: "gone.php", kind: "omit", reason: "absent", bytes: null }]);
    expect(ev.attached).toEqual([]);
    expect(ev.omitted).toEqual([{ path: "gone.php", reason: "absent", bytes: null }]);
  });

  it("attaches an EMPTY file rather than treating it as nothing", () => {
    // An empty file is real evidence ("this file is empty"), and `bytes: 0` must not
    // be confused with `bytes: null` ("size unknown").
    const ev = selectEvidence([text("empty.php", "")]);
    expect(ev.attached).toEqual([{ path: "empty.php", bytes: 0, content: "" }]);
  });

  it("THROWS on a duplicate path instead of silently picking one version", () => {
    expect(() => selectEvidence([text("a.php", "one"), text("a.php", "two")])).toThrow(/duplicate path/);
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

  it("skips a blank path instead of resolving it to the worktree ROOT", async () => {
    // `resolve(root, "")` is the root directory itself
    // (docs/gotchas/empty-path-resolves-to-repo-root.md) -- a blank entry must never
    // reach the reader, and there is nothing to tell the critic about it either.
    const ev = await collectCriticEvidence(root, ["", "   "]);
    expect(ev).toEqual({ attached: [], omitted: [] });
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
