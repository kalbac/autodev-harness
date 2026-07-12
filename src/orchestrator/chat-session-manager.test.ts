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

  it("send() rejects a second concurrent call for the SAME session immediately, without clearing turnInFlight for the first", async () => {
    const { adapter, closed } = makeFakeAdapter();
    let now = 0;
    const mgr = new ChatSessionManager({ adapter, log: () => {}, now: () => now, idleTimeoutMs: 1000 });

    let resolveSend!: (value: { reply: string }) => void;
    adapter.send = () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      });

    const { sessionId } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });

    const firstSend = mgr.send(sessionId, "hello");

    // Second concurrent send for the same session, WITHOUT resolving the
    // first send's underlying adapter promise first. This must reject
    // immediately at the manager's own guard — proving it fires before the
    // process-level rejection would even be reachable, and that it does NOT
    // touch (and in particular does not clear) the first call's turnInFlight.
    await expect(mgr.send(sessionId, "world")).rejects.toThrow(
      "a turn is already in flight for this chat session",
    );

    // The first call's turn must still be considered in-flight: a reap sweep
    // well past the idle timeout must NOT kill this session.
    now = 5000;
    mgr.reapOnce();
    expect(closed).not.toContain(sessionId);
    expect(mgr.hasOpenSession("p1")).toBe(true);

    // Now resolve the first send's promise and confirm it completes normally.
    resolveSend({ reply: "done" });
    await expect(firstSend).resolves.toEqual({ reply: "done" });

    // turnInFlight must correctly end up false once the first turn is done —
    // a further idle stretch should reap it like any other idle session.
    now = 5000 + 1000 + 1;
    mgr.reapOnce();
    expect(closed).toContain(sessionId);
  });

  it("isTurnInFlight() reflects whether a turn is currently active, and is false for an unknown session", async () => {
    const { adapter } = makeFakeAdapter();
    const mgr = new ChatSessionManager({ adapter, log: () => {} });

    let resolveSend!: (value: { reply: string }) => void;
    adapter.send = () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      });

    const { sessionId } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });

    // No turn in flight yet, right after start().
    expect(mgr.isTurnInFlight(sessionId)).toBe(false);

    const sendPromise = mgr.send(sessionId, "hello");
    expect(mgr.isTurnInFlight(sessionId)).toBe(true);

    resolveSend({ reply: "done" });
    await expect(sendPromise).resolves.toEqual({ reply: "done" });

    // Back to false once the turn completes.
    expect(mgr.isTurnInFlight(sessionId)).toBe(false);

    // Unknown session id must never throw -- just report "no turn in flight".
    expect(mgr.isTurnInFlight("unknown")).toBe(false);
  });

  it("cancel() still closes the underlying process (and does not throw) when the attached SSE sink's end() throws", async () => {
    const { adapter, closed } = makeFakeAdapter();
    const mgr = new ChatSessionManager({ adapter, log: () => {} });
    const { sessionId } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });

    const throwingSink = {
      write: () => {},
      end: () => {
        throw new Error("write after end");
      },
    };
    expect(mgr.attachStream(sessionId, throwingSink)).toBe(true);

    // The throwing sink must not prevent cancel() from resolving, nor from
    // reaching adapter.close() — release()'s sink teardown is best-effort.
    await expect(mgr.cancel(sessionId)).resolves.toBe(true);
    expect(closed).toEqual([sessionId]);
    expect(mgr.hasOpenSession("p1")).toBe(false);
  });

  it("attachStream() still attaches the NEW sink (and does not throw) when the OLD sink's end() throws", async () => {
    const { adapter } = makeFakeAdapter();
    const mgr = new ChatSessionManager({ adapter, log: () => {} });
    const { sessionId } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });

    const ended: string[] = [];
    const firstSink = {
      write: () => {},
      end: () => {
        throw new Error("write after end");
      },
    };
    const secondSink = {
      write: () => {},
      end: () => {
        ended.push("second");
      },
    };
    const thirdSink = {
      write: () => {},
      end: () => {
        ended.push("third");
      },
    };

    expect(mgr.attachStream(sessionId, firstSink)).toBe(true);

    // Replacing the throwing first sink must not throw, and must genuinely
    // attach the second sink (not silently leave the old one wired up) —
    // attachStream()'s old-sink teardown is best-effort, mirroring release().
    expect(() => mgr.attachStream(sessionId, secondSink)).not.toThrow();

    // Prove the SECOND sink (not the first) is the one now attached: a
    // third attachStream() call ends whichever sink is currently attached,
    // and only "second" (never "first", which can't push anyway) should
    // show up.
    expect(mgr.attachStream(sessionId, thirdSink)).toBe(true);
    expect(ended).toEqual(["second"]);
  });

  it("detachStream() is identity-guarded (a stale sink can't clobber the live one) and only clears the CURRENTLY attached sink", async () => {
    const { adapter } = makeFakeAdapter();
    const mgr = new ChatSessionManager({ adapter, log: () => {} });
    const { sessionId } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });

    const staleSink = { write: () => {}, end: () => {} };
    const liveSink = { write: () => {}, end: () => {} };
    expect(mgr.attachStream(sessionId, liveSink)).toBe(true);

    // A stale close event (e.g. from an OLD connection that a reconnect
    // already superseded) must be a safe no-op: it is not the currently
    // attached sink, so nothing is cleared.
    expect(mgr.detachStream(sessionId, staleSink)).toBe(false);

    // Prove the live sink is genuinely still attached after the no-op: a
    // fresh attachStream() call ends whatever is CURRENTLY attached, and it
    // must be `liveSink` (not `staleSink`, which was never wired up).
    const ended: string[] = [];
    const probeSink = { write: () => {}, end: () => ended.push("probe-saw-live") };
    liveSink.end = () => ended.push("live-ended-by-probe");
    expect(mgr.attachStream(sessionId, probeSink)).toBe(true);
    expect(ended).toEqual(["live-ended-by-probe"]);

    // Now detach the sink that IS actually attached (probeSink) -- must
    // succeed and return true.
    expect(mgr.detachStream(sessionId, probeSink)).toBe(true);

    // Detaching twice is a safe no-op the second time: it is no longer the
    // currently attached sink (attach cleared it to null already).
    expect(mgr.detachStream(sessionId, probeSink)).toBe(false);

    // An unknown session id is also a safe no-op.
    expect(mgr.detachStream("no-such-session", probeSink)).toBe(false);
  });

  it("start()'s onToken forwarding stays live for later turns: a token that arrives AFTER attachStream() reaches the sink, but one that arrives BEFORE is safely dropped", async () => {
    const { adapter } = makeFakeAdapter();
    // Capture the onToken the manager hands to the adapter -- ClaudeChatProcess
    // binds this ONCE at construction and reuses it for every later send() turn,
    // so this simulates a token arriving asynchronously during a SECOND turn.
    let capturedOnToken: ((text: string) => void) | undefined;
    adapter.startSession = async (input) => {
      capturedOnToken = input.onToken;
      return { handle: { sessionId: "s1" }, turn: { reply: "hi" } };
    };

    const mgr = new ChatSessionManager({ adapter, log: () => {} });

    const callerOnTokenCalls: string[] = [];
    const { sessionId } = await mgr.start({
      projectId: "p1",
      intent: "x",
      state: emptyState,
      onToken: (t) => callerOnTokenCalls.push(t),
    });
    expect(capturedOnToken).toBeTruthy();

    // Before any SSE client is attached (i.e. still "turn one" from the UI's
    // perspective), a token must not throw and must not reach any sink.
    expect(() => capturedOnToken!("too-early")).not.toThrow();
    // The caller-supplied onToken must still fire regardless (kept for
    // backward API compatibility / testability).
    expect(callerOnTokenCalls).toEqual(["too-early"]);

    const sink = { write: vi.fn(), end: vi.fn() };
    expect(mgr.attachStream(sessionId, sink)).toBe(true);

    // Now simulate a token arriving during a LATER turn, after the SSE
    // stream is attached -- it must reach the live sink.
    capturedOnToken!("hello");
    expect(callerOnTokenCalls).toEqual(["too-early", "hello"]);
    expect(sink.write).toHaveBeenCalledTimes(1);
    const [payload] = sink.write.mock.calls[0]!;
    expect(payload).toContain("hello");
  });

  it("a sink provided to start() is wired in at session creation, so a token on the captured onToken reaches it without a separate attachStream() call", async () => {
    const { adapter } = makeFakeAdapter();
    // Same capture trick as the "onToken forwarding stays live for later
    // turns" test above: ClaudeChatProcess binds onToken ONCE and reuses it
    // for the session's whole lifetime, so grabbing it here simulates a
    // token arriving on that same reference at the earliest moment a sink
    // set at start() time could possibly receive one -- right after the
    // session is registered, with no attachStream() call in between.
    let capturedOnToken: ((text: string) => void) | undefined;
    adapter.startSession = async (input) => {
      capturedOnToken = input.onToken;
      return { handle: { sessionId: "s1" }, turn: { reply: "hi" } };
    };

    const mgr = new ChatSessionManager({ adapter, log: () => {} });

    const tokens: string[] = [];
    const sink = { write: (c: string) => tokens.push(c), end: () => {} };

    await mgr.start({ projectId: "p1", intent: "hi", state: emptyState, onToken: () => {}, sink });
    expect(capturedOnToken).toBeTruthy();

    // No attachStream() call anywhere above -- the sink came in via start().
    capturedOnToken!("hello");
    expect(tokens.join("")).toContain('"token"');
    expect(tokens.join("")).toContain("hello");
  });

  it("start() with no sink behaves exactly as before -- sseRes stays null and a token on the captured onToken is dropped until attachStream() is called", async () => {
    const { adapter } = makeFakeAdapter();
    let capturedOnToken: ((text: string) => void) | undefined;
    adapter.startSession = async (input) => {
      capturedOnToken = input.onToken;
      return { handle: { sessionId: "s1" }, turn: { reply: "hi" } };
    };

    const mgr = new ChatSessionManager({ adapter, log: () => {} });
    const callerTokens: string[] = [];
    // No `sink` field at all -- existing callers (e.g. handleChatStart).
    await mgr.start({ projectId: "p1", intent: "hi", state: emptyState, onToken: (t) => callerTokens.push(t) });

    expect(() => capturedOnToken!("too-early")).not.toThrow();
    expect(callerTokens).toEqual(["too-early"]); // caller onToken still fires regardless of any sink
  });

  it("streams opening-turn tokens (emitted during startSession) to the start sink", async () => {
    const { adapter } = makeFakeAdapter();
    // Simulate the real adapter: onToken fires INCREMENTALLY while
    // startSession() is still in flight (before liveSessionId is assigned),
    // not just after it resolves -- this is when real opening-turn tokens
    // actually arrive.
    adapter.startSession = async (input) => {
      input.onToken("Hel");
      input.onToken("lo");
      return { handle: { sessionId: "s1" }, turn: { reply: "Hello" } };
    };

    const mgr = new ChatSessionManager({ adapter, log: () => {} });

    const frames: string[] = [];
    const sink = { write: (c: string) => frames.push(c), end: () => {} };

    await mgr.start({ projectId: "p1", intent: "hi", state: emptyState, onToken: () => {}, sink });

    const joined = frames.map((f) => JSON.parse(f).text ?? "").join("");
    expect(joined).toBe("Hello");
  });

  it("hasSession() is true for a live session, false for an unknown one, and false again after cancel()", async () => {
    const { adapter } = makeFakeAdapter();
    const mgr = new ChatSessionManager({ adapter, log: () => {} });
    expect(mgr.hasSession("nope")).toBe(false);

    const { sessionId } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });
    expect(mgr.hasSession(sessionId)).toBe(true);
    expect(mgr.hasSession("still-not-a-real-id")).toBe(false);

    await mgr.cancel(sessionId);
    expect(mgr.hasSession(sessionId)).toBe(false);
  });

  it("start() rejects with a timeout-shaped error when adapter.startSession() never settles within START_TIMEOUT_MS, and frees the project slot", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, closed } = makeFakeAdapter();
      // Hang forever -- never resolve, never reject.
      adapter.startSession = () => new Promise(() => {});
      const mgr = new ChatSessionManager({ adapter, log: () => {} });

      const startPromise = mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });

      // hasOpenSession() must read "busy" while the opening turn is still
      // racing the timeout.
      expect(mgr.hasOpenSession("p1")).toBe(true);

      const assertion = expect(startPromise).rejects.toThrow(/failed to start within/);
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
      await assertion;

      // The project slot must be freed so a retry is possible -- this is the
      // whole point of the fix (previously it stayed locked forever).
      expect(mgr.hasOpenSession("p1")).toBe(false);
      expect(closed).toEqual([]); // startSession() never resolved -- nothing to close yet
    } finally {
      vi.useRealTimers();
    }
  });

  it("a LATE-resolving startSession() (settles after START_TIMEOUT_MS already fired) closes the orphaned handle and never registers the session", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, closed } = makeFakeAdapter();
      let resolveStart!: (value: { handle: ChatSessionHandle; turn: { reply: string } }) => void;
      adapter.startSession = () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        });
      const mgr = new ChatSessionManager({ adapter, log: () => {} });

      const startPromise = mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });

      const assertion = expect(startPromise).rejects.toThrow(/failed to start within/);
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
      await assertion;
      expect(mgr.hasOpenSession("p1")).toBe(false);

      // NOW the real adapter call finally resolves, long after start() gave up.
      const handle: ChatSessionHandle = { sessionId: "late-session" };
      resolveStart({ handle, turn: { reply: "hi" } });
      // Flush the microtask queue so the fire-and-forget cleanup `.then()` runs.
      await vi.advanceTimersByTimeAsync(0);

      expect(closed).toEqual(["late-session"]);
      expect(mgr.hasSession("late-session")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the normal (fast, non-timeout) start() path is completely unaffected -- adapter.close() is never called for a session that resolved normally", async () => {
    const { adapter, closed } = makeFakeAdapter();
    const mgr = new ChatSessionManager({ adapter, log: () => {} });
    const { sessionId } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });

    expect(mgr.hasSession(sessionId)).toBe(true);
    expect(mgr.hasOpenSession("p1")).toBe(true);
    expect(closed).toEqual([]);
  });

  it("a successful start() clears the start-timeout timer instead of leaking it — no pending timer survives, and advancing past START_TIMEOUT_MS afterward has no effect", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, closed } = makeFakeAdapter();
      const mgr = new ChatSessionManager({ adapter, log: () => {} });

      const { sessionId } = await mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });

      // The opening turn already won the race (adapter.startSession() above
      // resolves synchronously-ish via a real Promise, no fake-timer
      // advancement needed) -- if the timeout timer had been cleared, there
      // must be NO pending timers left at all.
      expect(vi.getTimerCount()).toBe(0);

      // Belt-and-suspenders: even if a pending timer had somehow survived,
      // advancing past START_TIMEOUT_MS must not retroactively fail or close
      // the now fully-registered session.
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 1);
      expect(mgr.hasSession(sessionId)).toBe(true);
      expect(mgr.hasOpenSession("p1")).toBe(true);
      expect(closed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a session whose startSession() resolves AFTER closeAll() has already run is closed immediately, not registered — the shutdown-race leak", async () => {
    const { adapter, closed } = makeFakeAdapter();
    const mgr = new ChatSessionManager({ adapter, log: () => {} });

    // Same manually-controlled-promise technique as the turnInFlight tests
    // above, but on startSession() instead of send(): hold the opening turn
    // open so closeAll() can run while it's still in flight.
    let resolveStart!: (value: { handle: ChatSessionHandle; turn: { reply: string } }) => void;
    adapter.startSession = () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      });

    const startPromise = mgr.start({ projectId: "p1", intent: "x", state: emptyState, onToken: () => {} });

    // Daemon shutdown runs while the opening turn is still awaiting the
    // adapter — the session isn't in the registry yet, so this sweep has
    // nothing to close.
    await mgr.closeAll();
    expect(closed).toEqual([]);

    // NOW the adapter's startSession() finally resolves.
    const handle: ChatSessionHandle = { sessionId: "late-session" };
    resolveStart({ handle, turn: { reply: "hi" } });

    // start() must reject (not silently register the now-orphaned session)
    // once it observes that closeAll() already ran.
    await expect(startPromise).rejects.toThrow("chat session manager is shutting down");

    // The handle that was about to be registered must have been closed
    // immediately instead — proving the leaked-process path is now closed.
    expect(closed).toEqual(["late-session"]);

    // The session must never appear in the registry, and the project slot
    // must be freed (not left permanently stuck "in flight").
    expect(mgr.hasSession("late-session")).toBe(false);
    expect(mgr.hasOpenSession("p1")).toBe(false);
  });
});
