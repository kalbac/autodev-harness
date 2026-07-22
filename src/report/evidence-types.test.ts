import { describe, it, expect } from "vitest";
import { EvidenceSchema, type EvidenceRecord } from "./evidence-types.js";

function minimal(): unknown {
  return {
    schema: 1,
    task_id: "t1",
    run_id: null,
    title: "Add a getter",
    type: "feature",
    declared: { file_set: ["src/a.php"], acceptance: [], success_commands: [] },
    profile: null,
    outcome: "committed",
    commit: "abc1234",
    escalation: null,
    rounds: 0,
    attempts: 1,
    started_at: "2026-07-22T10:00:00.000Z",
    ended_at: "2026-07-22T10:04:00.000Z",
    critic: null,
    gate: null,
    profile_gates: [],
    tokens: null,
  };
}

describe("EvidenceSchema", () => {
  it("parses a minimal record", () => {
    const r: EvidenceRecord = EvidenceSchema.parse(minimal());
    expect(r.task_id).toBe("t1");
    expect(r.outcome).toBe("committed");
  });

  it("REJECTS an unknown key rather than stripping it", () => {
    const bad = { ...(minimal() as object), surprise: 1 };
    expect(() => EvidenceSchema.parse(bad)).toThrow();
  });

  it("REJECTS an unknown outcome", () => {
    const bad = { ...(minimal() as object), outcome: "probably-fine" };
    expect(() => EvidenceSchema.parse(bad)).toThrow();
  });

  it("REJECTS a future schema version", () => {
    const bad = { ...(minimal() as object), schema: 2 };
    expect(() => EvidenceSchema.parse(bad)).toThrow();
  });

  it("REJECTS a commit hash on a non-committed outcome", () => {
    // A commit in the range is how the Qualification Report proves a change landed;
    // an abandoned/escalated record carrying one would forge product proof.
    const bad = { ...(minimal() as object), outcome: "escalated", commit: "abc1234" };
    expect(() => EvidenceSchema.parse(bad)).toThrow();
  });

  it("REJECTS a committed outcome with no commit hash", () => {
    const bad = { ...(minimal() as object), outcome: "committed", commit: null };
    expect(() => EvidenceSchema.parse(bad)).toThrow();
  });
});
