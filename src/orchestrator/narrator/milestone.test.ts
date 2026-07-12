import { describe, it, expect } from "vitest";
import { coalesceMilestones } from "./milestone.js";

const M = (at: number, kind = "task_active") => ({ at, milestone: { kind } as any });

describe("coalesceMilestones", () => {
  it("keeps recent pending milestones (still coalescing)", () => {
    const r = coalesceMilestones([M(100), M(120)], 130, 50);
    expect(r.fire).toEqual([]);
    expect(r.keep).toHaveLength(2);
  });
  it("fires all pending once the oldest exceeds the window", () => {
    const r = coalesceMilestones([M(100), M(120)], 160, 50);
    expect(r.fire).toHaveLength(2);
    expect(r.keep).toEqual([]);
  });
  it("always fires a terminal milestone immediately", () => {
    const r = coalesceMilestones([{ at: 100, milestone: { kind: "run_finished", runId: "r" } as any }], 105, 50);
    expect(r.fire).toHaveLength(1);
  });
  it("nothing pending -> nothing fires", () => {
    expect(coalesceMilestones([], 100, 50)).toEqual({ fire: [], keep: [] });
  });
});
