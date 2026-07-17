import { describe, it, expect } from "vitest";
import { isRetryable, parseReworkCount, superviseOvernight, type OvernightSupervisorDeps } from "./overnight-supervisor.js";
import type { EscalationType } from "../escalate/escalate.js";
import type { DecisionJournalEntry } from "./decision-journal.js";

describe("isRetryable (reason-routing table)", () => {
  const retryable: EscalationType[] = ["disagreement", "uncertain", "poison"];
  const park: EscalationType[] = ["constitution", "needs-guard", "blocked", "dirty-file", "drift"];

  for (const t of retryable) it(`routes ${t} -> auto-rework`, () => expect(isRetryable(t)).toBe(true));
  for (const t of park) it(`routes ${t} -> park`, () => expect(isRetryable(t)).toBe(false));
});

describe("parseReworkCount (fail-closed budget)", () => {
  it("absent file (null) -> 0 (fresh budget)", () => expect(parseReworkCount(null, 2)).toBe(0));
  it("a clean non-negative integer parses through", () => {
    expect(parseReworkCount("0", 2)).toBe(0);
    expect(parseReworkCount("2", 2)).toBe(2);
    expect(parseReworkCount(" 3 ", 2)).toBe(3);
  });
  it("fails CLOSED (-> maxAutoReworks, parks) on any corrupt value", () => {
    for (const bad of ["", "NaN", "-1", "1.5", "1garbage", "garbage", "0x10", "1e3", "  "]) {
      expect(parseReworkCount(bad, 2)).toBe(2);
    }
  });
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

  it("terminates even if setReworkCount never persists (in-memory progress guarantees no spin)", async () => {
    // Worst case: the task is ALWAYS still escalated and the persisted counter NEVER
    // advances (getReworkCount always 0, setReworkCount a no-op). Without the in-memory
    // `seen` tally this loops forever; with it, it stops after exactly maxAutoReworks.
    const requeued: string[] = [];
    const journal: DecisionJournalEntry[] = [];
    const deps: OvernightSupervisorDeps = {
      enabled: true,
      maxAutoReworks: 2,
      drain: async () => {},
      listEscalated: async () => [{ id: "z" }],
      readEscalationType: async () => "disagreement",
      getReworkCount: async () => 0,
      setReworkCount: async () => {}, // no-op: never persists
      requeueForRework: async (id) => void requeued.push(id),
      writeDecision: async (e) => void journal.push(e),
      now: () => "2026-07-17T00:00:00.000Z",
    };
    await superviseOvernight(deps); // must RETURN, not hang
    expect(requeued).toEqual(["z", "z"]);
    expect(journal.filter((e) => e.decision === "auto-rework")).toHaveLength(2);
    expect(journal.some((e) => e.decision === "park")).toBe(true);
  });

  it("does NOT journal an auto-rework whose requeue fails (journal records completed actions only)", async () => {
    // Act-first, journal-after: a requeue failure must leave NO false "auto-rework" line.
    const journal: DecisionJournalEntry[] = [];
    const deps: OvernightSupervisorDeps = {
      enabled: true,
      maxAutoReworks: 2,
      drain: async () => {},
      listEscalated: async () => [{ id: "f" }],
      readEscalationType: async () => "disagreement",
      getReworkCount: async () => 0,
      setReworkCount: async () => {},
      requeueForRework: async () => {
        throw new Error("move failed");
      },
      writeDecision: async (e) => void journal.push(e),
      now: () => "2026-07-17T00:00:00.000Z",
    };
    await expect(superviseOvernight(deps)).rejects.toThrow("move failed");
    expect(journal).toEqual([]);
  });
});
