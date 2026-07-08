import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ClaudeOrchestratorChatAdapter } from "./claude-orchestrator-chat-adapter.js";
import type { HarnessConfig } from "../config/schema.js";
import type { ReadSnapshot } from "./adapter.js";

function fakeCfg(): HarnessConfig {
  return {
    roles: { orchestrator: { adapter: "claude", model: "opus" } },
  } as unknown as HarnessConfig;
}

const emptyState: ReadSnapshot = { existingIds: [], queues: {} as never };

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (e: string) => void };
    stdin: { write: (chunk: string, cb?: (err?: Error) => void) => void; end: () => void; on: (e: string, cb: () => void) => void };
    kill: () => void;
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const written: string[] = [];
  child.stdin = { write: (c, cb) => { written.push(c); cb?.(); }, end: () => {}, on: () => {} };
  child.kill = vi.fn();
  return { child, written };
}

function emitResult(child: { stdout: EventEmitter }, result: string): void {
  child.stdout.emit("data", `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result })}\n`);
}

describe("ClaudeOrchestratorChatAdapter", () => {
  it("startSession spawns claude with the correct chat args and returns the first turn", async () => {
    const { child, written } = makeFakeChild();
    let capturedArgs: string[] = [];
    const adapter = new ClaudeOrchestratorChatAdapter({
      cfg: fakeCfg(),
      repoRoot: "/repo",
      spawnFn: ((exe: string, args: string[]) => {
        capturedArgs = args;
        return child as never;
      }) as never,
    });

    const startPromise = adapter.startSession({ intent: "add rate limiting", state: emptyState, onToken: () => {} });
    emitResult(child, "I'd split this into 2 tasks.");
    const { handle, turn } = await startPromise;

    expect(handle.sessionId).toBeTruthy();
    expect(turn.reply).toBe("I'd split this into 2 tasks.");
    expect(turn.proposedSpecs).toBeUndefined();
    expect(capturedArgs).toEqual(
      expect.arrayContaining(["-p", "--model", "opus", "--input-format", "stream-json", "--output-format", "stream-json"]),
    );
    expect(written[0]).toContain("add rate limiting");
  });

  it("extracts proposedSpecs from a fenced JSON block in the reply, dropping invalid elements", async () => {
    const { child } = makeFakeChild();
    const adapter = new ClaudeOrchestratorChatAdapter({ cfg: fakeCfg(), repoRoot: "/repo", spawnFn: (() => child) as never });
    const startPromise = adapter.startSession({ intent: "x", state: emptyState, onToken: () => {} });
    const reply =
      'Here is a plan:\n```json\n[{"id":"a","title":"A","type":"feature","file_set":["a.ts"]},{"bad":true}]\n```';
    emitResult(child, reply);
    const { turn } = await startPromise;
    expect(turn.proposedSpecs).toHaveLength(1);
    expect(turn.proposedSpecs?.[0]?.id).toBe("a");
  });

  it("send() forwards to the underlying process for a second turn", async () => {
    const { child } = makeFakeChild();
    const adapter = new ClaudeOrchestratorChatAdapter({ cfg: fakeCfg(), repoRoot: "/repo", spawnFn: (() => child) as never });
    const startPromise = adapter.startSession({ intent: "x", state: emptyState, onToken: () => {} });
    emitResult(child, "ok, what else?");
    const { handle } = await startPromise;

    const sendPromise = adapter.send(handle, "also the webhook");
    emitResult(child, "got it, added.");
    const turn = await sendPromise;
    expect(turn.reply).toBe("got it, added.");
  });

  it("close() tears down the underlying process", async () => {
    const { child } = makeFakeChild();
    const adapter = new ClaudeOrchestratorChatAdapter({ cfg: fakeCfg(), repoRoot: "/repo", spawnFn: (() => child) as never });
    const startPromise = adapter.startSession({ intent: "x", state: emptyState, onToken: () => {} });
    emitResult(child, "hi");
    const { handle } = await startPromise;
    await adapter.close(handle);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
