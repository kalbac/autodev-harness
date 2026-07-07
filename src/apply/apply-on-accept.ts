/**
 * apply-on-accept (operator gate-override): commit an escalated task's REVIEWED
 * diff that the independent critic did NOT bless, on the operator's explicit
 * request (`POST /escalations/:id/reply` choice "C" — a distinct, deliberate
 * action, NOT the default "A" accept, which still only releases the lock to
 * quarantine).
 *
 * The worker's worktree is torn down at escalation, so the change survives ONLY
 * as the file_set-scoped unified diff the conductor persists to
 * `runtime/<id>/diff.patch` (present for critic/gate/merge escalations — the
 * ones that reach the critic). This replays that patch onto the loop branch:
 * validate → `git apply` → `git add <file_set>` → `git commit`. It reuses the
 * conductor's commit-time branch re-check + clean-tree precondition (NOT
 * `mergeAfterGate` — there is no worktree/branch to merge).
 *
 * Because this bypasses the safety gate, every step FAILS CLOSED:
 *  - the patch is validated to touch ONLY the task's file_set BEFORE applying
 *    (a compromised worker cannot smuggle an out-of-file_set edit into the tree);
 *  - the target branch must exactly match the loop branch the diff was captured
 *    on (pinned in `runtime/<id>/loop-branch`), not merely "some allowed branch";
 *  - a post-apply staging/commit failure RESTORES the clean tree (so a failed
 *    override never leaves dirt that a future commit could fold in) — unless a
 *    commit actually landed, in which case it is kept;
 *  - the gate-bypass is LOUD: the commit message marks it as an operator override.
 */
import type { HarnessConfig } from "../config/schema.js";
import type { Git, PorcelainEntry } from "../util/git.js";
import type { Task } from "../blackboard/types.js";
import { runNative } from "../util/native.js";

export type ApplyOnAcceptResult = { ok: true; hash: string } | { ok: false; reason: string };

export interface ApplyOnAcceptDeps {
  taskId: string;
  repoRoot: string;
  cfg: HarnessConfig;
  /** Git bound to the MAIN repo (branch re-check, stage, commit). */
  git: Git;
  /** The main tree's dirty entries — apply refuses on a non-empty tree. */
  mainTreeStatus: () => Promise<PorcelainEntry[]>;
  /** `runtime/<id>/diff.patch` text, or null when absent (pre-critic escalation). */
  readPatch: () => Promise<string | null>;
  /** The loop branch the diff was captured on (`runtime/<id>/loop-branch`), or null
   *  for a pre-s32 run that never recorded it (falls back to the pattern check). */
  readLoopBranch: () => Promise<string | null>;
  /** The still-escalated task (file_set to stage, type/title for the message), or null. */
  readTask: () => Promise<Task | null>;
  log: (level: string, message: string) => void;
}

/**
 * Normalize a path for the file_set ALLOWLIST comparison. Unlike the scheduler's
 * file-lock normalize (which strips ALL leading `.`/`/` — safe there because
 * over-collapsing only makes MORE tasks lock, i.e. more conservative), an allowlist
 * must NOT over-collapse: stripping a real leading dot would let `.env` match a
 * file_set entry `env` and smuggle a secret-file edit through (codex). So strip ONLY
 * a literal `./` prefix; a real leading dot (`.env`, `.github/…`) is preserved.
 */
