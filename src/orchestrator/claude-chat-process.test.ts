import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ClaudeChatProcess } from "./claude-chat-process.js";

/** A minimal fake `cross-spawn` child: an EventEmitter with `stdout`/`stdin`/`kill`. */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (e: string) => void };
    stdin: { write: (chunk: string, cb?: (err?: Error) => void) => void; end: () => void; on: (e: string, cb: () => void) => void };
    kill: (sig: string) => void;
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const written: string[] = [];
  child.stdin = {
    write: (chunk, cb) => {
      written.push(chunk);
      cb?.();
    },
    end: () => {},
    on: () => {},
  };
  child.kill = vi.fn();
  return { child, written };
}

function emitLine(child: { stdout: EventEmitter }, obj: unknown): void {
  child.stdout.emit("data", `${JSON.stringify(obj)}\n`);
}

describe("ClaudeChatProcess", () => {
  it("resolves send() with the reply text once a result event arrives, forwarding tokens via onToken", async () => {
    const { child, written } = makeFakeChild();
    const tokens: string[] = [];
    const proc = new ClaudeChatProcess({
      exe: "claude",
      cwd: "/repo",
      args: ["-p"],
      onToken: (t) => tokens.push(t),
      spawnFn: () => child as never,
    });

    const pending = proc.send("hello");
    emitLine(child, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "P" } } });
    emitLine(child, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ONG" } } });
    emitLine(child, { type: "result", subtype: "success", is_error: false, result: "PONG" });

    const outcome = await pending;
    expect(outcome).toEqual({ replyText: "PONG", isError: false });
    expect(tokens).toEqual(["P", "ONG"]);
    expect(written[0]).toContain('"content":"hello"');
  });

  it("rejects a second send() while one is already in flight", async () => {
    const { child } = makeFakeChild();
    const proc = new ClaudeChatProcess({ exe: "claude", cwd: "/repo", args: [], onToken: () => {}, spawnFn: () => child as never });
    const first = proc.send("one");
    await expect(proc.send("two")).rejects.toThrow("a turn is already in flight");
    emitLine(child, { type: "result", subtype: "success", is_error: false, result: "ok" });
    await first;
  });

  it("rejects the in-flight send() if the child exits unexpectedly", async () => {
    const { child } = makeFakeChild();
    const proc = new ClaudeChatProcess({ exe: "claude", cwd: "/repo", args: [], onToken: () => {}, spawnFn: () => child as never });
    const pending = proc.send("hello");
    child.emit("close", 1);
    await expect(pending).rejects.toThrow("chat process exited unexpectedly");
  });

  it("rejects send() after close()", async () => {
    const { child } = makeFakeChild();
    const proc = new ClaudeChatProcess({ exe: "claude", cwd: "/repo", args: [], onToken: () => {}, spawnFn: () => child as never });
    proc.close();
    await expect(proc.send("hello")).rejects.toThrow("chat process is closed");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("buffers a split stdout chunk across two data events (event line arrives split)", async () => {
    const { child } = makeFakeChild();
    const proc = new ClaudeChatProcess({ exe: "claude", cwd: "/repo", args: [], onToken: () => {}, spawnFn: () => child as never });
    const pending = proc.send("hi");
    const full = `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK" })}\n`;
    child.stdout.emit("data", full.slice(0, 5));
    child.stdout.emit("data", full.slice(5));
    await expect(pending).resolves.toEqual({ replyText: "OK", isError: false });
  });
});
