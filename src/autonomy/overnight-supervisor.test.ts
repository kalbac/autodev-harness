import { describe, it, expect } from "vitest";
import { isRetryable, superviseOvernight, type OvernightSupervisorDeps } from "./overnight-supervisor.js";
import type { EscalationType } from "../escalate/escalate.js";
import type { DecisionJournalEntry } from "./decision-journal.js";

describe("isRetryable (reason-routing table)", () => {
  const retryable: EscalationType[] = ["disagreement", "uncertain", "poison"];
  const park: EscalationType[] = ["constitution", "needs-guard", "blocked", "dirty-file", "drift"];

  for (const t of retryable) it(`routes ${t} -> auto-rework`, () => expect(isRetryable(t)).toBe(true));
  for (const t of park) it(`routes ${t} -> park`, () => expect(isRetryable(t)).toBe(false));
});

/** A scriptable fake: `escalatedByDrain[i]` is the escalated-id list returned AFTER the
 *  i-th drain (the last entry repeats if more drains happen). `types` maps id ->
 *  EscalationType. Rework-counts + requeues are recorded for assertions. */
function makeDeps(opts: {
  enabled?: boolean;
  maxAutoReworks?: number;
  escalatedByDrain: string[][];
  types: Record<string, EscalationType>;
}): { deps: OvernightSupervisorDeps; journal: DecisionJournalEntry[]; requeued: string[] } {
  const journal: DecisionJournalEntry[] = [];
  const requeued: string[] = [];
  const counts = new Map<string, number>();
  let drainIdx = -1;
  const deps: OvernightSupervisorDeps = {
    enabled: opts.enabled ?? true,
    maxAutoReworks: opts.maxAutoReworks ?? 2,
    drain: async () => { drainIdx += 1; },
    listEscalated: async () => (opts.escalatedByDrain[Math.min(drainIdx, opts.escalatedByDrain.length - 1)] ?? []).map((id) => ({ id })),
    readEscalationType: async (id) => opts.types[id] ?? null,
    getReworkCount: async (id) => counts.get(id) ?? 0,
    setReworkCount: async (id, n) => void counts.set(id, n),
    requeueForRework: async (id) => void requeued.push(id),
    writeDecision: async (e) => void journal.push(e),
    now: () => "2026-07-17T00:00:00.000Z",
  };
  return { deps, journal, requeued };
}

describe("superviseOvernight", () => {
  it("does nothing when disabled (no drain, no journal)", async () => {
    const { deps, journal, requeued } = makeDeps({ enabled: false, escalatedByDrain: [["a"]], types: { a: "disagreement" } });
    let drained = 0;
    await superviseOvernight({ ...deps, drain: async () => void drained++ });
    expect(drained).toBe(0);
    expect(journal).toEqual([]);
    expect(requeued).toEqual([]);
  });

  it("auto-reworks a disagreement escalation, journals it, then parks it once the budget is spent", async () => {
    // Drain 1 -> [x] still escalated; drain 2 -> [x]; drain 3 -> [x]. maxAutoReworks=2.
    const { deps, journal, requeued } = makeDeps({
      maxAutoReworks: 2,
      escalatedByDrain: [["x"], ["x"], ["x"]],
      types: { x: "disagreement" },
    });
    await superviseOvernight(deps);
    // Two auto-reworks (count 1 then 2), then one park entry.
    expect(requeued).toEqual(["x", "x"]);
    const kinds = journal.map((e) => e.decision);
    expect(kinds).toEqual(["auto-rework", "auto-rework", "park"]);
    expect(journal[0]!.reworkCount).toBe(1);
    expect(journal[1]!.reworkCount).toBe(2);
    expect(journal[2]!.decision).toBe("park");
    expect(journal[2]!.reason).toMatch(/budget exhausted/);
  });

  it("parks a blocked escalation immediately (no rework, one park entry)", async () => {
    const { deps, journal, requeued } = makeDeps({ escalatedByDrain: [["b"]], types: { b: "blocked" } });
    await superviseOvernight(deps);
    expect(requeued).toEqual([]);
    expect(journal.map((e) => e.decision)).toEqual(["park"]);
    expect(journal[0]!.escalationType).toBe("blocked");
    expect(journal[0]!.reason).toMatch(/needs operator/);
  });

  it("leaves an unclassifiable escalation (null type) untouched and unjournaled", async () => {
    const { deps, journal, requeued } = makeDeps({ escalatedByDrain: [["u"]], types: {} });
    await superviseOvernight(deps);
    expect(requeued).toEqual([]);
    expect(journal).toEqual([]);
  });

  it("re-runs the loop after an escalation clears (drain 2 empties the queue)", async () => {
    const { deps, journal, requeued } = makeDeps({ escalatedByDrain: [["y"], []], types: { y: "disagreement" } });
    await superviseOvernight(deps);
    expect(requeued).toEqual(["y"]);            // one rework
    expect(journal.map((e) => e.decision)).toEqual(["auto-rework"]); // cleared -> no park
  });
});
