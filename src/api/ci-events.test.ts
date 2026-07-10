import { describe, it, expect } from "vitest";
import { CiEventBus, type CiStreamSink } from "./ci-events.js";
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
