import type { EscalationType } from "../escalate/escalate.js";
import type { DecisionJournalEntry } from "./decision-journal.js";

/** Reason-routing table (spec 2026-07-17). Litmus: "can a re-run with the critic's
 *  feedback plausibly fix this?" -- yes => auto-rework, no => park. Retryable are the
 *  correctness-verdict + circuit-breaker types; everything contract/operator/transient
 *  (constitution, needs-guard, blocked, dirty-file, drift) parks for a morning decision. */
const RETRYABLE: ReadonlySet<EscalationType> = new Set<EscalationType>(["disagreement", "uncertain", "poison"]);

export function isRetryable(type: EscalationType): boolean {
  return RETRYABLE.has(type);
}

export interface OvernightSupervisorDeps {
  /** From cfg.autonomy.overnight -- when false, superviseOvernight is a no-op. */
  enabled: boolean;
  maxAutoReworks: number;
  /** One bounded drain of the whole project queue (`() => conductor.run({drain:true})`). */
  drain: () => Promise<void>;
  /** Ids currently in `queue/escalated/` (`repo.listTasks("escalated")` -> ids). */
  listEscalated: () => Promise<{ id: string }[]>;
  /** The escalation's type (parse `<escalationsDir>/<id>.md`); null if missing/unparseable. */
  readEscalationType: (taskId: string) => Promise<EscalationType | null>;
  getReworkCount: (taskId: string) => Promise<number>;
  setReworkCount: (taskId: string, n: number) => Promise<void>;
  /** The reply-B requeue (setAttempts(0) + move escalated->pending). The next loop
   *  drain re-runs the task, which reads the critic's persisted feedback (s42). */
  requeueForRework: (taskId: string) => Promise<void>;
  writeDecision: (entry: DecisionJournalEntry) => Promise<void>;
  /** ISO timestamp source (injected for deterministic tests). */
  now: () => string;
  log?: (level: string, message: string) => void;
}

/**
 * Bounded loop-until-dry over the project's escalations, ABOVE the gate. Each
 * iteration drains, then reason-routes every escalation: retryable + under budget
 * => auto-rework (journal + requeue), otherwise leave it. Terminates when no
 * actionable escalation remains (each auto-rework consumes finite per-task budget).
 * On exit, every still-escalated task is parked -> one park journal entry each.
 * Never touches the critic/gate/commit -- only the operator-equivalent reply-B path.
 */
export async function superviseOvernight(deps: OvernightSupervisorDeps): Promise<void> {
  if (!deps.enabled) return;

  for (;;) {
    await deps.drain();
    const escalated = await deps.listEscalated();
    const actionable: { id: string; type: EscalationType }[] = [];
    for (const { id } of escalated) {
      const type = await deps.readEscalationType(id);
      if (type === null || !isRetryable(type)) continue;
      if ((await deps.getReworkCount(id)) >= deps.maxAutoReworks) continue;
      actionable.push({ id, type });
    }
    if (actionable.length === 0) break;

    for (const { id, type } of actionable) {
      const next = (await deps.getReworkCount(id)) + 1;
      await deps.writeDecision({
        ts: deps.now(),
        taskId: id,
        escalationType: type,
        decision: "auto-rework",
        reworkCount: next,
        reason: `${type}: re-running with critic feedback`,
        reversible: true,
      });
      await deps.setReworkCount(id, next);
      await deps.requeueForRework(id);
    }
  }

  // Loop exit: every remaining escalated task is parked (park-type OR budget-exhausted).
  const parked = new Set<string>();
  for (const { id } of await deps.listEscalated()) {
    if (parked.has(id)) continue;
    const type = await deps.readEscalationType(id);
    if (type === null) continue; // can't classify -> leave it as-is, do not journal a guess
    await deps.writeDecision({
      ts: deps.now(),
      taskId: id,
      escalationType: type,
      decision: "park",
      reworkCount: await deps.getReworkCount(id),
      reason: isRetryable(type)
        ? `${type}: auto-rework budget exhausted -- parked for morning review`
        : `${type}: needs operator -- parked for morning review`,
      reversible: true,
    });
    parked.add(id);
  }
}
