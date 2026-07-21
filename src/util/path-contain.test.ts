import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { canonicalPathContains, realpathContains } from "./path-contain.js";

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

describe("canonicalPathContains (fix 3 — drive-root / UNC trailing-separator false reject)", () => {
  it("accepts a legitimate child when root carries a trailing separator (portable — no real drive root needed)", () => {
    // Simulates a canonical Windows drive root (`C:\`) or UNC share root, which
    // `realpath` returns WITH its trailing separator intact -- unlike an ordinary
    // directory. Before the fix, `canonicalRoot + sep` on an already-`sep`-terminated
    // root doubles the separator and rejects every real child as "escaped".
    const root = `C:${sep}`;
    const child = `C:${sep}repo${sep}file.txt`;

    expect(canonicalPathContains(root, child)).toBe(true);
  });

  it("still rejects a real escape when root carries a trailing separator (the fix must not go permissive)", () => {
    const root = `C:${sep}`;
    const sibling = `D:${sep}other${sep}file.txt`;

    expect(canonicalPathContains(root, sibling)).toBe(false);
  });

  it("accepts the root path itself (candidate === root, both without trailing separator)", () => {
    expect(canonicalPathContains(`C:${sep}repo`, `C:${sep}repo`)).toBe(true);
  });

  it("rejects a sibling directory whose name merely starts with the root's name (no trailing-sep false accept)", () => {
    expect(canonicalPathContains(`C:${sep}repo`, `C:${sep}repo-evil${sep}file.txt`)).toBe(false);
  });
});

describe("canonicalPathContains (round-3 fix 2 — case sensitivity is platform-dependent, not hardcoded)", () => {
  // The `platform` param is injected explicitly so these are deterministic on BOTH
  // CI platforms regardless of which OS actually runs the suite — we are testing the
  // function's internal branch, not real OS path-casing behavior, so the real `sep`
  // (from "node:path", which DOES reflect the actual runtime OS) is still used to build
  // the fixture strings; only the case-fold branch itself is forced.
  it("win32 semantics: a root and child differing only in case ARE contained (case-insensitive fold)", () => {
    const root = `C:${sep}Repo`;
    const child = `c:${sep}repo${sep}file.txt`;

    expect(canonicalPathContains(root, child, "win32")).toBe(true);
  });

  it("POSIX semantics: a root and child differing only in case are NOT contained (case-sensitive — folding here would be a genuine security weakening, two differently-cased paths on POSIX really are different files)", () => {
    const root = `${sep}Repo`;
    const child = `${sep}repo${sep}file.txt`;

    expect(canonicalPathContains(root, child, "linux")).toBe(false);
  });

  it("win32 semantics: a real escape (different path entirely) is still rejected even with case-folding on", () => {
    const root = `C:${sep}Repo`;
    const sibling = `D:${sep}Other${sep}file.txt`;

    expect(canonicalPathContains(root, sibling, "win32")).toBe(false);
  });

  it("defaults to the actual process.platform when no platform is passed (production call sites never pass one)", () => {
    // Sanity check that omitting the param doesn't throw and matches the real
    // platform's expected semantics for a same-case pair (case-fold is a no-op here).
    expect(canonicalPathContains(`C:${sep}repo`, `C:${sep}repo${sep}file.txt`)).toBe(true);
  });
});

describe("canonicalPathContains (round-3 fix 3 — strip ALL trailing separators, not just one)", () => {
  it("a root with TWO trailing separators still accepts a legitimate child", () => {
    const root = `C:${sep}repo${sep}${sep}`; // pathological double-trailing-separator canonical root
    const child = `C:${sep}repo${sep}file.txt`;

    expect(canonicalPathContains(root, child)).toBe(true);
  });

  it("a root with TWO trailing separators still rejects a real escape", () => {
    const root = `C:${sep}repo${sep}${sep}`;
    const sibling = `D:${sep}other${sep}file.txt`;

    expect(canonicalPathContains(root, sibling)).toBe(false);
  });

  it("a pathological all-separators root does not swallow arbitrary paths (fail-CLOSED, not fail-open)", () => {
    const root = `${sep}${sep}${sep}`; // nothing but separators -- stripping ALL of them yields ""
    const arbitrary = `${sep}etc${sep}passwd`;

    expect(canonicalPathContains(root, arbitrary)).toBe(false);
  });

  it("a pathological all-separators root does not even match itself (no empty-string prefix wildcard)", () => {
    const root = `${sep}${sep}${sep}`;

    expect(canonicalPathContains(root, root)).toBe(false);
  });
});

describe("realpathContains (fix 2/3 — shared realpath-containment primitive)", () => {
  it("resolves true for a real child directory nested inside root", async () => {
    const root = tmpDir("adh-contain-root-");
    mkdirSync(join(root, "child"), { recursive: true });

    await expect(realpathContains(root, join(root, "child"))).resolves.toBe(true);
  });

  it("resolves false for a sibling directory outside root", async () => {
    const root = tmpDir("adh-contain-root-");
    const outside = tmpDir("adh-contain-outside-");

    await expect(realpathContains(root, outside)).resolves.toBe(false);
  });

  it("resolves false (never throws) when the candidate does not exist", async () => {
    const root = tmpDir("adh-contain-root-");

    await expect(realpathContains(root, join(root, "does-not-exist"))).resolves.toBe(false);
  });

  it("follows an intermediate symlinked directory to its REAL target and rejects it as escaped", async () => {
    const root = tmpDir("adh-contain-root-");
    const outside = tmpDir("adh-contain-outside-");
    mkdirSync(join(outside, "deep"), { recursive: true });
    symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");

    // Lexically "root/link/deep" looks contained; its REAL location is `outside/deep`.
    await expect(realpathContains(root, join(root, "link", "deep"))).resolves.toBe(false);
  });
});
