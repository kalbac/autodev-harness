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
});
