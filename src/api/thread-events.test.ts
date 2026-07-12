import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import { ThreadEventBus, handleThreadStream } from "./thread-events.js";

function fakeRes() {
  const chunks: string[] = [];
  let onClose: (() => void) | undefined;
  const res = {
    writeHead() { return res; },
    flushHeaders() {},
    write(c: string) { chunks.push(c); return true; },
    end() {},
    on(ev: string, cb: () => void) { if (ev === "close") onClose = cb; return res; },
  } as unknown as ServerResponse;
  return { res, chunks, close: () => onClose?.() };
}

describe("ThreadEventBus", () => {
  it("broadcasts entries and tokens to subscribers as SSE frames", async () => {
    const bus = new ThreadEventBus();
    const { res, chunks } = fakeRes();
    handleThreadStream({ bus, readNdjson: async () => "" }, "th-1", res);
    await new Promise((r) => setImmediate(r));
    bus.broadcast("th-1", JSON.stringify({ type: "operator_msg", ts: 1, text: "hi" }));
    bus.broadcast("th-1", JSON.stringify({ type: "token", text: "he" }));
    expect(chunks.some((c) => c.includes("operator_msg"))).toBe(true);
    expect(chunks.some((c) => c.includes('"token"'))).toBe(true);
  });

  it("replays history then goes live", async () => {
    const bus = new ThreadEventBus();
    const { res, chunks } = fakeRes();
    handleThreadStream({ bus, readNdjson: async () => JSON.stringify({ type: "run_link", ts: 1, runId: "r" }) + "\n" }, "th-1", res);
    await new Promise((r) => setImmediate(r));
    expect(chunks.some((c) => c.includes("run_link"))).toBe(true);
  });

  it("does not leak a subscription when the client disconnects during replay", async () => {
    const bus = new ThreadEventBus();
    const { res, close } = fakeRes();
    let resolveReplay: (v: string) => void;
    handleThreadStream({ bus, readNdjson: () => new Promise<string>((r) => { resolveReplay = r; }) }, "th-1", res);
    close();
    resolveReplay!("");
    await new Promise((r) => setImmediate(r));
    expect((bus as any).subs.get("th-1")).toBeUndefined();
  });
});
