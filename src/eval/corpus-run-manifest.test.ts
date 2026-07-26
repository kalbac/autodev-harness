import { describe, it, expect } from "vitest";
import {
  buildCorpusRunManifest,
  renderCorpusRunManifest,
  CORPUS_RUN_MANIFEST_SCHEMA_VERSION,
  type CorpusRunContext,
} from "./corpus-run-manifest.js";
import type { CorpusCaseResult } from "./corpus-metrics.js";
import type { CorpusCase } from "./corpus-case.js";
import type { EvidenceRecord } from "../report/evidence-types.js";

function makeCase(id: string, over: Partial<CorpusCase> = {}): CorpusCase {
  return {
    schema: 1,
    id,
    type: "feature",
    intent: `intent for ${id}`,
    seed: "seeds/x",
    adversarial: false,
    expected: { outcome: "committed", escalation_type: null },
    rationale: "why",
    ...over,
  };
}

function record(taskId: string, over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  const base: EvidenceRecord = {
    schema: 1,
    task_id: taskId,
    run_id: null,
    title: taskId,
    type: "feature",
    declared: { file_set: ["a.php"], acceptance: [], success_commands: [] },
    profile: null,
    outcome: "committed",
    commit: "abc123",
    escalation: null,
    rounds: 0,
    attempts: 1,
    started_at: "2026-07-25T00:00:00.000Z",
    ended_at: "2026-07-25T00:00:05.000Z",
    critic: { verdict: "clean", confidence: 0.9 },
    gate: null,
    profile_gates: [],
    tokens: { worker_total: 10, critic_total: 5 },
  };
  const merged = { ...base, ...over };
  if (merged.outcome !== "committed") merged.commit = null;
  return merged;
}

const ctx: CorpusRunContext = {
  generated_at: "2026-07-26T12:00:00.000Z",
  target_repo: "D:/repos/polygon",
  baseline: "fb21553",
  corpus_dir: "D:/harness/corpus",
  artifacts_dir: "D:/repos/polygon/.autodev/corpus-artifacts",
  total_cases: 2,
};

describe("buildCorpusRunManifest", () => {
  it("carries each case's raw evidence record verbatim", () => {
    const ev = record("t1");
    const results: CorpusCaseResult[] = [{ case: makeCase("good-a"), evidence: ev }];

    const m = buildCorpusRunManifest(ctx, results);

    expect(m.cases[0]!.evidence).toEqual(ev);
    expect(m.cases[0]!.evidence?.critic).toEqual({ verdict: "clean", confidence: 0.9 });
  });

  it("records the executor's failure reason for an errored case", () => {
    const results: CorpusCaseResult[] = [
      { case: makeCase("boom"), evidence: null, error: "the intent enqueued 0 tasks" },
    ];

    const m = buildCorpusRunManifest(ctx, results);

    expect(m.cases[0]!.evidence).toBeNull();
    expect(m.cases[0]!.error).toBe("the intent enqueued 0 tasks");
    expect(m.cases[0]!.passed).toBe(false);
  });

  it("reports null (not undefined) for a case that ran", () => {
    const results: CorpusCaseResult[] = [{ case: makeCase("ok"), evidence: record("t1") }];

    expect(buildCorpusRunManifest(ctx, results).cases[0]!.error).toBeNull();
  });

  // The verdict must come from the SAME aggregator the markdown report renders from — two
  // copies of "did this case pass" is how a projection starts disagreeing with its source.
  it("re-derives the verdict rather than restating it", () => {
    const results: CorpusCaseResult[] = [
      {
        case: makeCase("adv", { adversarial: true, expected: { outcome: "escalated", escalation_type: "constitution" } }),
        evidence: record("t1", { outcome: "escalated", escalation: { type: "disagreement", reason: "r" } }),
      },
    ];

    const m = buildCorpusRunManifest(ctx, results);

    expect(m.cases[0]!.passed).toBe(false);
    expect(m.cases[0]!.reason).toMatch(/escalated as 'disagreement', expected 'constitution'/);
    expect(m.cases[0]!.actual).toEqual({ outcome: "escalated", escalation_type: "disagreement" });
  });

  // A manifest written after case 1 of 2 must not read like a complete two-case corpus that
  // happened to be short — a partial run has to announce itself.
  it("marks a mid-run manifest partial and a complete one not", () => {
    const one: CorpusCaseResult[] = [{ case: makeCase("a"), evidence: record("t1") }];
    const both: CorpusCaseResult[] = [...one, { case: makeCase("b"), evidence: record("t2") }];

    expect(buildCorpusRunManifest(ctx, one).partial).toBe(true);
    expect(buildCorpusRunManifest(ctx, one).cases_completed).toBe(1);
    expect(buildCorpusRunManifest(ctx, both).partial).toBe(false);
    expect(buildCorpusRunManifest(ctx, both).cases_completed).toBe(2);
  });

  it("writes a manifest for a run that died before its first case", () => {
    const m = buildCorpusRunManifest(ctx, []);

    expect(m.cases).toEqual([]);
    expect(m.cases_completed).toBe(0);
    expect(m.partial).toBe(true);
  });

  // codex R1: naming the archive path unconditionally let a FAILED archive read as a
  // successful one — when clearing a previous run's directory fails, the stale directory is
  // still sitting at exactly that path, so "it exists" meant "these are this run's
  // diagnostics" while being the opposite.
  it("states the archive outcome instead of implying success by naming a path", () => {
    const results: CorpusCaseResult[] = [
      { case: makeCase("ok-case"), evidence: record("t1") },
      { case: makeCase("bad-case"), evidence: record("t2") },
      { case: makeCase("never-archived"), evidence: record("t3") },
    ];
    const archives = new Map([
      ["ok-case", { status: "ok" as const, path: "X", copied: 4, skipped: [], error: null }],
      [
        "bad-case",
        { status: "failed" as const, path: "X", copied: 0, skipped: [], error: "EACCES: cannot clear" },
      ],
    ]);

    const m = buildCorpusRunManifest(ctx, results, archives);

    expect(m.cases[0]!.archive).toEqual({ status: "ok", copied: 4, skipped: [], error: null });
    expect(m.cases[1]!.archive).toEqual({
      status: "failed",
      copied: 0,
      skipped: [],
      error: "EACCES: cannot clear",
    });
    // No status reported at all = the case never got as far as archiving. Distinct from
    // `failed`, and NOT reported as ok.
    expect(m.cases[2]!.archive).toBeNull();
  });

  it("reports a null archive when no statuses were collected at all", () => {
    const m = buildCorpusRunManifest(ctx, [{ case: makeCase("a"), evidence: record("t1") }]);
    expect(m.cases[0]!.archive).toBeNull();
  });

  it("points each case at its archive directory and carries the run context", () => {
    const m = buildCorpusRunManifest(ctx, [{ case: makeCase("good-a"), evidence: record("t1") }]);

    expect(m.cases[0]!.artifacts).toBe("good-a");
    expect(m.schema).toBe(CORPUS_RUN_MANIFEST_SCHEMA_VERSION);
    expect(m.baseline).toBe("fb21553");
    expect(m.target_repo).toBe("D:/repos/polygon");
    expect(m.generated_at).toBe("2026-07-26T12:00:00.000Z");
  });
});

describe("renderCorpusRunManifest", () => {
  it("round-trips through JSON and ends with a newline", () => {
    const m = buildCorpusRunManifest(ctx, [{ case: makeCase("a"), evidence: record("t1") }]);

    const text = renderCorpusRunManifest(m);

    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(m);
  });
});
