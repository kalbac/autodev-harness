import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNative } from "./native.js";
import { createGit, diffFileNames, mainTreeStatus, type Git } from "./git.js";

let repoRoot: string;
let git: Git;

async function initRepo(dir: string): Promise<void> {
  let r = await runNative("git", ["init", "-b", "main"], { cwd: dir });
  if (r.exitCode !== 0) {
    // Older git without -b support: init then rename branch.
    r = await runNative("git", ["init"], { cwd: dir });
    if (r.exitCode !== 0) throw new Error(`git init failed: ${r.stderr}`);
    await runNative("git", ["branch", "-m", "main"], { cwd: dir });
  }
  await runNative("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runNative("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a1\n");
  writeFileSync(join(dir, "b.txt"), "b1\n");
  await runNative("git", ["add", "-A"], { cwd: dir });
  const c = await runNative("git", ["commit", "-m", "initial"], { cwd: dir });
  if (c.exitCode !== 0) throw new Error(`initial commit failed: ${c.stderr}`);
}

let extraWorktrees: string[] = [];

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), "adh-git-"));
  await initRepo(repoRoot);
  git = createGit(repoRoot);
  extraWorktrees = [];
});

afterEach(async () => {
  for (const wt of extraWorktrees) {
    await runNative("git", ["worktree", "remove", "--force", wt], { cwd: repoRoot });
  }
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("createGit", () => {
  it("currentBranch returns the checked-out branch", async () => {
    expect(await git.currentBranch()).toBe("main");
  });

  it("diffText scoped to a path excludes other files' changes", async () => {
    writeFileSync(join(repoRoot, "a.txt"), "a1\nCHANGED-A\n");
    writeFileSync(join(repoRoot, "b.txt"), "b1\nCHANGED-B\n");
    const scoped = await git.diffText(["a.txt"]);
    expect(scoped).toContain("CHANGED-A");
    expect(scoped).not.toContain("CHANGED-B");
  });

  it("changedFiles lists modified paths, optionally scoped", async () => {
    writeFileSync(join(repoRoot, "a.txt"), "a1\nCHANGED-A\n");
    writeFileSync(join(repoRoot, "b.txt"), "b1\nCHANGED-B\n");
    const all = await git.changedFiles();
    expect(all.sort()).toEqual(["a.txt", "b.txt"]);
    const scoped = await git.changedFiles(["a.txt"]);
    expect(scoped).toEqual(["a.txt"]);
  });

  it("add + commit stages and creates a commit, returning its hash", async () => {
    writeFileSync(join(repoRoot, "a.txt"), "a1\nCHANGED-A\n");
    await git.add(["a.txt"]);
    const hash = await git.commit("update a");
    expect(hash).toMatch(/^[0-9a-f]{7,40}$/);
    const log = await runNative("git", ["log", "--format=%H", "-1"], { cwd: repoRoot });
    expect(log.stdout.trim().startsWith(hash) || hash.startsWith(log.stdout.trim())).toBe(true);
  });

  it("worktreeAdd creates an isolated working dir on a new branch; worktreeRemove cleans it", async () => {
    const wtPath = join(tmpdir(), `adh-git-wt-${Date.now()}`);
    extraWorktrees.push(wtPath);
    await git.worktreeAdd(wtPath, "feature/x", "main");
    expect(existsSync(join(wtPath, "a.txt"))).toBe(true);
    const wtGit = createGit(wtPath);
    expect(await wtGit.currentBranch()).toBe("feature/x");

    await git.worktreeRemove(wtPath);
    expect(existsSync(wtPath)).toBe(false);
    extraWorktrees = extraWorktrees.filter((w) => w !== wtPath);
  });

  it("merge() reports a conflict, aborts, and leaves the tree clean", async () => {
    const wtPath = join(tmpdir(), `adh-git-wt-conflict-${Date.now()}`);
    extraWorktrees.push(wtPath);
    await git.worktreeAdd(wtPath, "feature/conflict", "main");

    // Conflicting edit to the same line in main and in the worktree branch.
    writeFileSync(join(repoRoot, "a.txt"), "MAIN-CHANGE\n");
    await git.add(["a.txt"]);
    await git.commit("main changes a.txt");

    writeFileSync(join(wtPath, "a.txt"), "WORKTREE-CHANGE\n");
    const wtGit = createGit(wtPath);
    await wtGit.add(["a.txt"]);
    await wtGit.commit("worktree changes a.txt");

    const result = await git.merge("feature/conflict");
    expect(result).toEqual({ ok: false, conflict: true });

    const status = await runNative("git", ["status", "--porcelain=v1"], { cwd: repoRoot });
    expect(status.stdout.trim()).toBe("");
    const content = readFileSync(join(repoRoot, "a.txt"), "utf8");
    expect(content).not.toContain("<<<<<<<");
  });

  it("merge() succeeds cleanly for a non-conflicting branch", async () => {
    const wtPath = join(tmpdir(), `adh-git-wt-clean-${Date.now()}`);
    extraWorktrees.push(wtPath);
    await git.worktreeAdd(wtPath, "feature/clean", "main");

    writeFileSync(join(wtPath, "c.txt"), "c1\n");
    const wtGit = createGit(wtPath);
    await wtGit.add(["c.txt"]);
    await wtGit.commit("add c.txt");

    const result = await git.merge("feature/clean");
    expect(result).toEqual({ ok: true, conflict: false });
    expect(existsSync(join(repoRoot, "c.txt"))).toBe(true);
  });

  it("merge() throws a real error for a non-existent branch instead of reporting a conflict", async () => {
    await expect(git.merge("no-such-branch")).rejects.toThrow(/git merge failed/i);
    const status = await runNative("git", ["status", "--porcelain=v1"], { cwd: repoRoot });
    expect(status.stdout.trim()).toBe("");
  });

  it("init creates a repo in an empty dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adh-init-"));
    try {
      const g = createGit(dir);
      await g.init();
      expect(existsSync(join(dir, ".git"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("commitEmpty establishes HEAD even with no configured user (baked identity)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adh-empty-"));
    try {
      const g = createGit(dir);
      await g.init();
      const sha = await g.commitEmpty("chore: initialize autodev project");
      expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
      // No user.email/user.name configured in this repo — commit must still succeed.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("listBranches lists local branches; createBranch + checkoutBranch switch", async () => {
    // Harness repo starts on `main` with one commit.
    await git.createBranch("autodev/main");
    expect(await git.currentBranch()).toBe("autodev/main");
    const branches = await git.listBranches();
    expect(branches).toEqual(expect.arrayContaining(["main", "autodev/main"]));
    await git.checkoutBranch("main");
    expect(await git.currentBranch()).toBe("main");
  });

  it("countUntracked counts only untracked (??) entries", async () => {
    expect(await git.countUntracked()).toBe(0);
    writeFileSync(join(repoRoot, "new-untracked.txt"), "x\n");
    expect(await git.countUntracked()).toBe(1);
  });
});

describe("mainTreeStatus", () => {
  it("returns [] on a clean tree", async () => {
    expect(await mainTreeStatus(repoRoot)).toEqual([]);
  });

  it("reports a tracked-but-modified file (code contains M) and an untracked file (code ??), with paths", async () => {
    writeFileSync(join(repoRoot, "a.txt"), "a1\nCHANGED\n"); // tracked, worktree-modified
    writeFileSync(join(repoRoot, "u.txt"), "u\n"); // untracked
    const entries = await mainTreeStatus(repoRoot);
    const byPath = new Map(entries.map((e) => [e.path, e.code]));
    expect(byPath.get("a.txt")).toMatch(/M/);
    expect(byPath.get("u.txt")).toBe("??");
    expect(entries).toHaveLength(2);
  });

  it("uses the NEW path for a rename record (old -> new), for churn classification/hints", async () => {
    await runNative("git", ["mv", "a.txt", "renamed.txt"], { cwd: repoRoot });
    const entries = await mainTreeStatus(repoRoot);
    const renamed = entries.find((e) => e.path === "renamed.txt");
    expect(renamed).toBeDefined(); // parsed the destination, not "a.txt -> renamed.txt"
    expect(renamed!.code).toMatch(/R/);
    expect(entries.some((e) => e.path.includes(" -> "))).toBe(false);
  });

  it("classifies a tracked churn file as NOT untracked (drives the skip-worktree hint)", async () => {
    // A committed .serena/project.yml is the s31 case: tracked, so .git/info/exclude
    // cannot neutralize it — it must be reported with a non-?? code.
    writeFileSync(join(repoRoot, "a.txt"), "a1\nedit\n");
    await runNative("git", ["add", "a.txt"], { cwd: repoRoot });
    const entries = await mainTreeStatus(repoRoot);
    const a = entries.find((e) => e.path === "a.txt");
    expect(a).toBeDefined();
    expect(a!.code).not.toBe("??");
  });
});

describe("diff context width (#123) + diffFileNames", () => {
  it("widens the unified-diff context so a declaration outside the hunk is still visible", async () => {
    // 30 lines, edit line 30 only. With git's default -U3 the top of the file is
    // outside the window; this is the shape that made the critic's clean verdict
    // unreachable (docs/gotchas/critic-sees-only-the-diff-hunk.md).
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    writeFileSync(join(repoRoot, "wide.txt"), `${lines.join("\n")}\n`);
    await runNative("git", ["add", "wide.txt"], { cwd: repoRoot });
    await runNative("git", ["commit", "-m", "wide"], { cwd: repoRoot });
    lines[29] = "line30-edited";
    writeFileSync(join(repoRoot, "wide.txt"), `${lines.join("\n")}\n`);

    const narrow = await git.diffText(["wide.txt"]);
    expect(narrow).not.toContain("line1\n"); // the declaration end of the file is invisible

    const wide = await git.diffText(["wide.txt"], { contextLines: 25 });
    expect(wide).toContain("line5"); // 25 lines of context reach back far enough
    expect(wide).toContain("+line30-edited");
  });

  it("REFUSES a contextLines value git would misparse, instead of shipping it", async () => {
    // -U-5 becomes a flag and -UNaN is a fatal: a bad value must fail here, where it
    // is still nameable, not deep inside a git invocation mid-run.
    await expect(git.diffText(["a.txt"], { contextLines: -5 })).rejects.toThrow(/non-negative safe integer/);
    await expect(git.diffText(["a.txt"], { contextLines: Number.NaN })).rejects.toThrow(
      /non-negative safe integer/,
    );
    await expect(git.diffText(["a.txt"], { contextLines: 1.5 })).rejects.toThrow(/non-negative safe integer/);
    // 0 IS a bound (a context-free diff), so it must be accepted, not rejected.
    writeFileSync(join(repoRoot, "a.txt"), "a1\nmore\n");
    await expect(git.diffText(["a.txt"], { contextLines: 0 })).resolves.toContain("+more");
  });

  it("diffFileNames lists exactly the files diffText renders, for the same scope", async () => {
    writeFileSync(join(repoRoot, "a.txt"), "a1\nedited\n");
    writeFileSync(join(repoRoot, "b.txt"), "b1\nedited\n");
    expect(await diffFileNames(repoRoot)).toEqual(["a.txt", "b.txt"]);
    // Scoped: the attachment set must never be wider than the diff the critic reads.
    expect(await diffFileNames(repoRoot, ["a.txt"])).toEqual(["a.txt"]);
    const scopedDiff = await git.diffText(["a.txt"]);
    expect(scopedDiff).toContain("a.txt");
    expect(scopedDiff).not.toContain("b.txt");
  });

  it("returns a non-ASCII path in literal UTF-8, not git's octal-escaped wire form", async () => {
    // An octal-escaped path (`"\321\204.txt"`) would not open, so the file would be
    // reported to the critic as unreadable when it is perfectly readable.
    const name = "файл.txt";
    writeFileSync(join(repoRoot, name), "x\n");
    await runNative("git", ["add", "--", name], { cwd: repoRoot });
    await runNative("git", ["commit", "-m", "cyrillic"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, name), "x\ny\n");
    const names = await diffFileNames(repoRoot);
    expect(names).toContain(name);
    expect(names.some((n) => n.startsWith('"'))).toBe(false);
  });
});
