import { describe, it, expect, vi } from "vitest";
import { ThreadChatService } from "./thread-chat-service.js";
import { LAUNCH_MARKER } from "../thread/launch-marker.js";

function makeDeps(overrides: any = {}) {
  const appended: any[] = [];
  const store = {
    create: vi.fn(async ({ id, title }: any) => ({ id, title, created_at: 1, status: "chatting" })),
    append: vi.fn(async (_id: string, e: any) => { appended.push(e); }),
    read: vi.fn(async () => ({ meta: { id: "th", title: "t", created_at: 1, status: "chatting" }, entries: appended.map((e, i) => ({ ts: i, ...e })) })),
    setMeta: vi.fn(async () => {}),
    readNdjson: vi.fn(async () => ""),
    list: vi.fn(async () => []),
  };
  const bus = { broadcast: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), closeAll: vi.fn() };
  const manager = {
    start: vi.fn(async () => ({ sessionId: "s1", turn: { reply: "Hello", proposedSpecs: undefined } })),
    send: vi.fn(async () => ({ reply: "ok", proposedSpecs: undefined })),
    cancel: vi.fn(async () => true),
    hasSession: vi.fn(() => true),
    ...overrides.manager,
  };
  const launch = vi.fn(async () => ({ accepted: true }));
  const startNarrator = vi.fn();
  let t = 0;
  const svc = new ThreadChatService({
    store, bus, manager, log: () => {}, now: () => ++t,
    buildSnapshot: async () => ({} as any),
    launch, startNarrator, mintThreadId: (_intent: string) => "th",
    ...overrides.deps,
  } as any);
  return { svc, store, bus, manager, launch, startNarrator, appended };
}

