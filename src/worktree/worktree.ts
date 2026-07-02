import { rm, symlink, unlink, rmdir, mkdir, lstat, readdir, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, posix, win32, resolve } from "node:path";
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

// Canonicalize a link target for comparison: strip a Windows `\\?\` prefix
// (readlink() on a junction can return one), resolve, and lowercase +
// backslash-normalize on win32 (filesystem paths are case-insensitive and
// `readlink` may return forward slashes). POSIX: resolve only. Exported and
// unit-pinned (see the PLATFORM PIN test) because deprovision's whole safety
// argument rests on this comparison correctly recognizing a provisioned
// link's target.
export function normalizeForCompare(p: string): string {
  let s = p;
  if (process.platform === "win32") s = s.replace(/^\\\\\?\\/, "");
  s = resolve(s);
  return process.platform === "win32" ? s.replace(/\//g, "\\").toLowerCase() : s;
}

export function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
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

  // A provision entry must be a SINGLE top-level path segment within the repo
  // (no absolute, no `..`, no separator at all — nesting is unused/YAGNI and
  // is the root of a nested-stale-link blocker: a nested `a/b` junction under
  // a real `a/` would survive a top-level-only scan). Config-load validates
  // this too (fail-loud); this is the defense-in-depth guard at the fs-op
  // site — the manager is also constructed directly (in tests) without going
  // through config. `isAbsolute` from `node:path` resolves to the HOST
  // platform's semantics only (win32 on Windows, posix elsewhere); check both
  // explicitly so a Windows-style absolute path (`C:\...`) or a UNC path
  // (`\\host\share\...`) is rejected even when the harness runs on Linux/mac,
  // and a POSIX-style absolute path (`/etc`) is rejected even when it runs on
  // Windows (finding 3).
  const isSafeProvisionEntry = (p: string): boolean =>
    p !== "" &&
    p !== "." &&
    p !== ".." &&
    !p.includes("/") &&
    !p.includes("\\") &&
    !posix.isAbsolute(p) &&
    !win32.isAbsolute(p);

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
        // `existsSync` FOLLOWS a symlink, so a DANGLING pre-existing link (e.g.
        // checked out from a tracked git entry that happens to collide with a
        // provision path) reads as "absent" here even though the path is
        // occupied on disk. `symlink()` then throws EEXIST, which the outer
        // catch swallows as a generic "failed to link" — silently leaving the
        // stale dangling link in place instead of reporting it (finding 4).
        // `lstat` (no-follow) reports the entry regardless of where — or
        // whether — it resolves.
        let occupied = false;
        try {
          await lstat(link);
          occupied = true;
        } catch {
          occupied = false;
        }
        if (occupied) {
          safeLog("WARN", `provision: path already exists in worktree, skipping ${p}`);
          continue;
        }
        // Best-effort operator footgun warning (finding 5): a provisioned link
        // whose repo-relative path is NOT gitignored will show up as untracked
        // content in the worktree and can trip the dirty-file fence. This must
        // never throw and never block provisioning — it's advisory only.
        try {
          const r = await runNative("git", ["check-ignore", "-q", "--", p], { cwd: mainRepoRoot });
          if (r.exitCode !== 0) {
            safeLog(
              "WARN",
              `provision: ${p} is not gitignored in the repo; its link may dirty the worktree / dirty-file fence`,
            );
          }
        } catch {
          /* best-effort — a git check-ignore failure must never block provisioning */
        }
        await mkdir(dirname(link), { recursive: true });
        await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        safeLog("WARN", `provision: failed to link ${p}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // Remove ONLY the link entry — NEVER recurse into its target. Genuinely
  // link-only: `lstat` (no-follow) first identifies WHAT is at `link` before
  // touching anything. `deprovisionWorktree` only ever calls this once it has
  // already confirmed `isSymbolicLink()`, so the non-symlink branch below is a
  // defense-in-depth guard for any other caller, not a path exercised by the
  // normal scan; only a confirmed symlink/junction is removed, and removal is
  // verified by re-`lstat`-ing afterward. This is THE safety invariant: a
  // reparse point must never let `git worktree remove` (which FOLLOWS a
  // junction on Windows) or a recursive delete reach the clone's real deps.
  //
  // Returns `true` when, after the call, `link` is confirmed ABSENT (safe to
  // proceed with a recursive removal of its parent); `false` when a real
  // non-link entry was found, or a link could not be confirmed-removed — in
  // either case the caller must NOT recursively delete.
  const removeLinkOnly = async (link: string): Promise<boolean> => {
    let st;
    try {
      st = await lstat(link);
    } catch {
      return true; // nothing there — safe
    }
    if (!st.isSymbolicLink()) {
      safeLog(
        "WARN",
        `provision: refusing to remove non-link entry at ${link} (not a provisioned link; leaving it and the recursive removal of its parent will be skipped)`,
      );
      return false;
    }
    try {
      await unlink(link); // file-symlink (and POSIX dir-symlinks)
    } catch {
      try {
        await rmdir(link); // junction / dir-symlink on Windows
      } catch {
        /* fall through to the verification below */
      }
    }
    try {
      await lstat(link);
      safeLog("ERROR", `provision: failed to remove provisioned link at ${link}`);
      return false; // still there — NOT safe to recurse
    } catch {
      return true; // confirmed gone
    }
  };

  // TOP-LEVEL-ONLY reparse-point scan. Part A restricts every provisioned
  // entry to a single top-level segment, so a non-recursive top-level
  // `readdir` covers all of OUR links — no source-tree walk is needed.
  //
  // CRITICAL PLATFORM FACT (empirically reproduced on Windows / Git-for-
  // Windows, s15): `git worktree remove --force` FOLLOWS an NTFS junction and
  // recursively deletes its real target's content, rather than treating the
  // junction as an opaque link entry. So a reparse point left in place at
  // teardown is a data-loss vector regardless of who created it. We therefore
  // link-only remove EVERY confirmed top-level reparse point BEFORE git's
  // recursive removal — ours, a stale one from an older/emptied config, OR a
  // foreign / tracked source symlink. This is STRICTLY SAFER than a
  // signature-gated removal that leaves non-matching links for git to follow:
  //  - `removeLinkOnly` unlinks/rmdirs ONLY the link entry (verified by lstat
  //    before and after) and NEVER follows into the target, so removing a
  //    link — even a tracked source symlink — cannot lose the target's data.
  //    Leaving it for `git worktree remove` to "handle", by contrast, DOES
  //    lose that data on this platform (finding: the very case we must guard).
  //  - The worktree directory is fully removed immediately after every call
  //    (both call sites), so pre-stripping a link inside a doomed directory
  //    does not change the final state — it only denies git a junction to
  //    follow. (Fail-safe: if a link can't be confirmed-removed we return
  //    `false` and the caller SKIPS the recursive removal entirely.)
  //  - Bounded: top-level only. `samePath(readlink, join(mainRepoRoot, name))`
  //    no longer GATES removal (that gate is what leaked foreign junctions to
  //    git); it now only LABELS the log line ours-vs-foreign for diagnostics.
  //
  // Residual (documented, not closed here): a NESTED foreign reparse point —
  // one a user/tool created deeper than top level — is not scanned and could
  // still be followed by `git worktree remove`. Part A guarantees WE never
  // create one; closing the foreign-nested case fully would require replacing
  // git's recursive delete with our own non-following remover (out of scope).
  //
  // Returns `true` iff every top-level reparse point is confirmed gone (safe
  // for the caller to proceed with the recursive removal). Best-effort: never
  // throws. Skips `.git` — worktree internals must not be disturbed. Backward
  // compat: a never-provisioned worktree has no top-level reparse point, so
  // this removes nothing and costs one cheap top-level `readdir`.
  const deprovisionWorktree = async (wtPath: string): Promise<boolean> => {
    let entries: string[];
    try {
      entries = await readdir(wtPath);
    } catch {
      return true; // worktree absent — nothing to clean
    }
    let ok = true;
    for (const name of entries) {
      if (name === ".git") continue;
      const p = join(wtPath, name);
      let st;
      try {
        st = await lstat(p);
      } catch {
        continue; // vanished between readdir and lstat — nothing to do
      }
      if (!st.isSymbolicLink()) continue; // real file/dir — git removes it safely (no reparse to follow)
      // A confirmed reparse point. Identify (for logging only) whether it is
      // one WE provisioned — points exactly where provisioning would have put
      // it — then remove it link-only regardless. `readlink` may fail on an
      // exotic reparse point; if so we still attempt the link-only removal
      // (removeLinkOnly re-lstats and only ever touches the entry itself).
      let ours = false;
      try {
        ours = samePath(await readlink(p), join(mainRepoRoot, name));
      } catch {
        ours = false;
      }
      safeLog(
        "INFO",
        `deprovision: removing top-level ${ours ? "provisioned" : "foreign"} reparse point ${name} (link-only, before recursive worktree removal)`,
      );
      const removed = await removeLinkOnly(p);
      if (!removed) ok = false;
    }
    return ok;
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
      // Strip any reparse points left from a prior attempt BEFORE the recursive
      // cleanup below (`worktree remove --force` and `rm -rf`), so a stale
      // junction can never let those deletes reach the clone's real deps. If a
      // reparse point could not be confirmed removed, REFUSE the recursive
      // cleanup entirely — fail safe rather than risk deleting real deps near it.
      const safe = await deprovisionWorktree(path);
      if (!safe) {
        throw new Error(
          `create: cannot clean stale worktree ${path}; a reparse point could not be removed (refusing recursive delete near real deps)`,
        );
      }
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
      // Strip reparse points FIRST: a leaked junction + `git worktree remove`
      // (recursive) could otherwise traverse into the clone's real deps. If any
      // reparse point could not be confirmed removed, REFUSE the recursive
      // worktree removal — fail safe rather than risk deleting real deps.
      const safe = await deprovisionWorktree(wt.path);
      if (!safe) {
        safeLog(
          "ERROR",
          `teardown: reparse point(s) remain under ${wt.path}; skipping recursive worktree removal to avoid deleting real deps`,
        );
        return;
      }
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
