import { describe, it, expect } from "vitest";
import { createScheduler, fileSetsDisjoint } from "./scheduler.js";
import type { BlackboardRepository, QueueState } from "../blackboard/repository.js";
import type { Task } from "../blackboard/types.js";

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: overrides.id,
    type: "tooling",
    touches_contract_zone: false,
    writes_guard: false,
    model: null,
    success_commands: [],
    forbidden_paths: [],
    max_rounds: null,
    file_set: [],
    depends_on: [],
    contract_zones_touched: [],
    needs_guard: false,
    acceptance: [],
    body: "",
    path: `.autodev/queue/pending/${overrides.id}.md`,
    ...overrides,
  };
}

/**
 * A minimal in-memory BlackboardRepository fake. Only the members the
 * scheduler actually calls (listTasks, moveTask) carry real behavior; the
 * rest throw if invoked since the scheduler must never touch them.
 */
class FakeRepo implements BlackboardRepository {
  private queues: Record<QueueState, Task[]> = {
    pending: [],
    active: [],
    done: [],
    escalated: [],
    quarantine: [],
  };
  private moveThrowsFor: Set<string>;

  constructor(seed: Partial<Record<QueueState, Task[]>>, moveThrowsFor: string[] = []) {
    for (const [state, tasks] of Object.entries(seed) as Array<[QueueState, Task[] | undefined]>) {
      this.queues[state] = [...(tasks ?? [])];
    }
    this.moveThrowsFor = new Set(moveThrowsFor);
  }

  async listTasks(state: QueueState): Promise<Task[]> {
    return [...this.queues[state]].sort((a, b) => a.id.localeCompare(b.id));
  }

  async moveTask(id: string, from: QueueState, to: QueueState): Promise<void> {
    if (this.moveThrowsFor.has(id)) {
      throw new Error(`lost race claiming ${id}`);
    }
    const list = this.queues[from];
    const idx = list.findIndex((t) => t.id === id);
    if (idx === -1) {
      throw new Error(`task ${id} not found in ${from}`);
    }
    const [task] = list.splice(idx, 1);
    if (!task) {
      throw new Error(`task ${id} not found in ${from}`);
    }
    this.queues[to].push(task);
  }

  getAttempts(_id: string): Promise<number> {
    throw new Error("not used by scheduler");
  }
  setAttempts(_id: string, _n: number): Promise<void> {
    throw new Error("not used by scheduler");
  }
  writeRuntimeFile(_id: string, _name: string, _content: string): Promise<void> {
    throw new Error("not used by scheduler");
  }
  readRuntimeFile(_id: string, _name: string): Promise<string | null> {
    throw new Error("not used by scheduler");
  }
  markDone(_id: string, _commitHash: string): Promise<void> {
    throw new Error("not used by scheduler");
  }
  appendDigest(_line: string): Promise<void> {
    throw new Error("not used by scheduler");
  }
  runtimeDir(_id: string): string {
    throw new Error("not used by scheduler");
  }
}

/** Builds the 7-task self-test scenario ported from scheduler.ps1's own self-test. */
function makeScenario(moveThrowsFor: string[] = []): FakeRepo {
  const taskA = makeTask({ id: "taskA", file_set: ["woodev/class-plugin.php"] });
  const taskB = makeTask({
    id: "taskB",
    file_set: ["woodev/class-plugin.php", "woodev/class-helper.php"],
  });
  const taskC = makeTask({ id: "taskC", file_set: ["woodev/class-lifecycle.php"] });
  const depDone = makeTask({ id: "depDone" });
  const taskD = makeTask({ id: "taskD", file_set: ["woodev/class-d.php"], depends_on: ["depDone"] });
  const taskE = makeTask({ id: "taskE", file_set: ["woodev/class-e.php"], depends_on: ["depMissing"] });
  const taskF = makeTask({ id: "taskF", file_set: ["woodev/class-lifecycle.php"] });
  const taskG = makeTask({ id: "taskG", file_set: ["woodev/class-lifecycle.php"] });

  return new FakeRepo(
    {
      active: [taskA],
      pending: [taskB, taskC, taskD, taskE, taskG],
      done: [depDone],
      escalated: [taskF],
    },
    moveThrowsFor,
  );
}

