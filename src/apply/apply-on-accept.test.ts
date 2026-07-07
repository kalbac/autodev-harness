import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNative } from "../util/native.js";
import { createGit, mainTreeStatus } from "../util/git.js";
import { HarnessConfigSchema } from "../config/schema.js";
import type { Task } from "../blackboard/types.js";
import { applyOnAccept, type ApplyOnAcceptDeps } from "./apply-on-accept.js";

let repoRoot: string;
const cfg = HarnessConfigSchema.parse({});

async function initRepo(dir: string): Promise<void> {
  await runNative("git", ["init", "-b", "autodev/loop-main"], { cwd: dir });
  await runNative("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await runNative("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "v1\n");
  writeFileSync(join(dir, "b.txt"), "b1\n");
  writeFileSync(join(dir, ".secret"), "s1\n");
  await runNative("git", ["add", "-A"], { cwd: dir });
  await runNative("git", ["commit", "-m", "initial"], { cwd: dir });
}

/** Produce a real unified diff that applies to the CURRENT clean tree: edit, diff, reset. */
async function captureApplicablePatch(dir: string, file: string, newContent: string): Promise<string> {
  writeFileSync(join(dir, file), newContent);
  const d = await runNative("git", ["diff", "--", file], { cwd: dir });
  await runNative("git", ["checkout", "--", file], { cwd: dir });
  return d.stdout;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Add v2",
    type: "tooling",
    touches_contract_zone: false,
    writes_guard: false,
    model: null,
    success_commands: [],
    forbidden_paths: [],
    max_rounds: null,
    file_set: ["a.txt"],
    depends_on: [],
    contract_zones_touched: [],
    needs_guard: false,
    acceptance: [],
    body: "",
    path: "queue/escalated/t1.md",
    ...overrides,
  };
}

function baseDeps(over: Partial<ApplyOnAcceptDeps> = {}): ApplyOnAcceptDeps {
  return {
    taskId: "t1",
    repoRoot,
    cfg,
    git: createGit(repoRoot),
    mainTreeStatus: () => mainTreeStatus(repoRoot),
    readPatch: async () => captureApplicablePatch(repoRoot, "a.txt", "v2\n"),
    readLoopBranch: async () => "autodev/loop-main",
    readTask: async () => makeTask(),
    log: () => {},
    ...over,
  };
}

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), "adh-apply-"));
  await initRepo(repoRoot);
});
afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

describe("applyOnAccept", () => {
  it("happy path: applies the persisted diff, stages file_set, commits with an override marker, returns the hash", async () => {
    const res = await applyOnAccept(baseDeps());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.hash).toMatch(/^[0-9a-f]{7,40}$/);
    // File committed with the new content, tree clean after. Normalize CRLF: Windows
    // git (core.autocrlf) may rewrite line endings on apply/checkout — not our concern.
    expect(readFileSync(join(repoRoot, "a.txt"), "utf8").replace(/\r/g, "")).toBe("v2\n");
    expect(await mainTreeStatus(repoRoot)).toEqual([]);
    const logMsg = await runNative("git", ["log", "-1", "--format=%B"], { cwd: repoRoot });
    expect(logMsg.stdout).toMatch(/\(autodev\): Add v2/); // kind from cfg.commit.typeMap
    expect(logMsg.stdout).toMatch(/apply-on-accept override/);
  });

  it("returns ok:false when there is no persisted diff (pre-critic escalation)", async () => {
    const res = await applyOnAccept(baseDeps({ readPatch: async () => null }));
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/no persisted diff/i) });
  });

  it("returns ok:false when the diff is empty", async () => {
    const res = await applyOnAccept(baseDeps({ readPatch: async () => "   \n" }));
    expect(res.ok).toBe(false);
  });

  it("refuses on a dirty main tree (would fold unrelated edits into the commit)", async () => {
    writeFileSync(join(repoRoot, "dirt.txt"), "x\n"); // untracked dirt
    const res = await applyOnAccept(baseDeps());
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/not clean/i) });
  });

  it("refuses to commit on main / a branch off the allowed pattern", async () => {
    await runNative("git", ["checkout", "-b", "main"], { cwd: repoRoot });
    const res = await applyOnAccept(baseDeps());
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/refusing to commit on branch/i) });
  });

  it("returns ok:false when git apply fails (structurally valid, in file_set, but context no longer applies)", async () => {
    // Passes numstat (path a.txt is in file_set) but the hunk context doesn't match
    // the tree — so it fails at the apply step, not the pre-validation.
    const stale = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-WRONGCONTEXT\n+changed\n";
    const res = await applyOnAccept(baseDeps({ readPatch: async () => stale }));
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/git apply failed/i) });
    // The tree must be left clean (a failed apply must not leave partial edits).
    expect(await mainTreeStatus(repoRoot)).toEqual([]);
  });

  it("returns ok:false when the escalated task is not found", async () => {
    const res = await applyOnAccept(baseDeps({ readTask: async () => null }));
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/not found/i) });
  });

  it("refuses a patch that touches a file OUTSIDE the task file_set (no out-of-file_set smuggling)", async () => {
    // task file_set is ["a.txt"], but the patch modifies b.txt.
    const res = await applyOnAccept(
      baseDeps({ readPatch: async () => captureApplicablePatch(repoRoot, "b.txt", "b2\n") }),
    );
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/outside the task file_set/i) });
    // Nothing applied — tree still clean.
    expect(await mainTreeStatus(repoRoot)).toEqual([]);
  });

  it("does NOT let a leading-dot path bypass the file_set allowlist (`.secret` must not match `secret`)", async () => {
    // The old scheduler-style normalize stripped leading dots, so `.secret` -> `secret`
    // would have matched a file_set entry `secret` and smuggled a secret-file edit.
    const res = await applyOnAccept(
      baseDeps({
        readPatch: async () => captureApplicablePatch(repoRoot, ".secret", "s2\n"),
        readTask: async () => makeTask({ file_set: ["secret"] }),
      }),
    );
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/outside the task file_set/i) });
    expect(await mainTreeStatus(repoRoot)).toEqual([]);
  });

  it("refuses when the current branch is not the loop branch the diff was captured on", async () => {
    const res = await applyOnAccept(baseDeps({ readLoopBranch: async () => "autodev/some-other" }));
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/not the loop branch/i) });
    expect(await mainTreeStatus(repoRoot)).toEqual([]);
  });

  it("falls back to the pattern check when no loop branch was recorded (pre-s32 run) and still commits", async () => {
    const res = await applyOnAccept(baseDeps({ readLoopBranch: async () => null }));
    expect(res.ok).toBe(true);
  });

  it("rolls the working tree back to clean when staging/commit fails AFTER a successful apply", async () => {
    const realGit = createGit(repoRoot);
    const brokenGit = { ...realGit, add: async () => { throw new Error("add boom"); } };
    const res = await applyOnAccept(baseDeps({ git: brokenGit }));
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/restored/i) });
    // The applied patch was rolled back: tree clean, a.txt back to its committed value.
    expect(await mainTreeStatus(repoRoot)).toEqual([]);
    expect(readFileSync(join(repoRoot, "a.txt"), "utf8").replace(/\r/g, "")).toBe("v1\n");
  });
});
