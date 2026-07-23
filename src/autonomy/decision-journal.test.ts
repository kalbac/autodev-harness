import { describe, it, expect } from "vitest";
import { serializeDecision, parseDecisionJournal, type DecisionJournalEntry } from "./decision-journal.js";

describe("serializeDecision", () => {
  it("emits one JSON object per line, newline-terminated", () => {
    const entry: DecisionJournalEntry = {
      ts: "2026-07-17T00:00:00.000Z",
      taskId: "t-1",
      escalationType: "disagreement",
      decision: "auto-rework",
      reworkCount: 1,
      reason: "disagreement: re-running with critic feedback",
      reversible: true,
    };
    const line = serializeDecision(entry);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.includes("\n")).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed).toEqual(entry);
  });

  it("includes runId only when present (best-effort field)", () => {
    const withRun = serializeDecision({
      ts: "2026-07-17T00:00:00.000Z", taskId: "t-2", runId: "run-9",
      escalationType: "blocked", decision: "park", reworkCount: 0,
      reason: "blocked: needs operator -- parked for morning review", reversible: true,
    });
    expect(JSON.parse(withRun.trimEnd()).runId).toBe("run-9");
  });
});

describe("parseDecisionJournal", () => {
  const good = (over: Partial<Record<string, unknown>> = {}) =>
    JSON.stringify({
      ts: "2026-07-23T02:00:00.000Z",
      taskId: "t1",
      escalationType: "needs-guard",
      decision: "park",
      reworkCount: 0,
      reason: "needs a guard",
      reversible: true,
      ...over,
    });

  it("parses every valid NDJSON line", () => {
    const text = `${good({ taskId: "a" })}\n${good({ taskId: "b", decision: "auto-rework" })}\n`;
    const { entries, skipped } = parseDecisionJournal(text);
    expect(entries.map((e) => e.taskId)).toEqual(["a", "b"]);
    expect(skipped).toBe(0);
  });

  it("skips and counts a corrupt line without throwing", () => {
    const text = `${good({ taskId: "a" })}\nnot json\n${good({ taskId: "b" })}\n`;
    const { entries, skipped } = parseDecisionJournal(text);
    expect(entries.map((e) => e.taskId)).toEqual(["a", "b"]);
    expect(skipped).toBe(1);
  });

  it("skips a JSON line missing a required field", () => {
    const text = `${good()}\n${JSON.stringify({ ts: "x", taskId: "y" })}\n`;
    const { entries, skipped } = parseDecisionJournal(text);
    expect(entries.length).toBe(1);
    expect(skipped).toBe(1);
  });

  it("treats blank/absent input as empty, zero skipped", () => {
    expect(parseDecisionJournal("")).toEqual({ entries: [], skipped: 0 });
    expect(parseDecisionJournal("\n  \n")).toEqual({ entries: [], skipped: 0 });
  });
});
