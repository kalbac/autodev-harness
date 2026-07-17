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

/**
 * Parse a persisted `auto-rework-count` runtime value, FAIL-CLOSED. An absent file
 * (null) means "never reworked" -> 0 (a fresh budget). ANY other unreadable value --
 * empty, non-numeric, partially-numeric (`"1garbage"`), negative, or non-integer -- is
 * treated as budget-EXHAUSTED (`maxAutoReworks`), so a corrupted or tampered counter
 * PARKS the task rather than silently granting a fresh auto-rework quota. A safety
 * budget must degrade toward LESS unattended spend, not more.
 */
export function parseReworkCount(raw: string | null, maxAutoReworks: number): number {
  if (raw === null) return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return maxAutoReworks; // reject "", "NaN", "-1", "1.5", "1garbage"
  const n = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : maxAutoReworks;
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

  // In-memory per-run rework tally. The loop's TERMINATION guarantee rests on this,
  // NOT the runtime file: `seen` advances by 1 on every requeue regardless of whether
  // the persisted counter's read/write behaves, so a stuck / externally-rewritten /
  // never-persisting file cannot spin the loop. `getReworkCount` (the persisted value)
  // is still honored so the budget survives across supervise() invocations; the
  // effective count is the max of the two. One read per task per iteration also closes
  // the split-read race (a filter read of 1 then a separate `next` read of 2).
  const seen = new Map<string, number>();
  const effectiveCount = async (id: string): Promise<number> =>
    Math.max(await deps.getReworkCount(id), seen.get(id) ?? 0);

  for (;;) {
    await deps.drain();
    const escalated = await deps.listEscalated();
    const actionable: { id: string; type: EscalationType; count: number }[] = [];
    for (const { id } of escalated) {
      const type = await deps.readEscalationType(id);
      if (type === null || !isRetryable(type)) continue;
      const count = await effectiveCount(id);
      if (count >= deps.maxAutoReworks) continue;
      actionable.push({ id, type, count });
    }
    if (actionable.length === 0) break;

    for (const { id, type, count } of actionable) {
      const next = count + 1;
      // A rework consumes budget (a runtime file) AND triggers work (the escalated->pending
      // move) -- two separate blackboard files that cannot be committed atomically. This
      // saga ordering keeps the budget DURABLY enforced while never false-parking:
      //   1. Persist the budget FIRST. If the counter write persistently fails it throws
      //      HERE, before any requeue -- so no rework (and no over-budget) can ever happen
      //      under runtime-file failure; the per-task cap stays enforceable across runs.
      //   2. Requeue (the actual re-run trigger). If it throws AFTER the counter was
      //      persisted, ROLL THE COUNTER BACK so the task is retried cleanly on a later run
      //      instead of being false-parked as "budget exhausted" for a rework that never
      //      happened. A doubly-faulted rollback leaves the counter one high -> the task
      //      parks one rework EARLY (less unattended spend -- the safe direction for a budget).
      //   3. Advance `seen` (in-memory termination guard) only after the real action.
      //   4. Journal LAST -- a completed action, never a mere intent; a journal failure
      //      leaves the rework + budget correct with only the audit line missing (honest).
      await deps.setReworkCount(id, next);
      try {
        await deps.requeueForRework(id);
      } catch (err) {
        await Promise.resolve(deps.setReworkCount(id, count)).catch(() => {}); // compensate; best-effort
        throw err;
      }
      seen.set(id, next);
      await deps.writeDecision({
        ts: deps.now(),
        taskId: id,
        escalationType: type,
        decision: "auto-rework",
        reworkCount: next,
        reason: `${type}: re-running with critic feedback`,
        reversible: true,
      });
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
      reworkCount: await effectiveCount(id),
      reason: isRetryable(type)
        ? `${type}: auto-rework budget exhausted -- parked for morning review`
        : `${type}: needs operator -- parked for morning review`,
      reversible: true,
    });
    parked.add(id);
  }
}
