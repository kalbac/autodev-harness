import type { ThreadStore } from "../thread/thread-store.js";
import type { ThreadEventBus } from "../api/thread-events.js";
import type { ThreadEntryInput } from "../thread/thread-types.js";
import type { ChatSessionManager, ChatStreamSink } from "./chat-session-manager.js";
import type { ReadSnapshot } from "./adapter.js";
import type { LaunchResult } from "./launch.js";
import { stripFencedJson, StreamingFenceStripper } from "../thread/strip-fenced-json.js";
import { containsLaunchMarker, stripLaunchMarker } from "../thread/launch-marker.js";
import { toPlanPreview } from "../thread/plan-preview.js";
import type { TaskSpec } from "./task-spec.js";

/**
 * Pre-launch bridge between the orchestrator chat machinery
 * (`ChatSessionManager`) and the persisted `ThreadStore`. It owns one chat
 * session per thread, mirrors every turn into the thread (streaming tokens
 * through a fence-stripper to the thread event bus; persisting the stripped
 * `orchestrator_msg` + a `plan` preview), and drives the two launch paths
 * (Confirm button + launch-by-word) through the injected `launch` fn.
 *
 * The HTTP layer only ever addresses THREADS: this service holds the
 * `threadId -> {projectId, sessionId}` map so the session id never leaks past
 * it. On confirm it releases the chat session, flips thread meta to running,
 * and hands off to a narrator via `startNarrator` -- it does NOT write a
 * `run_link` (onOrchestrate is fire-and-forget and mints the runId later; the
 * narrator discovers it asynchronously).
 */

export interface ThreadChatServiceDeps {
  store: ThreadStore;
  bus: ThreadEventBus;
  manager: ChatSessionManager;
  buildSnapshot: () => Promise<ReadSnapshot>;
  launch: (pid: string, intent: string) => Promise<LaunchResult>;
  startNarrator: (a: { projectId: string; threadId: string; finalIntent: string; launchedAt: number }) => void;
  /** Inject; default in composition = slugifyIntent. Mints a path-safe base id. */
  mintThreadId: (intent: string) => string;
  log: (level: "INFO" | "WARN" | "ERROR", msg: string) => void;
  now: () => number;
}

interface TurnResult {
  reply: string;
  proposedSpecs?: TaskSpec[];
}

export class ThreadChatService {
  private readonly d: ThreadChatServiceDeps;
  /** threadId -> the chat session backing its pre-launch conversation. */
  private readonly threadSessions = new Map<string, { projectId: string; sessionId: string }>();
  /** In-flight background opening/message turns, keyed by threadId (for waitIdle). */
  private readonly pending = new Map<string, Promise<void>>();
  /** The CURRENT turn's stripper for a thread; the sink looks this up fresh per
   *  token (never captures it) -- avoids the `[chat/onToken-bound-once]` trap. */
  private readonly turnStrippers = new Map<string, StreamingFenceStripper>();
  /** Ids this process created -- the only source of truth for dedupe. We do NOT
   *  consult store.read() for "taken" (a just-created thread with empty entries
   *  still reads back as a valid thread, which would look taken forever). */
  private readonly createdIds = new Set<string>();

  constructor(deps: ThreadChatServiceDeps) {
    this.d = deps;
  }

  /** Persist an entry then broadcast its input shape live. Best-effort:
   *  store.append never throws, and the broadcast is guarded by the bus. */
  private async persist(threadId: string, entry: ThreadEntryInput): Promise<void> {
    await this.d.store.append(threadId, entry);
    try {
      this.d.bus.broadcast(threadId, JSON.stringify({ ...entry }));
    } catch {
      /* best-effort live fan-out: a serialization/bus hiccup must not break persistence */
    }
  }

  /** SSE-shaped sink handed to the chat manager for a thread. Every token frame
   *  is JSON.parse'd, its text pushed through the thread's CURRENT stripper
   *  (looked up fresh per token via the map -- so a new turn's stripper is
   *  always used), and any emitted prose broadcast as a token frame. `end()` is
   *  a noop: the bus subscription outlives the chat session so the narrator can
   *  keep publishing to the same thread stream after launch. */
  private makeSink(threadId: string): ChatStreamSink {
    return {
      write: (frame: string): void => {
        try {
          const parsed = JSON.parse(frame) as { type?: string; text?: string };
          if (parsed.type !== "token") return;
          const stripper = this.turnStrippers.get(threadId);
          if (!stripper) return;
          const emitted = stripper.push(String(parsed.text ?? ""));
          if (emitted.length > 0) {
            this.d.bus.broadcast(threadId, JSON.stringify({ type: "token", text: emitted }));
          }
        } catch {
          /* never throw back into the manager's token loop */
        }
      },
      end: (): void => {
        /* noop -- the thread stream outlives the chat session (narrator continues it) */
      },
    };
  }

