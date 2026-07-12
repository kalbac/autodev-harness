import { describe, it, expect, vi } from "vitest";
import { NarratorService } from "./narrator-service.js";

function harness(snaps: any[], extra: any = {}) {
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
    ...extra,
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

  it("waits for a run whose intent matches; ignores an older unrelated run", async () => {
    const appended: any[] = [];
    const store = {
      append: vi.fn(async (_id: string, e: any) => { appended.push(e); }),
      setMeta: vi.fn(async () => {}),
      read: vi.fn(async () => ({ meta: {}, entries: appended.map((e, k) => ({ ts: k, ...e })) })),
    };
    let runs: any[] = [{ runId: "old", created_at: 500, intent: "other" }];
    const read = {
      recentRuns: vi.fn(async () => runs),
      runSnapshot: vi.fn(async () => ({ runId: "new", tasks: [{ taskId: "t1", status: "pending", title: "T" }] })),
    };
    let tick: () => Promise<void> = async () => {};
    const svc = new NarratorService({
      projectId: "p", threadId: "th", finalIntent: "x", launchedAt: 1000,
      store, bus: { broadcast: vi.fn() }, ciBus: { subscribe: vi.fn(), unsubscribe: vi.fn() },
      read, narrate: vi.fn(async () => ""), log: () => {}, now: () => 6000, tickMs: 10, windowMs: 5,
      setInterval: ((fn: any) => { tick = fn; return 1 as any; }) as any,
      clearInterval: (() => {}) as any,
    } as any);
    svc.start();
    await tick(); // only an older, wrong-intent run present -> no bind
    expect(appended.some((e) => e.type === "run_link")).toBe(false);
    runs = [{ runId: "old", created_at: 500, intent: "other" }, { runId: "new", created_at: 1500, intent: "x" }];
    await tick(); // matching run appears -> bind THAT run
    expect(appended.some((e) => e.type === "run_link" && e.runId === "new")).toBe(true);
  });

  it("tick never throws when the log throws and runSnapshot rejects with a hostile error", async () => {
    const hostile = { get message(): string { throw new Error("nope"); } };
    const read = {
      recentRuns: vi.fn(async () => [{ runId: "r", created_at: 5000, intent: "x" }]),
      runSnapshot: vi.fn(async () => { throw hostile; }),
    };
    let tick: () => Promise<void> = async () => {};
    const svc = new NarratorService({
      projectId: "p", threadId: "th", finalIntent: "x", launchedAt: 1000,
      store: { append: vi.fn(async () => {}), setMeta: vi.fn(async () => {}), read: vi.fn(async () => ({ meta: {}, entries: [] })) },
      bus: { broadcast: vi.fn() }, ciBus: { subscribe: vi.fn(), unsubscribe: vi.fn() },
      read, narrate: vi.fn(async () => ""),
      log: () => { throw new Error("logger down"); },
      now: () => 6000, tickMs: 10, windowMs: 5,
      setInterval: ((fn: any) => { tick = fn; return 1 as any; }) as any,
      clearInterval: (() => {}) as any,
    } as any);
    svc.start();
    await expect(tick()).resolves.toBeUndefined();
  });

  it("calls onStopped once when the run reaches terminal", async () => {
    const onStopped = vi.fn();
    const h = harness([
      { runId: "r", tasks: [{ taskId: "t1", status: "active", title: "T" }] },
      { runId: "r", tasks: [{ taskId: "t1", status: "done", title: "T" }] },
    ], { onStopped });
    h.svc.start();
    await h.advance(); // discover + active
    await h.advance(); // active->done -> terminal -> stop -> onStopped
    expect(onStopped).toHaveBeenCalledTimes(1);
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
