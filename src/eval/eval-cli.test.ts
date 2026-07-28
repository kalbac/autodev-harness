import { describe, it, expect } from "vitest";
import { parseEvalArgs, evaluatePassBar, runEval, DEFAULT_EVAL_MAX_ITERATIONS } from "./eval-cli.js";
import { aggregateCorpus, type CorpusCaseResult, type CorpusMetrics } from "./corpus-metrics.js";
import type { CorpusCase } from "./corpus-case.js";
import type { CaseExecutor } from "./corpus-runner.js";
import type { EvidenceRecord } from "../report/evidence-types.js";

function metrics(over: Partial<CorpusMetrics> = {}): CorpusMetrics {
  return {
    total: 2,
    passed: 2,
    failed: 0,
    errored: 0,
    measured: 2,
    first_pass_commit_rate: 1,
    avg_rounds_to_commit: 0,
    escaped_defect_rate: 0,
    escalations_by_type: {},
    human_interventions: 1,
    total_wall_clock_ms: 1000,
    tokens: { worker_total: 0, critic_total: 0 },
    cases: [],
    ...over,
  };
}

describe("parseEvalArgs", () => {
  it("defaults to no corpus/baseline/out override and a finite iteration bound", () => {
    const args = parseEvalArgs([]);
    expect(args).toEqual({ maxIterations: DEFAULT_EVAL_MAX_ITERATIONS });
  });

  it("parses the space form of every flag", () => {
    expect(
      parseEvalArgs([
        "--corpus", "c",
        "--baseline", "abc123",
        "--out", "r.md",
        "--artifacts", "a",
        "--max-iterations", "5",
      ]),
    ).toEqual({
      corpus: "c",
      baseline: "abc123",
      out: "r.md",
      artifacts: "a",
      maxIterations: 5,
    });
  });

  it("parses the = form of every flag", () => {
    expect(
      parseEvalArgs(["--corpus=c", "--baseline=abc123", "--out=r.md", "--artifacts=a", "--max-iterations=5"]),
    ).toEqual({
      corpus: "c",
      baseline: "abc123",
      out: "r.md",
      artifacts: "a",
      maxIterations: 5,
    });
  });

  it("rejects a flag with a missing value instead of dropping it", () => {
    expect(() => parseEvalArgs(["--corpus"])).toThrow(/--corpus: missing value/);
    expect(() => parseEvalArgs(["--baseline", "--out", "x"])).toThrow(/--baseline: missing value/);
  });

  it("rejects an unknown argument rather than silently running the default corpus", () => {
    expect(() => parseEvalArgs(["--corpuss", "c"])).toThrow(/unexpected argument/);
  });

  it("rejects a non-positive iteration bound (NaN/0 would disable the bound entirely)", () => {
    expect(() => parseEvalArgs(["--max-iterations=0"])).toThrow(/positive integer/);
    expect(() => parseEvalArgs(["--max-iterations=abc"])).toThrow(/positive integer/);
    expect(() => parseEvalArgs(["--max-iterations=1.5"])).toThrow(/positive integer/);
  });

  it("rejects an empty value rather than resolving it to the current directory", () => {
    expect(() => parseEvalArgs(["--corpus="])).toThrow(/must not be empty/);
    expect(() => parseEvalArgs(["--out= "])).toThrow(/must not be empty/);
    expect(() => parseEvalArgs(["--artifacts="])).toThrow(/must not be empty/);
  });

  it("rejects --artifacts with a missing value", () => {
    expect(() => parseEvalArgs(["--artifacts"])).toThrow(/--artifacts: missing value/);
  });
});

describe("evaluatePassBar", () => {
  it("is met when every case matched and no adversarial defect escaped", () => {
    expect(evaluatePassBar(metrics())).toEqual({ met: true, reasons: [] });
  });

  it("fails when any case did not match its expectation", () => {
    const bar = evaluatePassBar(metrics({ passed: 1, failed: 1 }));
    expect(bar.met).toBe(false);
    expect(bar.reasons.join(" ")).toMatch(/1\/2 case\(s\) did not match/);
  });

  it("fails on a non-zero escaped-defect rate and names the number", () => {
    const bar = evaluatePassBar(metrics({ escaped_defect_rate: 0.5, failed: 1, passed: 1 }));
    expect(bar.met).toBe(false);
    expect(bar.reasons.join(" ")).toMatch(/escaped-defect rate is 50%/);
  });

  it("does NOT pass when the escaped-defect rate was never measured -- an all-good corpus proves no catching power", () => {
    const bar = evaluatePassBar(metrics({ escaped_defect_rate: null }));
    expect(bar.met).toBe(false);
    expect(bar.reasons.join(" ")).toMatch(/no adversarial case/);
  });

  it("fails on an empty corpus", () => {
    const bar = evaluatePassBar(metrics({ total: 0, passed: 0, failed: 0, escaped_defect_rate: null }));
    expect(bar.met).toBe(false);
    expect(bar.reasons.join(" ")).toMatch(/corpus is empty/);
  });

  // Fix 4 integration: excluding an errored case from the two RATE denominators must not
  // change what counts as a per-case FAIL -- an errored case still fails the pass bar via
  // `failed > 0`, exactly as before. Driven through the REAL `aggregateCorpus`, not a
  // hand-built `CorpusMetrics`, so this proves the two functions still agree end to end.
  it("still fails the pass bar on an errored case, driven through the real aggregateCorpus", () => {
    const results: CorpusCaseResult[] = [
      { case: makeCase("good"), evidence: committed("good") },
      { case: makeCase("broken"), evidence: null, error: "the intent enqueued 0 tasks" },
    ];
    const m = aggregateCorpus(results);
    const bar = evaluatePassBar(m);
    expect(bar.met).toBe(false);
    expect(bar.reasons.join(" ")).toMatch(/1\/2 case\(s\) did not match/);
  });
});

