import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNative } from "./native.js";
import { createGit, type Git } from "./git.js";

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
});
