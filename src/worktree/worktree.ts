import { rm, symlink, unlink, rmdir, mkdir, lstat, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, posix, win32 } from "node:path";
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
  // directly (in tests) without going through config. `isAbsolute` from
  // `node:path` resolves to the HOST platform's semantics only (win32 on
  // Windows, posix elsewhere); check both explicitly so a Windows-style
  // absolute path (`C:\...`) or a UNC path (`\\host\share\...`) is rejected
  // even when the harness runs on Linux/mac, and a POSIX-style absolute path
  // (`/etc`) is rejected even when it runs on Windows (finding 3).
  const isSafeProvisionEntry = (p: string): boolean =>
    p !== "" &&
    !posix.isAbsolute(p) &&
    !win32.isAbsolute(p) &&
    !p.split(/[\\/]/).includes("..");

  // The current `provision` config is NOT an authoritative record of what a
  // given worktree actually has linked into it: a worktree provisioned under
  // an OLDER config, then left stale (crash / skipped teardown), can be
  // re-queued after the config changed (e.g. an entry dropped). Deprovisioning
  // driven solely by the CURRENT config would then miss the stale link
  // entirely, letting a later recursive delete traverse it into real deps.
  // Persist what was ACTUALLY provisioned, per task id, as a manifest file
  // living OUTSIDE the worktree directory (a sibling under worktreesDir) so
  // `git worktree remove` / recursive `rm` of the worktree dir never touches
  // it. taskId is validated by `assertSafeTaskId` before this is ever called
  // from `create`, so it is safe to use directly as a single path segment.
  const manifestPath = (taskId: string): string => join(worktreesDir, `${taskId}.provision.json`);

  // Best-effort: absent or corrupt manifest reads as "nothing recorded" ([]),
  // never throws. Defensively accepts only an array of strings.
  const readManifest = async (taskId: string): Promise<string[]> => {
    try {
      const raw = await readFile(manifestPath(taskId), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x): x is string => typeof x === "string");
    } catch {
      return [];
    }
  };

  // Best-effort: writing the manifest must never break provisioning.
  const writeManifest = async (taskId: string, entries: string[]): Promise<void> => {
    try {
      await writeFile(manifestPath(taskId), JSON.stringify(entries));
    } catch (err) {
      safeLog(
        "WARN",
        `provision: failed to write manifest for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Best-effort: absence (or removal failure) is not an error worth surfacing.
  const removeManifest = async (taskId: string): Promise<void> => {
    try {
      await unlink(manifestPath(taskId));
    } catch {
      /* nothing to remove, or already gone — fine */
    }
  };

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
  // touching anything. A real (non-symlink) entry — e.g. a mistakenly
  // provisioned `README.md` or `.git` (finding 2) — is left untouched and
  // reported unsafe; only a confirmed symlink/junction is removed, and removal
  // is verified by re-`lstat`-ing afterward. This is THE safety invariant: a
  // leaked junction (or a misconfigured real entry) must never let a
  // recursive delete reach the clone's real deps.
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

  // Unlink all provisioned links at a worktree path. MUST run before any
  // recursive removal of that path (git worktree remove / rm -rf). Driven by
  // the UNION of the per-worktree manifest (what was actually provisioned,
  // possibly under an older config) and the current config — never by the
  // current config alone, since that would miss stale links left by a config
  // change (the exact stale-config data-loss blocker this manifest fixes).
  // Attempts EVERY entry regardless of earlier failures (so a stuck link
  // doesn't mask others), and returns `true` only if ALL entries were
  // confirmed safe.
  const deprovisionWorktree = async (wtPath: string, taskId: string): Promise<boolean> => {
    const recorded = await readManifest(taskId);
    const entries = Array.from(new Set([...recorded, ...provision])).filter(isSafeProvisionEntry);
    let safe = true;
    for (const p of entries) {
      const ok = await removeLinkOnly(join(wtPath, p));
      safe = safe && ok;
    }
    return safe;
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
      // Unlink any provisioned links from a prior attempt BEFORE the recursive
      // cleanup below (`worktree remove --force` and `rm -rf`), so a stale
      // junction can never let those deletes reach the clone's real deps. If a
      // link could not be confirmed removed (or a real non-link entry was
      // found where a link should be), REFUSE the recursive cleanup entirely
      // — fail safe rather than risk deleting real deps near it.
      const safe = await deprovisionWorktree(path, taskId);
      if (!safe) {
        throw new Error(
          `create: cannot clean stale worktree ${path}; a provisioned link could not be removed (refusing recursive delete near real deps)`,
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
      // Record what THIS create actually provisioned so a future deprovision
      // (teardown, or a later re-queue's stale-cleanup) stays authoritative
      // even if the config changes again before then. An empty config writes
      // no manifest — and removes any leftover manifest from an OLDER config
      // for this taskId, so a stale manifest never lingers once the current
      // config genuinely provisions nothing.
      if (provision.length > 0) {
        await writeManifest(taskId, provision);
      } else {
        await removeManifest(taskId);
      }
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
      // (recursive) could otherwise traverse into the clone's real deps. If any
      // link could not be confirmed removed, REFUSE the recursive worktree
      // removal — fail safe rather than risk deleting real deps.
      const safe = await deprovisionWorktree(wt.path, wt.taskId);
      if (!safe) {
        safeLog(
          "ERROR",
          `teardown: provisioned link(s) remain under ${wt.path}; skipping recursive worktree removal to avoid deleting real deps`,
        );
        return;
      }
      await mainGit.worktreeRemove(wt.path);
      await removeManifest(wt.taskId);
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
