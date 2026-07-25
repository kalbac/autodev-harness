import type { QueueState } from "../blackboard/repository.js";

/** The queue states that represent LIVE work — a task sitting in one of these is either
 *  waiting to run, running, or parked awaiting the operator. `done` and `quarantine` are
 *  terminal history and are left out. */
const LIVE_STATES: readonly QueueState[] = ["pending", "active", "escalated"];

/** The slice of the blackboard the preflight needs. Narrow on purpose so the check is
 *  testable without a repo. */
export interface QueueReader {
  listTasks(state: QueueState): Promise<{ id: string }[]>;
}

/**
 * Refuse to start a corpus run against a target project that still has live work.
 *
 * This closes a destruction path `git status` cannot see (codex R1 High): the blackboard
 * lives under a git-EXCLUDED `.autodev`, so the environment's clean-tree check says
 * nothing about it, yet every case purges `queue/` and `runtime/` outright. Without this,
 * running `eval` against a project with a parked escalation would silently delete the
 * operator's queued work — including an escalation waiting for a decision — and the only
 * evidence would be that the tasks stopped existing.
 *
 * It runs ONCE, before the first case. Between cases the queue only ever holds the
 * corpus's own tasks, which are meant to be cleared.
 */
export async function assertTargetQueueIsIdle(repo: QueueReader): Promise<void> {
  const live: string[] = [];
  for (const state of LIVE_STATES) {
    for (const t of await repo.listTasks(state)) live.push(`${state}/${t.id}`);
  }
  if (live.length === 0) return;

  const shown = live.slice(0, 10).join(", ");
  throw new Error(
    `eval: refusing to run -- the target project has ${live.length} live task(s) [${shown}` +
      `${live.length > 10 ? ", ..." : ""}]. A corpus case purges the queue and runtime state before ` +
      `every case, which would DESTROY this work (it lives under a git-excluded .autodev, so no ` +
      `git check can protect it). Finish or clear the queue first.`,
  );
}

/** A guard that must be satisfied before the first purge and is retired only once the
 *  corpus has actually taken ownership of the queue. */
export interface OneShotQueueGuard {
  /** Throws while the guard is still armed and the target queue is not idle. */
  check(): Promise<void>;
  /** Retire the guard. Call this ONLY after a purge has genuinely completed. */
  satisfied(): void;
}

/**
 * The idle-queue guard, armed until the corpus owns the queue.
 *
 * The subtlety is when to retire it (codex R3 High, a narrower leak inside the R2 fix):
 * retiring it right after a passing check means a first attempt that throws LATER — on
 * the branch check, on a dirty tree — leaves the guard down while nothing has been purged
 * yet, so a retry seconds later would blow away work the operator queued in between. The
 * guard may only be retired once the purge has actually run, because that is the moment
 * the queue stops being the operator's and starts being the corpus's. Until then, every
 * attempt re-checks.
 */
export function createOneShotQueueGuard(repo: QueueReader): OneShotQueueGuard {
  let armed = true;
  return {
    async check(): Promise<void> {
      if (armed) await assertTargetQueueIsIdle(repo);
    },
    satisfied(): void {
      armed = false;
    },
  };
}
