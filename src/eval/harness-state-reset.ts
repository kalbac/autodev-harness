import { lstat, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";

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
 *  - `escalations` — the human-readable escalation ARTIFACT (`escalate.ts`'s markdown
 *    body), separate from the queue entry that locks the file_set above. Left unpurged,
 *    it accumulates across the WHOLE run (25 stale files measured on the s60 polygon), so
 *    a diagnostician reading one case's archive sees every other case's escalation bodies
 *    mixed in alongside it — per-case isolation of diagnostics, the same reason `runtime`
 *    is purged, not a new one (#131).
 */
export const PURGED_SUBDIRS = ["queue", "runtime", "escalations"] as const;

/**
 * CALLER CONTRACT (codex R3, scope caveat): this is a low-level removal, not a policy. It
 * verifies WHERE it may delete, never WHETHER it should — establishing that the state
 * directory is the corpus's to clear rather than the operator's live work is the caller's
 * job, and `harness-case-environment.ts` does it with a one-shot idle-queue guard before
 * the first call. Deliberately not folded in here: this function has no way to tell a
 * corpus run from any other caller, so a check inside it would either be redundant or
 * would block a legitimate future user of the same primitive.
 */

/**
 * Empty the per-run blackboard subdirectories under `stateDirAbs`, returning the ones
 * that actually existed. Idempotent — an absent subdirectory is not an error.
 *
 * Deliberately narrow: it removes only the two literally-named subdirectories, never
 * `stateDirAbs` itself, and it refuses a filesystem root outright. A reparse point
 * (Windows junction / symlink) is UNLINKED, never recursed into: `rm -r` follows a
 * junction and deletes its real target, which is how a teardown could wipe a directory
 * nobody named (docs/gotchas/win-git-worktree-remove-follows-junction.md).
 *
 * The state directory ITSELF must be a real directory too (codex R1 High): a junctioned
 * `.autodev` would make the leaf `lstat` below report an ordinary directory that in fact
 * lives somewhere else entirely, and the recursive removal would then land on whatever
 * the link points at. This matches the refusal `registry/scaffold.ts` already applies to a
 * symlinked `.autodev` (docs/gotchas/scaffold-symlink-escape.md) — one rule, both writers.
 *
 * RESIDUAL, named rather than papered over (raised again as codex R2 High; still declined,
 * with the guarantee stated precisely rather than overclaimed). What IS guaranteed: at the
 * moment of the check, `stateDirAbs` and each target are real directories, and Node's
 * recursive `rm` unlinks any symlink it meets DURING the walk instead of following it — so
 * a link planted anywhere below the target cannot redirect the removal. What is NOT
 * guaranteed: the top-level `stateDirAbs`/`queue`/`runtime` entries being swapped for a
 * reparse point in the window between the `lstat` and the `rm`. Closing that needs an
 * fd-relative recursive remove (`openat2`) which Node does not expose — the same residual
 * already accepted in docs/gotchas/static-file-serving-symlink-traversal.md. Reaching it
 * requires write access inside the target repo's state directory while a corpus run is
 * live, which is strictly more access than the removal itself would grant.
 */
export async function resetHarnessState(stateDirRaw: string): Promise<string[]> {
  // Normalize FIRST, then validate. Checking the raw string would let `C:\work\..` pass
  // the root test while `join` later resolves its children to `C:\queue` — the
  // check-one-form / use-another shape of docs/gotchas/validated-one-string-used-another.md
  // (codex R1 High).
  if (stateDirRaw.trim() === "" || !isAbsolute(stateDirRaw)) {
    throw new Error(`corpus: refusing to purge harness state -- '${stateDirRaw}' is not an absolute path`);
  }
  const stateDirAbs = resolve(stateDirRaw);
  if (parse(stateDirAbs).root === stateDirAbs) {
    throw new Error(`corpus: refusing to purge harness state -- '${stateDirAbs}' is a filesystem root`);
  }

  const rootStat = await lstat(stateDirAbs).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) {
    throw new Error(
      `corpus: refusing to purge harness state -- '${stateDirAbs}' is not a real directory ` +
        `(a symlinked or absent state directory would put the removal somewhere nobody named)`,
    );
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
