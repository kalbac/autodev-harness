import { rm, symlink, unlink, rmdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { createGit, type MergeResult } from "../util/git.js";
import { runNative } from "../util/native.js";
import type { Logger } from "../util/log.js";

/**
 * A task id must be a single, safe path segment: it becomes both a directory
 * name under `worktreesDir` and part of a branch name, and `create` performs
 * DESTRUCTIVE cleanup (rm + branch -D) on the derived path. A traversal id like
 * `../other` would let that cleanup escape the worktrees dir and clobber
 * unrelated state, so reject anything with a separator, a `..`, or that is
 * empty / `.`.
 */
function assertSafeTaskId(taskId: string): void {
  if (
    taskId === "" ||
    taskId === "." ||
    taskId.includes("..") ||
    taskId.includes("/") ||
    taskId.includes("\\")
  ) {
    throw new Error(`createWorktree: unsafe task id ${JSON.stringify(taskId)} (must be a single path segment)`);
  }
}

export interface WorktreeManagerOptions {
  /**
   * Repo-root-relative dir paths (e.g. ["vendor", "plugins-reference"]) to link
   * into each worktree so a real gate can find gitignored deps. Empty = off.
   */
  provision?: string[];
  /** Optional logger for provision warnings (missing target, skips, failures). */
  log?: Logger;
}

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
export function createWorktreeManager(
  mainRepoRoot: string,
  worktreesDir: string,
  opts: WorktreeManagerOptions = {},
): WorktreeManager {
  const mainGit = createGit(mainRepoRoot);
  const provision = opts.provision ?? [];
  // Never throw from logging inside a best-effort / catch path (gotcha [ts/fail-closed]).
  const safeLog: Logger = (level, message) => {
    try {
      opts.log?.(level, message);
    } catch {
      /* logging must never break provisioning */
    }
  };

  // A provision entry must be a relative path within the repo (no absolute, no
  // `..` segment). Config-load validates this too (fail-loud); this is the
  // defense-in-depth guard at the fs-op site — the manager is also constructed
  // directly (in tests) without going through config.
  const isSafeProvisionEntry = (p: string): boolean =>
    p !== "" && !isAbsolute(p) && !p.split(/[\\/]/).includes("..");

  // Link each configured dir from the main repo into a fresh worktree. Runs
  // AFTER `git worktree add`. Best-effort: never throws (a throw here would
  // abort the whole task loop) — logs loudly and continues. A missing target is
  // skipped (no dangling link) so the gate fails honestly instead.
  const provisionWorktree = async (wtPath: string): Promise<void> => {
    for (const p of provision) {
      if (!isSafeProvisionEntry(p)) {
        safeLog("WARN", `provision: unsafe entry skipped: ${JSON.stringify(p)}`);
        continue;
      }
      const target = join(mainRepoRoot, p);
      const link = join(wtPath, p);
      try {
        if (!existsSync(target)) {
          safeLog("WARN", `provision: target missing, skipping ${p} (${target})`);
          continue;
        }
        if (existsSync(link)) {
          safeLog("WARN", `provision: path already exists in worktree, skipping ${p}`);
          continue;
        }
        await mkdir(dirname(link), { recursive: true });
        await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        safeLog("WARN", `provision: failed to link ${p}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // Remove ONLY the link entry — NEVER recurse into its target. `unlink` clears a
  // file-symlink (and POSIX dir-symlinks); a Windows junction / dir needs
  // `rmdir`. Non-recursive `rmdir` can NEVER delete a populated real directory
  // (ENOTEMPTY), so an anomalous real dir at the link path is left intact. This
  // is THE safety invariant: a leaked junction must never let a recursive delete
  // reach the clone's real deps.
  const removeLinkOnly = async (link: string): Promise<void> => {
    try {
      await unlink(link);
      return;
    } catch {
      /* not a plain file-symlink; fall through to rmdir */
    }
    try {
      await rmdir(link); // junction / dir-symlink / empty dir; populated real dir -> ENOTEMPTY (left intact)
    } catch {
      /* absent, or a populated real dir we must not delete */
    }
  };

  // Unlink all provisioned links at a worktree path. MUST run before any
  // recursive removal of that path (git worktree remove / rm -rf).
  const deprovisionWorktree = async (wtPath: string): Promise<void> => {
    for (const p of provision) {
      if (!isSafeProvisionEntry(p)) continue;
      await removeLinkOnly(join(wtPath, p));
    }
  };

  return {
    async create(taskId: string, baseBranch: string): Promise<Worktree> {
      assertSafeTaskId(taskId);
      const branch = `autodev/wt-${taskId}`;
      const path = join(worktreesDir, taskId);

      // Re-queue safety: the conductor re-claims the same task id after a
      // rate-limit/timeout/gate-RETRY/escalate-then-operator-requeue, and
      // `git worktree add -b <branch>` fails if the branch or worktree path
      // from the earlier (discarded) attempt still exists. Best-effort clean
      // up any leftovers of a prior attempt before creating fresh off
      // `baseBranch` — a re-claimed task id must start from a clean base, so
      // intentionally discarding the previous attempt's commits on the stale
      // branch is correct (parity with the PS loop re-running the worker
      // fresh). None of these steps may throw: there being nothing to clean
      // up is the common case, not an error.
      await runNative("git", ["worktree", "prune"], { cwd: mainRepoRoot });
      await runNative("git", ["worktree", "remove", "--force", "--", path], { cwd: mainRepoRoot });
      // `worktree remove` only clears a REGISTERED worktree; an interrupted
      // earlier `worktree add` can leave an orphaned plain directory at `path`
      // that would then make the fresh `worktree add` fail ("path already
      // exists"). rm it (force = no error when absent) so create is idempotent
      // even after a crash mid-add. Safe because `path` is under worktreesDir
      // and taskId was validated as a single segment above.
      await rm(path, { recursive: true, force: true });
      await runNative("git", ["branch", "-D", branch], { cwd: mainRepoRoot });

      await mainGit.worktreeAdd(path, branch, baseBranch);
      await provisionWorktree(path);
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
      // Unlink provisioned links FIRST: a leaked junction + `git worktree remove`
      // (recursive) could otherwise traverse into the clone's real deps.
      await deprovisionWorktree(wt.path);
      await mainGit.worktreeRemove(wt.path);
    },

    async mergeAfterGate(wt: Worktree, intoBranch: string): Promise<MergeResult> {
      const status = await runNative("git", ["status", "--porcelain"], { cwd: mainRepoRoot });
      if (status.stdout.trim().length > 0) {
        throw new Error("mergeAfterGate: main working tree is not clean; refusing to merge");
      }

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