function normalizeForAllowlist(p: string): string {
  return p.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

/** Reject an absolute path, a Windows drive path, or any `..` segment — belt-and-
 *  suspenders over `git apply`'s own out-of-tree guard (fail-closed). */
function isUnsafePath(p: string): boolean {
  const n = p.replace(/\\/g, "/");
  return n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.split("/").includes("..");
}

async function currentCommit(repoRoot: string): Promise<string | null> {
  const r = await runNative("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/**
 * Confirm every path the patch would touch is inside `fileSet`. Uses
 * `git apply --numstat` (parses the diff, prints `added\tdeleted\tpath` per file,
 * WITHOUT touching the tree). Fails CLOSED: a numstat error, an unparseable path,
 * or a rename/copy (`=>`/`{...}` in the path column — which could move a file OUT
 * of file_set) all refuse.
 */
async function patchPathsWithinFileSet(
  repoRoot: string,
  patch: string,
  fileSet: string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await runNative("git", ["apply", "--numstat", "-"], { cwd: repoRoot, stdin: patch });
  if (r.exitCode !== 0) {
    return { ok: false, reason: `git apply --numstat failed (malformed or inapplicable patch): ${r.stderr.trim()}` };
  }
  const allowed = new Set(fileSet.map(normalizeForAllowlist));
  for (const line of r.stdout.split("\n").filter((l) => l.trim().length > 0)) {
    const path = line.split("\t")[2] ?? "";
    if (path === "" || path.includes(" => ") || path.includes("{")) {
      return { ok: false, reason: `patch contains a rename/copy or unparseable path ('${path}'); refusing (an override must touch only the task file_set)` };
    }
    if (isUnsafePath(path)) {
      return { ok: false, reason: `patch path '${path}' is absolute or escapes the repo; refusing` };
    }
    if (!allowed.has(normalizeForAllowlist(path))) {
      return { ok: false, reason: `patch touches '${path}', which is outside the task file_set; refusing` };
    }
  }
  return { ok: true };
}

/** Best-effort restore to a clean tree at `headBefore` after a failed post-apply
 *  step, so a failed override leaves NO dirt. `reset --hard` reverts tracked edits
 *  (and any partial commit) to headBefore; `clean` removes patch-added untracked
 *  files (scoped to file_set, which the pre-apply validation proved is all the
 *  patch touches). */
async function restoreClean(repoRoot: string, headBefore: string, fileSet: string[]): Promise<void> {
  const reset = await runNative("git", ["reset", "--hard", headBefore], { cwd: repoRoot });
  if (reset.exitCode !== 0) throw new Error(`git reset --hard failed: ${reset.stderr.trim()}`);
  const clean = await runNative("git", ["clean", "-fd", "--", ...fileSet], { cwd: repoRoot });
  if (clean.exitCode !== 0) throw new Error(`git clean failed: ${clean.stderr.trim()}`);
}

export async function applyOnAccept(deps: ApplyOnAcceptDeps): Promise<ApplyOnAcceptResult> {
  const { taskId, repoRoot, cfg, git, mainTreeStatus, readPatch, readLoopBranch, readTask, log } = deps;

  // 1. There must be a persisted, reviewable diff. Pre-critic escalations never
  //    wrote one — there is nothing the operator reviewed to commit.
  const patch = await readPatch();
  if (patch === null || patch.trim().length === 0) {
    return { ok: false, reason: "no persisted diff.patch for this task (a pre-critic escalation has no reviewed change to commit)" };
  }

  // 2. The escalated task must still be readable (file_set to stage; type/title).
  const task = await readTask();
  if (task === null) {
    return { ok: false, reason: `escalated task '${taskId}' not found (already resolved?)` };
  }

  // 3. Branch safety — never main, must match the allowed pattern AND, when the
  //    capturing loop branch was recorded, EXACTLY that branch (mirrors the
  //    conductor's `cur !== loopBranch` guard so an override can't land the diff
  //    on a different allowed branch than the one it was reviewed against).
  const branch = await git.currentBranch();
  if (branch === "main" || !new RegExp(cfg.allowedBranchPattern).test(branch)) {
    return { ok: false, reason: `refusing to commit on branch '${branch}' (must match ${cfg.allowedBranchPattern}, never main)` };
  }
  const loopBranch = await readLoopBranch();
  if (loopBranch !== null && loopBranch !== branch) {
    return { ok: false, reason: `current branch '${branch}' is not the loop branch the diff was captured on ('${loopBranch}'); restore it before accepting` };
  }

  // 4. Clean main tree — apply onto a dirty tree could fold unrelated edits into
  //    this commit (the same precondition mergeAfterGate enforces).
  const dirty = await mainTreeStatus();
  if (dirty.length > 0) {
    return { ok: false, reason: `main working tree is not clean (${dirty.length} path(s)); resolve it before committing an accepted change` };
  }

  // 5. Validate the patch touches ONLY the task's file_set BEFORE applying — a
  //    compromised worker must not be able to smuggle an out-of-file_set edit into
  //    the tree via the operator's accept.
  const within = await patchPathsWithinFileSet(repoRoot, patch, task.file_set);
  if (!within.ok) return within;

  // 6. Replay the patch onto the working tree (atomic — a failing hunk applies
  //    nothing, leaving the tree untouched).
  const headBefore = await currentCommit(repoRoot);
  const applied = await runNative("git", ["apply", "-"], { cwd: repoRoot, stdin: patch });
  if (applied.exitCode !== 0) {
    return { ok: false, reason: `git apply failed (the loop branch likely moved since the diff was captured): ${applied.stderr.trim()}` };
  }

  // 7. Stage EXACTLY the file_set + commit as an explicit, attributed override.
  try {
    await git.add(task.file_set);
    const kind = cfg.commit.typeMap[task.type] ?? cfg.commit.defaultKind;
    const msg = `${kind}(autodev): ${task.title}\n\n[operator-accepted over a critic escalation — apply-on-accept override]`;
    const hash = await git.commit(msg);
    log("INFO", `apply-on-accept: committed ${taskId} -> ${hash} (operator override, critic-unblessed)`);
    return { ok: true, hash };
  } catch (err) {
    // Post-apply failure. If a commit actually landed (e.g. commit succeeded but a
    // follow-on rev-parse hiccupped), KEEP it — never discard a real commit. Else
    // restore the clean tree so the failed override leaves no dirt.
    const headAfter = await currentCommit(repoRoot);
    if (headAfter !== null && headBefore !== null && headAfter !== headBefore) {
      log("WARN", `apply-on-accept: ${taskId} commit landed (${headAfter}) despite a post-commit error; keeping it`);
      return { ok: true, hash: headAfter };
    }
    if (headBefore !== null) {
      try {
        await restoreClean(repoRoot, headBefore, task.file_set);
      } catch (restoreErr) {
        log("ERROR", `apply-on-accept: ${taskId} rollback after a failed commit ALSO failed: ${String(restoreErr)} (tree may be dirty)`);
      }
    }
    return { ok: false, reason: `staging/commit failed after apply (working tree restored): ${String((err as Error).message ?? err)}` };
  }
}
