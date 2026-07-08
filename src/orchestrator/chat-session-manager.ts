import type { OrchestratorChatAdapter, ChatSessionHandle, ChatTurnResult } from "./chat-adapter.js";
import type { ReadSnapshot } from "./adapter.js";
import type { Logger } from "../util/log.js";

/** Default idle timeout before the reaper kills an abandoned session
 *  (operator closed the tab without cancelling). Chosen at plan time — not a
 *  product decision (see spec §7's open question). */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** How often the reaper sweeps for idle sessions. */
const REAP_INTERVAL_MS = 60 * 1000;

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

  async start(input: {
    projectId: string;
    intent: string;
    state: ReadSnapshot;
    onToken: (text: string) => void;
  }): Promise<{ sessionId: string; turn: ChatTurnResult }> {
    if (this.projectsInFlight.has(input.projectId)) {
      throw new Error("a chat session is already open for this project");
    }
    this.projectsInFlight.add(input.projectId);
    try {
      const { handle, turn } = await this.adapter.startSession({
        intent: input.intent,
        state: input.state,
        onToken: input.onToken,
      });
      this.sessions.set(handle.sessionId, {
        projectId: input.projectId,
        handle,
        lastActivityAt: this.now(),
        sseRes: null,
        turnInFlight: false,
      });
      return { sessionId: handle.sessionId, turn };
    } catch (err) {
      this.projectsInFlight.delete(input.projectId);
      throw err;
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
    if (s.sseRes) s.sseRes.end();
    s.sseRes = res;
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
    s.sseRes?.end();
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

  /** Kill every live session — called on daemon shutdown. */
  async closeAll(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map((id) => this.forceClose(id)));
  }
}
