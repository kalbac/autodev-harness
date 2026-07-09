import { describe, it, expect } from "vitest";
import { parseChatWireLine } from "./chat-wire.js";

describe("parseChatWireLine", () => {
  it("recognizes a system/init event and extracts session_id", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      cwd: "D:\\Projects\\autodev-harness",
      session_id: "8102bf62-2fd5-486f-b146-37a38c8d2113",
      tools: [],
    });
    expect(parseChatWireLine(line)).toEqual({
      kind: "init",
      sessionId: "8102bf62-2fd5-486f-b146-37a38c8d2113",
    });
  });

  it("recognizes a content_block_delta text token", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ONG" } },
      session_id: "s1",
    });
    expect(parseChatWireLine(line)).toEqual({ kind: "token", text: "ONG" });
  });

  it("ignores a non-text-delta stream_event (e.g. message_start/message_stop)", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "message_start", message: { role: "assistant" } },
      session_id: "s1",
    });
    expect(parseChatWireLine(line)).toEqual({ kind: "ignored" });
  });

  it("recognizes a successful result event as turn-done", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "PONG",
      session_id: "s1",
    });
    expect(parseChatWireLine(line)).toEqual({ kind: "turn-done", replyText: "PONG", isError: false });
  });

  it("recognizes a failed result event as turn-done with isError true", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Not logged in · Please run /login",
      session_id: "s1",
    });
    const parsed = parseChatWireLine(line);
    expect(parsed.kind).toBe("turn-done");
    if (parsed.kind === "turn-done") {
      expect(parsed.isError).toBe(true);
      expect(parsed.replyText).toContain("Not logged in");
    }
  });

  it("ignores an unrelated system event (hook_started/hook_response)", () => {
    const line = JSON.stringify({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" });
    expect(parseChatWireLine(line)).toEqual({ kind: "ignored" });
  });

  it("ignores the replayed user-turn echo", () => {
    const line = JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, isReplay: true });
    expect(parseChatWireLine(line)).toEqual({ kind: "ignored" });
  });

  it("ignores an unparseable line rather than throwing", () => {
    expect(parseChatWireLine("not json at all")).toEqual({ kind: "ignored" });
  });

  it("ignores a JSON line that isn't an object (e.g. a bare number)", () => {
    expect(parseChatWireLine("42")).toEqual({ kind: "ignored" });
  });
});
