import { describe, it, expect } from "vitest";
import { renderCorpusReport } from "./corpus-report.js";
import type { CorpusMetrics } from "./corpus-metrics.js";

function metrics(over: Partial<CorpusMetrics> = {}): CorpusMetrics {
  return {
    total: 3,
    passed: 2,
    failed: 1,
    errored: 0,
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
});
