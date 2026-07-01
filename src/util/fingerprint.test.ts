import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesSha256, snapshot, workerTouched, strayChanged, forbiddenTouches } from "./fingerprint.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "adh-fp-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("bytesSha256", () => {
  it("is stable and lowercase hex for the same bytes", () => {
    const a = bytesSha256(Buffer.from("hello"));
    const b = bytesSha256(Buffer.from("hello"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different hash for different bytes", () => {
    const a = bytesSha256(Buffer.from("hello"));
    const b = bytesSha256(Buffer.from("world"));
    expect(a).not.toBe(b);
  });
});

describe("snapshot", () => {
  it("hashes a present file, marks an absent path, and keys by the raw path", () => {
    mkdirSync(join(repoRoot, ".autodev"), { recursive: true });
    writeFileSync(join(repoRoot, ".autodev", "x"), "content");
    const map = snapshot(repoRoot, [".autodev/x", "missing/nope.ts"]);
    expect(map.get(".autodev/x")).toMatch(/^[0-9a-f]{64}$/);
    expect(map.get("missing/nope.ts")).toBe("<absent>");
  });
});

describe("workerTouched", () => {
  it("detects a new key, a changed value, excludes an unchanged key, and ignores baseline-only keys", () => {
    const baseline = new Map([
      ["a.ts", "hashA"],
      ["b.ts", "hashB"],
      ["onlyInBaseline.ts", "hashX"],
    ]);
    const now = new Map([
      ["a.ts", "hashA"], // unchanged
      ["b.ts", "hashB2"], // changed
      ["c.ts", "hashC"], // new
    ]);
    const result = workerTouched(baseline, now);
    expect(result.sort()).toEqual(["b.ts", "c.ts"]);
    expect(result).not.toContain("onlyInBaseline.ts");
  });

  it("divergence #3: an already-dirty out-of-scope file edited further is still caught", () => {
    // Baseline: `other/x.ts` was already dirty BEFORE the worker ran.
    const baseline = new Map([["other/x.ts", "hashA"]]);
    // After the worker: the file's content changed again (a naive path-set diff
    // would miss this, since the path was "changed" both before and after).
    const now = new Map([["other/x.ts", "hashB"]]);
    const touched = workerTouched(baseline, now);
    expect(touched).toEqual(["other/x.ts"]);

    const stray = strayChanged(touched, ["src/owned.ts"], [".autodev/"]);
    expect(stray).toEqual(["other/x.ts"]);
  });
});

describe("strayChanged", () => {
  it("excludes a file exactly in fileSet, excludes files under an ignore prefix, respects boundary safety", () => {
    const touched = ["src/owned.ts", ".autodev/runtime/scratch.log", ".autodev/runtimeX", "other/stray.ts"];
    const result = strayChanged(touched, ["src/owned.ts"], [".autodev/runtime/"]);
    expect(result).not.toContain("src/owned.ts");
    expect(result).not.toContain(".autodev/runtime/scratch.log");
    expect(result).toContain("autodev/runtimeX"); // normalized: leading "." stripped
    expect(result).toContain("other/stray.ts");
  });

  it("normalizes fileSet entries with a leading ./ before comparing", () => {
    const result = strayChanged(["src/a.ts"], ["./src/a.ts"], []);
    expect(result).toEqual([]);
  });
});

describe("forbiddenTouches", () => {
  it("matches a changed file against a forbidden glob and returns the normalized path", () => {
    const result = forbiddenTouches(["docs/x-policy.md"], ["**/*-policy.md"]);
    expect(result).toEqual(["docs/x-policy.md"]);
  });

  it("returns [] when forbiddenGlobs is empty", () => {
    expect(forbiddenTouches(["docs/x-policy.md"], [])).toEqual([]);
  });

  it("normalizes the path BEFORE matching so a './'-prefixed forbidden touch is still caught (parity Test-GlobMatch)", () => {
    // A naive raw-path match against `docs/*-policy.md` would miss the leading
    // './' and fail-open; PS normalizes both sides before matching.
    const result = forbiddenTouches(["./docs/x-policy.md"], ["docs/*-policy.md"]);
    expect(result).toEqual(["docs/x-policy.md"]);
  });
});
