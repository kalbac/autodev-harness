import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { runOrchestratorOneShot } from "./orchestrator-oneshot.js";

function fakeSpawn(lines: string[]) {
  return () => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {}, on() {} };
    child.kill = () => {};
    setImmediate(() => {
      for (const l of lines) child.stdout.emit("data", Buffer.from(l + "\n"));
      child.emit("close", 0);
    });
    return child;
  };
}

describe("runOrchestratorOneShot", () => {
  it("streams tokens and resolves the full reply", async () => {
    const lines = [
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } }),
      JSON.stringify({ type: "result", is_error: false, result: "Hello" }),
    ];
    const tokens: string[] = [];
    const reply = await runOrchestratorOneShot({
      exe: "claude", cwd: ".", args: [], prompt: "narrate", onToken: (t) => tokens.push(t), spawnFn: fakeSpawn(lines) as any,
    });
    expect(tokens.join("")).toBe("Hello");
    expect(reply).toBe("Hello");
  });

  it("resolves even if no result event arrives (close ends the turn)", async () => {
    const lines = [
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } }),
    ];
    const reply = await runOrchestratorOneShot({ exe: "claude", cwd: ".", args: [], prompt: "x", onToken: () => {}, spawnFn: fakeSpawn(lines) as any });
    expect(reply).toBe("partial");
  });
});
