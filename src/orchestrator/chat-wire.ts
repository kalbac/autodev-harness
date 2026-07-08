/**
 * One parsed event from a live `claude -p --output-format stream-json` chat
 * process, narrowed to the three kinds `ClaudeChatProcess` acts on. Every
 * other real event (hook lifecycle, rate-limit, replayed user echo,
 * message_start/message_stop, etc.) parses to `{kind:"ignored"}` — the caller
 * only reacts to `token`/`turn-done`/`init`.
 *
 * Shapes verified against a real spawn transcript (2026-07-08, see the plan's
 * header) — not inferred from docs alone.
 */
export type ChatWireEvent =
  | { kind: "init"; sessionId: string }
  | { kind: "token"; text: string }
  | { kind: "turn-done"; replyText: string; isError: boolean }
  | { kind: "ignored" };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/** Parse ONE complete line of `stream-json` output. Never throws — an
 *  unparseable or unrecognized line is `{kind:"ignored"}`. */
export function parseChatWireLine(line: string): ChatWireEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "ignored" };
  }

  const o = asRecord(parsed);
  if (o === null) return { kind: "ignored" };

  if (o["type"] === "system" && o["subtype"] === "init" && typeof o["session_id"] === "string") {
    return { kind: "init", sessionId: o["session_id"] };
  }

  if (o["type"] === "stream_event") {
    const event = asRecord(o["event"]);
    const delta = event ? asRecord(event["delta"]) : null;
    if (event?.["type"] === "content_block_delta" && delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
      return { kind: "token", text: delta["text"] };
    }
    return { kind: "ignored" };
  }

  if (o["type"] === "result") {
    return {
      kind: "turn-done",
      replyText: typeof o["result"] === "string" ? o["result"] : "",
      isError: o["is_error"] === true,
    };
  }

  return { kind: "ignored" };
}
