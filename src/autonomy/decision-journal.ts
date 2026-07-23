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

/** The set of `decision` values a valid entry may carry. */
const DECISION_KINDS: ReadonlySet<string> = new Set<DecisionKind>(["auto-rework", "park"]);

/** Type guard: is `v` a well-formed `DecisionJournalEntry`? Checks exactly the fields
 *  the morning report reads. `runId` and `reversible` are optional/fixed and not
 *  required for a line to be usable. */
function isDecisionEntry(v: unknown): v is DecisionJournalEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["ts"] === "string" &&
    typeof o["taskId"] === "string" &&
    typeof o["escalationType"] === "string" &&
    typeof o["decision"] === "string" &&
    DECISION_KINDS.has(o["decision"]) &&
    typeof o["reworkCount"] === "number" &&
    typeof o["reason"] === "string"
  );
}

/**
 * Parse an NDJSON decision journal tolerantly. Every well-formed line becomes a
 * `DecisionJournalEntry`; a line that is not valid JSON, or is JSON of the wrong
 * shape, is SKIPPED and counted rather than thrown on -- one corrupt line must not
 * sink the whole morning report (Principle 10). A blank or absent journal (`""`)
 * yields `{ entries: [], skipped: 0 }`.
 */
export function parseDecisionJournal(text: string): { entries: DecisionJournalEntry[]; skipped: number } {
  const entries: DecisionJournalEntry[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }
    if (isDecisionEntry(parsed)) {
      entries.push(parsed);
    } else {
      skipped++;
    }
  }
  return { entries, skipped };
}
