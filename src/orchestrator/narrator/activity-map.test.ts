import { describe, it, expect } from "vitest";
import { diffRunSnapshot } from "./activity-map.js";

const T = (taskId: string, status: any, title = taskId) => ({ taskId, status, title });

describe("diffRunSnapshot", () => {
  it("emits run_started + a run cell on first snapshot", () => {
    const { cells, milestones } = diffRunSnapshot(null, { runId: "r", tasks: [T("t1", "pending")] });
    expect(milestones).toContainEqual({ kind: "run_started", runId: "r" });
    expect(cells.some((c) => c.kind === "run")).toBe(true);
  });
  it("emits task_active on pending->active", () => {
    const prev = { runId: "r", tasks: [T("t1", "pending")] };
    const next = { runId: "r", tasks: [T("t1", "active")] };
    const { cells, milestones } = diffRunSnapshot(prev, next);
    expect(milestones).toContainEqual({ kind: "task_active", taskId: "t1", title: "t1" });
    expect(cells).toContainEqual(expect.objectContaining({ kind: "worker", status: "running", ref: { taskId: "t1" } }));
  });
  it("emits task_done + run_finished when the last task completes", () => {
    const prev = { runId: "r", tasks: [T("t1", "active")] };
    const next = { runId: "r", tasks: [T("t1", "done")] };
    const { milestones } = diffRunSnapshot(prev, next);
    expect(milestones).toContainEqual({ kind: "task_done", taskId: "t1", title: "t1" });
    expect(milestones).toContainEqual({ kind: "run_finished", runId: "r" });
  });
  it("emits task_escalated on ->escalated with an error-status cell", () => {
    const prev = { runId: "r", tasks: [T("t1", "active")] };
    const next = { runId: "r", tasks: [T("t1", "escalated")] };
    const { cells, milestones } = diffRunSnapshot(prev, next);
    expect(milestones).toContainEqual({ kind: "task_escalated", taskId: "t1", title: "t1" });
    expect(cells).toContainEqual(expect.objectContaining({ kind: "escalation", status: "error" }));
  });
  it("no cells/milestones when nothing changed", () => {
    const s = { runId: "r", tasks: [T("t1", "active")] };
    expect(diffRunSnapshot(s, s)).toEqual({ cells: [], milestones: [] });
  });
});
