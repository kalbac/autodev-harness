import { describe, it, expect } from "vitest";
import { aggregateCorpus } from "./corpus-metrics.js";
import type { CorpusCaseResult } from "./corpus-metrics.js";
import type { CorpusCase } from "./corpus-case.js";
import type { EvidenceRecord } from "../report/evidence-types.js";

function makeCase(over: Partial<CorpusCase> = {}): CorpusCase {
  return {
    schema: 1,
    id: "c",
    type: "feature",
    intent: "do a thing",
    seed: "seeds/x",
    adversarial: false,
    expected: { outcome: "committed", escalation_type: null },
    rationale: "why",
    ...over,
  };
}

function makeEvidence(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  const committed = (over.outcome ?? "committed") === "committed";
  return {
    schema: 1,
    task_id: "t",
    run_id: null,
    title: "t",
    type: "feature",
    declared: { file_set: [], acceptance: [], success_commands: [] },
    profile: null,
    outcome: "committed",
    commit: committed ? "abc123" : null,
    escalation: null,
    rounds: 0,
    attempts: 1,
    started_at: "2026-07-25T00:00:00.000Z",
    ended_at: "2026-07-25T00:00:10.000Z", // 10s
    critic: null,
    gate: null,
    profile_gates: [],
    tokens: { worker_total: 100, critic_total: 50 },
    ...over,
    // keep the committed<=>commit biconditional honest under overrides
    ...(over.outcome !== undefined
      ? { commit: over.commit ?? (over.outcome === "committed" ? "abc123" : null) }
      : {}),
  };
}

