import { join } from "node:path";
import { createGit, type MergeResult } from "../util/git.js";
import { runNative } from "../util/native.js";

export interface Worktree {
  path: string;
  branch: string;
  taskId: string;
}

export interface WorktreeManager {
  create(taskId: string, baseBranch: string): Promise<Worktree>;
  diff(wt: Worktree, scope?: string[]): Promise<string>;
  teardown(wt: Worktree): Promise<void>;
  mergeAfterGate(wt: Worktree, intoBranch: string): Promise<MergeResult>;
}

/**
 * Per-task git worktree lifecycle (AO isolation pattern — parity spec
 * divergence #1). The gate runs on the worktree diff; the conductor merges
 * into the loop branch only after the gate passes. Teardown is
 * non-destructive: it removes the worktree directory but keeps the branch.
 */
export function createWorktreeManager(mainRepoRoot: string, worktreesDir: string): WorktreeManager {
  const mainGit = createGit(mainRepoRoot);

  return {
    async create(taskId: string, baseBranch: string): Promise<Worktree> {
      const branch = `autodev/wt-${taskId}`;
      const path = join(worktreesDir, taskId);
      await mainGit.worktreeAdd(path, branch, baseBranch);
      return { path, branch, taskId };
    },

    async diff(wt: Worktree, scope?: string[]): Promise<string> {
      // Intent-to-add any untracked files first so brand-new files show up
      // in `git diff` (mirrors the PS loop's diff-includes-new-files behavior).
      const addArgs = ["add", "-N", "--"].concat(scope && scope.length > 0 ? scope : ["."]);
      await runNative("git", addArgs, { cwd: wt.path });
      const wtGit = createGit(wt.path);
      return wtGit.diffText(scope);
    },

    async teardown(wt: Worktree): Promise<void> {
      await mainGit.worktreeRemove(wt.path);
    },

    async mergeAfterGate(wt: Worktree, intoBranch: string): Promise<MergeResult> {
      const current = await mainGit.currentBranch();
      if (current !== intoBranch) {
        const r = await runNative("git", ["checkout", intoBranch], { cwd: mainRepoRoot });
        if (r.exitCode !== 0) {
          throw new Error(`git checkout ${intoBranch} failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
        }
      }
      return mainGit.merge(wt.branch);
    },
  };
}
