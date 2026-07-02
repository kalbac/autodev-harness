import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
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

  it("create() is re-queue-safe: a re-claimed task id starts clean even without teardown", async () => {
    const taskId = "task-requeue";

    // First attempt: create, leave a committed file on the branch, then tear down
    // (mirrors: task claimed, worker runs, then rate-limit/timeout/gate RETRY/
    // escalate-then-operator-requeues sends it back to the queue).
    const wt1 = await manager.create(taskId, "main");
    writeFileSync(join(wt1.path, "stale-file.txt"), "stale from attempt 1\n");
    const wt1Git = (await import("../util/git.js")).createGit(wt1.path);
    await wt1Git.add(["stale-file.txt"]);
    await wt1Git.commit("stale commit from discarded attempt");
    await manager.teardown(wt1);

    // Re-claim of the same task id after teardown: must succeed instead of
    // failing on "branch already exists", and must start from a clean base —
    // the prior attempt's commit must be gone (thrown away, not carried over).
    const wt2 = await manager.create(taskId, "main");
    expect(wt2.taskId).toBe(taskId);
    expect(wt2.branch).toBe(`autodev/wt-${taskId}`);
    expect(existsSync(wt2.path)).toBe(true);
    expect(existsSync(join(wt2.path, "stale-file.txt"))).toBe(false);

    // Re-claim AGAIN, this time WITHOUT tearing down wt2 first (the worktree
    // dir and its registration are still live) — the second call must clean
    // up the leftover worktree + branch itself and still succeed.
    writeFileSync(join(wt2.path, "second-stale-file.txt"), "stale from attempt 2\n");
    const wt3 = await manager.create(taskId, "main");
    expect(wt3.taskId).toBe(taskId);
    expect(wt3.branch).toBe(`autodev/wt-${taskId}`);
    expect(existsSync(wt3.path)).toBe(true);
    expect(existsSync(join(wt3.path, "second-stale-file.txt"))).toBe(false);
  });

  it("create() rejects an unsafe task id before performing any destructive cleanup", async () => {
    // A traversal id must be refused: create() rm's + branch -D's the derived
    // path, so `../x` would let that cleanup escape worktreesDir.
    for (const bad of ["../evil", "a/b", "..", ".", "", "x\\y"]) {
      await expect(manager.create(bad, "main")).rejects.toThrow(/unsafe task id/i);
    }
    // A normal id with dots/dashes is still accepted.
    const ok = await manager.create("s7-t1.conductor", "main");
    expect(ok.branch).toBe("autodev/wt-s7-t1.conductor");
  });

  it("provision: with no provision config, create() adds no extra links (behavior unchanged)", async () => {
    mkdirSync(join(repoRoot, "deps"));
    const wt = await manager.create("t-noprov", "main"); // default manager: no provision
    expect(existsSync(join(wt.path, "deps"))).toBe(false);
  });

  it("provision: links configured dirs into the worktree; the link resolves to the target", async () => {
    mkdirSync(join(repoRoot, "deps"));
    writeFileSync(join(repoRoot, "deps", "dep.txt"), "installed\n");
    const m = createWorktreeManager(repoRoot, worktreesDir, { provision: ["deps"] });
    const wt = await m.create("t-prov", "main");

    // Content is visible THROUGH the link.
    expect(readFileSync(join(wt.path, "deps", "dep.txt"), "utf8")).toBe("installed\n");
    // It's a link, not a copy: a new file in the target shows through the worktree.
    writeFileSync(join(repoRoot, "deps", "extra.txt"), "x\n");
    expect(existsSync(join(wt.path, "deps", "extra.txt"))).toBe(true);
  });

  it("provision: a missing target is skipped — no dangling link, create() does not throw", async () => {
    const m = createWorktreeManager(repoRoot, worktreesDir, { provision: ["nope", "deps"] });
    mkdirSync(join(repoRoot, "deps"));
    writeFileSync(join(repoRoot, "deps", "dep.txt"), "ok\n");
    const wt = await m.create("t-missing", "main"); // must resolve, not reject
    expect(existsSync(join(wt.path, "nope"))).toBe(false);          // missing target -> no link
    expect(readFileSync(join(wt.path, "deps", "dep.txt"), "utf8")).toBe("ok\n"); // present target -> linked
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
