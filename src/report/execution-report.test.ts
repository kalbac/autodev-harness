import { describe, it, expect } from "vitest";
import { buildExecutionReport } from "./execution-report.js";
import type { EvidenceSlot } from "./evidence-store.js";

function ok(taskId: string, over: Record<string, unknown> = {}): EvidenceSlot {
  return {
    taskId, state: "ok",
    record: {
      schema: 1, task_id: taskId, run_id: "run-1", title: taskId, type: "feature",
      declared: { file_set: [], acceptance: [], success_commands: [] },
      profile: null, outcome: "committed", commit: "abc", escalation: null,
      rounds: 0, attempts: 1, started_at: "2026-07-22T10:00:00.000Z", ended_at: "2026-07-22T10:05:00.000Z",
      critic: { verdict: "clean", confidence: 0.9 }, gate: null, profile_gates: [],
      tokens: { worker_total: 100, critic_total: 40 },
      ...over,
    } as never,
  };
}

describe("buildExecutionReport", () => {
  it("rolls up first-pass gate rate and tokens", () => {
    const r = buildExecutionReport({ runId: "run-1", intent: "do a thing", at: 0 }, [
      ok("t1"),
      ok("t2", { rounds: 2 }),
    ]);
    expect(r.tasks).toHaveLength(2);
    expect(r.rollups.committed).toBe(2);
    expect(r.rollups.first_pass).toBe(1); // t2 needed retries
    expect(r.rollups.tokens.worker_total).toBe(200);
  });

  it("reports evidence completeness honestly (H1)", () => {
    const r = buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, [
      ok("t1"),
      { taskId: "t2", state: "absent" },
      { taskId: "t3", state: "unreadable", detail: "bad json" },
    ]);
    expect(r.completeness).toEqual({ total: 3, recorded: 1, absent: 1, unreadable: 1 });
  });

  it("counts escalations by type", () => {
    const r = buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, [
      ok("t1", { outcome: "escalated", escalation: { type: "disagreement", reason: "r" }, commit: null }),
      ok("t2", { outcome: "escalated", escalation: { type: "disagreement", reason: "r" }, commit: null }),
      ok("t3", { outcome: "escalated", escalation: { type: "constitution", reason: "r" }, commit: null }),
    ]);
    expect(r.rollups.escalations_by_type).toEqual({ disagreement: 2, constitution: 1 });
  });
});
