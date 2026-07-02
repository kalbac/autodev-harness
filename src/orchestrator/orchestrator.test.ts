import { describe, it, expect } from "vitest";
import { createOrchestrator } from "./orchestrator.js";
import type { OrchestratorAdapter, DecomposeInput } from "./adapter.js";
import type { OrchestratorCapabilities } from "./capabilities.js";
import type { QueueState } from "../blackboard/repository.js";
import type { Task } from "../blackboard/types.js";
import type { Logger } from "../util/log.js";
import { validateTaskSpec, type TaskSpec } from "./task-spec.js";

const ALL_STATES: QueueState[] = ["pending", "active", "done", "escalated", "quarantine"];

function emptyQueues(): Record<QueueState, Task[]> {
  return Object.fromEntries(ALL_STATES.map((s) => [s, [] as Task[]] as const)) as Record<QueueState, Task[]>;
}

function makeSpec(id: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return validateTaskSpec({ id, title: "Title", type: "tooling", file_set: ["src/a.ts"], ...overrides });
}

interface FakeCapsRecorder {
  enqueueCalls: TaskSpec[];
  triggerCalls: Array<{ once?: boolean; maxIterations?: number } | undefined>;
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

function makeFakeAdapter(specs: TaskSpec[]): OrchestratorAdapter {
  return {
    async decompose(_input: DecomposeInput) {
      return specs;
    },
  };
}

const noopLog: Logger = () => {};

describe("createOrchestrator / handleIntent", () => {
  it("happy path: 3 specs -> 3 enqueued -> trigger called with maxIterations 3 -> result", async () => {
    const specs = [makeSpec("s1-t1"), makeSpec("s1-t2"), makeSpec("s1-t3")];
    const { caps, recorder } = makeFakeCaps();
    const adapter = makeFakeAdapter(specs);
    const orchestrator = createOrchestrator({ caps, adapter, log: noopLog });

    const result = await orchestrator.handleIntent("build the thing");

    expect(recorder.enqueueCalls.map((s) => s.id)).toEqual(["s1-t1", "s1-t2", "s1-t3"]);
    expect(recorder.triggerCalls).toEqual([{ maxIterations: 3 }]);
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
