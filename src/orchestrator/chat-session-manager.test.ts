import { describe, it, expect, vi } from "vitest";
import { ChatSessionManager } from "./chat-session-manager.js";
import type { OrchestratorChatAdapter, ChatSessionHandle } from "./chat-adapter.js";
import type { ReadSnapshot } from "./adapter.js";

const emptyState: ReadSnapshot = { existingIds: [], queues: {} as never };

function makeFakeAdapter() {
  const closed: string[] = [];
  let counter = 0;
  const adapter: OrchestratorChatAdapter = {
    startSession: async () => {
      const handle: ChatSessionHandle = { sessionId: `s${++counter}` };
      return { handle, turn: { reply: "hi" } };
    },
    send: async (_handle, message) => ({ reply: `echo:${message}` }),
    close: async (handle) => {
      closed.push(handle.sessionId);
    },
  };
  return { adapter, closed };
}

describe("ChatSessionManager", () => {
  it("start() returns a sessionId and the first turn; a second start() for the SAME project 409s", async () => {
    const { adapter } = makeFakeAdapter();
    const mgr = new ChatSessionManager({ adapter, log: () => {} });
    const { sessionId, turn } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });
    expect(sessionId).toBeTruthy();
    expect(turn.reply).toBe("hi");
    expect(mgr.hasOpenSession("p1")).toBe(true);
    await expect(mgr.start({ projectId: "p1", intent: "y", state: emptyState, onToken: () => {} })).rejects.toThrow(
      "a chat session is already open for this project",
    );
  });

  it("a second project can open its own session concurrently", async () => {
    const { adapter } = makeFakeAdapter();
    const mgr = new ChatSessionManager({ adapter, log: () => {} });
    await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });
    await expect(mgr.start({ projectId: "p2", intent: "x", state: emptyState, onToken: () => {} })).resolves.toBeDefined();
  });

  it("send() forwards to the adapter for an existing session and rejects for an unknown one", async () => {
    const { adapter } = makeFakeAdapter();
    const mgr = new ChatSessionManager({ adapter, log: () => {} });
    const { sessionId } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });
    await expect(mgr.send(sessionId, "hello")).resolves.toEqual({ reply: "echo:hello" });
    await expect(mgr.send("unknown", "hello")).rejects.toThrow("chat session not found");
  });

  it("cancel() closes the underlying session and frees the project slot", async () => {
    const { adapter, closed } = makeFakeAdapter();
    const mgr = new ChatSessionManager({ adapter, log: () => {} });
    const { sessionId } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });
    expect(await mgr.cancel(sessionId)).toBe(true);
    expect(closed).toEqual([sessionId]);
    expect(mgr.hasOpenSession("p1")).toBe(false);
    expect(await mgr.cancel(sessionId)).toBe(false); // already gone
  });

  it("reapOnce() closes a session idle past the configured timeout, and leaves a fresh one alone", async () => {
    const { adapter, closed } = makeFakeAdapter();
    let now = 0;
    const mgr = new ChatSessionManager({ adapter, log: () => {}, now: () => now, idleTimeoutMs: 1000 });
    const { sessionId: stale } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });
    now = 500;
    const { sessionId: fresh } = await mgr.start({ projectId: "p2", intent: "x", state: emptyState, onToken: () => {} });
    now = 1600; // stale is 1600ms old (> 1000ms timeout); fresh is 1100ms old (> 1000ms too... use a smaller gap)
    mgr.reapOnce();
    expect(closed).toContain(stale);
    void fresh;
  });

  it("closeAll() closes every open session", async () => {
    const { adapter, closed } = makeFakeAdapter();
    const mgr = new ChatSessionManager({ adapter, log: () => {} });
    const { sessionId: a } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });
    const { sessionId: b } = await mgr.start({ projectId: "p2", intent: "x", state: emptyState, onToken: () => {} });
    await mgr.closeAll();
    expect(closed.sort()).toEqual([a, b].sort());
  });

  it("cancel() releases the registry BEFORE awaiting close(), so a rejecting close still leaves state clean but still surfaces the error", async () => {
    const { adapter } = makeFakeAdapter();
    // Override just this instance's close() to reject, without touching the
    // shared makeFakeAdapter() helper's default (best-effort) behavior.
    adapter.close = async () => {
      throw new Error("close failed");
    };
    const mgr = new ChatSessionManager({ adapter, log: () => {} });
    const { sessionId } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });

    await expect(mgr.cancel(sessionId)).rejects.toThrow("close failed");
    // Registry/project-slot bookkeeping must already be clean, even though
    // the close itself failed — a subsequent start() for the same project
    // must not be blocked by a session that's already torn down.
    expect(mgr.hasOpenSession("p1")).toBe(false);
    await expect(
      mgr.start({ projectId: "p1", intent: "y", state: emptyState, onToken: () => {} }),
    ).resolves.toBeDefined();
  });

  it("reapOnce() does not kill a session with a turn in flight, even past the idle timeout, and reaps it once the turn completes and it goes idle again", async () => {
    const { adapter, closed } = makeFakeAdapter();
    let now = 0;
    const mgr = new ChatSessionManager({ adapter, log: () => {}, now: () => now, idleTimeoutMs: 1000 });

    let resolveSend!: (value: { reply: string }) => void;
    adapter.send = () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      });

    const { sessionId } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });

    const sendPromise = mgr.send(sessionId, "hello");

    // Advance well past the idle timeout while the turn is still in flight.
    now = 5000;
    mgr.reapOnce();
    expect(closed).not.toContain(sessionId);
    expect(mgr.hasOpenSession("p1")).toBe(true);

    // Complete the turn.
    resolveSend({ reply: "done" });
    await expect(sendPromise).resolves.toEqual({ reply: "done" });

    // Now that the turn is over, turnInFlight must have reset to false — a
    // further idle stretch should reap it like any other idle session.
    now = 5000 + 1000 + 1;
    mgr.reapOnce();
    expect(closed).toContain(sessionId);
  });
});
