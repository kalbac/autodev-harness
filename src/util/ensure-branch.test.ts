import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNative } from "./native.js";
import { createGit } from "./git.js";
import { ensureAutodevBranch, initAutodevRepo, DEFAULT_AUTODEV_BRANCH } from "./ensure-branch.js";

let dir: string;

async function initRealRepo(d: string, branch: string): Promise<void> {
  await runNative("git", ["init", "-b", branch], { cwd: d });
  await runNative("git", ["config", "user.email", "t@e.com"], { cwd: d });
  await runNative("git", ["config", "user.name", "T"], { cwd: d });
  writeFileSync(join(d, "f.txt"), "x\n");
  await runNative("git", ["add", "-A"], { cwd: d });
  await runNative("git", ["commit", "-m", "init"], { cwd: d });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adh-ensure-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureAutodevBranch", () => {
  it("no-ops when already on a matching branch", async () => {
    await initRealRepo(dir, "autodev/main");
    const g = createGit(dir);
    const r = await ensureAutodevBranch(g);
    expect(r).toEqual({ branch: "autodev/main", switched: false });
  });

  it("creates autodev/main from master when no autodev branch exists", async () => {
    await initRealRepo(dir, "master");
    const g = createGit(dir);
    const r = await ensureAutodevBranch(g);
    expect(r).toEqual({ branch: DEFAULT_AUTODEV_BRANCH, switched: true });
    expect(await g.currentBranch()).toBe("autodev/main");
  });

  it("switches to an EXISTING autodev branch rather than recreating", async () => {
    await initRealRepo(dir, "master");
    const g = createGit(dir);
    await g.createBranch("autodev/work");
    await g.checkoutBranch("master");
    const r = await ensureAutodevBranch(g);
    expect(r).toEqual({ branch: "autodev/work", switched: true });
    expect(await g.currentBranch()).toBe("autodev/work");
  });

  it("carries a dirty tree over when creating the branch (no stash)", async () => {
    await initRealRepo(dir, "master");
    const g = createGit(dir);
    writeFileSync(join(dir, "f.txt"), "x\nDIRTY\n");
    await ensureAutodevBranch(g);
    expect(await g.currentBranch()).toBe("autodev/main");
    // The uncommitted edit survived the branch switch.
    const status = await runNative("git", ["status", "--porcelain"], { cwd: dir });
    expect(status.stdout).toMatch(/ M f\.txt/);
  });
});

describe("initAutodevRepo", () => {
  it("git-inits a non-repo, lands on autodev/main, leaves files untracked", async () => {
    writeFileSync(join(dir, "existing.txt"), "keep me\n");
    const g = createGit(dir);
    const r = await initAutodevRepo(g);
    expect(r.branch).toBe("autodev/main");
    expect(r.untrackedCount).toBe(1); // existing.txt is NOT auto-committed
    expect(await g.currentBranch()).toBe("autodev/main");
  });
});
