import { describe, it, expect } from "vitest";
import { runCorpus, evaluateCorpus } from "./corpus-runner.js";
import type { CaseExecutor } from "./corpus-runner.js";
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

function committedEvidence(taskId: string): EvidenceRecord {
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
    ended_at: "2026-07-25T00:00:05.000Z",
    critic: null,
    gate: null,
    profile_gates: [],
    tokens: { worker_total: 10, critic_total: 5 },
  };
}

/** Records call order; returns the scripted evidence per case id, or throws when scripted to. */
function scriptedExecutor(
  script: Record<string, EvidenceRecord | null | "throw">,
): { executor: CaseExecutor; order: string[] } {
  const order: string[] = [];
  const executor: CaseExecutor = {
    async execute(c: CorpusCase): Promise<EvidenceRecord | null> {
      order.push(c.id);
      const scripted = script[c.id];
      if (scripted === "throw") throw new Error(`boom for ${c.id}`);
      return scripted ?? null;
    },
  };
  return { executor, order };
}

describe("runCorpus", () => {
  it("executes every case and pairs each with its evidence", async () => {
    const cases = [makeCase("a"), makeCase("b")];
    const { executor } = scriptedExecutor({ a: committedEvidence("a"), b: committedEvidence("b") });

    const results = await runCorpus(cases, executor);

    expect(results.map((r) => r.case.id)).toEqual(["a", "b"]);
    expect(results[0]!.evidence?.task_id).toBe("a");
    expect(results[1]!.evidence?.task_id).toBe("b");
  });

  it("runs cases sequentially in order (a corpus run drives real conductors)", async () => {
    const cases = [makeCase("first"), makeCase("second"), makeCase("third")];
    const { executor, order } = scriptedExecutor({});

    await runCorpus(cases, executor);

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("turns a throwing executor into a null-evidence result without aborting the run", async () => {
    const cases = [makeCase("ok"), makeCase("bad"), makeCase("ok2")];
    const { executor } = scriptedExecutor({
      ok: committedEvidence("ok"),
      bad: "throw",
      ok2: committedEvidence("ok2"),
    });

    const results = await runCorpus(cases, executor);

    expect(results).toHaveLength(3);
    expect(results[1]!.evidence).toBeNull(); // the thrower
    expect(results[2]!.evidence?.task_id).toBe("ok2"); // run continued past the failure
  });

  // The reason used to be discarded by the catch, which is what made a failed case cost a
  // 12-minute re-run to understand (#126).
  it("keeps the executor's failure message on the errored result", async () => {
    const cases = [makeCase("bad")];
    const { executor } = scriptedExecutor({ bad: "throw" });

    const results = await runCorpus(cases, executor);

    expect(results[0]!.evidence).toBeNull();
    expect(results[0]!.error).toMatch(/bad/);
  });

  // codex R1: a hostile thrown value with a throwing `message`/`toString` would make the
  // catch ITSELF throw, escaping runCorpus and aborting the whole corpus instead of turning
  // one case into a null-evidence result — the catch's entire purpose (gotcha
  // [ts/fail-closed]). Mutation-check: swapping `safeErrorText(err)` back to `String(err)`
  // makes this test fail.
  it("survives a thrown value whose message cannot be stringified", async () => {
    const hostile = {
      get message(): string {
        throw new Error("message getter exploded");
      },
      toString(): string {
        throw new Error("toString exploded");
      },
    };
    const executor: CaseExecutor = {
      async execute() {
        throw hostile;
      },
    };

    const results = await runCorpus([makeCase("hostile"), makeCase("after")], executor);

    expect(results).toHaveLength(2); // the run continued past it
    expect(results[0]!.evidence).toBeNull();
    expect(typeof results[0]!.error).toBe("string");
  });

  it("leaves `error` absent on a case that ran", async () => {
    const cases = [makeCase("ok")];
    const { executor } = scriptedExecutor({ ok: committedEvidence("ok") });

    const results = await runCorpus(cases, executor);

    expect(results[0]!.error).toBeUndefined();
  });

  // Awaited, not fire-and-forget: a hook persisting a case's diagnostics must finish before
  // the next case's reset starts purging the state it describes.
  it("awaits an async onCaseDone hook before starting the next case", async () => {
    const cases = [makeCase("a"), makeCase("b")];
    const trace: string[] = [];
    const executor: CaseExecutor = {
      async execute(c) {
        trace.push(`execute:${c.id}`);
        return committedEvidence(c.id);
      },
    };

    await runCorpus(cases, executor, {
      onCaseDone: async (r) => {
        trace.push(`hook-start:${r.case.id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        trace.push(`hook-end:${r.case.id}`);
      },
    });

    // The load-bearing assertion is `hook-end:a` BEFORE `execute:b` — with a
    // fire-and-forget hook the next case starts while the previous one is still writing.
    expect(trace).toEqual(["execute:a", "hook-start:a", "hook-end:a", "execute:b", "hook-start:b", "hook-end:b"]);
  });

  it("fires the per-case hooks with index/total", async () => {
    const cases = [makeCase("a"), makeCase("b")];
    const { executor } = scriptedExecutor({ a: committedEvidence("a"), b: null });
    const started: Array<[string, number, number]> = [];
    const done: Array<[string, boolean, number]> = [];

    await runCorpus(cases, executor, {
      onCaseStart: (c, i, total) => {
        started.push([c.id, i, total]);
      },
      onCaseDone: (r, i) => {
        done.push([r.case.id, r.evidence !== null, i]);
      },
    });

    expect(started).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
    ]);
    expect(done).toEqual([
      ["a", true, 0],
      ["b", false, 1],
    ]);
  });
});

describe("evaluateCorpus", () => {
  it("runs the corpus and aggregates in one call", async () => {
    const cases = [makeCase("good")];
    const { executor } = scriptedExecutor({ good: committedEvidence("good") });

    const { results, metrics } = await evaluateCorpus(cases, executor);

    expect(results).toHaveLength(1);
    expect(metrics.total).toBe(1);
    expect(metrics.passed).toBe(1);
    expect(metrics.first_pass_commit_rate).toBe(1);
  });
});
