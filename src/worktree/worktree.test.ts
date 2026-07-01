import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNative } from "../util/native.js";
import { createWorktreeManager, type Worktree, type WorktreeManager } from "./worktree.js";

let repoRoot: string;
let worktreesDir: string;
let manager: WorktreeManager;

async function initRepo(dir: string): Promise<void> {
  let r = await runNative("git", ["init", "-b", "main"], { cwd: dir });
  if (r.exitCode !== 0) {
    r = await runNative("git", ["init"], { cwd: dir });
    if (r.exitCode !== 0) throw new Error(`git init failed: ${r.stderr}`);
    await runNative("git", ["branch", "-m", "main"], { cwd: dir });
  }
  await runNative("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await runNative("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a1\n");
  await runNative("git", ["add", "-A"], { cwd: dir });
  const c = await runNative("git", ["commit", "-m", "initial"], { cwd: dir });
  if (c.exitCode !== 0) throw new Error(`initial commit failed: ${c.stderr}`);
}

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), "adh-wt-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "adh-wt-dir-"));
  await initRepo(repoRoot);
  manager = createWorktreeManager(repoRoot, worktreesDir);
});

afterEach(async () => {
  // Best-effort cleanup of any worktrees still registered before removing dirs.
  const list = await runNative("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  for (const line of list.stdout.split("\n")) {
    const m = /^worktree (.+)$/.exec(line.trim());
    if (m && m[1] && m[1] !== repoRoot.replace(/\\/g, "/") && !m[1].endsWith(repoRoot)) {
      await runNative("git", ["worktree", "remove", "--force", m[1]], { cwd: repoRoot });
    }
  }
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

describe("createWorktreeManager", () => {
  it("create() yields an isolated dir on branch autodev/wt-<id>; edits stay isolated until merged", async () => {
    const wt = await manager.create("task1", "main");
    expect(wt.taskId).toBe("task1");
    expect(wt.branch).toBe("autodev/wt-task1");
    expect(existsSync(wt.path)).toBe(true);

    writeFileSync(join(wt.path, "new-file.txt"), "hello\n");
    const wtGit = (await import("../util/git.js")).createGit(wt.path);
    await wtGit.add(["new-file.txt"]);
    await wtGit.commit("add new-file.txt");

    // Not visible in main until merged.
    expect(existsSync(join(repoRoot, "new-file.txt"))).toBe(false);
  });

  it("diff() shows the worktree's changes including new files", async () => {
    const wt = await manager.create("task2", "main");
    writeFileSync(join(wt.path, "new-file.txt"), "hello\n");
    const text = await manager.diff(wt);
    expect(text).toContain("new-file.txt");
    expect(text).toContain("hello");
  });

  it("mergeAfterGate merges the worktree branch into main; file appears in main", async () => {
    const wt = await manager.create("task3", "main");
    writeFileSync(join(wt.path, "merged.txt"), "merged content\n");
    const wtGit = (await import("../util/git.js")).createGit(wt.path);
    await wtGit.add(["merged.txt"]);
    await wtGit.commit("add merged.txt");

    const result = await manager.mergeAfterGate(wt, "main");
    expect(result).toEqual({ ok: true, conflict: false });
    expect(existsSync(join(repoRoot, "merged.txt"))).toBe(true);
    // Tolerate git's core.autocrlf normalizing line endings on Windows.
    expect(readFileSync(join(repoRoot, "merged.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
      "merged content\n",
    );
  });

  it("mergeAfterGate reports a conflict and leaves main clean", async () => {
    const wt = await manager.create("task4", "main");

    writeFileSync(join(repoRoot, "a.txt"), "MAIN-CHANGE\n");
    await runNative("git", ["add", "-A"], { cwd: repoRoot });
    await runNative("git", ["commit", "-m", "main changes a.txt"], { cwd: repoRoot });

    writeFileSync(join(wt.path, "a.txt"), "WORKTREE-CHANGE\n");
    const wtGit = (await import("../util/git.js")).createGit(wt.path);
    await wtGit.add(["a.txt"]);
    await wtGit.commit("worktree changes a.txt");

    const result = await manager.mergeAfterGate(wt, "main");
    expect(result).toEqual({ ok: false, conflict: true });

    const status = await runNative("git", ["status", "--porcelain=v1"], { cwd: repoRoot });
    expect(status.stdout.trim()).toBe("");
  });

  it("mergeAfterGate refuses to merge when the main working tree is dirty", async () => {
    const wt = await manager.create("task-dirty", "main");
    writeFileSync(join(wt.path, "merged.txt"), "merged content\n");
    const wtGit = (await import("../util/git.js")).createGit(wt.path);
    await wtGit.add(["merged.txt"]);
    await wtGit.commit("add merged.txt");

    // Dirty the main working tree with an uncommitted change.
    writeFileSync(join(repoRoot, "a.txt"), "a1\nUNCOMMITTED-CHANGE\n");

    await expect(manager.mergeAfterGate(wt, "main")).rejects.toThrow(
      /main working tree is not clean/i,
    );
    // The dirty change is untouched, and no merge happened.
    expect(existsSync(join(repoRoot, "merged.txt"))).toBe(false);
  });

  it("teardown removes the worktree dir but keeps the branch (non-destructive)", async () => {
    const wt = await manager.create("task5", "main");
    expect(existsSync(wt.path)).toBe(true);

    await manager.teardown(wt);
    expect(existsSync(wt.path)).toBe(false);

    const branches = await runNative("git", ["branch", "--list", wt.branch], { cwd: repoRoot });
    expect(branches.stdout).toContain(wt.branch);
  });
});
