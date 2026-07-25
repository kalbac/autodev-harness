import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/** The lock file's name inside the target project's state directory. It sits at the state
 *  directory's ROOT, deliberately outside the `queue`/`runtime` subdirectories a case
 *  purges — so holding the lock survives every reset the run itself performs. */
export const CORPUS_LOCK_FILE = "corpus.lock";

export interface CorpusLock {
  /** Idempotent; safe to call from a `finally` that may run after a failure. */
  release(): Promise<void>;
}

/** Seams so the lock's contents are deterministic under test. */
export interface CorpusLockDeps {
  pid: number;
  nowIso: () => string;
}

/**
 * Take EXCLUSIVE ownership of a target project's harness state for the duration of a
 * corpus run.
 *
 * A point-in-time "is the queue idle?" check cannot make two concurrent corpus runs safe
 * (codex R4 High): both can observe an idle queue, and then the second one's purge deletes
 * the first one's live case mid-flight — destroying the measurement in a way whose only
 * symptom is a case erroring for an unrelated-looking reason. An `O_EXCL` create is the
 * standard primitive that actually settles it: exactly one process wins, and the loser
 * learns who holds it rather than racing.
 *
 * Order matters at the call site: acquire the lock FIRST, then check the queue. Checking
 * under the lock is what makes the check meaningful — another corpus run cannot be between
 * its own check and its own purge, because it cannot be running at all.
 *
 * A crashed run leaves the file behind. That is deliberate: a lock that expires on its own
 * would silently re-open the race it exists to close. The refusal names the file and the
 * pid that wrote it, so clearing it is a one-line, informed decision by the operator.
 */
export async function acquireCorpusLock(
  stateDirAbs: string,
  deps: CorpusLockDeps = { pid: process.pid, nowIso: () => new Date().toISOString() },
): Promise<CorpusLock> {
  const path = join(stateDirAbs, CORPUS_LOCK_FILE);

  let handle;
  try {
    handle = await open(path, "wx"); // O_CREAT | O_EXCL — fails if it already exists
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Best-effort detail: a lock we cannot read is still a lock. Never fold an unreadable
    // holder into "no holder" — that is the fail-open this whole primitive exists to stop.
    const holder = await readFile(path, "utf8").catch(() => "<unreadable>");
    throw new Error(
      `eval: another corpus run holds this project (${path}: ${holder.trim()}). ` +
        `A corpus run takes exclusive ownership of the harness state. If no run is actually ` +
        `active, that file is left over from a crashed run -- delete it and retry.`,
    );
  }

  try {
    await handle.writeFile(JSON.stringify({ pid: deps.pid, startedAt: deps.nowIso() }));
  } finally {
    await handle.close();
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await unlink(path);
      } catch (err) {
        // Already gone is fine (someone cleared a lock they believed was stale); anything
        // else must be loud, or a lock nobody can remove would block every future run
        // while looking released.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}
