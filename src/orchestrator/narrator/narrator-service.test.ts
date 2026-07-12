import { describe, it, expect, vi } from "vitest";
import { NarratorService } from "./narrator-service.js";

function harness(snaps: any[]) {
  const appended: any[] = [];
  const store = {
    append: vi.fn(async (_id: string, e: any) => { appended.push(e); }),
    setMeta: vi.fn(async () => {}),
    read: vi.fn(async () => ({ meta: { id: "th", title: "t", created_at: 1, status: "running" }, entries: appended.map((e, k) => ({ ts: k, ...e })) })),
  };
  const bus = { broadcast: vi.fn() };
  const ciBus = { subscribe: vi.fn(), unsubscribe: vi.fn() };
  let i = 0;
  const read = {
    recentRuns: vi.fn(async () => [{ runId: "r", created_at: 5000, intent: "x" }]),
    runSnapshot: vi.fn(async () => snaps[Math.min(i, snaps.length - 1)] ?? null),
  };
  const narrate = vi.fn(async (_p: string, onToken: (t: string) => void) => { onToken("narrated"); return "narrated"; });
  let tick: () => Promise<void> = async () => {};
  let nowV = 6000;
  const svc = new NarratorService({
    projectId: "p", threadId: "th", finalIntent: "x", launchedAt: 1000,
    store, bus, ciBus, read, narrate, log: () => {}, now: () => (nowV += 1000),
    tickMs: 10, windowMs: 5,
    setInterval: ((fn: any) => { tick = fn; return 1 as any; }) as any,
    clearInterval: (() => {}) as any,
  } as any);
  return { svc, appended, store, read, narrate, advance: async () => { await tick(); i++; } };
}

describe("NarratorService", () => {
  it("discovers the run and writes run_link + meta on first tick", async () => {
    const h = harness([{ runId: "r", tasks: [{ taskId: "t1", status: "pending", title: "T" }] }]);
    h.svc.start();
    await h.advance();
    expect(h.appended.some((e) => e.type === "run_link" && e.runId === "r")).toBe(true);
    expect(h.store.setMeta).toHaveBeenCalledWith("th", expect.objectContaining({ run_id: "r" }));
  });

  it("appends instant activity cells for a transition and narrates the milestone", async () => {
    const h = harness([
      { runId: "r", tasks: [{ taskId: "t1", status: "pending", title: "T" }] },
      { runId: "r", tasks: [{ taskId: "t1", status: "active", title: "T" }] },
    ]);
    h.svc.start();
    await h.advance(); // tick0: discover + snapshot pending (prev null -> run_started only)
    await h.advance(); // tick1: pending->active -> worker cell + task_active milestone
    expect(h.appended.some((e) => e.type === "activity" && e.kind === "worker")).toBe(true);
    await h.advance(); // tick2: coalesce window elapsed -> narrate
    expect(h.narrate).toHaveBeenCalled();
    expect(h.appended.some((e) => e.type === "orchestrator_msg" && e.milestone)).toBe(true);
  });

  it("stops and sets meta done when the run finishes", async () => {
    const h = harness([
      { runId: "r", tasks: [{ taskId: "t1", status: "active", title: "T" }] },
      { runId: "r", tasks: [{ taskId: "t1", status: "done", title: "T" }] },
    ]);
    h.svc.start();
    await h.advance(); // tick0: discover + active
    await h.advance(); // tick1: active->done -> run_finished -> setMeta done + stop
    expect(h.store.setMeta).toHaveBeenCalledWith("th", expect.objectContaining({ status: "done" }));
  });

  it("mid-run message: one-shot reply streamed into the thread", async () => {
    const h = harness([{ runId: "r", tasks: [{ taskId: "t1", status: "active", title: "T" }] }]);
    h.svc.start();
    await h.advance();
    await h.svc.handleOperatorMessage("how is it going?");
    expect(h.narrate).toHaveBeenCalled();
    expect(h.appended.some((e) => e.type === "operator_msg" && e.text === "how is it going?")).toBe(true);
    expect(h.appended.some((e) => e.type === "orchestrator_msg")).toBe(true);
  });
});