describe("fileSetsDisjoint", () => {
  it("returns true for sets sharing no path", () => {
    expect(fileSetsDisjoint(["a/x.php"], ["b/y.php"])).toBe(true);
  });

  it("returns false for sets sharing a path", () => {
    expect(fileSetsDisjoint(["a/x.php", "a/y.php"], ["a/y.php"])).toBe(false);
  });

  it("returns true for two empty sets", () => {
    expect(fileSetsDisjoint([], [])).toBe(true);
  });

  it("normalizes backslashes and strips leading ./ before comparing", () => {
    expect(fileSetsDisjoint(["./woodev/x.php"], ["woodev/x.php"])).toBe(false);
    expect(fileSetsDisjoint(["woodev\\x.php"], ["woodev/x.php"])).toBe(false);
    expect(fileSetsDisjoint(["../../woodev/x.php"], ["woodev/x.php"])).toBe(false);
  });
});

describe("listClaimable", () => {
  it("reports claimable + blocked_by exactly per the 7-task scenario", async () => {
    const repo = makeScenario();
    const scheduler = createScheduler(repo);

    const report = await scheduler.listClaimable();
    const byId = new Map(report.map((r) => [r.id, r]));

    expect(byId.get("taskB")).toEqual({ id: "taskB", claimable: false, blocked_by: "active:taskA" });
    expect(byId.get("taskC")).toEqual({ id: "taskC", claimable: false, blocked_by: "escalated:taskF" });
    expect(byId.get("taskD")).toEqual({ id: "taskD", claimable: true, blocked_by: "" });
    expect(byId.get("taskE")).toEqual({ id: "taskE", claimable: false, blocked_by: "dep:depMissing" });
    expect(byId.get("taskG")).toEqual({ id: "taskG", claimable: false, blocked_by: "escalated:taskF" });
    expect(report).toHaveLength(5);
  });
});

describe("claimNextTask", () => {
  it("claims taskD (the first claimable pending task in id order) and moves it pending -> active", async () => {
    const repo = makeScenario();
    const scheduler = createScheduler(repo);

    const claimed = await scheduler.claimNextTask();

    expect(claimed?.id).toBe("taskD");

    const pendingIds = (await repo.listTasks("pending")).map((t) => t.id);
    const activeIds = (await repo.listTasks("active")).map((t) => t.id);
    expect(pendingIds).toEqual(["taskB", "taskC", "taskE", "taskG"]);
    expect(activeIds.sort()).toEqual(["taskA", "taskD"]);
  });

  it("returns null when no pending task is claimable", async () => {
    const taskA = makeTask({ id: "taskA", file_set: ["x.php"] });
    const taskB = makeTask({ id: "taskB", file_set: ["x.php"] });
    const repo = new FakeRepo({ active: [taskA], pending: [taskB] });
    const scheduler = createScheduler(repo);

    const claimed = await scheduler.claimNextTask();

    expect(claimed).toBeNull();
  });

  it("silently skips a lost-race claim (moveTask throws) instead of propagating the throw", async () => {
    // taskD is the sole claimable task in the 7-task scenario; force its
    // claim attempt to throw as if another loop iteration won the race.
    const repo = makeScenario(["taskD"]);
    const scheduler = createScheduler(repo);

    const claimed = await scheduler.claimNextTask();

    // No other pending task is claimable once taskD's claim is lost, so the
    // scheduler must fall through to null -- but crucially it must NOT throw.
    expect(claimed).toBeNull();
    const pendingIds = (await repo.listTasks("pending")).map((t) => t.id);
    expect(pendingIds).toContain("taskD"); // never actually moved
  });

  it("after a lost-race skip, proceeds to claim the next claimable task", async () => {
    const taskA = makeTask({ id: "taskA", file_set: ["woodev/class-plugin.php"] });
    const taskD = makeTask({ id: "taskD", file_set: ["woodev/class-d.php"] });
    const taskH = makeTask({ id: "taskH", file_set: ["woodev/class-h.php"] });
    const repo = new FakeRepo({ active: [taskA], pending: [taskD, taskH] }, ["taskD"]);
    const scheduler = createScheduler(repo);

    const claimed = await scheduler.claimNextTask();

    expect(claimed?.id).toBe("taskH");
    const activeIds = (await repo.listTasks("active")).map((t) => t.id).sort();
    expect(activeIds).toEqual(["taskA", "taskH"]);
    const pendingIds = (await repo.listTasks("pending")).map((t) => t.id);
    expect(pendingIds).toEqual(["taskD"]);
  });
});
