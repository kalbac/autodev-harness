import { describe, it, expect } from "vitest";
import { loadEvidence, type EvidenceSlot } from "./evidence-store.js";

const good = JSON.stringify({
  schema: 1, task_id: "t1", run_id: null, title: "x", type: "feature",
  declared: { file_set: [], acceptance: [], success_commands: [] },
  profile: null, outcome: "committed", commit: "abc", escalation: null,
  rounds: 0, attempts: 1, started_at: "s", ended_at: "e",
  critic: null, gate: null, profile_gates: [], tokens: null,
});

describe("loadEvidence", () => {
  it("returns ok for a valid record", async () => {
    const slots = await loadEvidence(["t1"], async () => good);
    expect(slots[0]).toMatchObject({ taskId: "t1", state: "ok" });
  });

  it("distinguishes ABSENT from UNREADABLE (H1)", async () => {
    const absent = await loadEvidence(["t1"], async () => null);
    expect(absent[0]).toMatchObject({ taskId: "t1", state: "absent" });

    const broken = await loadEvidence(["t1"], async () => "{not json");
    expect(broken[0]).toMatchObject({ taskId: "t1", state: "unreadable" });

    const wrongShape = await loadEvidence(["t1"], async () => JSON.stringify({ schema: 1 }));
    expect(wrongShape[0]).toMatchObject({ taskId: "t1", state: "unreadable" });
  });

  it("a read that THROWS is unreadable, never absent", async () => {
    const slots = await loadEvidence(["t1"], async () => {
      throw new Error("EACCES");
    });
    expect(slots[0]!.state).toBe("unreadable");
  });
});
