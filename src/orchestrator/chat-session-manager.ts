import type { OrchestratorChatAdapter, ChatSessionHandle, ChatTurnResult } from "./chat-adapter.js";
import type { ReadSnapshot } from "./adapter.js";
import type { Logger } from "../util/log.js";

/** Default idle timeout before the reaper kills an abandoned session
 *  (operator closed the tab without cancelling). Chosen at plan time — not a
 *  product decision (see spec §7's open question). */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** How often the reaper sweeps for idle sessions. */
const REAP_INTERVAL_MS = 60 * 1000;
/** How long the opening chat turn (adapter.startSession()) may take before
 *  start() gives up and releases the project slot. A hung/stalled spawn
 *  (network hang, an interactive prompt that never gets answered, etc.)
 *  would otherwise permanently lock the project's chat slot -- before this
 *  point, no ManagedSession exists yet for the idle reaper or cancel route
 *  to reach. Generous (opus can genuinely take a while composing a first
 *  reply), but bounded -- not a product decision, a reasonable default. */
const START_TIMEOUT_MS = 3 * 60 * 1000;

/** Minimal shape of the SSE response the manager writes to — matches
 *  `node:http`'s `ServerResponse` surface without importing it here. */
export interface ChatStreamSink {
  write(chunk: string): void;
  end(): void;
}

interface ManagedSession {
  projectId: string;
  handle: ChatSessionHandle;
  lastActivityAt: number;
  sseRes: ChatStreamSink | null;
  /** True while a `send()` turn is awaiting the adapter (the model is
   *  actively working). The reaper must never kill a session while this is
   *  true — the idle clock only applies when the session is waiting on the
   *  OPERATOR, not busy waiting on the model. */
  turnInFlight: boolean;
}

export interface ChatSessionManagerDeps {
  adapter: OrchestratorChatAdapter;
  log: Logger;
  now?: () => number;
  idleTimeoutMs?: number;
}

/**
 * Owns every live pre-launch chat session for a project's daemon process:
 * one active session per project (mirrors the existing `orchestrateInFlight`
 * single-flight guard in `api/server.ts`), an idle-timeout reaper for
 * abandoned sessions, and `closeAll()` for daemon shutdown (mirrors
 * `ApiServerHandle.close()`'s WS-client teardown — no chat process may
 * outlive the server).
 */