describe("aggregateCorpus", () => {
  it("passes a good case that committed, and counts it as a first-pass commit", () => {
    const results: CorpusCaseResult[] = [
      { case: makeCase({ id: "good1" }), evidence: makeEvidence({ outcome: "committed", rounds: 0 }) },
    ];
    const m = aggregateCorpus(results);
    expect(m.total).toBe(1);
    expect(m.passed).toBe(1);
    expect(m.failed).toBe(0);
    expect(m.first_pass_commit_rate).toBe(1);
    expect(m.cases[0]!.passed).toBe(true);
  });

  it("fails a good case that escalated instead of committing", () => {
    const results: CorpusCaseResult[] = [
      {
        case: makeCase({ id: "good-but-parked", expected: { outcome: "committed", escalation_type: null } }),
        evidence: makeEvidence({ outcome: "escalated", escalation: { type: "uncertain", reason: "r" } }),
      },
    ];
    const m = aggregateCorpus(results);
    expect(m.passed).toBe(0);
    expect(m.failed).toBe(1);
    expect(m.human_interventions).toBe(1);
  });

  it("passes an adversarial case caught with the expected escalation type", () => {
    const results: CorpusCaseResult[] = [
      {
        case: makeCase({ id: "adv", adversarial: true, expected: { outcome: "escalated", escalation_type: "disagreement" } }),
        evidence: makeEvidence({ outcome: "escalated", escalation: { type: "disagreement", reason: "bug" } }),
      },
    ];
    const m = aggregateCorpus(results);
    expect(m.passed).toBe(1);
    expect(m.escaped_defect_rate).toBe(0);
    expect(m.escalations_by_type).toEqual({ disagreement: 1 });
  });

  it("fails an adversarial case whose escalation type differs from expected", () => {
    const results: CorpusCaseResult[] = [
      {
        case: makeCase({ id: "adv2", adversarial: true, expected: { outcome: "escalated", escalation_type: "disagreement" } }),
        evidence: makeEvidence({ outcome: "escalated", escalation: { type: "uncertain", reason: "r" } }),
      },
    ];
    const m = aggregateCorpus(results);
    expect(m.passed).toBe(0);
    expect(m.failed).toBe(1);
  });

  it("counts an escaped defect: an adversarial case that committed instead of being caught", () => {
    const results: CorpusCaseResult[] = [
      {
        case: makeCase({ id: "escaped", adversarial: true, expected: { outcome: "escalated", escalation_type: "disagreement" } }),
        evidence: makeEvidence({ outcome: "committed", rounds: 0 }),
      },
    ];
    const m = aggregateCorpus(results);
    expect(m.escaped_defect_rate).toBe(1);
    expect(m.passed).toBe(0);
  });

  it("treats a null evidence (case failed to run) as errored and a per-case fail", () => {
    const results: CorpusCaseResult[] = [{ case: makeCase({ id: "boom" }), evidence: null }];
    const m = aggregateCorpus(results);
    expect(m.errored).toBe(1);
    expect(m.passed).toBe(0);
    expect(m.failed).toBe(1);
    expect(m.cases[0]!.passed).toBe(false);
  });

  // Fix 4: the report names each errored case by its REAL reason (`CorpusCaseResult.error`,
  // which the executor's throw always carries), not a boilerplate stand-in -- this is the
  // plumbing the report's loud errored-cases list reads from.
  it("carries the executor's real error message into the errored case's verdict reason", () => {
    const results: CorpusCaseResult[] = [
      { case: makeCase({ id: "boom" }), evidence: null, error: "the intent enqueued 0 tasks" },
    ];
    const m = aggregateCorpus(results);
    expect(m.cases[0]!.reason).toContain("the intent enqueued 0 tasks");
  });

  it("falls back to a boilerplate reason when the executor's error message is absent", () => {
    const results: CorpusCaseResult[] = [{ case: makeCase({ id: "boom" }), evidence: null }];
    const m = aggregateCorpus(results);
    expect(m.cases[0]!.reason).toBe("no evidence record — the case failed to run");
  });

  it("aggregates wall-clock, tokens, and averages across a mixed corpus", () => {
    const results: CorpusCaseResult[] = [
      { case: makeCase({ id: "a" }), evidence: makeEvidence({ outcome: "committed", rounds: 0 }) },
      { case: makeCase({ id: "b" }), evidence: makeEvidence({ outcome: "committed", rounds: 2 }) },
    ];
    const m = aggregateCorpus(results);
    expect(m.total).toBe(2);
    expect(m.first_pass_commit_rate).toBe(0.5); // one at round 0, one at round 2
    expect(m.avg_rounds_to_commit).toBe(1); // (0 + 2) / 2
    expect(m.total_wall_clock_ms).toBe(20000); // 10s each
    expect(m.tokens).toEqual({ worker_total: 200, critic_total: 100 });
  });

  it("reports null rates when no case exercises them", () => {
    const results: CorpusCaseResult[] = [
      {
        case: makeCase({ id: "only-adv", adversarial: true, expected: { outcome: "escalated", escalation_type: null } }),
        evidence: makeEvidence({ outcome: "escalated", escalation: { type: "uncertain", reason: "r" } }),
      },
    ];
    const m = aggregateCorpus(results);
    expect(m.first_pass_commit_rate).toBeNull(); // no committed-expected cases
    expect(m.avg_rounds_to_commit).toBeNull();
    expect(m.escaped_defect_rate).toBe(0); // one adversarial, none escaped
  });

  // Fix 4: a broken instrument (no evidence record at all) must not sit in the DENOMINATOR
  // of either rate, or an intermittent decompose/enqueue/critic failure moves the metric
  // between runs on its own -- exactly what makes runs incomparable, the corpus's whole
  // purpose.
  describe("measured (excludes errored cases from the two rate denominators)", () => {
    it("reports the measured count as total minus errored", () => {
      const results: CorpusCaseResult[] = [
        { case: makeCase({ id: "a" }), evidence: makeEvidence({ outcome: "committed", rounds: 0 }) },
        { case: makeCase({ id: "b" }), evidence: null, error: "the intent enqueued 0 tasks" },
      ];
      const m = aggregateCorpus(results);
      expect(m.total).toBe(2);
      expect(m.errored).toBe(1);
      expect(m.measured).toBe(1);
    });

    it("excludes an errored good case from the first-pass-commit-rate denominator", () => {
      const results: CorpusCaseResult[] = [
        { case: makeCase({ id: "good-committed" }), evidence: makeEvidence({ outcome: "committed", rounds: 0 }) },
        { case: makeCase({ id: "good-errored" }), evidence: null, error: "critic unreachable" },
      ];
      const m = aggregateCorpus(results);
      // Denominator is 1 (only the measured committed-expected case), not 2.
      expect(m.first_pass_commit_rate).toBe(1);
    });

    it("excludes an errored adversarial case from the escaped-defect-rate denominator", () => {
      const results: CorpusCaseResult[] = [
        {
          case: makeCase({ id: "adv-escaped", adversarial: true, expected: { outcome: "escalated", escalation_type: null } }),
          evidence: makeEvidence({ outcome: "committed", rounds: 0 }),
        },
        {
          case: makeCase({ id: "adv-errored", adversarial: true, expected: { outcome: "escalated", escalation_type: null } }),
          evidence: null,
          error: "decompose returned garbage",
        },
      ];
      const m = aggregateCorpus(results);
      // Denominator is 1 (only the measured adversarial case), not 2 -- so the escaped
      // defect is 100%, not diluted to 50% by a case the instrument never ran.
      expect(m.escaped_defect_rate).toBe(1);
    });

    it("reports escaped-defect-rate as null (not 0) when every adversarial case errored", () => {
      const results: CorpusCaseResult[] = [
        {
          case: makeCase({ id: "adv-errored", adversarial: true, expected: { outcome: "escalated", escalation_type: null } }),
          evidence: null,
          error: "decompose returned garbage",
        },
      ];
      const m = aggregateCorpus(results);
      expect(m.escaped_defect_rate).toBeNull();
    });

    it("reports first-pass-commit-rate as null (not 0) when every good case errored", () => {
      const results: CorpusCaseResult[] = [
        { case: makeCase({ id: "good-errored" }), evidence: null, error: "enqueued 0 tasks" },
      ];
      const m = aggregateCorpus(results);
      expect(m.first_pass_commit_rate).toBeNull();
    });

    // The denominator change must NOT change what counts as a per-case FAIL: an errored
    // case still fails, on its own, independent of the two rates.
    it("still counts an errored case as a per-case FAIL even though it leaves both rates alone", () => {
      const results: CorpusCaseResult[] = [
        { case: makeCase({ id: "good-errored" }), evidence: null, error: "enqueued 0 tasks" },
      ];
      const m = aggregateCorpus(results);
      expect(m.passed).toBe(0);
      expect(m.failed).toBe(1);
      expect(m.cases[0]!.passed).toBe(false);
    });
  });
});
