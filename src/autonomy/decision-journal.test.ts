import { describe, it, expect } from "vitest";
import { serializeDecision, type DecisionJournalEntry } from "./decision-journal.js";

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
