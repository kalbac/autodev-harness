import { describe, it, expect } from "vitest";
import { renderCorpusReport } from "./corpus-report.js";
import type { CorpusMetrics } from "./corpus-metrics.js";

function metrics(over: Partial<CorpusMetrics> = {}): CorpusMetrics {
  return {
    total: 3,
    passed: 2,
    failed: 1,
    errored: 0,
    measured: 3,
    first_pass_commit_rate: 0.5,
    avg_rounds_to_commit: 1,
    escaped_defect_rate: 0,
    escalations_by_type: { disagreement: 1 },
    human_interventions: 1,
    total_wall_clock_ms: 30000,
    tokens: { worker_total: 200, critic_total: 100 },
    cases: [
      {
        id: "good1",
        type: "feature",
        expected: { outcome: "committed", escalation_type: null },
        actual: { outcome: "committed", escalation_type: null },
        passed: true,
        reason: "committed as expected",
      },
      {
        id: "adv1",
        type: "security",
        expected: { outcome: "escalated", escalation_type: "disagreement" },
        actual: { outcome: "escalated", escalation_type: "disagreement" },
        passed: true,
        reason: "escalated as expected",
      },
      {
        id: "escaped1",
        type: "bugfix",
        expected: { outcome: "escalated", escalation_type: "disagreement" },
        actual: { outcome: "committed", escalation_type: null },
        passed: false,
        reason: "expected an escalation but the harness committed the task (escaped defect)",
      },
    ],
    ...over,
  };
}

describe("renderCorpusReport", () => {
  it("headlines the pass/total and the escaped-defect rate", () => {
    const md = renderCorpusReport(metrics());
    expect(md).toContain("# Corpus Report");
    expect(md).toContain("2/3");
    expect(md).toMatch(/escaped[- ]defect/i);
  });

  it("renders token COUNTS and never a dollar cost", () => {
    const md = renderCorpusReport(metrics());
    expect(md).toContain("200");
    expect(md).toContain("100");
    expect(md).not.toMatch(/\$/);
    expect(md).not.toMatch(/cost/i);
  });

  it("lists each case with its pass/fail and reason", () => {
    const md = renderCorpusReport(metrics());
    expect(md).toContain("good1");
    expect(md).toContain("escaped1");
    expect(md).toContain("escaped defect");
  });

  it("shows 'n/a' for a null rate rather than a misleading 0", () => {
    const md = renderCorpusReport(metrics({ first_pass_commit_rate: null, avg_rounds_to_commit: null }));
    expect(md).toMatch(/n\/a/i);
  });

  it("renders the escalations-by-type histogram", () => {
    const md = renderCorpusReport(metrics());
    expect(md).toContain("disagreement");
  });

  // Fix 4: an errored case must never be a silent denominator shrink -- the bound is
  // stated LOUDLY, above the metric table, and every errored case is named with its reason.
  describe("the measured bound (errored cases as an instrument failure, not a harness verdict)", () => {
    it("states the measured bound above the metric table when a case errored", () => {
      const md = renderCorpusReport(
        metrics({
          total: 7,
          measured: 5,
          errored: 2,
          cases: [
            {
              id: "case-a",
              type: "feature",
              expected: { outcome: "committed", escalation_type: null },
              actual: { outcome: "errored", escalation_type: null },
              passed: false,
              reason: "no evidence record — the intent enqueued 0 tasks",
            },
            {
              id: "case-b",
              type: "feature",
              expected: { outcome: "committed", escalation_type: null },
              actual: { outcome: "errored", escalation_type: null },
              passed: false,
              reason: "no evidence record — critic unreachable",
            },
          ],
        }),
      );

      const aggregateIdx = md.indexOf("## Aggregate metrics");
      const measuredIdx = md.indexOf("measured: 5/7");
      expect(measuredIdx).toBeGreaterThan(-1);
      expect(measuredIdx).toBeLessThan(aggregateIdx);
      expect(md).toMatch(/2 errored/);
      // Named by id and reason ABOVE the metric table -- not merely present somewhere in
      // the document (the per-case table at the bottom already names every case by id and
      // reason regardless of this block, so a bare `toContain` would pass even if this
      // dedicated list were deleted).
      const caseAReasonIdx = md.indexOf("the intent enqueued 0 tasks");
      const caseBReasonIdx = md.indexOf("critic unreachable");
      expect(caseAReasonIdx).toBeGreaterThan(-1);
      expect(caseAReasonIdx).toBeLessThan(aggregateIdx);
      expect(caseBReasonIdx).toBeGreaterThan(-1);
      expect(caseBReasonIdx).toBeLessThan(aggregateIdx);
      expect(md.slice(0, aggregateIdx)).toContain("case-a");
      expect(md.slice(0, aggregateIdx)).toContain("case-b");
    });

    it("still states the measured bound (as fully measured) when nothing errored", () => {
      const md = renderCorpusReport(metrics({ total: 3, measured: 3, errored: 0 }));
      expect(md).toMatch(/measured: 3\/3/);
    });
  });
});