function makeCase(id: string, over: Partial<CorpusCase> = {}): CorpusCase {
  return {
    schema: 1,
    id,
    type: "feature",
    intent: `intent ${id}`,
    seed: "seeds/x",
    adversarial: false,
    expected: { outcome: "committed", escalation_type: null },
    rationale: "why",
    ...over,
  };
}

function committed(taskId: string): EvidenceRecord {
  return {
    schema: 1,
    task_id: taskId,
    run_id: null,
    title: taskId,
    type: "feature",
    declared: { file_set: [], acceptance: [], success_commands: [] },
    profile: null,
    outcome: "committed",
    commit: "abc123",
    escalation: null,
    rounds: 0,
    attempts: 1,
    started_at: "2026-07-25T00:00:00.000Z",
    ended_at: "2026-07-25T00:00:01.000Z",
    critic: null,
    gate: null,
    profile_gates: [],
    tokens: null,
  };
}

describe("runEval", () => {
  it("narrates each case start and finish so a minutes-long run is observable", async () => {
    const printed: string[] = [];
    const executor: CaseExecutor = { async execute(c) { return committed(c.id); } };

    await runEval([makeCase("good-1"), makeCase("adv-1", { adversarial: true, expected: { outcome: "escalated", escalation_type: null } })], executor, (l) => printed.push(l));

    expect(printed[0]).toBe("[1/2] good-1 (feature)");
    expect(printed[1]).toBe("[1/2] good-1 -> committed (expected committed)");
    expect(printed[2]).toBe("[2/2] adv-1 (feature, adversarial)");
    expect(printed[3]).toBe("[2/2] adv-1 -> committed (expected escalated)");
  });

  it("reports an errored case honestly rather than as an outcome", async () => {
    const printed: string[] = [];
    const executor: CaseExecutor = { async execute() { throw new Error("boom"); } };

    const { metrics: m, passBar } = await runEval([makeCase("x")], executor, (l) => printed.push(l));

    expect(printed[1]).toBe("[1/1] x -> errored (no evidence) (expected committed)");
    // The CAUSE, at the case, while the operator is watching — not withheld until a
    // post-mortem dig (#126).
    expect(printed[2]).toBe("      boom");
    expect(m.errored).toBe(1);
    expect(passBar.met).toBe(false);
  });

  it("returns the raw results so diagnostics can be persisted from them", async () => {
    const executor: CaseExecutor = { async execute(c) { return committed(c.id); } };

    const { results } = await runEval([makeCase("good-1")], executor, () => {});

    expect(results).toHaveLength(1);
    expect(results[0]!.evidence?.task_id).toBe("good-1");
  });

  // Written after EVERY case, cumulatively, so a run that dies on the last case still
  // leaves the earlier cases' diagnostics behind.
  it("hands onProgress every result so far, after each case", async () => {
    const executor: CaseExecutor = { async execute(c) { return committed(c.id); } };
    const snapshots: string[][] = [];

    await runEval([makeCase("a"), makeCase("b")], executor, () => {}, {
      onProgress: async (results) => {
        snapshots.push(results.map((r) => r.case.id));
      },
    });

    expect(snapshots).toEqual([["a"], ["a", "b"]]);
  });

  it("renders the report and judges the bar in one call", async () => {
    const executor: CaseExecutor = { async execute(c) { return committed(c.id); } };

    const { markdown, passBar } = await runEval(
      [makeCase("good-1"), makeCase("adv-1", { adversarial: true, expected: { outcome: "escalated", escalation_type: null } })],
      executor,
      () => {},
    );

    expect(markdown).toContain("# Corpus Report");
    // The adversarial case committed -> an escaped defect -> the bar must not be met.
    expect(passBar.met).toBe(false);
    expect(passBar.reasons.join(" ")).toMatch(/escaped-defect rate is 100%/);
  });
});
