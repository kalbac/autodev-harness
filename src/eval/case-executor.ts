import type { CorpusCase } from "./corpus-case.js";
import type { CaseExecutor } from "./corpus-runner.js";
import type { EvidenceRecord } from "../report/evidence-types.js";
import type { EvidenceSlot } from "../report/evidence-store.js";

/**
 * The environment seam the real `CaseExecutor` drives. Everything heavy and
 * environment-bound (git, the blackboard, the conductor, the LLM decompose) lives
 * BEHIND this interface, so the executor's own decision logic below — what counts as a
 * runnable case, which record is the decisive one, what makes a measurement
 * untrustworthy — stays pure and unit-testable against a scripted fake.
 *
 * Ordering is a contract, not an implementation detail: `resetToBaseline` must restore
 * BOTH the target repo tree AND the harness blackboard, because a leftover escalated
 * task from a previous case file-LOCKS its `file_set` and would silently prevent the
 * next case's task from ever being claimed
 * (docs/gotchas/replied-escalation-holds-filelock.md), while a leftover `runtime/`
 * directory would let a previous case's `evidence.json` be read as THIS case's result
 * (the stale-projection failure of docs/gotchas/stale-projection-needs-ssot-reconciliation.md).
 */
export interface CaseEnvironment {
  /** Restore the known-clean starting state: the target repo at the corpus baseline
   *  AND a purged harness blackboard. Throws rather than proceeding from an unknown
   *  state (Principle 10). */
  resetToBaseline(): Promise<void>;
  /** Materialize the case's seed fixture into the target repo and commit it, so the
   *  run starts from a clean tree that already contains the case's premise. */
  applySeed(c: CorpusCase): Promise<void>;
  /** Compose a run from the operator intent (decompose → enqueue) and return the
   *  enqueued task ids. An empty array means nothing was enqueued. */
  compose(intent: string): Promise<string[]>;
  /** Drive the headless conductor until the queue stops moving (bounded). */
  drain(): Promise<void>;
  /** Read each task's evidence slot — `ok` / `absent` / `unreadable` kept DISTINCT,
   *  because they mean different things to the measurement (see `evidence-store.ts`). */
  readEvidence(taskIds: string[]): Promise<EvidenceSlot[]>;
  log(level: string, msg: string): void;
}

/**
 * How decisively an outcome explains why a case did not simply land. A case is a single
 * assertion about the harness's behaviour, but one intent can legitimately decompose
 * into several tasks — so the case's outcome is the outcome of the task whose fate
 * DECIDED the case.
 *
 * A non-committed outcome always outranks a committed one: a case counts as `committed`
 * only when EVERY task committed. That direction is load-bearing for the corpus's
 * headline metric — an adversarial case whose planted defect was caught in one task
 * while a harmless sibling committed must read as CAUGHT, never as an escaped defect.
 * Among the non-committed outcomes, `escalated` ranks first because it is the only one
 * that carries an escalation TYPE, which is what an adversarial case asserts on.
 */
const OUTCOME_RANK: Record<EvidenceRecord["outcome"], number> = {
  escalated: 0,
  quarantined: 1,
  abandoned: 2,
  committed: 3,
};

/**
 * Pick the record that decides the case out of every record the run produced. Pure and
 * total: ties are broken by `task_id` so the choice is deterministic (a corpus whose
 * verdict depended on filesystem enumeration order would not be a measurement), and an
 * empty input yields `null` rather than a fabricated record.
 */
export function selectDecisiveEvidence(records: EvidenceRecord[]): EvidenceRecord | null {
  let best: EvidenceRecord | null = null;
  for (const r of records) {
    if (best === null) {
      best = r;
      continue;
    }
    const rank = OUTCOME_RANK[r.outcome];
    const bestRank = OUTCOME_RANK[best.outcome];
    if (rank < bestRank || (rank === bestRank && r.task_id < best.task_id)) best = r;
  }
  return best;
}

/**
 * The real `CaseExecutor` (Evaluation Corpus Phase 2): run ONE case end to end through
 * the actual harness and return the `EvidenceRecord` that decided it.
 *
 * Every failure mode here is a THROW, never a quietly-degraded record. The runner turns
 * a throw into a `null`-evidence result, which the aggregator counts as an errored case
 * — a visible failure. The alternative (returning a partial or substituted record) would
 * let a broken measurement read as a harness verdict, which is the one thing a corpus
 * whose job is to make the harness's value provable must never do.
 */
export function createCaseExecutor(env: CaseEnvironment): CaseExecutor {
  function fail(c: CorpusCase, detail: string): never {
    const message = `corpus case '${c.id}': ${detail}`;
    env.log("ERROR", message);
    throw new Error(message);
  }

  return {
    async execute(c: CorpusCase): Promise<EvidenceRecord | null> {
      env.log("INFO", `corpus case '${c.id}': restoring the baseline`);
      await env.resetToBaseline();

      env.log("INFO", `corpus case '${c.id}': applying seed '${c.seed}'`);
      await env.applySeed(c);

      env.log("INFO", `corpus case '${c.id}': composing a run from the intent`);
      const taskIds = await env.compose(c.intent);
      if (taskIds.length === 0) {
        // Nothing was enqueued, so the harness was never asked to decide anything.
        // Counting this as a pass or a fail would both be wrong — it is a case that
        // did not RUN, which is exactly what an errored case means.
        fail(c, "the intent enqueued 0 tasks -- the case never ran");
      }
      env.log("INFO", `corpus case '${c.id}': ${taskIds.length} task(s) enqueued -- draining`);
      await env.drain();

      const slots = await env.readEvidence(taskIds);
      const unreadable = slots.filter((s) => s.state === "unreadable");
      if (unreadable.length > 0) {
        // An unreadable record is a defect, never an absence (evidence-store.ts). One
        // corrupt record makes the whole case's outcome unknowable, so the case errors
        // rather than being decided by the records that happened to survive.
        const detail = unreadable
          .map((s) => `${s.taskId} (${s.state === "unreadable" ? s.detail : ""})`)
          .join("; ");
        fail(c, `unreadable evidence for ${unreadable.length} task(s): ${detail}`);
      }

      const records = slots.flatMap((s) => (s.state === "ok" ? [s.record] : []));
      if (records.length === 0) {
        fail(c, `no evidence record was written for any of the ${taskIds.length} task(s): ${taskIds.join(", ")}`);
      }

      const decisive = selectDecisiveEvidence(records);
      /* c8 ignore next */
      if (decisive === null) fail(c, "internal: no decisive record among a non-empty record set");
      if (records.length > 1) {
        env.log(
          "INFO",
          `corpus case '${c.id}': ${records.length} record(s); decisive = ${decisive.task_id} (${decisive.outcome})`,
        );
      }
      return decisive;
    },
  };
}
