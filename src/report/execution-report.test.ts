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

/** A live-queue lookup mapping each committed record to `done` etc. — i.e. the
 *  record agrees with the blackboard, the normal case. */
const agrees: Record<string, string> = { committed: "done", escalated: "escalated", quarantined: "quarantine" };
function agreeingState(slots: EvidenceSlot[]): (id: string) => string | null {
  const m = new Map<string, string>();
  for (const s of slots) if (s.state === "ok") m.set(s.taskId, agrees[s.record.outcome] ?? "done");
  return (id) => m.get(id) ?? null;
}

describe("buildExecutionReport", () => {
  it("rolls up first-pass gate rate and tokens", () => {
    const slots = [ok("t1"), ok("t2", { rounds: 2 })];
    const r = buildExecutionReport({ runId: "run-1", intent: "do a thing", at: 0 }, slots, agreeingState(slots));
    expect(r.tasks).toHaveLength(2);
    expect(r.rollups.committed).toBe(2);
    expect(r.rollups.first_pass).toBe(1); // t2 needed retries
    expect(r.rollups.tokens.worker_total).toBe(200);
  });

  it("reports evidence completeness honestly (H1)", () => {
    const slots: EvidenceSlot[] = [ok("t1"), { taskId: "t2", state: "absent" }, { taskId: "t3", state: "unreadable", detail: "bad json" }];
    const r = buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, slots, agreeingState(slots));
    expect(r.completeness).toEqual({ total: 3, recorded: 1, absent: 1, unreadable: 1 });
  });

  it("counts escalations by type", () => {
    const slots = [
      ok("t1", { outcome: "escalated", escalation: { type: "disagreement", reason: "r" }, commit: null }),
      ok("t2", { outcome: "escalated", escalation: { type: "disagreement", reason: "r" }, commit: null }),
      ok("t3", { outcome: "escalated", escalation: { type: "constitution", reason: "r" }, commit: null }),
    ];
    const r = buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, slots, agreeingState(slots));
    expect(r.rollups.escalations_by_type).toEqual({ disagreement: 2, constitution: 1 });
  });

  it("trusts the LIVE QUEUE over a stale record (Principle 11) and flags it", () => {
    // The record says abandoned, but the blackboard says the task is in done/: the
    // evidence write failed after a commit and the previous iteration's record
    // survived. The report must not repeat the lie -- the blackboard is the single
    // source of truth, evidence.json is a downstream projection.
    const slots = [ok("t1", { outcome: "abandoned", commit: null, critic: null, tokens: { worker_total: 9, critic_total: 9 } })];
    const r = buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, slots, () => "done");
    // The blackboard says done -> reported in the OUTCOME vocabulary as committed,
    // NOT the raw queue name, so it reads and counts like any other committed line.
    expect(r.tasks[0]!.outcome).toBe("committed");
    expect(r.tasks[0]!.evidence_stale).toBe(true);
    // The untrusted detail from the wrong iteration is dropped, not reported.
    expect(r.tasks[0]!.commit).toBeNull();
    expect(r.tasks[0]!.tokens).toBeNull();
    expect(r.tasks[0]!.attempts).toBe(0);
    // It really committed (the blackboard says so), so it counts as committed...
    expect(r.rollups.committed).toBe(1);
    // ...but its round count is untrusted, so it is NEVER credited as first-pass,
    // and the wrong iteration's tokens never enter the totals.
    expect(r.rollups.first_pass).toBe(0);
    expect(r.rollups.tokens.worker_total).toBe(0);
  });

  it("does NOT flag a record the live queue agrees with", () => {
    const slots = [ok("t1")];
    const r = buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, slots, () => "done");
    expect(r.tasks[0]!.evidence_stale).toBe(false);
    expect(r.tasks[0]!.outcome).toBe("committed");
  });

  it("a task the live queue cannot locate is not treated as stale", () => {
    // A null live state means "cannot determine" (e.g. the task file was archived),
    // never "contradicts". Do not fabricate a staleness flag from missing info.
    const slots = [ok("t1")];
    const r = buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, slots, () => null);
    expect(r.tasks[0]!.evidence_stale).toBe(false);
    expect(r.tasks[0]!.outcome).toBe("committed");
  });
});
