import { lstat, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, parse } from "node:path";

/**
 * The blackboard subdirectories a corpus case must start from empty. Both are per-run
 * working state, NOT history: `digest.md`, `runs/`, and `decision-journal.ndjson` are
 * deliberately left alone so a corpus run's own trail survives.
 *
 *  - `queue` — a task left in `escalated/` from a previous case still holds a LOCK on
 *    its `file_set`, so the next case's task targeting the same file is never claimed:
 *    the run reports "triggered", nothing happens, and the case errors for a reason that
 *    looks nothing like its cause (docs/gotchas/replied-escalation-holds-filelock.md).
 *  - `runtime` — the executor reads each task's `evidence.json` from here. A previous
 *    case's record under a task id the decompose happens to reuse would be read as THIS
 *    case's outcome: a stale projection presented as a measurement, which is exactly the
 *    failure docs/gotchas/stale-projection-needs-ssot-reconciliation.md is about.
 */
export const PURGED_SUBDIRS = ["queue", "runtime"] as const;

/**
 * Empty the per-run blackboard subdirectories under `stateDirAbs`, returning the ones
 * that actually existed. Idempotent — an absent subdirectory is not an error.
 *
 * Deliberately narrow: it removes only the two literally-named subdirectories, never
 * `stateDirAbs` itself, and it refuses a filesystem root outright. A reparse point
 * (Windows junction / symlink) is UNLINKED, never recursed into: `rm -r` follows a
 * junction and deletes its real target, which is how a teardown could wipe a directory
 * nobody named (docs/gotchas/win-git-worktree-remove-follows-junction.md).
 */
export async function resetHarnessState(stateDirAbs: string): Promise<string[]> {
  if (stateDirAbs.trim() === "" || !isAbsolute(stateDirAbs)) {
    throw new Error(`corpus: refusing to purge harness state -- '${stateDirAbs}' is not an absolute path`);
  }
  if (parse(stateDirAbs).root === stateDirAbs) {
    throw new Error(`corpus: refusing to purge harness state -- '${stateDirAbs}' is a filesystem root`);
  }

  const purged: string[] = [];
  for (const sub of PURGED_SUBDIRS) {
    const target = join(stateDirAbs, sub);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Only a positive "not there" is absence; anything else (EACCES, ...) must be
      // loud, because silently skipping a purge leaves the next case measuring a
      // contaminated blackboard.
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw err;
    }
    if (st.isSymbolicLink()) {
      await unlink(target); // link-only removal — never recurse through a reparse point
    } else {
      await rm(target, { recursive: true, force: true });
    }
    purged.push(sub);
  }
  return purged;
}
