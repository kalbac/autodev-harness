import type { ServerResponse } from "node:http";

/** Structural sink (mirrors CiStreamSink) so the bus never touches ServerResponse directly. */
export interface ThreadStreamSink {
  write(chunk: string): void;
  end(): void;
}

/** Per-thread in-memory fan-out of chat entries + token frames, keyed by threadId. Sibling to
 *  CiEventBus but the payload is a caller-serialized string since threads stream two distinct
 *  frame kinds (full entry JSON and token-frame JSON). */
export class ThreadEventBus {
  private readonly subs = new Map<string, Set<ThreadStreamSink>>();

  subscribe(threadId: string, sink: ThreadStreamSink): void {
    let set = this.subs.get(threadId);
    if (!set) { set = new Set(); this.subs.set(threadId, set); }
    set.add(sink);
  }

  unsubscribe(threadId: string, sink: ThreadStreamSink): void {
    const set = this.subs.get(threadId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.subs.delete(threadId);
  }

  broadcast(threadId: string, payload: string): void {
    const set = this.subs.get(threadId);
    if (!set) return;
    for (const sink of set) {
      try { sink.write(payload); } catch { /* best-effort: a dead socket must not crash broadcast */ }
    }
  }

  closeAll(): void {
    for (const set of this.subs.values()) {
      for (const sink of set) { try { sink.end(); } catch { /* already closed */ } }
    }
    this.subs.clear();
  }
}

export interface ThreadStreamProvider {
  bus: ThreadEventBus;
  /** Reads the persisted ndjson for history replay; "" if none yet. */
  readNdjson: (threadId: string) => Promise<string>;
}

/** SSE: replay the persisted ndjson (history) then forward live bus events. Mirrors
 *  handleCiStream exactly, including the replay-disconnect-leak fix. */
export function handleThreadStream(tp: ThreadStreamProvider | undefined, threadId: string, res: ServerResponse): void {
  if (!tp) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders(); // else Node buffers headers until the first write

  const sink: ThreadStreamSink = {
    write: (chunk) => { try { res.write(`data: ${chunk}\n\n`); } catch { /* client gone */ } },
    end: () => { try { res.end(); } catch { /* already closed */ } },
  };

  let closed = false;
  // Register the disconnect handler SYNCHRONOUSLY so a drop DURING history replay still detaches.
  res.on("close", () => {
    closed = true;
    tp.bus.unsubscribe(threadId, sink); // safe no-op if not yet subscribed
  });

  // History replay first (best-effort), then go live. A microscopic race (an event landing
  // between replay and subscribe) is covered by persistence -- a reconnect replays it.
  void tp.readNdjson(threadId)
    .then((ndjson) => {
      if (closed) return;
      for (const line of ndjson.split(/\r?\n/)) {
        const t = line.trim();
        if (t.length > 0) sink.write(t);
      }
    })
    .catch(() => { /* no history yet -- stream live only */ })
    .finally(() => {
      if (!closed) tp.bus.subscribe(threadId, sink);
    });
}
