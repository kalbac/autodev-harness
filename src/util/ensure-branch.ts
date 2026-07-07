/**
 * Shared git branch/bootstrap ops for the New Project flow + the conductor
 * branch-guard onboarding fix (s30 Task 1). `ensureAutodevBranch` guarantees a
 * repo is on an `^autodev/` branch (the conductor refuses to run otherwise —
 * `conductor.ts` guard, default pattern `schema.ts`); `initAutodevRepo`
 * git-inits a fresh folder, establishes HEAD via an empty commit (a zero-commit
 * repo cannot create a worktree), and lands it on `autodev/main`. Neither stages
 * or commits the operator's existing files — they stay untracked for the
 * operator to commit their own baseline (spec §2 non-goals).
 *
 * The canonical default branch name is a FIXED `autodev/main` — we never reverse
 * the guard regex to synthesize a name (Task 1 brief).
 */
import type { Git } from "./git.js";
import { runNative } from "./native.js";

type Log = (level: string, message: string) => void;

export const DEFAULT_AUTODEV_BRANCH = "autodev/main";
export const DEFAULT_AUTODEV_PATTERN = /^autodev\//;

export interface EnsureBranchResult {
  branch: string;
  /** True when we changed the checked-out branch (created or switched). */
  switched: boolean;
}

export interface EnsureBranchOptions {
  /** Guard pattern to satisfy (default `^autodev/`, matching the conductor). */
  pattern?: RegExp;
  /** Name to CREATE when no matching branch exists (default `autodev/main`). */
  defaultBranch?: string;
  log?: Log;
}

/**
 * Put `git`'s repo on a branch matching `pattern`. Already-matching → no-op;
 * a matching branch exists but isn't checked out → switch (never recreate);
 * otherwise create `defaultBranch` from the current HEAD (dirty tree carries
 * over — `git checkout`/`checkout -b` preserve uncommitted changes; we never
 * stash). Requires a born HEAD (call after an initial commit for a fresh repo).
 */
export async function ensureAutodevBranch(git: Git, opts: EnsureBranchOptions = {}): Promise<EnsureBranchResult> {
  const pattern = opts.pattern ?? DEFAULT_AUTODEV_PATTERN;
  const defaultBranch = opts.defaultBranch ?? DEFAULT_AUTODEV_BRANCH;

  const cur = await git.currentBranch();
  if (pattern.test(cur)) return { branch: cur, switched: false };

  const existing = (await git.listBranches()).find((b) => pattern.test(b));
  if (existing !== undefined) {
    await git.checkoutBranch(existing);
    opts.log?.("INFO", `ensure-branch: switched ${cur} -> ${existing}`);
    return { branch: existing, switched: true };
  }

  await git.createBranch(defaultBranch);
  opts.log?.("INFO", `ensure-branch: created ${defaultBranch} from ${cur}`);
  return { branch: defaultBranch, switched: true };
}

/**
 * Turn a NON-git folder into a usable autodev project root: `git init` → empty
 * initial commit (establishes HEAD so worktrees work) → `ensureAutodevBranch`.
 * Existing files stay UNTRACKED (never `git add`-ed); `untrackedCount` lets the
 * UI hint the operator to commit their baseline before the first run.
 */
export async function initAutodevRepo(
  git: Git,
  opts: EnsureBranchOptions = {},
): Promise<{ branch: string; untrackedCount: number }> {
  await git.init();
  await git.commitEmpty("chore: initialize autodev project");
  const { branch } = await ensureAutodevBranch(git, opts);
  const untrackedCount = await git.countUntracked();
  return { branch, untrackedCount };
}

/**
 * True iff `repoRoot` is inside an existing git work tree (its own repo OR a
 * subdirectory of one with no nested `.git` of its own) — the case
 * `existsSync(join(root, ".git"))` alone misses. Used by `initGit`'s
 * already-a-repo guard so selecting a subfolder of a repo doesn't `git init` a
 * nested repo. A missing `git` binary makes the underlying spawn REJECT
 * (ENOENT) rather than resolving `false` — callers that need to distinguish
 * "not a repo" from "git unavailable" must let that rejection propagate.
 */
export async function isInsideWorkTree(repoRoot: string): Promise<boolean> {
  const r = await runNative("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });
  return r.exitCode === 0 && r.stdout.trim() === "true";
}
