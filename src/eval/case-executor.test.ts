import { describe, it, expect } from "vitest";
import { createCaseExecutor, selectDecisiveEvidence } from "./case-executor.js";
import type { CaseEnvironment } from "./case-executor.js";
import type { CorpusCase } from "./corpus-case.js";
import type { EvidenceRecord } from "../report/evidence-types.js";
import type { EvidenceSlot } from "../report/evidence-store.js";

function makeCase(over: Partial<CorpusCase> = {}): CorpusCase {
  return {
    schema: 1,
    id: "case-1",
    type: "feature",
    intent: "add a thing",
    seed: "seeds/pristine",
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
    tokens: null,
  };
  // A non-committed outcome must drop the commit hash — the schema enforces the
  // biconditional, and a fixture that violated it would not be a realistic record.
  const merged = { ...base, ...over };
  if (merged.outcome !== "committed") merged.commit = null;
  return merged;
}

function escalated(taskId: string, type = "disagreement"): EvidenceRecord {
  return record(taskId, { outcome: "escalated", escalation: { type, reason: "r" } });
}

interface FakeEnv extends CaseEnvironment {
  calls: string[];
}

function fakeEnv(over: Partial<CaseEnvironment> = {}): FakeEnv {
  const calls: string[] = [];
  const env: FakeEnv = {
    calls,
    async resetToBaseline() {
      calls.push("reset");
    },
    async applySeed() {
      calls.push("seed");
    },
    async compose() {
      calls.push("compose");
      return ["t1"];
    },
    async drain() {
      calls.push("drain");
    },
    async readEvidence(taskIds: string[]) {
      calls.push(`read:${taskIds.join(",")}`);
      return taskIds.map((taskId): EvidenceSlot => ({ taskId, state: "ok", record: record(taskId) }));
    },
    // Fixed records are stamped 2026-07-25; a case "starting" before that keeps every
    // fixture record legitimately newer than its case.
    now: () => Date.parse("2026-07-24T00:00:00.000Z"),
    async archiveArtifacts() {
      calls.push("archive");
    },
    archiveStatuses: () => new Map(),
    async dispose() {
      calls.push("dispose");
    },
    log() {
      /* silent in tests */
    },
    ...over,
  };
  return env;
}

describe("selectDecisiveEvidence", () => {
  it("returns null for no records rather than fabricating one", () => {
    expect(selectDecisiveEvidence([])).toBeNull();
  });

  it("returns the only record when a case produced exactly one", () => {
    expect(selectDecisiveEvidence([record("solo")])?.task_id).toBe("solo");
  });

  it("prefers an escalation over a sibling commit (a caught defect is not an escaped one)", () => {
    const picked = selectDecisiveEvidence([record("a-committed"), escalated("z-escalated")]);
    expect(picked?.task_id).toBe("z-escalated");
    expect(picked?.outcome).toBe("escalated");
  });

  it("ranks escalated over quarantined over abandoned over committed", () => {
    const all = [
      record("d", { outcome: "committed" }),
      record("c", { outcome: "abandoned" }),
      record("b", { outcome: "quarantined" }),
      escalated("a"),
    ];
    expect(selectDecisiveEvidence(all)?.outcome).toBe("escalated");
    expect(selectDecisiveEvidence(all.filter((r) => r.outcome !== "escalated"))?.outcome).toBe("quarantined");
    expect(
      selectDecisiveEvidence(all.filter((r) => r.outcome !== "escalated" && r.outcome !== "quarantined"))?.outcome,
    ).toBe("abandoned");
  });

  it("breaks a same-outcome tie by task id, so the choice never depends on enumeration order", () => {
    const forward = selectDecisiveEvidence([escalated("b-task"), escalated("a-task")]);
    const reverse = selectDecisiveEvidence([escalated("a-task"), escalated("b-task")]);
    expect(forward?.task_id).toBe("a-task");
    expect(reverse?.task_id).toBe("a-task");
  });
});

