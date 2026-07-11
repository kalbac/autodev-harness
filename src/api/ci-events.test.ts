import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import { CiEventBus, handleCiStream, type CiStreamSink, type CiCapabilityProvider } from "./ci-events.js";
import type { AgentCiEvent } from "../gate/agent-ci-events.js";

function fakeSink(): CiStreamSink & { chunks: string[]; ended: boolean } {
  const chunks: string[] = [];
  return { chunks, ended: false, write(c) { chunks.push(c); }, end() { (this as { ended: boolean }).ended = true; } };
}
const ev = (e: AgentCiEvent): AgentCiEvent => e;

describe("CiEventBus", () => {
  it("fans a published event out to every subscribed sink for that task", () => {
    const bus = new CiEventBus();
    const a = fakeSink();
    const b = fakeSink();
    bus.subscribe("t1", a);
    bus.subscribe("t1", b);
    bus.publish("t1", ev({ kind: "run-finish", status: "passed" }));
    expect(a.chunks).toHaveLength(1);
    expect(JSON.parse(a.chunks[0]!)).toEqual({ kind: "run-finish", status: "passed" });
    expect(b.chunks).toHaveLength(1);
  });

  it("does not deliver to a different task's subscribers", () => {
    const bus = new CiEventBus();
    const a = fakeSink();
    bus.subscribe("t1", a);
    bus.publish("t2", ev({ kind: "run-start" }));
    expect(a.chunks).toHaveLength(0);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new CiEventBus();
    const a = fakeSink();
    bus.subscribe("t1", a);
    bus.unsubscribe("t1", a);
    bus.publish("t1", ev({ kind: "run-start" }));
    expect(a.chunks).toHaveLength(0);
  });

  it("a throwing sink never crashes publish or blocks other sinks", () => {
    const bus = new CiEventBus();
    const bad: CiStreamSink = { write: () => { throw new Error("dead socket"); }, end: () => {} };
    const good = fakeSink();
    bus.subscribe("t1", bad);
    bus.subscribe("t1", good);
    expect(() => bus.publish("t1", ev({ kind: "run-start" }))).not.toThrow();
    expect(good.chunks).toHaveLength(1);
  });

  it("closeAll ends every sink", () => {
    const bus = new CiEventBus();
    const a = fakeSink();
    bus.subscribe("t1", a);
    bus.closeAll();
    expect(a.ended).toBe(true);
  });
});

/** Minimal fake `ServerResponse`: just enough surface for `handleCiStream`
 *  (writeHead/flushHeaders/write/end/on("close")). */
function fakeRes(): { res: ServerResponse; writes: string[]; fireClose: () => void } {
  const writes: string[] = [];
  const closeHandlers: Array<() => void> = [];
  const res = {
    writeHead() {},
    flushHeaders() {},
    write(c: string) {
      writes.push(c);
      return true;
    },
    end() {},
    on(evt: string, cb: () => void) {
      if (evt === "close") closeHandlers.push(cb);
      return this;
    },
  } as unknown as ServerResponse;
  return { res, writes, fireClose: () => closeHandlers.forEach((h) => h()) };
}

describe("handleCiStream", () => {
  it("subscribes after history replay and unsubscribes on a normal disconnect", async () => {
    const bus = new CiEventBus();
    const ci: CiCapabilityProvider = { bus, readEvents: async () => "" };
    const { res, writes, fireClose } = fakeRes();

    handleCiStream(ci, "t1", res);
    await new Promise((r) => setImmediate(r)); // let readEvents().then/finally settle

    bus.publish("t1", { kind: "run-finish", status: "passed" });
    expect(writes.some((w) => w.includes("run-finish"))).toBe(true);

    fireClose();
    writes.length = 0;
    bus.publish("t1", { kind: "run-finish", status: "passed" });
    expect(writes).toHaveLength(0); // unsubscribed -- no further delivery
  });

  it("does not leak a subscription when the client disconnects during history replay", async () => {
    let resolveHistory!: (s: string) => void;
    const bus = new CiEventBus();
    const ci: CiCapabilityProvider = {
      bus,
      readEvents: () => new Promise<string>((r) => { resolveHistory = r; }),
    };
    const { res, writes, fireClose } = fakeRes();

    handleCiStream(ci, "t1", res);
    fireClose(); // client disconnects WHILE readEvents() is still pending
    resolveHistory('{"kind":"run-start"}\n'); // history now resolves after the disconnect
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    bus.publish("t1", { kind: "run-finish", status: "passed" });
    expect(writes.filter((w) => w.includes("run-finish"))).toHaveLength(0); // no dead-sink delivery
  });
});
