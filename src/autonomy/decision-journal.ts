import type { EscalationType } from "../escalate/escalate.js";

/** What the overnight supervisor did at one escalation fork. */
export type DecisionKind = "auto-rework" | "park";

/** One append-only line in `.autodev/decision-journal.ndjson`. Shared schema for
 *  the future morning report + later class-2 "decide-and-flag" entries. */
export interface DecisionJournalEntry {
  /** ISO timestamp. */
  ts: string;
  /** Always present -- the stable key the morning report groups on. */
  taskId: string;
  /** Best-effort: the originating run id when the escalation carries one. */
  runId?: string;
  escalationType: EscalationType;
  decision: DecisionKind;
  /** The supervisor's per-task auto-rework count AFTER this decision (park entries
   *  report the count at park time). */
  reworkCount: number;
  reason: string;
  /** Always true in v1 -- both rework and park are cheap to undo (the safety argument). */
  reversible: true;
}

/** Serialize one entry as an NDJSON line (newline-terminated). `JSON.stringify`
 *  omits an absent optional `runId`, so the field appears only when present. */
export function serializeDecision(entry: DecisionJournalEntry): string {
  return `${JSON.stringify(entry)}\n`;
}
