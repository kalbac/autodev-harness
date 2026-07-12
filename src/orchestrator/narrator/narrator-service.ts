import type { ThreadStore } from "../../thread/thread-store.js";
import type { ThreadEventBus } from "../../api/thread-events.js";
import type { CiEventBus, CiStreamSink } from "../../api/ci-events.js";
import type { ThreadEntryInput } from "../../thread/thread-types.js";
import { diffRunSnapshot, type ActivityCell, type RunSnapshot } from "./activity-map.js";
import { coalesceMilestones, type PendingMilestone } from "./milestone.js";
import { buildNarrationPrompt, buildMidRunReplyPrompt } from "./narration-prompt.js";

/**
 * NarratorService — the read-only post-launch narrator (adr/003 R1).
 *
 * It ONLY reads the blackboard (via `read`) and subscribes to the existing CI event bus.
 * It NEVER touches enforcement. Everything here is best-effort: a narrator failure must
 * never affect the run, so no throw may escape `tick` / `handleOperatorMessage`.
 */
export interface NarratorDeps {
  projectId: string;
  threadId: string;
  finalIntent: string;
  launchedAt: number;
  store: ThreadStore; // append / read / setMeta
  bus: ThreadEventBus; // broadcast
  ciBus: CiEventBus; // subscribe / unsubscribe
  read: {
    recentRuns: () => Promise<Array<{ runId: string; created_at: number; intent?: string }>>;
    runSnapshot: (runId: string) => Promise<RunSnapshot | null>;
  };
  narrate: (prompt: string, onToken: (t: string) => void) => Promise<string>;
  log: (level: "INFO" | "WARN" | "ERROR", msg: string) => void;
  now: () => number;
  tickMs?: number; // default 1500
  windowMs?: number; // default 1200
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export class NarratorService {
  private runId: string | null = null;
  private lastSnapshot: RunSnapshot | null = null;
  private pending: PendingMilestone[] = [];
  private stopped = false;
  private inTick = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly ciTaskSinks = new Map<string, CiStreamSink>();

  constructor(private readonly deps: NarratorDeps) {}

  start(): void {
    const set = this.deps.setInterval ?? setInterval;
    // Do NOT tick synchronously here — the tick loop drives snapshot reads.
    // Return the tick promise so a test harness that awaits the callback awaits the FULL tick;
    // the real setInterval ignores the return value, and tick() never rejects (it self-catches).
    this.timer = set(() => this.tick(), this.deps.tickMs ?? 1500);
  }

  async tick(): Promise<void> {
    if (this.inTick || this.stopped) return;
    this.inTick = true;
    try {
      // 1. Discover the run (onOrchestrate is fire-and-forget so we find the runId ourselves).
      if (this.runId === null) {
        const runs = await this.deps.read.recentRuns();
        if (runs.length === 0) return; // try again next tick
        const sorted = [...runs].sort((a, b) => b.created_at - a.created_at);
        const chosen = sorted.find((r) => r.created_at >= this.deps.launchedAt) ?? sorted[0];
        if (!chosen) return; // try again next tick
        this.runId = chosen.runId;
        await this.persist({ type: "run_link", runId: this.runId });
        await this.deps.store.setMeta(this.deps.threadId, { run_id: this.runId, status: "running" });
        // do NOT return — read the first snapshot this same tick.
      }

      // 2. Read the current snapshot.
      const snap = await this.deps.read.runSnapshot(this.runId);
      if (snap === null) return;

      // 3. Diff → instant cells (no LLM) + milestones (coalesced later).
      const { cells, milestones } = diffRunSnapshot(this.lastSnapshot, snap);
      for (const cell of cells) await this.appendCell(cell);
      for (const milestone of milestones) this.pending.push({ at: this.deps.now(), milestone });
      this.lastSnapshot = snap;

      // 4. Subscribe CI for any task not yet subscribed (best-effort — cells only).
      for (const task of snap.tasks) {
        if (this.ciTaskSinks.has(task.taskId)) continue;
        const taskId = task.taskId;
        const sink: CiStreamSink = {
          write: (chunk: string) => {
            try {
              const ev = JSON.parse(chunk) as { event?: string; type?: string };
              void this.appendCell({
                kind: "agent_ci",
                ref: { taskId },
                summary: `ci: ${ev.event ?? ev.type ?? "event"}`,
                status: "running",
              });
            } catch { /* [ts/fail-closed] ignore malformed CI frame */ }
          },
          end() { /* no-op */ },
        };
        try {
          this.deps.ciBus.subscribe(taskId, sink);
          this.ciTaskSinks.set(taskId, sink);
        } catch (err) {
          this.deps.log("WARN", `[ts/fail-closed] ci subscribe failed for ${taskId}: ${String((err as Error)?.message ?? err)}`);
        }
      }

      // 5. Coalesce milestone bursts → ONE-SHOT LLM narration per burst.
      const { fire, keep } = coalesceMilestones(this.pending, this.deps.now(), this.deps.windowMs ?? 1200);
      this.pending = keep;
      if (fire.length > 0) {
        try {
          const read = await this.deps.store.read(this.deps.threadId);
          const prompt = buildNarrationPrompt(read?.entries ?? [], fire.map((f) => f.milestone));
          await this.narrateInto(prompt, fire.map((f) => f.milestone.kind).join(","));
        } catch (err) {
          this.deps.log("WARN", `[ts/fail-closed] narration skipped: ${String((err as Error)?.message ?? err)}`);
        }
      }

      // 6. Terminal check — stop when every task is terminal.
      const allTerminal = snap.tasks.length > 0 &&
        snap.tasks.every((t) => t.status === "done" || t.status === "quarantine");
      if (allTerminal) {
        const allDone = snap.tasks.every((t) => t.status === "done");
        await this.deps.store.setMeta(this.deps.threadId, { status: allDone ? "done" : "error" });
        this.stop();
      }
    } catch (err) {
      this.deps.log("WARN", `[ts/fail-closed] narrator tick failed: ${String((err as Error)?.message ?? err)}`);
    } finally {
      this.inTick = false;
    }
  }

  async handleOperatorMessage(text: string): Promise<void> {
    try {
      await this.persist({ type: "operator_msg", text });
      const summary = this.stateSummary();
      const read = await this.deps.store.read(this.deps.threadId);
      const prompt = buildMidRunReplyPrompt(read?.entries ?? [], summary, text);
      await this.narrateInto(prompt, ""); // empty label → no milestone tag on the reply
    } catch (err) {
      this.deps.log("WARN", `[ts/fail-closed] operator message failed: ${String((err as Error)?.message ?? err)}`);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    (this.deps.clearInterval ?? clearInterval)(this.timer as ReturnType<typeof setInterval>);
    for (const [taskId, sink] of this.ciTaskSinks) {
      try { this.deps.ciBus.unsubscribe(taskId, sink); } catch { /* best-effort */ }
    }
    this.ciTaskSinks.clear();
  }

  private stateSummary(): string {
    const snap = this.lastSnapshot;
    if (!snap || snap.tasks.length === 0) return "run starting";
    return `${snap.tasks.length} task(s): ${snap.tasks.map((t) => t.status).join(", ")}`;
  }

  /** Stream a one-shot narration into the thread, then persist the resolved reply. */
  private async narrateInto(prompt: string, milestoneLabel: string): Promise<void> {
    const reply = await this.deps.narrate(prompt, (t) => {
      try { this.deps.bus.broadcast(this.deps.threadId, JSON.stringify({ type: "token", text: t })); }
      catch { /* [ts/fail-closed] token broadcast best-effort */ }
    });
    const entry: ThreadEntryInput = milestoneLabel
      ? { type: "orchestrator_msg", text: reply, milestone: milestoneLabel }
      : { type: "orchestrator_msg", text: reply };
    await this.persist(entry);
  }

  private async appendCell(cell: ActivityCell): Promise<void> {
    await this.persist({ type: "activity", ...cell });
  }

  /** Factor append+broadcast: persist the entry, then broadcast the same input as JSON. */
  private async persist(entry: ThreadEntryInput): Promise<void> {
    await this.deps.store.append(this.deps.threadId, entry);
    try { this.deps.bus.broadcast(this.deps.threadId, JSON.stringify(entry)); }
    catch { /* [ts/fail-closed] broadcast best-effort */ }
  }
}
