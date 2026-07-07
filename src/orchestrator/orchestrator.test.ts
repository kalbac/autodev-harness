import { describe, it, expect } from "vitest";
import { createOrchestrator } from "./orchestrator.js";
import type { OrchestratorAdapter, DecomposeInput } from "./adapter.js";
import type { OrchestratorCapabilities } from "./capabilities.js";
import type { QueueState } from "../blackboard/repository.js";
import type { Task } from "../blackboard/types.js";
import type { Logger } from "../util/log.js";
import { validateTaskSpec, type TaskSpec } from "./task-spec.js";
import { isDuplicateTask } from "./orchestrator.js";

const ALL_STATES: QueueState[] = ["pending", "active", "done", "escalated", "quarantine"];

function emptyQueues(): Record<QueueState, Task[]> {
  return Object.fromEntries(ALL_STATES.map((s) => [s, [] as Task[]] as const)) as Record<QueueState, Task[]>;
}

function makeSpec(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return validateTaskSpec({ id, title: "Title", type: "tooling", file_set: ["src/a.ts"], ...overrides });
}

interface FakeCapsRecorder {
  enqueueCalls: TaskSpec[];
  triggerCalls: Array<{ once?: boolean; maxIterations?: number; drain?: boolean } | undefined>;
  reportCalls: Array<{ level: string; message: string }>;
  recordRunCalls: Array<{ intent: string; taskIds: string[] }>;
}

function makeFakeCaps(
  overrides: Partial<{
    queues: Record<QueueState, Task[]>;
    triggerOutcome: unknown;
    enqueueImpl: (spec: TaskSpec) => Promise<{ id: string; path: string }>;
    recordRunResult: { runId: string; path: string } | null;
  }> = {},
): { caps: OrchestratorCapabilities; recorder: FakeCapsRecorder } {
  const recorder: FakeCapsRecorder = { enqueueCalls: [], triggerCalls: [], reportCalls: [], recordRunCalls: [] };
  const queues = overrides.queues ?? emptyQueues();

  const caps: OrchestratorCapabilities = {
    async enqueue(spec) {
      recorder.enqueueCalls.push(spec);
      if (overrides.enqueueImpl) return overrides.enqueueImpl(spec);
      return { id: spec.id, path: `queue/pending/${spec.id}.md` };
    },
    async trigger(opts) {
      recorder.triggerCalls.push(opts);
      return overrides.triggerOutcome ?? { ok: true };
    },
    read: {
      async queues() {
        return queues;
      },
      async runtimeReport() {
        return null;
      },
      async digestTail() {
        return "";
      },
    },
    async report(entry) {
      recorder.reportCalls.push(entry);
    },
    async recordRun(run) {
      recorder.recordRunCalls.push(run);
      if ("recordRunResult" in overrides) return overrides.recordRunResult ?? null;
      return { runId: "run-fake", path: "runs/run-fake.json" };
    },
  };

  return { caps, recorder };
}

/** An in-flight Task (parsed on-disk form: a spec plus a queue path). */
function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return { ...makeSpec(id), path: `queue/pending/${id}.md`, ...overrides } as Task;
}

function makeFakeAdapter(specs: TaskSpec[]): OrchestratorAdapter {
  return {
    async decompose(_input: DecomposeInput) {
      return specs;
    },
  };
}

const noopLog: Logger = () => {};

