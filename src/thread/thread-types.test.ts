import { describe, it, expect } from "vitest";
import { threadEntrySchema, threadMetaSchema, type ThreadEntry } from "./thread-types.js";

describe("thread schemas", () => {
  it("accepts each entry type", () => {
    const now = 1_000;
    const entries: ThreadEntry[] = [
      { ts: now, type: "operator_msg", text: "build X" },
      { ts: now, type: "orchestrator_msg", text: "on it", milestone: "run_started" },
      { ts: now, type: "activity", kind: "gate", ref: { taskId: "t1" }, summary: "gate: commit", status: "ok" },
      { ts: now, type: "plan", specs: [{ id: "t1", title: "T", type: "feature", file_set: ["a.ts"] }] },
      { ts: now, type: "run_link", runId: "run-x" },
    ];
    for (const e of entries) expect(threadEntrySchema.parse(e)).toEqual(e);
  });

  it("rejects an unknown entry type", () => {
    expect(() => threadEntrySchema.parse({ ts: 1, type: "nope" })).toThrow();
  });

  it("parses meta with optional run_id", () => {
    const m = threadMetaSchema.parse({ id: "th-1", title: "X", created_at: 1, status: "chatting" });
    expect(m.run_id).toBeUndefined();
  });
});
