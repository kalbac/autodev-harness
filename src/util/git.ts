import { runNative } from "./native.js";

export interface MergeResult {
  ok: boolean;
  conflict: boolean;
  /** Present on a NON-conflict refusal (a failed precondition, e.g. a dirty
   * main working tree or a failed checkout) so the caller can escalate with an
   * accurate, actionable reason instead of a phantom "merge conflict". */
  reason?: string;
}

export interface Git {
  currentBranch(): Promise<string>;
  init(): Promise<void>;
  listBranches(): Promise<string[]>;
  checkoutBranch(name: string): Promise<void>;
  createBranch(name: string): Promise<void>;
  commitEmpty(message: string): Promise<string>;
  countUntracked(): Promise<number>;
  changedFiles(scope?: string[]): Promise<string[]>;
  diffText(scope?: string[]): Promise<string>;
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<string>;
  worktreeAdd(path: string, branch: string, base: string): Promise<void>;
  worktreeRemove(path: string): Promise<void>;
  merge(branch: string): Promise<MergeResult>;
}

function fail(cmd: string, args: string[], result: { exitCode: number; stderr: string }): never {
  throw new Error(`git ${cmd} failed (exit ${result.exitCode}): ${result.stderr.trim()}\n(args: ${args.join(" ")})`);
}

/** One `git status --porcelain` line: the 2-char XY status and the path. `??` = untracked
 *  (a `.git/info/exclude` entry can neutralize it); anything else = tracked dirt (exclude
 *  cannot help — needs a commit/stash or `update-index --skip-worktree`). */
export interface PorcelainEntry {
  /** The 2-char XY status field, e.g. "??", " M", "M ", "A ". */
  code: string;
  path: string;
}

/**
 * Read the MAIN working tree's dirty entries (`git status --porcelain`), parsed.
 * A standalone helper (not on the `Git` interface) so the dirty-tree preflight can
 * be wired without touching every `Git` fake — mirrors the direct `runNative` status
 * check in `worktree.mergeAfterGate`. Throws on a non-zero git exit; callers that must
 * never fail a run (the conductor preflight) wrap it best-effort.
 */
export async function mainTreeStatus(repoRoot: string): Promise<PorcelainEntry[]> {
  // core.quotepath=false → literal UTF-8 paths (no octal-escaped "\303\251" wrapping),
  // so a non-ASCII/spaced churn path is classified and printed verbatim in the WARNING.
  const r = await runNative("git", ["-c", "core.quotepath=false", "status", "--porcelain"], { cwd: repoRoot });
  if (r.exitCode !== 0) fail("status --porcelain", [], r);
  // Rename/copy records render as "old -> new" (warning-only): we take the NEW path (what's
  // now on disk) for classification/hints. This is a heuristic sufficient for a warning — the
  // real churn case (Serena rewriting its own tracked files) is a plain modification, not a rename.
  return r.stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const rest = l.slice(3);
      const arrow = rest.lastIndexOf(" -> "); // last arrow = porcelain's separator (dest is what's on disk)
      return { code: l.slice(0, 2), path: arrow >= 0 ? rest.slice(arrow + 4) : rest };
    });
}

