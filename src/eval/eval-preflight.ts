import type { QueueState } from "../blackboard/repository.js";
import type { AgentCiCapability } from "../gate/agent-ci-exec.js";

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
  /** Whether the corpus has actually taken ownership of the target's queue (`satisfied()`
   *  has been called at least once). A passing `check()` alone is NOT ownership -- see
   *  `satisfied`'s own contract. Read-only query, used by the end-of-run leftover-queue
   *  purge (#132 / Fix 5i) to decide whether there is anything of THIS run's to purge: a
   *  guard that never retired means the corpus never took ownership, and purging would be
   *  destroying the operator's own work rather than this run's remains. */
  ownsQueue(): boolean;
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
  let owns = false;
  return {
    async check(): Promise<void> {
      if (armed) await assertTargetQueueIsIdle(repo);
    },
    satisfied(): void {
      armed = false;
      owns = true;
    },
    ownsQueue(): boolean {
      return owns;
    },
  };
}

/** The decision inputs for `assertAgentCiRunnable`, gathered by the caller (index.ts) from
 *  the target project's config and a real platform/WSL probe. Kept as a plain data shape
 *  so the decision itself stays pure and unit-testable without spawning anything. */
export interface AgentCiPreflightInput {
  /** `cfg.gate.agentCi.enabled` from the target project's config. */
  enabled: boolean;
  /** Whether `cfg.gate.agentCi.workflows` is non-empty. The gate step is fully inert when
   *  `enabled` but the allowlist is empty (mirrors `gate.ts`'s own "nothing to run" no-op
   *  -- see `gateDeps`'s `runAgentCi`), so refusing on `enabled` alone would block a
   *  config that never actually engages agent-ci. */
  hasWorkflows: boolean;
  /** The real capability probe (`detectAgentCiCapability` from `../gate/agent-ci.js`). */
  capability: AgentCiCapability;
}

/**
 * Refuse to start a corpus run when the target project's `gate.agentCi` would actually
 * engage (`enabled` AND a non-empty `workflows` allowlist) but agent-ci cannot run on this
 * machine (`docs/gotchas/agent-ci-not-runnable-on-native-windows.md`: no Docker/POSIX
 * `tar` path on native Windows, and even the WSL fallback needs a distro with Node).
 *
 * Without this, the gate itself already fails safely per-task (`AgentCiUnavailableError`
 * -> the conductor escalates) -- but "safely" still means EVERY case in the corpus
 * escalates for an environment reason having nothing to do with the harness under test,
 * and the run finishes, writes a report, and exits looking exactly like a real
 * measurement. A corpus that silently measures nothing is worse than one that refuses to
 * start (#132).
 *
 * Deliberately does NOT touch the operator's config file (never writes) and does NOT
 * relax the check by treating `unavailable` as "skip agent-ci for this run" -- a corpus
 * that quietly weakens the gate it exists to measure is not measuring the gate. The only
 * two ways forward are named in the message itself.
 */
export function assertAgentCiRunnable(input: AgentCiPreflightInput): void {
  if (!input.enabled || !input.hasWorkflows) return; // inert either way -- nothing to refuse
  if (input.capability.mode !== "unavailable") return;

  throw new Error(
    `eval: refusing to run -- the target project has gate.agentCi.enabled: true (with workflows configured), ` +
      `but agent-ci cannot run on this machine (${input.capability.detail}). Every case would escalate for an ` +
      `environment reason that has nothing to do with the harness under test, and the run would finish and ` +
      `write a report shaped exactly like a real measurement while actually measuring nothing. Either ` +
      `(1) set gate.agentCi.enabled: false in the target project's .autodev/config.yaml before running the ` +
      `corpus, or (2) run the corpus somewhere agent-ci actually works (native Linux/Mac, or Windows with WSL ` +
      `+ Node installed in the distro).`,
  );
}