describe("ThreadChatService", () => {
  it("startThread creates a thread, persists operator + orchestrator turns", async () => {
    const { svc, store, appended } = makeDeps();
    const { threadId } = await svc.startThread("p", "build X");
    await svc.waitIdle(threadId);
    expect(threadId).toBe("th");
    expect(store.create).toHaveBeenCalled();
    expect(appended.some((e) => e.type === "operator_msg")).toBe(true);
    expect(appended.some((e) => e.type === "orchestrator_msg")).toBe(true);
  });

  it("persists a plan entry when the turn proposes specs", async () => {
    const { svc, appended } = makeDeps({ manager: { start: vi.fn(async () => ({ sessionId: "s1", turn: { reply: "plan ready", proposedSpecs: [{ id: "t1", title: "T", type: "feature", file_set: ["a"] }] } })) } });
    await svc.startThread("p", "x");
    await svc.waitIdle();
    expect(appended.some((e) => e.type === "plan")).toBe(true);
  });

  it("strips fenced json from the persisted orchestrator prose", async () => {
    const reply = "Here:\n```json\n[{\"id\":\"t1\"}]\n```\nready";
    const { svc, appended } = makeDeps({ manager: { start: vi.fn(async () => ({ sessionId: "s1", turn: { reply, proposedSpecs: [] } })) } });
    await svc.startThread("p", "x");
    await svc.waitIdle();
    const om = appended.find((e) => e.type === "orchestrator_msg");
    expect(om.text).not.toContain("```json");
  });

  it("LAUNCH-by-word launches only with a plan and no run_link (marker on its own line)", async () => {
    const { svc, launch } = makeDeps({ manager: {
      start: vi.fn(async () => ({ sessionId: "s1", turn: { reply: "plan", proposedSpecs: [{ id: "t1", title: "T", type: "feature", file_set: ["a"] }] } })),
      send: vi.fn(async () => ({ reply: `Launching now\n${LAUNCH_MARKER}`, proposedSpecs: undefined })),
    } });
    await svc.startThread("p", "x");
    await svc.waitIdle();
    await svc.sendMessage("th", "go");
    expect(launch).toHaveBeenCalled();
  });

  it("does NOT launch when the marker is inside a ```json block", async () => {
    const { svc, launch } = makeDeps({ manager: {
      start: vi.fn(async () => ({ sessionId: "s1", turn: { reply: "plan", proposedSpecs: [{ id: "t1", title: "T", type: "feature", file_set: ["a"] }] } })),
      send: vi.fn(async () => ({ reply: `Here:\n\`\`\`json\n[{"note":"${LAUNCH_MARKER}"}]\n\`\`\`\nnot yet`, proposedSpecs: undefined })),
    } });
    await svc.startThread("p", "x");
    await svc.waitIdle();
    await svc.sendMessage("th", "go");
    expect(launch).not.toHaveBeenCalled();
  });

  it("does NOT launch when the marker text is only a narrative substring (absent)", async () => {
    const { svc, launch } = makeDeps({ manager: {
      start: vi.fn(async () => ({ sessionId: "s1", turn: { reply: "plan", proposedSpecs: [{ id: "t1", title: "T", type: "feature", file_set: ["a"] }] } })),
      send: vi.fn(async () => ({ reply: "we could launch it later", proposedSpecs: undefined })),
    } });
    await svc.startThread("p", "x");
    await svc.waitIdle();
    await svc.sendMessage("th", "go");
    expect(launch).not.toHaveBeenCalled();
  });

  it("sendMessage never rejects when the turn throws; persists a visible error turn", async () => {
    const { svc, appended } = makeDeps({ manager: {
      send: vi.fn(async () => { throw new Error("boom"); }),
    } });
    await svc.startThread("p", "x");
    await svc.waitIdle();
    await expect(svc.sendMessage("th", "go")).resolves.toBeUndefined();
    expect(appended.some((e) => e.type === "orchestrator_msg" && /error on that turn/.test(e.text))).toBe(true);
  });

  it("sendMessage awaits the opening turn so early input is not dropped", async () => {
    const { svc, manager } = makeDeps();
    await svc.startThread("p", "x"); // do NOT waitIdle
    await svc.sendMessage("th", "go");
    expect(manager.send).toHaveBeenCalled();
  });

  it("flushes the stripper tail to the live stream on turn end", async () => {
    const { svc, bus } = makeDeps({ manager: {
      start: vi.fn(async ({ sink }: any) => {
        sink.write(JSON.stringify({ type: "token", text: "ok" }));
        return { sessionId: "s1", turn: { reply: "ok", proposedSpecs: undefined } };
      }),
    } });
    const { threadId } = await svc.startThread("p", "x");
    await svc.waitIdle(threadId);
    const tokenText = bus.broadcast.mock.calls
      .map((c: any[]) => { try { return JSON.parse(c[1]); } catch { return null; } })
      .filter((f: any) => f && f.type === "token")
      .map((f: any) => f.text)
      .join("");
    expect(tokenText).toContain("ok");
  });

  it("retries the thread id when store.create collides", async () => {
    const store = {
      create: vi.fn(async ({ id, title }: any) => { if (id === "th") throw new Error("thread already exists: th"); return { id, title, created_at: 1, status: "chatting" }; }),
      append: vi.fn(async () => {}),
      read: vi.fn(async () => null),
      setMeta: vi.fn(async () => {}),
      readNdjson: vi.fn(async () => ""),
      list: vi.fn(async () => []),
    };
    const { svc } = makeDeps({ deps: { store } });
    const { threadId } = await svc.startThread("p", "x");
    await svc.waitIdle(threadId);
    expect(threadId).toBe("th-2");
  });

  it("ignores LAUNCH marker when there is no plan entry", async () => {
    const { svc, launch } = makeDeps({ manager: {
      start: vi.fn(async () => ({ sessionId: "s1", turn: { reply: "let me ask", proposedSpecs: undefined } })),
      send: vi.fn(async () => ({ reply: `sure ${LAUNCH_MARKER}`, proposedSpecs: undefined })),
    } });
    await svc.startThread("p", "x");
    await svc.waitIdle();
    await svc.sendMessage("th", "go");
    expect(launch).not.toHaveBeenCalled();
  });

  it("confirm launches, cancels the session, sets meta running, starts narrator", async () => {
    const { svc, launch, manager, store, startNarrator } = makeDeps({ manager: {
      start: vi.fn(async () => ({ sessionId: "s1", turn: { reply: "plan", proposedSpecs: [{ id: "t1", title: "T", type: "feature", file_set: ["a"] }] } })),
    } });
    await svc.startThread("p", "x");
    await svc.waitIdle();
    const r = await svc.confirm("th");
    expect(r).toEqual({ accepted: true });
    expect(launch).toHaveBeenCalled();
    expect(manager.cancel).toHaveBeenCalledWith("s1");
    expect(store.setMeta).toHaveBeenCalledWith("th", expect.objectContaining({ status: "running" }));
    expect(startNarrator).toHaveBeenCalled();
  });
});
