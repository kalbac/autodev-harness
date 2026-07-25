import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSeedFiles, applySeedOverlay } from "./seed-overlay.js";

let seed: string;
let repo: string;

beforeEach(() => {
  seed = mkdtempSync(join(tmpdir(), "adh-seed-"));
  repo = mkdtempSync(join(tmpdir(), "adh-seedrepo-"));
});
afterEach(() => {
  rmSync(seed, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("collectSeedFiles", () => {
  it("lists nested files as sorted, /-separated relative paths", async () => {
    write(seed, "b.php", "b");
    write(seed, "includes/a.php", "a");
    write(seed, "includes/deep/c.php", "c");

    expect(await collectSeedFiles(seed)).toEqual(["b.php", "includes/a.php", "includes/deep/c.php"]);
  });

  it("returns [] for an empty seed (a case whose premise IS the pristine baseline)", async () => {
    expect(await collectSeedFiles(seed)).toEqual([]);
  });

  it("skips the .gitkeep placeholder that lets git track an empty seed", async () => {
    write(seed, ".gitkeep", "");
    expect(await collectSeedFiles(seed)).toEqual([]);
  });

  it("throws when the seed directory does not exist", async () => {
    await expect(collectSeedFiles(join(seed, "nope"))).rejects.toThrow(/not a directory/);
  });

  it("throws when the seed path is a FILE, not a directory", async () => {
    write(seed, "f.txt", "x");
    await expect(collectSeedFiles(join(seed, "f.txt"))).rejects.toThrow(/not a directory/);
  });

  it("refuses a symlink inside the seed rather than following it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "adh-seed-out-"));
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(seed, "link.txt"), "file");

    await expect(collectSeedFiles(seed)).rejects.toThrow(/is a symlink/);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("applySeedOverlay", () => {
  it("copies every seed file into the repo and returns what it wrote", async () => {
    write(seed, "includes/class-x.php", "<?php // seeded");

    const written = await applySeedOverlay(seed, repo);

    expect(written).toEqual(["includes/class-x.php"]);
    expect(readFileSync(join(repo, "includes", "class-x.php"), "utf8")).toBe("<?php // seeded");
  });

  it("overwrites an existing regular file (a bugfix case seeds a broken version of it)", async () => {
    write(repo, "x.php", "old");
    write(seed, "x.php", "new");

    await applySeedOverlay(seed, repo);

    expect(readFileSync(join(repo, "x.php"), "utf8")).toBe("new");
  });

  it("writes nothing and returns [] for an empty seed", async () => {
    expect(await applySeedOverlay(seed, repo)).toEqual([]);
    expect(readdirSync(repo)).toEqual([]);
  });

  it("refuses to write THROUGH a symlinked destination file — nothing escapes the repo", async () => {
    const outside = mkdtempSync(join(tmpdir(), "adh-seed-dest-"));
    writeFileSync(join(outside, "target.txt"), "original");
    symlinkSync(join(outside, "target.txt"), join(repo, "x.php"), "file");
    write(seed, "x.php", "seeded");

    await expect(applySeedOverlay(seed, repo)).rejects.toThrow(/not a regular file/);
    expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("original");
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a symlinked ANCESTOR directory — the last-segment check alone would miss it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "adh-seed-anc-"));
    // 'junction' works without admin rights on Windows; a plain dir symlink on POSIX.
    symlinkSync(outside, join(repo, "includes"), "junction");
    write(seed, "includes/class-x.php", "seeded");

    await expect(applySeedOverlay(seed, repo)).rejects.toThrow(/is not a real directory/);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a destination that is a DIRECTORY of the same name", async () => {
    mkdirSync(join(repo, "x.php"));
    write(seed, "x.php", "seeded");

    await expect(applySeedOverlay(seed, repo)).rejects.toThrow(/not a regular file/);
  });

  it("creates missing parent directories for a nested seed file", async () => {
    write(seed, "a/b/c/d.php", "deep");

    await applySeedOverlay(seed, repo);

    expect(existsSync(join(repo, "a", "b", "c", "d.php"))).toBe(true);
  });
});