describe("createOrchestrator / handleIntent", () => {
  it("happy path: 3 specs -> 3 enqueued -> trigger called in drain mode -> result", async () => {
    const specs = [makeSpec("s1-t1"), makeSpec("s1-t2"), makeSpec("s1-t3")];
    const { caps, recorder } = makeFakeCaps();
    const adapter = makeFakeAdapter(specs);
    const orchestrator = createOrchestrator({ caps, adapter, log: noopLog });

    const result = await orchestrator.handleIntent("build the thing");

    expect(recorder.enqueueCalls.map((s) => s.id)).toEqual(["s1-t1", "s1-t2", "s1-t3"]);
    expect(recorder.triggerCalls).toEqual([{ drain: true }]);
    expect(result.intent).toBe("build the thing");
    expect(result.enqueued).toEqual([
      { id: "s1-t1", path: "queue/pending/s1-t1.md" },
      { id: "s1-t2", path: "queue/pending/s1-t2.md" },
      { id: "s1-t3", path: "queue/pending/s1-t3.md" },
    ]);
    expect(result.triggered).toBe(true);
    expect(result.triggerOutcome).toEqual({ ok: true });
    expect(recorder.reportCalls.at(-1)?.message).toMatch(/3 task\(s\) enqueued and triggered/);

    expect(recorder.recordRunCalls).toEqual([{ intent: "build the thing", taskIds: ["s1-t1", "s1-t2", "s1-t3"] }]);
  });

  it("all-or-nothing: one structurally invalid spec -> throws, zero enqueue calls made", async () => {
    const good = makeSpec("s1-t1");
    // Bypass validateTaskSpec's own guard to simulate an adapter that skipped
    // its own trust-boundary check and handed the orchestrator a bad spec.
    const bad = { ...good, id: "s1-t2", title: "" } as unknown as TaskSpec;
    const { caps, recorder } = makeFakeCaps();
    const adapter = makeFakeAdapter([good, bad]);
    const orchestrator = createOrchestrator({ caps, adapter, log: noopLog });

    await expect(orchestrator.handleIntent("intent")).rejects.toThrow(/all-or-nothing/);

    expect(recorder.enqueueCalls).toEqual([]);
    expect(recorder.triggerCalls).toEqual([]);
    expect(recorder.reportCalls).toHaveLength(1);
    expect(recorder.reportCalls[0]!.level).toBe("ERROR");
  });

  it("id-collision-vs-existing: a spec id already in-flight -> throws, zero enqueue calls made", async () => {
    const existingTask: Task = {
      id: "s1-t1",
      title: "existing",
      type: "tooling",
      touches_contract_zone: false,
      writes_guard: false,
      model: null,
      success_commands: [],
      forbidden_paths: [],
      max_rounds: null,
      file_set: ["src/x.ts"],
      depends_on: [],
      contract_zones_touched: [],
      needs_guard: false,
      acceptance: [],
      body: "",
      path: "queue/active/s1-t1.md",
    };
    const queues = emptyQueues();
    queues.active = [existingTask];
    const { caps, recorder } = makeFakeCaps({ queues });
    const adapter = makeFakeAdapter([makeSpec("s1-t1")]); // collides with existingTask's id
    const orchestrator = createOrchestrator({ caps, adapter, log: noopLog });

    await expect(orchestrator.handleIntent("intent")).rejects.toThrow(/collides with an existing in-flight task/);
    expect(recorder.enqueueCalls).toEqual([]);
    expect(recorder.triggerCalls).toEqual([]);
  });

  it("id-collision-within-batch: two specs sharing an id in the same batch -> throws, zero enqueue calls made", async () => {
    const { caps, recorder } = makeFakeCaps();
    const adapter = makeFakeAdapter([makeSpec("dup"), makeSpec("dup")]);
    const orchestrator = createOrchestrator({ caps, adapter, log: noopLog });

    await expect(orchestrator.handleIntent("intent")).rejects.toThrow(/collides with another task in this same batch/);
    expect(recorder.enqueueCalls).toEqual([]);
  });

  it("empty decomposition handling: zero specs -> skips trigger entirely, does not call caps.trigger", async () => {
    const { caps, recorder } = makeFakeCaps();
    const adapter = makeFakeAdapter([]);
    const orchestrator = createOrchestrator({ caps, adapter, log: noopLog });

    const result = await orchestrator.handleIntent("intent");

    expect(recorder.enqueueCalls).toEqual([]);
    expect(recorder.triggerCalls).toEqual([]);
    expect(result.enqueued).toEqual([]);
    expect(result.triggered).toBe(false);
    expect(recorder.reportCalls.at(-1)?.message).toMatch(
      /decomposition produced 0 tasks; nothing enqueued, trigger skipped/,
    );
    expect(recorder.recordRunCalls).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Relaunch-intent dedup (backlog C)
  // -------------------------------------------------------------------------

  it("full relaunch: every spec duplicates in-flight work -> nothing enqueued/recorded, but re-triggers the existing pool", async () => {
    const queues = emptyQueues();
    // Two in-flight tasks matching the relaunch (same title + overlapping file_set).
    queues.pending = [makeTask("old-t1", { title: "Add A", file_set: ["src/a.ts"] })];
    queues.active = [makeTask("old-t2", { title: "Add B", file_set: ["src/b.ts"] })];
    const { caps, recorder } = makeFakeCaps({ queues });
    const specs = [
      makeSpec("new-t1", { title: "Add A", file_set: ["src/a.ts"] }),
      makeSpec("new-t2", { title: "Add B", file_set: ["src/b.ts"] }),
    ];
    const orchestrator = createOrchestrator({ caps, adapter: makeFakeAdapter(specs), log: noopLog });

    const result = await orchestrator.handleIntent("do A and B");

    expect(recorder.enqueueCalls).toEqual([]); // nothing duplicated
    expect(recorder.recordRunCalls).toEqual([]); // no new run manifest
    expect(recorder.triggerCalls).toEqual([{ drain: true }]); // still re-drives existing pending
    expect(result.enqueued).toEqual([]);
    expect(result.triggered).toBe(true);
    expect(recorder.reportCalls.at(-1)?.level).toBe("WARN");
    expect(recorder.reportCalls.at(-1)?.message).toMatch(/duplicate existing/i);
  });

  it("partial overlap: some specs match in-flight work -> ALL enqueued (never drop a subset), with a WARN", async () => {
    const queues = emptyQueues();
    queues.active = [makeTask("old-t1", { title: "Add A", file_set: ["src/a.ts"] })];
    const { caps, recorder } = makeFakeCaps({ queues });
    const specs = [
      makeSpec("new-t1", { title: "Add A", file_set: ["src/a.ts"] }), // dup
      makeSpec("new-t2", { title: "Add C", file_set: ["src/c.ts"] }), // genuinely new
    ];
    const orchestrator = createOrchestrator({ caps, adapter: makeFakeAdapter(specs), log: noopLog });

    const result = await orchestrator.handleIntent("do A and C");

    // Both enqueued — dropping the overlapping one could break a depends_on and lose new work.
    expect(recorder.enqueueCalls.map((s) => s.id)).toEqual(["new-t1", "new-t2"]);
    expect(result.enqueued.map((e) => e.id)).toEqual(["new-t1", "new-t2"]);
    expect(recorder.triggerCalls).toEqual([{ drain: true }]);
    expect(recorder.reportCalls.some((r) => r.level === "WARN" && /overlap existing in-flight/i.test(r.message))).toBe(true);
  });

  it("file overlap WITHOUT a title match is NOT a duplicate (fail-open) -> enqueued", async () => {
    const queues = emptyQueues();
    queues.active = [makeTask("old-t1", { title: "Refactor the parser", file_set: ["src/a.ts"] })];
    const { caps, recorder } = makeFakeCaps({ queues });
    const specs = [makeSpec("new-t1", { title: "Add a totally different feature", file_set: ["src/a.ts"] })];
    const orchestrator = createOrchestrator({ caps, adapter: makeFakeAdapter(specs), log: noopLog });

    await orchestrator.handleIntent("different work touching a shared file");
    expect(recorder.enqueueCalls.map((s) => s.id)).toEqual(["new-t1"]);
  });

  it("a title match with a DISJOINT file_set is NOT a duplicate -> enqueued", async () => {
    const queues = emptyQueues();
    queues.pending = [makeTask("old-t1", { title: "Add A", file_set: ["src/a.ts"] })];
    const { caps, recorder } = makeFakeCaps({ queues });
    const specs = [makeSpec("new-t1", { title: "Add A", file_set: ["src/z.ts"] })];
    const orchestrator = createOrchestrator({ caps, adapter: makeFakeAdapter(specs), log: noopLog });

    await orchestrator.handleIntent("intent");
    expect(recorder.enqueueCalls.map((s) => s.id)).toEqual(["new-t1"]);
  });

  it("a match against DONE/QUARANTINE work is NOT a duplicate (only pending/active/escalated count) -> enqueued", async () => {
    const queues = emptyQueues();
    queues.done = [makeTask("old-done", { title: "Add A", file_set: ["src/a.ts"] })];
    queues.quarantine = [makeTask("old-quar", { title: "Add A", file_set: ["src/a.ts"] })];
    const { caps, recorder } = makeFakeCaps({ queues });
    const specs = [makeSpec("new-t1", { title: "Add A", file_set: ["src/a.ts"] })];
    const orchestrator = createOrchestrator({ caps, adapter: makeFakeAdapter(specs), log: noopLog });

    await orchestrator.handleIntent("re-do A after it finished/was parked");
    expect(recorder.enqueueCalls.map((s) => s.id)).toEqual(["new-t1"]);
  });

  it("isDuplicateTask: requires BOTH file overlap AND a normalized title match", () => {
    const spec = makeSpec("x", { title: "  Add   THE  Thing ", file_set: ["src/a.ts", "src/b.ts"] });
    // overlap + title-equivalent-modulo-whitespace/case -> duplicate
    expect(isDuplicateTask(spec, { title: "add the thing", file_set: ["src/b.ts"] })).toBe(true);
    // same title, disjoint files -> not a duplicate
    expect(isDuplicateTask(spec, { title: "add the thing", file_set: ["src/z.ts"] })).toBe(false);
    // overlapping files, different title -> not a duplicate
    expect(isDuplicateTask(spec, { title: "something else", file_set: ["src/a.ts"] })).toBe(false);
  });

  it("recordRun best-effort failure (returns null) does NOT fail handleIntent — normal success result still returned", async () => {
    const specs = [makeSpec("s1-t1"), makeSpec("s1-t2")];
    const { caps, recorder } = makeFakeCaps({ recordRunResult: null });
    const adapter = makeFakeAdapter(specs);
    const orchestrator = createOrchestrator({ caps, adapter, log: noopLog });

    const result = await orchestrator.handleIntent("intent");

    expect(recorder.recordRunCalls).toEqual([{ intent: "intent", taskIds: ["s1-t1", "s1-t2"] }]);
    expect(result.triggered).toBe(true);
    expect(result.enqueued).toHaveLength(2);
  });

  it("transactional enqueue: an fs error mid-batch rolls back already-written paths and does NOT trigger", async () => {
    const specs = [makeSpec("s1-t1"), makeSpec("s1-t2")];
    const enqueueImpl = async (spec: TaskSpec) => {
      if (spec.id === "s1-t2") {
        throw new Error("simulated fs error writing s1-t2");
      }
      return { id: spec.id, path: `queue/pending/${spec.id}.md` };
    };
    const { caps, recorder } = makeFakeCaps({ enqueueImpl });
    const adapter = makeFakeAdapter(specs);
    const unlinkCalls: string[] = [];
    const unlink = async (path: string) => {
      unlinkCalls.push(path);
    };
    const orchestrator = createOrchestrator({ caps, adapter, log: noopLog, unlink });

    await expect(orchestrator.handleIntent("intent")).rejects.toThrow(/s1-t2/);

    expect(unlinkCalls).toEqual(["queue/pending/s1-t1.md"]);
    expect(recorder.triggerCalls).toEqual([]);
  });

  it("transactional enqueue: rollback is best-effort — an unlink failure does not mask the original enqueue error", async () => {
    const specs = [makeSpec("s1-t1"), makeSpec("s1-t2")];
    const enqueueImpl = async (spec: TaskSpec) => {
      if (spec.id === "s1-t2") {
        throw new Error("simulated fs error writing s1-t2");
      }
      return { id: spec.id, path: `queue/pending/${spec.id}.md` };
    };
    const { caps, recorder } = makeFakeCaps({ enqueueImpl });
    const adapter = makeFakeAdapter(specs);
    const unlink = async () => {
      throw new Error("simulated unlink failure");
    };
    const orchestrator = createOrchestrator({ caps, adapter, log: noopLog, unlink });

    await expect(orchestrator.handleIntent("intent")).rejects.toThrow(/s1-t2/);
    expect(recorder.triggerCalls).toEqual([]);
  });
});