export class ChatSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly projectsInFlight = new Set<string>();
  private readonly adapter: OrchestratorChatAdapter;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private reaper: ReturnType<typeof setInterval> | undefined;
  /** Set at the START of `closeAll()`, before awaiting anything. Guards
   *  against a `start()` call whose `adapter.startSession()` is still in
   *  flight when shutdown runs: that session isn't in `this.sessions` yet,
   *  so `closeAll()`'s sweep can't close it -- without this flag it would be
   *  registered AFTER shutdown completed and leak forever (see codex
   *  finding). `start()` checks this right after `startSession()` resolves
   *  and closes (rather than registers) the session if shutdown has begun. */
  private closed = false;

  constructor(deps: ChatSessionManagerDeps) {
    this.adapter = deps.adapter;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /** Starts the periodic reaper. Call once at daemon startup — NOT from the
   *  constructor, so tests can drive `reapOnce()` deterministically instead. */
  startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => this.reapOnce(), REAP_INTERVAL_MS);
    this.reaper.unref?.();
  }

  /** One reap sweep: close every session idle past `idleTimeoutMs`. Exposed
   *  publicly so tests can invoke it directly instead of waiting on a timer. */
  reapOnce(): void {
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const [id, s] of this.sessions) {
      if (s.turnInFlight) continue; // mid-turn: busy waiting on the model, never idle-reaped
      if (s.lastActivityAt < cutoff) {
        this.log("WARN", `chat: reaping idle session '${id}' for project '${s.projectId}'`);
        void this.forceClose(id);
      }
    }
  }

  hasOpenSession(projectId: string): boolean {
    return this.projectsInFlight.has(projectId);
  }

  /** Read-only existence check -- does NOT close/mutate anything (unlike
   *  cancel()). Used by callers that must verify a session is still live
   *  BEFORE taking an action gated on it (e.g. confirming a launch). */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Read-only: is a turn currently in flight for this session? Used to gate
   *  actions (like confirming a launch) that must not race a live turn. */
  isTurnInFlight(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.turnInFlight ?? false;
  }

  async start(input: {
    projectId: string;
    intent: string;
    state: ReadSnapshot;
    onToken: (text: string) => void;
    /** Optional SSE sink to attach at session-creation time (rather than via
     *  a later `attachStream()` call) so the OPENING turn's tokens can also
     *  stream, not just later turns. Omitted by existing callers -> `null`,
     *  byte-identical to prior behavior. */
    sink?: ChatStreamSink;
  }): Promise<{ sessionId: string; turn: ChatTurnResult }> {
    if (this.projectsInFlight.has(input.projectId)) {
      throw new Error("a chat session is already open for this project");
    }
    this.projectsInFlight.add(input.projectId);
    // The real sessionId isn't known until adapter.startSession() resolves, but
    // `ClaudeChatProcess` binds its onToken callback ONCE at construction and
    // reuses it for the whole session's lifetime (every later send() call, not
    // just this opening turn) -- so this closure must look up the CURRENTLY
    // attached SSE sink fresh on every token, not capture one at start() time.
    // Before liveSessionId is assigned (i.e. during THIS opening turn), there is
    // by definition no ManagedSession/sseRes to look up yet -- but the model
    // streams the opening reply DURING this very await, so dropping those
    // tokens would mean dead air for the whole first turn. `input.sink`, if the
    // caller passed one, is the fallback target for exactly this pre-
    // registration window; once `liveSessionId` is set, the live session's
    // (possibly later-reattached) `sseRes` always takes priority over it.
    let liveSessionId: string | null = null;
    const forwardToken = (text: string): void => {
      input.onToken(text);
      const live = liveSessionId ? this.sessions.get(liveSessionId)?.sseRes : null;
      const target = live ?? input.sink ?? null;
      if (!target) return;
      try {
        target.write(JSON.stringify({ type: "token", text }));
      } catch {
        /* best-effort: a misbehaving sink must never crash mid-stream token delivery */
      }
    };
    const startPromise = this.adapter.startSession({
      intent: input.intent,
      state: input.state,
      onToken: forwardToken,
    });
    // Set synchronously by the timeout's own callback, BEFORE it rejects --
    // this is what lets the `catch` block below tell, unambiguously, whether
    // the race was lost to the timeout (in which case `startPromise` is
    // guaranteed still pending, since a settled promise would have already
    // won the race) or to a genuine `startSession()` rejection (nothing to
    // clean up). Deliberately NOT implemented as a `.then()` attached to
    // `startPromise` up front and raced separately -- that would create a
    // second, independent reaction on the same promise whose firing order
    // relative to the `await Promise.race(...)` below is not something to
    // depend on. Attaching the late-cleanup listener only HERE, only after
    // we've confirmed via this flag that the timeout won, sidesteps that
    // ordering question entirely: there is no earlier queued reaction of
    // ours on `startPromise` to race against.
    let timedOut = false;
    // Captured so it can be cleared once the race settles (see the `finally`
    // below) -- otherwise a SUCCESSFUL start leaves this 3-minute timer
    // referenced and alive, keeping the event loop running long after the
    // session (or the whole server) has already been torn down. `.unref?.()`
    // is defense-in-depth, matching the reaper's pattern below: even if a
    // future edit somehow skips the `finally`'s `clearTimeout`, this timer
    // alone must never be the thing keeping the process alive.
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(new Error(`chat failed to start within ${START_TIMEOUT_MS}ms`));
      }, START_TIMEOUT_MS);
      timeoutHandle.unref?.();
    });
    try {
      const { handle, turn } = await Promise.race([startPromise, timeoutPromise]);
      if (this.closed) {
        // Shutdown ran while this opening turn was in flight -- `closeAll()`
        // had nothing to close (this session wasn't registered yet). Close
        // it now instead of registering it, and throw so the caller (an
        // in-flight HTTP request) gets a clear failure rather than a
        // silently-registered-then-orphaned session. Falls through to the
        // `catch` below for the shared `projectsInFlight` cleanup.
        try {
          await this.adapter.close(handle);
        } catch {
          /* best-effort -- the daemon is shutting down regardless */
        }
        throw new Error("chat session manager is shutting down");
      }
      liveSessionId = handle.sessionId;
      this.sessions.set(handle.sessionId, {
        projectId: input.projectId,
        handle,
        lastActivityAt: this.now(),
        sseRes: input.sink ?? null,
        turnInFlight: false,
      });
      return { sessionId: handle.sessionId, turn };
    } catch (err) {
      this.projectsInFlight.delete(input.projectId);
      if (timedOut) {
        // The timeout won the race, so the real `adapter.startSession()`
        // call is still out there and may eventually settle. Nothing else
        // can ever reach it (it was never registered in `this.sessions`),
        // so if it resolves, close the now-orphaned process instead of
        // leaking it; if it rejects, there's nothing to close.
        startPromise.then(
          ({ handle }) => {
            void this.adapter.close(handle).catch(() => {
              /* best-effort cleanup of an abandoned/late session */
            });
          },
          () => {
            /* startSession() itself eventually failed too -- nothing to close */
          },
        );
      }
      throw err;
    } finally {
      // Runs on every exit path (normal return, the `this.closed`
      // shutdown-throw, a genuine `startSession()` rejection, AND the
      // timeout-reject itself) -- the race has settled by this point in all
      // of them, so the timer is pointless either way. `clearTimeout` on an
      // already-fired or already-cleared timer is a documented safe no-op.
      clearTimeout(timeoutHandle);
    }
  }

  async send(sessionId: string, message: string): Promise<ChatTurnResult> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("chat session not found");
    // Guard FIRST, before touching any shared state: a second concurrent
    // send() for the same session must be rejected outright, not raced.
    // `ClaudeChatProcess.send()` (one layer down) already enforces exactly
    // one turn in flight per session and rejects a second call almost
    // immediately — if we let both calls set turnInFlight = true and rely on
    // their `finally` blocks, the SECOND call's finally can run first and
    // clear turnInFlight while the FIRST call's real turn is still active,
    // letting the reaper kill a genuinely busy session (see codex finding).
    if (s.turnInFlight) {
      throw new Error("a turn is already in flight for this chat session");
    }
    s.lastActivityAt = this.now();
    s.turnInFlight = true;
    try {
      return await this.adapter.send(s.handle, message);
    } finally {
      s.turnInFlight = false;
      s.lastActivityAt = this.now();
    }
  }

  /** Attach (or replace) the SSE sink for a session — a browser reconnect
   *  simply replaces the previous sink; the old one is ended so it isn't
   *  double-written. Returns false if the session doesn't exist. */
  attachStream(sessionId: string, res: ChatStreamSink): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    try {
      s.sseRes?.end();
    } catch {
      /* best-effort: a misbehaving OLD sink (e.g. .end() on an already-reset
       * HTTP response during a browser reconnect) must never block the NEW
       * sink from being attached. */
    }
    s.sseRes = res;
    return true;
  }

  /** Detach a session's SSE sink -- but ONLY if `sink` is STILL the currently
   *  attached one for that session. This guards against a stale disconnect
   *  event racing a newer reconnect: if the client reconnected (a fresh
   *  `attachStream()` call already replaced the sink) before this session's
   *  OLD connection's 'close' event fires, that stale event must not clobber
   *  the NEW live sink. Does NOT call `sink.end()` -- this fires in response
   *  to the connection ALREADY being gone (client closed it, or it dropped),
   *  not a proactive close; teardown elsewhere (`release()`/`forceClose()`)
   *  already owns ending a still-live sink. Returns true if it actually
   *  detached something. */
  detachStream(sessionId: string, sink: ChatStreamSink): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.sseRes !== sink) return false;
    s.sseRes = null;
    return true;
  }

  /** Removes a session from the registry and frees its project slot. Takes
   *  the already-looked-up `ManagedSession` so callers don't re-query the
   *  map. Callers release BEFORE awaiting `adapter.close()` (not after) so
   *  the registry is never held hostage by a slow or failing close, and so
   *  a concurrent second teardown (reaper tick, another `cancel()`) can no
   *  longer find the session and double-close the same handle. */
  private release(sessionId: string, s: ManagedSession): void {
    this.sessions.delete(sessionId);
    this.projectsInFlight.delete(s.projectId);
    try {
      s.sseRes?.end();
    } catch {
      /* best-effort: a misbehaving sink (e.g. .end() on an already-reset
       * HTTP response) must never block registry cleanup or the caller's
       * subsequent adapter.close(). */
    }
  }

  /** Cancel: close the underlying process; nothing was ever enqueued.
   *  Registry state is released before the close is awaited, so a failed
   *  close still leaves the manager's bookkeeping clean — but the failure
   *  itself still propagates to the caller (an explicit operator action,
   *  unlike the reaper's best-effort `forceClose()`). */
  async cancel(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    this.release(sessionId, s);
    await this.adapter.close(s.handle);
    return true;
  }

  private async forceClose(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.release(sessionId, s);
    try {
      await this.adapter.close(s.handle);
    } catch {
      /* best-effort reap */
    }
  }

  /** Kill every live session — called on daemon shutdown. Sets `closed`
   *  BEFORE awaiting anything so a `start()` call whose `startSession()`
   *  resolves after this point closes its session instead of leaking it
   *  (see the `closed` field's doc comment). */
  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.reaper) clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map((id) => this.forceClose(id)));
  }
}
