/**
 * The Morning Report -- the third report type (after the s52 Execution + Qualification
 * pair). It turns the overnight supervisor's decision journal
 * (`.autodev/decision-journal.ndjson`) into an operator-facing summary of what the
 * unattended autonomy DECIDED and where those tasks LANDED, reconciled against the
 * live blackboard (Principle 11: the journal records the decision; the queue is the
 * truth about the current state). This module is PURE -- it takes parsed entries, a
 * synchronous `QueueLookup`, and a clock; it does no I/O and calls no model. The
 * composition root supplies the journal text, the lookup, and the narration.
 *
 * Design: `docs/superpowers/specs/2026-07-23-morning-report-design.md`.
 */
import type { DecisionJournalEntry } from "../autonomy/decision-journal.js";

/** A task's current queue membership, or `null` when it cannot be located. Same shape
 *  as `execution-report.ts`'s `QueueLookup`, kept independent so `report/` modules do
 *  not couple to each other. */
export type QueueLookup = (taskId: string) => string | null;

export interface MorningTaskLine {
  task_id: string;
  auto_reworks: number;
  parked: boolean;
  last_reason: string;
  escalation_type: string;
  current_state: string | null;
  needs_you: boolean;
}

export interface MorningReport {
  kind: "morning";
  window: { since: string | null; generated_at: string };
  completeness: { entries: number; skipped: number; tasks: number };
  rollups: {
    tasks_touched: number;
    auto_reworks: number;
    parks: number;
    still_needs_you: number;
  };
  tasks: MorningTaskLine[];
  narration: string | null;
}

/**
 * Build the report from journal entries + a live-state lookup. Pure and deterministic.
 * `opts.since` (ISO) drops older entries; `opts.skipped` carries the parser's
 * unparseable-line count into `completeness`.
 */
export function buildMorningReport(
  entries: DecisionJournalEntry[],
  liveState: QueueLookup,
  now: () => number,
  opts?: { since?: string | null; skipped?: number },
): MorningReport {
  const since = opts?.since ?? null;
  const skipped = opts?.skipped ?? 0;

  // Compare timestamps as MOMENTS (epoch ms), never as strings. Journal ts are UTC-Z
  // today, but `since` is operator input and may carry a timezone offset, where a
  // lexicographic compare is simply wrong (`...T00:00:00+03:00` sorts after `...T00:00:00Z`
  // yet is three hours EARLIER). An entry whose ts does not parse is KEPT (fail toward
  // showing it), never silently dropped. A NaN `sinceMs` (unparseable operator input --
  // the CLI/endpoint reject that at the boundary, so this is only a defensive fallback)
  // applies no filter rather than hiding everything.
  const sinceMs = since === null ? null : Date.parse(since);
  const windowed =
    sinceMs === null || Number.isNaN(sinceMs)
      ? entries
      : entries.filter((e) => {
          const t = Date.parse(e.ts);
          return Number.isNaN(t) ? true : t >= sinceMs;
        });

  const byTask = new Map<string, DecisionJournalEntry[]>();
  for (const e of windowed) {
    const g = byTask.get(e.taskId);
    if (g) g.push(e);
    else byTask.set(e.taskId, [e]);
  }

  const tasks: MorningTaskLine[] = [];
  for (const [taskId, group] of byTask) {
    const ordered = [...group].sort((a, b) => {
      // Order by MOMENT, not string (see the `since` note above). An unparseable ts
      // sorts as epoch 0 (stable); real journal ts always parse.
      const ta = Date.parse(a.ts);
      const tb = Date.parse(b.ts);
      return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
    });
    const last = ordered[ordered.length - 1]!;
    const autoReworks = ordered.filter((e) => e.decision === "auto-rework").length;
    const current = liveState(taskId);
    tasks.push({
      task_id: taskId,
      auto_reworks: autoReworks,
      parked: last.decision === "park",
      last_reason: last.reason,
      escalation_type: last.escalationType,
      current_state: current,
      needs_you: current === "escalated",
    });
  }
  tasks.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));

  return {
    kind: "morning",
    window: { since, generated_at: new Date(now()).toISOString() },
    completeness: { entries: windowed.length, skipped, tasks: tasks.length },
    rollups: {
      tasks_touched: tasks.length,
      auto_reworks: tasks.reduce((n, t) => n + t.auto_reworks, 0),
      parks: tasks.filter((t) => t.parked).length,
      still_needs_you: tasks.filter((t) => t.needs_you).length,
    },
    tasks,
    narration: null,
  };
}

/** Render the report as operator-facing text: the narration on top (or a fallback),
 *  then rollups, the per-task table, and a "Needs you" section. */
export function renderMorningReport(report: MorningReport): string {
  const lines: string[] = [];
  lines.push("# Morning Report");
  lines.push("");
  lines.push(report.narration ?? "(narration unavailable -- showing the structured summary)");
  lines.push("");
  if (report.tasks.length === 0) {
    lines.push("_No overnight decisions recorded._");
    if (report.completeness.skipped > 0) {
      lines.push("");
      lines.push(`(${report.completeness.skipped} unparseable journal line(s) skipped.)`);
    }
    return lines.join("\n");
  }
  lines.push(
    `Tasks touched: ${report.rollups.tasks_touched} - auto-reworks: ${report.rollups.auto_reworks} - ` +
      `parked: ${report.rollups.parks} - still needs you: ${report.rollups.still_needs_you}`,
  );
  if (report.completeness.skipped > 0) {
    lines.push(`(${report.completeness.skipped} unparseable journal line(s) skipped.)`);
  }
  lines.push("");
  for (const t of report.tasks) {
    lines.push(
      `- ${t.task_id}: ${t.auto_reworks} auto-rework(s)${t.parked ? ", then parked" : ""} ` +
        `-- now ${t.current_state ?? "unknown"} -- ${t.last_reason}`,
    );
  }
  const needy = report.tasks.filter((t) => t.needs_you);
  if (needy.length > 0) {
    lines.push("");
    lines.push("## Needs you");
    for (const t of needy) {
      lines.push(`- ${t.task_id} (${t.escalation_type}): ${t.last_reason}`);
    }
  }
  return lines.join("\n");
}

/** Build the narration prompt: render the structured report compactly and ask the
 *  narrator model for ONE warm, first-person paragraph. */
export function buildMorningReportPrompt(report: MorningReport): string {
  const taskLines = report.tasks
    .map(
      (t) =>
        `- ${t.task_id}: ${t.auto_reworks} auto-rework(s)${t.parked ? ", parked" : ""}, now ` +
        `${t.current_state ?? "unknown"} -- ${t.last_reason}`,
    )
    .join("\n");
  return (
    "You are the orchestrator greeting the operator in the morning. Reply with ONE short " +
    "paragraph of plain prose -- no JSON, no lists, no code fences -- summarizing what the " +
    "unattended autonomy did overnight and what still needs the operator. Be warm and " +
    "first-person.\n\n" +
    `Rollups: ${report.rollups.tasks_touched} task(s) touched, ${report.rollups.auto_reworks} ` +
    `auto-rework(s), ${report.rollups.parks} parked, ${report.rollups.still_needs_you} still need you.\n\n` +
    `Tasks:\n${taskLines || "(none)"}\n\n` +
    "Narrate this to the operator now."
  );
}