  /** One turn's lifecycle: fresh stripper -> produce the turn -> finalize the
   *  stripper -> persist stripped prose (+ plan preview if any). */
  private async runTurn(threadId: string, produce: () => Promise<TurnResult>): Promise<TurnResult> {
    this.turnStrippers.set(threadId, new StreamingFenceStripper());
    try {
      const turn = await produce();
      try { this.turnStrippers.get(threadId)?.end(); } catch { /* stripper finalize best-effort */ }
      this.turnStrippers.delete(threadId);

      let text = stripFencedJson(turn.reply);
      text = stripLaunchMarker(text);
      await this.persist(threadId, { type: "orchestrator_msg", text });

      if (turn.proposedSpecs?.length) {
        await this.persist(threadId, { type: "plan", specs: toPlanPreview(turn.proposedSpecs) });
      }
      return turn;
    } finally {
      this.turnStrippers.delete(threadId);
    }
  }

  /** Dedupe against ids WE created this process (not store.read -- see
   *  createdIds doc). base -> base-2 -> base-3 ... capped so a pathological
   *  collision can never loop forever. */
  private uniqueId(intent: string): string {
    const base = this.d.mintThreadId(intent);
    if (!this.createdIds.has(base)) return base;
    for (let i = 2; i <= 50; i++) {
      const candidate = `${base}-${i}`;
      if (!this.createdIds.has(candidate)) return candidate;
    }
    return base;
  }

  /** Start a thread + its chat session. Returns fast: the opening chat turn is
   *  kicked in the BACKGROUND (awaitable via waitIdle). */
  async startThread(projectId: string, intent: string): Promise<{ threadId: string }> {
    const threadId = this.uniqueId(intent);
    await this.d.store.create({ id: threadId, title: intent.slice(0, 80) });
    this.createdIds.add(threadId);
    await this.persist(threadId, { type: "operator_msg", text: intent });

    const sink = this.makeSink(threadId);
    const p = (async () => {
      try {
        await this.runTurn(threadId, async () => {
          const state = await this.d.buildSnapshot();
          const { sessionId, turn } = await this.d.manager.start({
            projectId,
            intent,
            state,
            onToken: () => {},
            sink,
          });
          this.threadSessions.set(threadId, { projectId, sessionId });
          return turn;
        });
      } catch (err) {
        this.d.log("ERROR", `thread ${threadId}: opening turn failed: ${String((err as Error)?.message ?? err)}`);
        await this.persist(threadId, {
          type: "orchestrator_msg",
          text: "(the orchestrator could not start -- see logs)",
        });
      } finally {
        this.pending.delete(threadId);
      }
    })();
    this.pending.set(threadId, p);
    return { threadId };
  }

  /** Await the in-flight background turn(s). No arg -> await every thread's. */
  async waitIdle(threadId?: string): Promise<void> {
    if (threadId !== undefined) {
      await (this.pending.get(threadId) ?? Promise.resolve());
      return;
    }
    await Promise.all([...this.pending.values()]);
  }

  /** Pre-launch operator message: persist it, run the chat turn, and honor a
   *  launch-by-word marker (only with an existing plan and no run_link). */
  async sendMessage(threadId: string, text: string): Promise<void> {
    await this.persist(threadId, { type: "operator_msg", text });
    const session = this.threadSessions.get(threadId);
    if (!session) {
      this.d.log("WARN", `thread ${threadId}: message with no live chat session (post-launch?) -- ignoring`);
      return;
    }

    const p = (async () => {
      try {
        const turn = await this.runTurn(threadId, () => this.d.manager.send(session.sessionId, text));
        if (containsLaunchMarker(turn.reply)) {
          const cur = await this.d.store.read(threadId);
          const hasPlan = !!cur?.entries.some((e) => e.type === "plan");
          const hasRunLink = !!cur?.entries.some((e) => e.type === "run_link");
          if (hasPlan && !hasRunLink && this.threadSessions.has(threadId)) {
            await this.confirm(threadId);
          }
        }
      } finally {
        this.pending.delete(threadId);
      }
    })();
    this.pending.set(threadId, p);
    await p;
  }

  /** Confirm & launch: fire the injected launch, and on accept release the chat
   *  session, flip meta to running, and hand off to the narrator. Does NOT
   *  write a run_link (narrator discovers the runId asynchronously). */
  async confirm(threadId: string): Promise<{ accepted: boolean; reason?: string }> {
    const session = this.threadSessions.get(threadId);
    if (!session) return { accepted: false, reason: "no_session" };

    const cur = await this.d.store.read(threadId);
    const operatorMsgs = (cur?.entries ?? [])
      .filter((e): e is Extract<typeof e, { type: "operator_msg" }> => e.type === "operator_msg")
      .map((e) => e.text);
    const finalIntent = operatorMsgs.length > 0 ? operatorMsgs.join("; ") : (cur?.meta.title ?? "");

    const r = await this.d.launch(session.projectId, finalIntent);
    if (r.accepted) {
      await this.d.manager.cancel(session.sessionId);
      await this.d.store.setMeta(threadId, { status: "running" });
      this.d.startNarrator({ projectId: session.projectId, threadId, finalIntent, launchedAt: this.d.now() });
      this.threadSessions.delete(threadId);
      return { accepted: true };
    }
    return { accepted: false, reason: r.reason };
  }

  /** Abandon a pre-launch conversation: cancel the chat session (if any).
   *  Returns whether a session actually existed. */
  async cancel(threadId: string): Promise<boolean> {
    const session = this.threadSessions.get(threadId);
    if (!session) return false;
    await this.d.manager.cancel(session.sessionId);
    this.threadSessions.delete(threadId);
    return true;
  }
}
