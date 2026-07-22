import type { EvidenceSlot } from "./evidence-store.js";

export interface RunRef {
  runId: string;
  intent: string;
  at: number;
}

export interface ExecutionTaskLine {
  task_id: string;
  title: string;
  outcome: string;
  commit: string | null;
  rounds: number;
  attempts: number;
  critic: { verdict: string; confidence: number } | null;
  gate_decision: string | null;
  /** Which gate greens were false — named, so a reader never has to guess. */
  gate_failures: string[];
  escalation_type: string | null;
  tokens: { worker_total: number; critic_total: number } | null;
  /** True when the record's own outcome disagreed with the live blackboard and the
   *  blackboard won. Its iteration-derived detail (commit, critic, gate, tokens) is
   *  then dropped rather than trusted, because it came from a superseded iteration. */
  evidence_stale: boolean;
}

/** A task's current queue membership, or `null` when it cannot be located. */
export type QueueLookup = (taskId: string) => string | null;

/**
 * The queue an outcome IMPLIES. `abandoned` maps to nothing: a report is only
 * generated for a finished run (no pending/active task), so an `abandoned` record
 * in a finished run cannot agree with any live queue -- it is always either a stale
 * record (a failed evidence write left a prior iteration's copy) or a missed exit.
 * Either way the live blackboard, not the record, is the truth (Principle 11).
 */
const OUTCOME_IMPLIES_QUEUE: Record<string, string> = {
  committed: "done",
  quarantined: "quarantine",
  escalated: "escalated",
};

export interface ExecutionReport {
  kind: "harness-execution";
  run: RunRef;
  completeness: { total: number; recorded: number; absent: number; unreadable: number };
  tasks: ExecutionTaskLine[];
  rollups: {
    committed: number;
    escalated: number;
    quarantined: number;
    /** Tasks that committed with rounds === 0 — the critic accepted the first diff. */
    first_pass: number;
    escalations_by_type: Record<string, number>;
    tokens: { worker_total: number; critic_total: number };
  };
}

/**
 * DIAGNOSTICS ONLY. This report answers "how did the machine perform", never
 * "is the product good" — which is why it does not read `profile_gates[].findings`
 * at all (H5). The separation is structural, not a matter of discipline: the
 * finding counts are simply never consulted here.
 *
 * `liveState` reconciles each record against the blackboard (Principle 11: the
 * blackboard is the single source of truth, `evidence.json` a downstream
 * projection). A record whose outcome disagrees with the live queue is treated as
 * STALE: the live outcome is reported and the record's iteration-derived detail is
 * dropped. This closes the residual where a failed evidence write leaves a prior
 * iteration's record (e.g. a committed task still carrying an `abandoned` copy) --
 * without it the report would faithfully repeat that lie.
 */
export function buildExecutionReport(run: RunRef, slots: EvidenceSlot[], liveState: QueueLookup): ExecutionReport {
  const records = slots.flatMap((s) => (s.state === "ok" ? [s.record] : []));

  const tasks: ExecutionTaskLine[] = records.map((r) => {
    const live = liveState(r.task_id);
    const implied = OUTCOME_IMPLIES_QUEUE[r.outcome];
    // Stale ONLY on a positive contradiction: a locatable live queue that differs
    // from the one the record's outcome implies. A `null` live state means "cannot
    // determine", never "contradicts" -- fabricating staleness from missing info
    // would be its own fail-open.
    const stale = live !== null && live !== implied;

    if (stale) {
      return {
        task_id: r.task_id,
        title: r.title,
        outcome: live, // the blackboard's truth, not the record's
        commit: null,
        rounds: 0,
        attempts: r.attempts, // monotonic retry counter on the task file, not iteration detail
        critic: null,
        gate_decision: null,
        gate_failures: [],
        escalation_type: null,
        tokens: null,
        evidence_stale: true,
      };
    }

    const gateFailures: string[] = [];
    if (r.gate) {
      if (!r.gate.composer_green) gateFailures.push("check command");
      if (!r.gate.success_green) gateFailures.push("success_command");
      if (!r.gate.agent_ci_green) gateFailures.push("agent-ci");
      if (!r.gate.profile_green) gateFailures.push("profile gates");
    }
    return {
      task_id: r.task_id,
      title: r.title,
      outcome: r.outcome,
      commit: r.commit,
      rounds: r.rounds,
      attempts: r.attempts,
      critic: r.critic,
      gate_decision: r.gate?.decision ?? null,
      gate_failures: gateFailures,
      escalation_type: r.escalation?.type ?? null,
      tokens: r.tokens,
      evidence_stale: false,
    };
  });

  // Rollups are computed from the RECONCILED task lines, never the raw records, so a
  // stale record can neither inflate a count nor contribute tokens from the wrong
  // iteration. A stale line reports `escalation_type: null`, so it also never lands
  // in `escalations_by_type`.
  const escalationsByType: Record<string, number> = {};
  for (const t of tasks) {
    if (t.escalation_type !== null) {
      escalationsByType[t.escalation_type] = (escalationsByType[t.escalation_type] ?? 0) + 1;
    }
  }

  return {
    kind: "harness-execution",
    run,
    completeness: {
      total: slots.length,
      recorded: records.length,
      absent: slots.filter((s) => s.state === "absent").length,
      unreadable: slots.filter((s) => s.state === "unreadable").length,
    },
    tasks,
    rollups: {
      committed: tasks.filter((t) => t.outcome === "committed").length,
      escalated: tasks.filter((t) => t.outcome === "escalated").length,
      quarantined: tasks.filter((t) => t.outcome === "quarantined").length,
      first_pass: tasks.filter((t) => t.outcome === "committed" && t.rounds === 0 && !t.evidence_stale).length,
      escalations_by_type: escalationsByType,
      tokens: {
        worker_total: tasks.reduce((n, t) => n + (t.tokens?.worker_total ?? 0), 0),
        critic_total: tasks.reduce((n, t) => n + (t.tokens?.critic_total ?? 0), 0),
      },
    },
  };
}
