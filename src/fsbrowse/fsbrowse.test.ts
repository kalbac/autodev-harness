import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirs, type FsBrowseDeps } from "./fsbrowse.js";

let base: string;

const deps = (registered: string[] = []): FsBrowseDeps => ({
  isRegistered: async (p) => registered.some((r) => r.toLowerCase() === p.toLowerCase()),
});

beforeEach(() => {
  // realpathSync.native: on macOS/Windows tmpdir itself may be a symlink/8.3 alias.
  // The NATIVE variant is required on Windows CI — the GitHub runner's tmpdir is an
  // 8.3 short path (C:\Users\RUNNER~1\...), and only realpathSync.native expands it to
  // the long form that listDirs' `fs.promises.realpath` (also native) returns; the
  // non-native realpathSync leaves the 8.3 alias in place, so the two would diverge.
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "adh-fsb-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("listDirs", () => {
  it("lists only directories, sorted by name, never files", async () => {
    mkdirSync(join(base, "beta"));
    mkdirSync(join(base, "alpha"));
    writeFileSync(join(base, "file.txt"), "x");

    const res = await listDirs(base, deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
    expect(res.path).toBe(base);
  });

  it("annotates isGitRepo (a .git dir OR a .git file both count)", async () => {
    mkdirSync(join(base, "repo", ".git"), { recursive: true });
    mkdirSync(join(base, "wt"));
    writeFileSync(join(base, "wt", ".git"), "gitdir: elsewhere");
    mkdirSync(join(base, "plain"));

    const res = await listDirs(base, deps());
    if (!res.ok) throw new Error("expected ok");
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(byName["repo"]!.isGitRepo).toBe(true);
    expect(byName["wt"]!.isGitRepo).toBe(true);
    expect(byName["plain"]!.isGitRepo).toBe(false);
  });

  it("annotates isRegistered via the injected registry check", async () => {
    mkdirSync(join(base, "reg"));
    mkdirSync(join(base, "unreg"));

    const res = await listDirs(base, deps([join(base, "reg")]));
    if (!res.ok) throw new Error("expected ok");
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(byName["reg"]!.isRegistered).toBe(true);
    expect(byName["unreg"]!.isRegistered).toBe(false);
  });

  it("includes a dir-symlink annotated with its resolved real target, never silently followed", async () => {
    const target = join(base, "real-target");
    mkdirSync(target);
    // 'junction' works without admin rights on Windows; plain dir symlink on POSIX.
    symlinkSync(target, join(base, "link"), "junction");

    const res = await listDirs(base, deps());
    if (!res.ok) throw new Error("expected ok");
    const link = res.entries.find((e) => e.name === "link");
    expect(link).toBeDefined();
    expect(link!.isSymlink).toBe(true);
    // path is the REAL target (canonicalized), so navigation continues on real paths
    expect(link!.path.toLowerCase()).toBe(target.toLowerCase());
  });

  it("skips a broken symlink entry-level (listing still succeeds)", async () => {
    mkdirSync(join(base, "ok"));
    symlinkSync(join(base, "gone"), join(base, "dangling"), "junction");

    const res = await listDirs(base, deps());
    if (!res.ok) throw new Error("expected ok");
    expect(res.entries.map((e) => e.name)).toEqual(["ok"]);
  });

  it("rejects a relative path with invalid_path", async () => {
    const res = await listDirs("relative/path", deps());
    expect(res).toMatchObject({ ok: false, code: "invalid_path" });
  });

  it("rejects a nonexistent path with invalid_path (400, never 500)", async () => {
    const res = await listDirs(join(base, "does-not-exist"), deps());
    expect(res).toMatchObject({ ok: false, code: "invalid_path" });
  });

  it("rejects a file path with invalid_path", async () => {
    writeFileSync(join(base, "f.txt"), "x");
    const res = await listDirs(join(base, "f.txt"), deps());
    expect(res).toMatchObject({ ok: false, code: "invalid_path" });
  });

  it("returns parent for a nested dir and null parent at a filesystem root", async () => {
    mkdirSync(join(base, "child"));
    const res = await listDirs(join(base, "child"), deps());
    if (!res.ok) throw new Error("expected ok");
    expect(res.parent).toBe(base);
  });

  it("no path on win32 yields the injected roots view; no path elsewhere lists /", async () => {
    const res = await listDirs(undefined, {
      ...deps(),
      platform: "win32",
      listRoots: async () => [base],
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.path).toBeNull();
    expect(res.parent).toBeNull();
    expect(res.entries.map((e) => e.path)).toEqual([base]);
  });
});
