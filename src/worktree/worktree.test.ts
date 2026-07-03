import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNative } from "../util/native.js";
import { createWorktreeManager, samePath, type Worktree, type WorktreeManager } from "./worktree.js";

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

  it("teardown: unlinks the provisioned link but the target dir + contents survive", async () => {
    mkdirSync(join(repoRoot, "deps"));
    writeFileSync(join(repoRoot, "deps", "dep.txt"), "keep\n");
    const m = createWorktreeManager(repoRoot, worktreesDir, { provision: ["deps"] });
    const wt = await m.create("t-td", "main");
    expect(existsSync(join(wt.path, "deps", "dep.txt"))).toBe(true);

    await m.teardown(wt);

    // The REAL target dir + its sentinel must be intact after the worktree removal.
    expect(existsSync(join(repoRoot, "deps", "dep.txt"))).toBe(true);
    expect(readFileSync(join(repoRoot, "deps", "dep.txt"), "utf8")).toBe("keep\n");
  });

  it("create re-queue: cleaning a stale worktree with a provisioned link does not delete the target", async () => {
    mkdirSync(join(repoRoot, "deps"));
    writeFileSync(join(repoRoot, "deps", "dep.txt"), "keep\n");
    const m = createWorktreeManager(repoRoot, worktreesDir, { provision: ["deps"] });

    const wt1 = await m.create("t-req", "main");
    expect(existsSync(join(wt1.path, "deps", "dep.txt"))).toBe(true);

    // Re-claim the SAME task id (rate-limit / retry / re-queue). The stale-cleanup
    // in create() runs on the existing worktree that still holds the link.
    const wt2 = await m.create("t-req", "main");
    expect(existsSync(join(wt2.path, "deps", "dep.txt"))).toBe(true);

    // The real target must be intact after the stale-cleanup's recursive delete.
    expect(readFileSync(join(repoRoot, "deps", "dep.txt"), "utf8")).toBe("keep\n");
  });

  // --- re-review blocker: stale-config ground-truth scan (deprovision must be
  // driven by what is ACTUALLY on disk, not by the CURRENT config — a
  // manifest recording only the current config's entries would miss a stale
  // junction left by an OLDER config) ---

  it("stale-config regression: re-queue after the provision config changes (drops the entry) must not delete the real target — ground-truth scan", async () => {
    mkdirSync(join(repoRoot, "deps"));
    writeFileSync(join(repoRoot, "deps", "dep.txt"), "keep\n");
    const m1 = createWorktreeManager(repoRoot, worktreesDir, { provision: ["deps"] });
    const wt = await m1.create("t-cfg", "main");
    expect(readFileSync(join(wt.path, "deps", "dep.txt"), "utf8")).toBe("keep\n");

    // Simulate a config change + re-queue: a NEW manager instance with an
    // EMPTY provision list (vendor/deps dropped from config) re-claims the
    // same task id. `wt` is left stale (crash / skipped teardown) — the
    // worktree dir on disk still holds the "deps" junction from m1's config.
    const m2 = createWorktreeManager(repoRoot, worktreesDir, { provision: [] });
    await m2.create("t-cfg", "main");

    // m2's stale-cleanup self-gate checks the TOP LEVEL of the stale worktree
    // for any reparse point regardless of its (now-empty) config, finds the
    // leftover "deps" junction from m1, and falls through to a full scan —
    // so the stale junction is stripped BEFORE the recursive rm() rather than
    // being traversed by it.
    expect(readFileSync(join(repoRoot, "deps", "dep.txt"), "utf8")).toBe("keep\n");
  });

  it("stale-config regression: teardown after a config change (drops the entry) uses the filesystem ground truth and does not delete the real target", async () => {
    mkdirSync(join(repoRoot, "deps"));
    writeFileSync(join(repoRoot, "deps", "dep.txt"), "keep\n");
    const m1 = createWorktreeManager(repoRoot, worktreesDir, { provision: ["deps"] });
    const wt = await m1.create("t-cfg-td", "main");

    const m2 = createWorktreeManager(repoRoot, worktreesDir, { provision: [] });
    await m2.teardown(wt);

    expect(existsSync(wt.path)).toBe(false);
    expect(readFileSync(join(repoRoot, "deps", "dep.txt"), "utf8")).toBe("keep\n");
  });

  // --- code-review gate: findings 1 & 2 (removeLinkOnly verify-before-recursive-delete) ---

  it("PLATFORM PIN: a provisioned link is a real symlink/junction on this platform; teardown removes the worktree dir while the target survives", async () => {
    mkdirSync(join(repoRoot, "deps"));
    writeFileSync(join(repoRoot, "deps", "dep.txt"), "keep\n");
    const m = createWorktreeManager(repoRoot, worktreesDir, { provision: ["deps"] });
    const wt = await m.create("t-pin", "main");
    const link = join(wt.path, "deps");

    // THE safety invariant depends on lstat().isSymbolicLink() being true for a
    // provisioned link on this platform (junction on win32, dir-symlink on POSIX).
    // If this assertion fails, the guard must NOT be weakened — an alternative
    // (link-tracking) is required instead.
    const st = await lstat(link);
    expect(st.isSymbolicLink()).toBe(true);

    await m.teardown(wt);
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(join(repoRoot, "deps", "dep.txt"))).toBe(true);
    expect(readFileSync(join(repoRoot, "deps", "dep.txt"), "utf8")).toBe("keep\n");
  });

  it("finding 2 regression (ground-truth scan): a real (non-link) file occupying a provisioned entry's path is skipped, not treated as an unsafe reparse point — teardown proceeds normally", async () => {
    // keep.txt is a normal tracked file that happens to collide with a
    // provision entry — provisionWorktree finds it already checked out at the
    // link path (existsSync(link) true) and skips creating a symlink there,
    // leaving the real checked-out file in place.
    writeFileSync(join(repoRoot, "keep.txt"), "real content\n");
    await runNative("git", ["add", "-A"], { cwd: repoRoot });
    await runNative("git", ["commit", "-m", "add keep.txt"], { cwd: repoRoot });

    const m = createWorktreeManager(repoRoot, worktreesDir, { provision: ["keep.txt"] });
    const wt = await m.create("t-realfile", "main");
    const link = join(wt.path, "keep.txt");
    expect(existsSync(link)).toBe(true);
    expect((await lstat(link)).isSymbolicLink()).toBe(false);

    // The ground-truth scan only ever removes confirmed reparse points
    // (isSymbolicLink() === true). keep.txt is a plain file, not a link to
    // anything external, so it is simply not a candidate for removeLinkOnly —
    // it is neither unsafe nor blocking. It has no "real target" to protect
    // (unlike a leaked junction), so it is fine for the normal, non-recursive-
    // into-links worktree removal to take it along with the rest of the
    // worktree's own content.
    await m.teardown(wt);
    expect(existsSync(wt.path)).toBe(false);
  });

  // --- code-review gate: finding 4 (dangling-link detection at provision time) ---

  it("finding 4 regression: a pre-existing dangling link at the link path (checked out from git) is detected via lstat and skipped, not silently EEXIST-swallowed", async () => {
    // Real target dir + content on "main" — what provisioning normally links to.
    mkdirSync(join(repoRoot, "collide"));
    writeFileSync(join(repoRoot, "collide", "dep.txt"), "real dep\n");
    await runNative("git", ["add", "-A"], { cwd: repoRoot });
    await runNative("git", ["commit", "-m", "add collide dir"], { cwd: repoRoot });

    // A second branch where "collide" is instead a DANGLING file-symlink —
    // simulates a leftover/foreign tracked entry that happens to collide with
    // the provision path name in whatever ref a worktree checks out.
    await runNative("git", ["checkout", "-b", "stale-branch"], { cwd: repoRoot });
    rmSync(join(repoRoot, "collide"), { recursive: true, force: true });
    symlinkSync("nonexistent-target.txt", join(repoRoot, "collide"), "file");
    await runNative("git", ["add", "-A"], { cwd: repoRoot });
    await runNative("git", ["commit", "-m", "collide becomes a dangling symlink"], { cwd: repoRoot });
    // Back to main: mainRepoRoot's own working copy has the REAL directory again
    // (this is what `target` resolves against).
    await runNative("git", ["checkout", "main"], { cwd: repoRoot });
    expect(existsSync(join(repoRoot, "collide", "dep.txt"))).toBe(true);

    const messages: string[] = [];
    const m = createWorktreeManager(repoRoot, worktreesDir, {
      provision: ["collide"],
      log: (level, message) => messages.push(`${level}: ${message}`),
    });

    // Fresh worktree built off stale-branch: "collide" checks out as the
    // pre-existing dangling symlink BEFORE provisionWorktree ever examines it.
    const wt = await m.create("t-dangling", "stale-branch");
    const link = join(wt.path, "collide");

    const st = await lstat(link);
    expect(st.isSymbolicLink()).toBe(true); // still the pre-existing dangling link, untouched

    expect(messages.some((m2) => /already exists/i.test(m2))).toBe(true);
    expect(messages.some((m2) => /failed to link/i.test(m2))).toBe(false);
  });

  // --- code-review gate: finding 5 (non-blocking gitignore WARN) ---

  it("finding 5 regression: provisioning a path that is NOT gitignored emits a non-blocking WARN", async () => {
    mkdirSync(join(repoRoot, "deps"));
    writeFileSync(join(repoRoot, "deps", "dep.txt"), "ok\n");
    // Deliberately no .gitignore entry for "deps".

    const messages: string[] = [];
    const m = createWorktreeManager(repoRoot, worktreesDir, {
      provision: ["deps"],
      log: (level, message) => messages.push(`${level}: ${message}`),
    });

    await expect(m.create("t-notignored", "main")).resolves.toBeDefined();
    expect(messages.some((m2) => /not gitignored/i.test(m2))).toBe(true);
  });

  // --- signature-based deprovision: TOP-LEVEL only, identified by target ---

  it("PLATFORM PIN (critical): samePath(readlink(link), target) holds for a provisioned junction/symlink on this platform — pins the target-signature identification premise", async () => {
    mkdirSync(join(repoRoot, "deps"));
    const m = createWorktreeManager(repoRoot, worktreesDir, { provision: ["deps"] });
    const wt = await m.create("t-pin-signature", "main");
    const link = join(wt.path, "deps");

    // If this ever reads FALSE on some platform, STOP: the target-signature
    // identification premise (deprovision matches a top-level symlink by
    // comparing its resolved readlink() target against
    // join(mainRepoRoot, name)) does not hold here and must not be weakened —
    // an alternative identification strategy (e.g. `git check-ignore`) is
    // required instead.
    const target = await readlink(link);
    expect(samePath(target, join(repoRoot, "deps"))).toBe(true);
  });

  it("provision: a nested entry (containing a path separator) is rejected as unsafe and skipped — nesting is not provisioned (Part A)", async () => {
    mkdirSync(join(repoRoot, "a", "b"), { recursive: true });
    writeFileSync(join(repoRoot, "a", "b", "sentinel.txt"), "nested-keep\n");
    const messages: string[] = [];
    const m = createWorktreeManager(repoRoot, worktreesDir, {
      provision: ["a/b"],
      log: (level, message) => messages.push(`${level}: ${message}`),
    });
    const wt = await m.create("t-nested", "main");

    // Nested entries are unsafe (Part A) — the manager never links them.
    expect(existsSync(join(wt.path, "a", "b"))).toBe(false);
    expect(messages.some((msg) => /unsafe entry skipped/i.test(msg))).toBe(true);

    await m.teardown(wt);
    expect(existsSync(wt.path)).toBe(false);
    expect(readFileSync(join(repoRoot, "a", "b", "sentinel.txt"), "utf8")).toBe("nested-keep\n");
  });

  it("finding 2 + junction-follow safety: a FOREIGN top-level symlink/junction (pointing OUTSIDE the worktree to real data) has its target survive teardown — deprovision link-only removes it BEFORE git's recursive removal so git can't follow it into the target", async () => {
    // s15 platform fact (reproduced): `git worktree remove --force` FOLLOWS an
    // NTFS junction and deletes its real target's content. So a foreign
    // reparse point left in place at teardown is a data-loss vector. deprovision
    // must link-only remove EVERY top-level reparse point (ours OR foreign)
    // first; link-only removal never touches the target, so the sentinel below
    // survives — whereas leaving the junction for git would delete it.
    const wt = await manager.create("t-foreign", "main"); // no provision config
    const foreignTargetDir = mkdtempSync(join(tmpdir(), "adh-wt-foreign-"));
    writeFileSync(join(foreignTargetDir, "sentinel.txt"), "foreign-keep\n");
    const link = join(wt.path, "foreign-link");
    symlinkSync(foreignTargetDir, link, process.platform === "win32" ? "junction" : "dir");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);

    await manager.teardown(wt);

    // Worktree gone (teardown proceeded), and the foreign junction's real target
    // + its sentinel survive — the whole point of link-only, pre-git removal.
    expect(existsSync(wt.path)).toBe(false);
    expect(readFileSync(join(foreignTargetDir, "sentinel.txt"), "utf8")).toBe("foreign-keep\n");
    rmSync(foreignTargetDir, { recursive: true, force: true });
  });

  it("ground-truth scan: a worktree with only real dirs and files (no links) tears down exactly as before — backward compat, no loop-brick", async () => {
    const wt = await manager.create("t-realtree", "main"); // default manager: no provision
    mkdirSync(join(wt.path, "src", "nested"), { recursive: true });
    writeFileSync(join(wt.path, "src", "nested", "file.ts"), "export const x = 1;\n");
    writeFileSync(join(wt.path, "top.txt"), "top\n");

    await manager.teardown(wt);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("ground-truth scan: a real (non-symlink) dir sitting at a configured provision path is skipped — not a reparse point, so it neither gets deleted by the scan nor makes deprovision report unsafe", async () => {
    // "deps" is a real, already-checked-out directory at the exact path the
    // config would otherwise provision — provisionWorktree's occupancy check
    // (existsSync/lstat) finds it present and skips linking, leaving the real
    // dir + its content in place, same shape as the finding-2 file case but
    // for a directory. The top-level deprovision scan only removes confirmed
    // reparse points (isSymbolicLink() === true), so a real dir is skipped —
    // neither deleted nor treated as unsafe.
    mkdirSync(join(repoRoot, "deps"));
    writeFileSync(join(repoRoot, "deps", "real.txt"), "real dir content\n");
    await runNative("git", ["add", "-A"], { cwd: repoRoot });
    await runNative("git", ["commit", "-m", "add real deps dir"], { cwd: repoRoot });

    const m = createWorktreeManager(repoRoot, worktreesDir, { provision: ["deps"] });
    const wt = await m.create("t-realdir", "main");
    const link = join(wt.path, "deps");
    expect((await lstat(link)).isSymbolicLink()).toBe(false);

    await m.teardown(wt);

    // No reparse point anywhere -> deprovision reports safe -> the normal
    // (non-junction-traversing) recursive worktree removal proceeds, same as
    // the no-provision case. No error, no refusal, no partial state left behind.
    expect(existsSync(wt.path)).toBe(false);
  });
});
