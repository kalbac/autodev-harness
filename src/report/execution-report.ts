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
}

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
 */
export function buildExecutionReport(run: RunRef, slots: EvidenceSlot[]): ExecutionReport {
  const records = slots.flatMap((s) => (s.state === "ok" ? [s.record] : []));

  const tasks: ExecutionTaskLine[] = records.map((r) => {
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
    };
  });

  const escalationsByType: Record<string, number> = {};
  for (const r of records) {
    if (r.escalation) {
      escalationsByType[r.escalation.type] = (escalationsByType[r.escalation.type] ?? 0) + 1;
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
      committed: records.filter((r) => r.outcome === "committed").length,
      escalated: records.filter((r) => r.outcome === "escalated").length,
      quarantined: records.filter((r) => r.outcome === "quarantined").length,
      first_pass: records.filter((r) => r.outcome === "committed" && r.rounds === 0).length,
      escalations_by_type: escalationsByType,
      tokens: {
        worker_total: records.reduce((n, r) => n + (r.tokens?.worker_total ?? 0), 0),
        critic_total: records.reduce((n, r) => n + (r.tokens?.critic_total ?? 0), 0),
      },
    },
  };
}