describe("createCaseExecutor", () => {
  it("drives reset -> seed -> compose -> drain -> read -> archive in that order", async () => {
    const env = fakeEnv();
    await createCaseExecutor(env).execute(makeCase());
    expect(env.calls).toEqual(["reset", "seed", "compose", "drain", "read:t1", "archive"]);
  });

  // The whole point of archiving is to preserve the artifacts of a case that went WRONG,
  // so the failure path is the one that must not skip it.
  it("archives the case's artifacts even when the case fails", async () => {
    const env = fakeEnv({
      async compose() {
        return [];
      },
    });

    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(/enqueued 0 tasks/);

    expect(env.calls).toContain("archive");
  });

  // A reset that failed left the state directory belonging to whoever held it before, and
  // this case produced nothing — copying someone else's state out under this case's name
  // would manufacture a diagnostic that describes the wrong run.
  it("does not archive when the baseline reset itself failed", async () => {
    const env = fakeEnv({
      async resetToBaseline() {
        throw new Error("tree is dirty");
      },
    });

    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(/tree is dirty/);

    expect(env.calls).not.toContain("archive");
  });

  // Diagnostics must never decide a measurement: a throwing archive inside the `finally`
  // would otherwise REPLACE the case's real outcome (or its real failure) with its own.
  it("swallows an archive failure without disturbing the case's result", async () => {
    const env = fakeEnv({
      async archiveArtifacts() {
        throw new Error("disk full");
      },
    });

    await expect(createCaseExecutor(env).execute(makeCase())).resolves.not.toBeNull();
  });

  it("does not let an archive failure mask the case's own failure", async () => {
    const env = fakeEnv({
      async compose() {
        return [];
      },
      async archiveArtifacts() {
        throw new Error("disk full");
      },
    });

    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(/enqueued 0 tasks/);
  });

  // A logger that throws while REPORTING the swallowed failure would resurrect exactly the
  // failure the swallow exists to contain (gotcha [ts/fail-closed]). Scoped to the WARN the
  // handler emits, because the executor's normal-path logging is deliberately unguarded —
  // this module is not a never-throws module, only its catch handler has to be.
  it("survives an archive failure reported through a throwing logger", async () => {
    const env = fakeEnv({
      async archiveArtifacts() {
        throw new Error("disk full");
      },
      log(level: string) {
        if (level === "WARN") throw new Error("logger exploded");
      },
    });

    await expect(createCaseExecutor(env).execute(makeCase())).resolves.not.toBeNull();
  });

  it("returns the decisive record for the enqueued tasks", async () => {
    const env = fakeEnv({
      async compose() {
        return ["t1", "t2"];
      },
      async readEvidence(ids: string[]) {
        return [
          { taskId: ids[0]!, state: "ok", record: record(ids[0]!) },
          { taskId: ids[1]!, state: "ok", record: escalated(ids[1]!, "constitution") },
        ];
      },
    });

    const out = await createCaseExecutor(env).execute(makeCase());

    expect(out?.task_id).toBe("t2");
    expect(out?.escalation?.type).toBe("constitution");
  });

  it("throws when the intent enqueued nothing (the case never ran)", async () => {
    const env = fakeEnv({
      async compose() {
        return [];
      },
    });
    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(/enqueued 0 tasks/);
  });

  it("does not drain when nothing was enqueued", async () => {
    const env = fakeEnv({
      async compose() {
        return [];
      },
    });
    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow();
    expect(env.calls).not.toContain("drain");
  });

  it("throws when ANY record is unreadable, even though other records survived", async () => {
    const env = fakeEnv({
      async compose() {
        return ["t1", "t2"];
      },
      async readEvidence(ids: string[]) {
        return [
          { taskId: ids[0]!, state: "ok", record: record(ids[0]!) },
          { taskId: ids[1]!, state: "unreadable", detail: "bad json" },
        ];
      },
    });

    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(/unreadable evidence for 1 task/);
  });

  it("throws when every record is absent (a run that wrote no evidence proves nothing)", async () => {
    const env = fakeEnv({
      async readEvidence(ids: string[]) {
        return ids.map((taskId): EvidenceSlot => ({ taskId, state: "absent" }));
      },
    });
    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(/no evidence record was written/);
  });

  it("throws when SOME task is absent -- an incomplete measurement is not a verdict", async () => {
    // The fail-open this closes: the absent task is the adversarial one, its committed
    // sibling would have made the case read as "committed as expected" while the task
    // that mattered was never measured at all.
    const env = fakeEnv({
      async compose() {
        return ["t1", "t2"];
      },
      async readEvidence(ids: string[]) {
        return [
          { taskId: ids[0]!, state: "absent" },
          { taskId: ids[1]!, state: "ok", record: record(ids[1]!) },
        ];
      },
    });
    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(/no evidence record was written for 1 of 2/);
  });

  it("throws when a record's own task_id disagrees with the task it was read for", async () => {
    const env = fakeEnv({
      async readEvidence(ids: string[]) {
        // A stale record left under `runtime/t1/` from an earlier, different task.
        return [{ taskId: ids[0]!, state: "ok", record: record("some-other-task") }];
      },
    });
    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(
      /misattributed.*t1 -> 'some-other-task'/,
    );
  });

  it("names the case id in every failure so a corpus log points at the culprit", async () => {
    const env = fakeEnv({
      async compose() {
        return [];
      },
    });
    await expect(createCaseExecutor(env).execute(makeCase({ id: "adv-hidden-bug" }))).rejects.toThrow(
      /corpus case 'adv-hidden-bug'/,
    );
  });

  it("throws when a record PREDATES the case -- a leftover from an earlier run is not evidence", async () => {
    const env = fakeEnv({
      // The case starts AFTER the fixture record's started_at (2026-07-25T00:00:00Z).
      now: () => Date.parse("2026-07-26T00:00:00.000Z"),
    });
    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(
      /stale evidence.*do not postdate this case/s,
    );
  });

  it("rejects a record stamped in the SAME millisecond the case began (equality is a leftover, not a race)", async () => {
    const env = fakeEnv({ now: () => Date.parse("2026-07-25T00:00:00.000Z") });
    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(/do not postdate this case/);
  });

  it("accepts a record stamped one millisecond after the case began", async () => {
    const env = fakeEnv({ now: () => Date.parse("2026-07-25T00:00:00.000Z") - 1 });
    await expect(createCaseExecutor(env).execute(makeCase())).resolves.not.toBeNull();
  });

  it("throws on an unparseable started_at rather than treating unknown age as fresh", async () => {
    const env = fakeEnv({
      async readEvidence(ids: string[]) {
        return [{ taskId: ids[0]!, state: "ok", record: record(ids[0]!, { started_at: "not a date" }) }];
      },
    });
    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(/unparseable started_at/);
  });

  it("compares timestamps as moments, not strings (a +03:00 stamp is EARLIER than it sorts)", async () => {
    // "2026-07-25T01:00:00+03:00" == 22:00Z on the 24th -- lexically it sorts AFTER
    // "2026-07-25T00:00:00.000Z" while being chronologically before it.
    const env = fakeEnv({
      now: () => Date.parse("2026-07-25T00:00:00.000Z"),
      async readEvidence(ids: string[]) {
        return [{ taskId: ids[0]!, state: "ok", record: record(ids[0]!, { started_at: "2026-07-25T01:00:00+03:00" }) }];
      },
    });
    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(/not after this case began/);
  });

  it("propagates a reset failure instead of running the case from an unknown state", async () => {
    const env = fakeEnv({
      async resetToBaseline() {
        throw new Error("target repo is DIRTY");
      },
    });
    await expect(createCaseExecutor(env).execute(makeCase())).rejects.toThrow(/DIRTY/);
    expect(env.calls).not.toContain("compose");
  });
});
