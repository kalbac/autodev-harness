import type { ServerResponse } from "node:http";
import type { AgentCiEvent } from "../gate/agent-ci-events.js";
import type { AgentCiCapability } from "../gate/agent-ci-exec.js";

/** Structural sink (mirrors ChatStreamSink) so the bus never touches ServerResponse directly. */
export interface CiStreamSink {
  write(chunk: string): void;
  end(): void;
}

/** Per-project in-memory fan-out of CI events, keyed by taskId. Sibling to ChatSessionManager
 *  but far simpler: no child lifecycle, just subscribe/publish/unsubscribe. */
export class CiEventBus {
  private readonly subs = new Map<string, Set<CiStreamSink>>();

  subscribe(taskId: string, sink: CiStreamSink): void {
    let set = this.subs.get(taskId);
    if (!set) { set = new Set(); this.subs.set(taskId, set); }
    set.add(sink);
  }

  unsubscribe(taskId: string, sink: CiStreamSink): void {
    const set = this.subs.get(taskId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.subs.delete(taskId);
  }

  publish(taskId: string, event: AgentCiEvent): void {
    const set = this.subs.get(taskId);
    if (!set) return;
    const payload = JSON.stringify(event);
    for (const sink of set) {
      try { sink.write(payload); } catch { /* best-effort: a dead socket must not crash publish */ }
    }
  }

  closeAll(): void {
    for (const set of this.subs.values()) {
      for (const sink of set) { try { sink.end(); } catch { /* already closed */ } }
    }
    this.subs.clear();
  }
}

export interface CiCapabilityProvider {
  bus: CiEventBus;
  /** Reads the persisted ndjson for history replay; "" if none yet. */
  readEvents: (taskId: string) => Promise<string>;
}

/** SSE: replay the persisted ndjson (history) then forward live bus events. Mirrors
 *  handleChatStream but ADDS history replay (chat has none). */
export function handleCiStream(ci: CiCapabilityProvider | undefined, taskId: string, res: ServerResponse): void {
  if (!ci) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders(); // else Node buffers headers until the first write

  const sink: CiStreamSink = {
    write: (chunk) => { try { res.write(`data: ${chunk}\n\n`); } catch { /* client gone */ } },
    end: () => { try { res.end(); } catch { /* already closed */ } },
  };

  let closed = false;
  // Register the disconnect handler SYNCHRONOUSLY so a drop DURING history replay still detaches.
  res.on("close", () => {
    closed = true;
    ci.bus.unsubscribe(taskId, sink); // safe no-op if not yet subscribed
  });

  // History replay first (best-effort), then go live. A microscopic race (an event landing
  // between replay and subscribe) is covered by persistence -- a reconnect replays it.
  void ci.readEvents(taskId)
    .then((ndjson) => {
      if (closed) return;
      for (const line of ndjson.split(/\r?\n/)) {
        const t = line.trim();
        if (t.length > 0) sink.write(t);
      }
    })
    .catch(() => { /* no history yet -- stream live only */ })
    .finally(() => {
      if (!closed) ci.bus.subscribe(taskId, sink);
    });
}

export function handleCiCapability(
  onCiCapability: (() => Promise<AgentCiCapability>) | undefined,
  res: ServerResponse,
): void {
  if (!onCiCapability) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
  void onCiCapability()
    .then((cap) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(cap)); })
    .catch(() => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "capability probe failed" })); });
}