/** Create a `Git` helper bound to a repo (or worktree) root, shelling out to the real `git` CLI. */
export function createGit(repoRoot: string): Git {
  async function run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return runNative("git", args, { cwd: repoRoot });
  }

  return {
    async currentBranch(): Promise<string> {
      const r = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (r.exitCode !== 0) fail("rev-parse --abbrev-ref HEAD", [], r);
      return r.stdout.trim();
    },

    async init(): Promise<void> {
      const r = await run(["init"]);
      if (r.exitCode !== 0) fail("init", [], r);
    },

    async listBranches(): Promise<string[]> {
      const r = await run(["branch", "--format=%(refname:short)"]);
      if (r.exitCode !== 0) fail("branch --format", [], r);
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    },

    async checkoutBranch(name: string): Promise<void> {
      const r = await run(["checkout", name]);
      if (r.exitCode !== 0) fail("checkout", [name], r);
    },

    async createBranch(name: string): Promise<void> {
      const r = await run(["checkout", "-b", name]);
      if (r.exitCode !== 0) fail("checkout -b", [name], r);
    },

    async commitEmpty(message: string): Promise<string> {
      // Baked identity so the bootstrap commit never fails on a machine with no
      // global user.email/user.name. Used ONLY for this empty init commit — the
      // operator's real commits go through their own git config elsewhere.
      const args = [
        "-c",
        "user.name=Autodev Harness",
        "-c",
        "user.email=autodev@harness.local",
        "commit",
        "--allow-empty",
        "-m",
        message,
      ];
      const r = await run(args);
      if (r.exitCode !== 0) fail("commit --allow-empty", args, r);
      const h = await run(["rev-parse", "HEAD"]);
      if (h.exitCode !== 0) fail("rev-parse HEAD", [], h);
      return h.stdout.trim();
    },

    async countUntracked(): Promise<number> {
      const r = await run(["status", "--porcelain"]);
      if (r.exitCode !== 0) fail("status --porcelain", [], r);
      return r.stdout.split("\n").filter((l) => l.startsWith("??")).length;
    },

    async changedFiles(scope?: string[]): Promise<string[]> {
      const args = ["diff", "--name-only", "HEAD"];
      if (scope && scope.length > 0) args.push("--", ...scope);
      const r = await run(args);
      if (r.exitCode !== 0) fail("diff --name-only", args, r);
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    },

    async diffText(scope?: string[]): Promise<string> {
      const args = ["diff"];
      if (scope && scope.length > 0) args.push("--", ...scope);
      const r = await run(args);
      if (r.exitCode !== 0) fail("diff", args, r);
      return r.stdout;
    },

    async add(paths: string[]): Promise<void> {
      const args = ["add", "--", ...paths];
      const r = await run(args);
      if (r.exitCode !== 0) fail("add", args, r);
    },

    async commit(message: string): Promise<string> {
      const r = await run(["commit", "-m", message]);
      if (r.exitCode !== 0) fail("commit", ["-m", message], r);
      const h = await run(["rev-parse", "HEAD"]);
      if (h.exitCode !== 0) fail("rev-parse HEAD", [], h);
      return h.stdout.trim();
    },

    async worktreeAdd(path: string, branch: string, base: string): Promise<void> {
      // `--` terminates options before the positional <path> so a path that
      // happens to look like a flag can never be misparsed.
      const args = ["worktree", "add", "-b", branch, "--", path, base];
      const r = await run(args);
      if (r.exitCode !== 0) fail("worktree add", args, r);
    },

    async worktreeRemove(path: string): Promise<void> {
      const args = ["worktree", "remove", "--force", "--", path];
      const r = await run(args);
      if (r.exitCode !== 0) fail("worktree remove", args, r);
    },

    async merge(branch: string): Promise<MergeResult> {
      const r = await run(["merge", "--no-edit", branch]);
      if (r.exitCode === 0) {
        return { ok: true, conflict: false };
      }

      // Determine REAL conflict state by checking for unmerged paths rather
      // than string-matching stdout/stderr (which false-positives on refs or
      // file content that happen to contain the word "CONFLICT").
      const unmerged = await run(["diff", "--name-only", "--diff-filter=U"]);
      const hasUnmergedPaths = unmerged.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0).length > 0;

      if (hasUnmergedPaths) {
        // Genuine conflict — abort to leave the tree clean (fail-closed —
        // never leave a half-merged state), then report it.
        const abort = await run(["merge", "--abort"]);
        if (abort.exitCode !== 0) {
          throw new Error(`git merge --abort failed: ${abort.stderr.trim()}`);
        }
        return { ok: false, conflict: true };
      }

      // Not a genuine conflict — some other merge failure (e.g. unknown
      // branch). If a merge somehow got left in progress, clean it up before
      // surfacing a real error; never silently report this as a conflict.
      const mergeInProgress = await run(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
      if (mergeInProgress.exitCode === 0) {
        const abort = await run(["merge", "--abort"]);
        if (abort.exitCode !== 0) {
          throw new Error(`git merge --abort failed: ${abort.stderr.trim()}`);
        }
      }
      fail("merge", [branch], r);
    },
  };
}
