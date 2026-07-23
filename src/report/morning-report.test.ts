import { describe, it, expect } from "vitest";
import { buildMorningReport, renderMorningReport, buildMorningReportPrompt } from "./morning-report.js";
import type { DecisionJournalEntry } from "../autonomy/decision-journal.js";

function entry(over: Partial<DecisionJournalEntry> & Pick<DecisionJournalEntry, "taskId" | "ts">): DecisionJournalEntry {
  return {
    escalationType: "needs-guard",
    decision: "park",
    reworkCount: 0,
    reason: "r",
    reversible: true,
    ...over,
  } as DecisionJournalEntry;
}

const now = () => 1_800_000_000_000;

describe("buildMorningReport", () => {
  it("reports 'no decisions' for an empty journal", () => {
    const r = buildMorningReport([], () => null, now);
    expect(r.tasks).toEqual([]);
    expect(r.rollups.tasks_touched).toBe(0);
    expect(renderMorningReport(r)).toMatch(/no overnight decisions/i);
  });

  it("groups by task, counts auto-reworks, and takes the LAST decision by ts", () => {
    const entries = [
      entry({ taskId: "a", ts: "2026-07-23T02:00:00.000Z", decision: "auto-rework", reworkCount: 1, reason: "first" }),
      entry({ taskId: "a", ts: "2026-07-23T03:00:00.000Z", decision: "park", reworkCount: 1, reason: "gave up" }),
    ];
    const r = buildMorningReport(entries, (id) => (id === "a" ? "escalated" : null), now);
    const a = r.tasks.find((t) => t.task_id === "a")!;
    expect(a.auto_reworks).toBe(1);
    expect(a.parked).toBe(true);
    expect(a.last_reason).toBe("gave up");
    expect(a.current_state).toBe("escalated");
    expect(a.needs_you).toBe(true);
    expect(r.rollups.still_needs_you).toBe(1);
  });

  it("reconciles against the live blackboard: a parked task now done reads done, not needs-you (Principle 11)", () => {
    const entries = [entry({ taskId: "b", ts: "2026-07-23T02:00:00.000Z", decision: "park", reason: "disagreement" })];
    const r = buildMorningReport(entries, () => "done", now);
    const b = r.tasks[0]!;
    expect(b.parked).toBe(true);
    expect(b.current_state).toBe("done");
    expect(b.needs_you).toBe(false);
    expect(r.rollups.still_needs_you).toBe(0);
  });

  it("filters entries older than `since`", () => {
    const entries = [
      entry({ taskId: "old", ts: "2026-07-22T00:00:00.000Z" }),
      entry({ taskId: "new", ts: "2026-07-23T00:00:00.000Z" }),
    ];
    const r = buildMorningReport(entries, () => null, now, { since: "2026-07-23T00:00:00.000Z" });
    expect(r.tasks.map((t) => t.task_id)).toEqual(["new"]);
    expect(r.window.since).toBe("2026-07-23T00:00:00.000Z");
  });

  it("reports a task the lookup cannot locate as current_state null", () => {
    const entries = [entry({ taskId: "gone", ts: "2026-07-23T02:00:00.000Z", decision: "auto-rework", reworkCount: 2 })];
    const r = buildMorningReport(entries, () => null, now);
    expect(r.tasks[0]!.current_state).toBeNull();
    expect(r.tasks[0]!.needs_you).toBe(false);
  });

  it("counts skipped lines in completeness when provided", () => {
    const r = buildMorningReport([], () => null, now, { skipped: 3 });
    expect(r.completeness.skipped).toBe(3);
  });
});

describe("renderMorningReport / buildMorningReportPrompt", () => {
  it("render includes the narration when present and a fallback when null", () => {
    const entries = [entry({ taskId: "a", ts: "2026-07-23T02:00:00.000Z", decision: "auto-rework", reworkCount: 1 })];
    const r = buildMorningReport(entries, () => "done", now);
    expect(renderMorningReport({ ...r, narration: "Overnight I handled one task." })).toMatch(/Overnight I handled one task\./);
    expect(renderMorningReport({ ...r, narration: null })).toMatch(/narration unavailable/i);
  });

  it("prompt asks for one paragraph and includes the task lines", () => {
    const entries = [entry({ taskId: "a", ts: "2026-07-23T02:00:00.000Z", decision: "park", reason: "needs a guard" })];
    const r = buildMorningReport(entries, () => "escalated", now);
    const p = buildMorningReportPrompt(r);
    expect(p).toMatch(/one .*paragraph/i);
    expect(p).toContain("a");
    expect(p).toContain("needs a guard");
  });
});
