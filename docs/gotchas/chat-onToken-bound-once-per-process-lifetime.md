# A chat session's `onToken` callback is bound ONCE at process construction — it must look up live state, not capture it

**Tag:** `[chat/onToken-bound-once]`
**Discovered:** s34 (2026-07-09), building the orchestrator-chat feature (`ClaudeChatProcess`/`ChatSessionManager`).

## What happened

`ClaudeChatProcess` holds one long-lived `claude -p stream-json` child for a chat
session's ENTIRE lifetime — every turn (`send()` call) reuses the same process and
the same `onToken` callback, which is bound exactly once at construction time
(inside `OrchestratorChatAdapter.startSession`). The first implementation of
`ChatSessionManager.start()` forwarded the HTTP layer's `onToken` straight through
— correctly a no-op for the opening turn (no SSE client has the `sessionId` yet to
attach a stream), but that SAME no-op closure then served every SUBSEQUENT turn too,
since nothing ever re-bound it. Result: live token streaming silently never worked
past the opening turn — `GET .../chat/:id/stream` would connect and sit open, but
no `data: {"type":"token",...}` frames would ever arrive for turn 2+, even though
the manager's `attachStream()`/`sseRes` machinery was fully built and unit-tested.

Unit tests for `ChatSessionManager` never caught this: they exercise `start()` and
`send()` against a fake `OrchestratorChatAdapter` whose `send()` has no `onToken`
parameter at all (matching the real interface) — so there was nothing to assert
was "forwarded," only that the manager's OWN state (`sseRes`) updated correctly on
`attachStream()`. The gap was between two ALREADY-CORRECT pieces: `attachStream()`
worked, and the process's single fixed `onToken` binding worked — nobody connected
them. Found by an independent codex GPT-5.5 review (not by the unit test suite),
and confirmed both broken and then fixed via a real live spawn (SSE frames observed
via `curl -N`, matching the final `reply` text exactly).

## Why it doesn't break silently in a way tests would catch

The plan's own design comment ("the FIRST turn's tokens are not streamed — no SSE
client attached yet") is correct and remains correct after the fix. The bug was
specifically that the SAME reasoning was implicitly (and wrongly) extended to every
LATER turn too, because nothing re-evaluated "is a client attached NOW" — the
`onToken` closure just permanently echoed whatever was true at construction time.

## Fix

`ChatSessionManager.start()`'s `onToken` closure must look up the CURRENTLY
attached SSE sink FRESH on every token call (`this.sessions.get(liveSessionId)?.sseRes`),
not capture a value once. `liveSessionId` starts `null` (correctly suppressing
turn-one tokens, since no `sessionId` exists yet for a client to attach to) and is
set the moment `adapter.startSession()` resolves — from then on, EVERY subsequent
`send()` call (reusing the same long-lived process/callback) reaches whatever sink
is live at token-arrival time, including a client that only attached between turn 1
and turn 2 (the normal real-world sequence: the UI gets `sessionId` from the
`POST /chat` response, THEN opens the `EventSource`, THEN sends the next message).

## How to apply

Any future "one persistent callback bound once, serves N later calls" pattern
(anywhere a long-lived process/session outlives the specific request that
constructed it) needs the SAME discipline: bind a closure that reads MUTABLE,
live-looked-up state, never a value snapshotted at bind time — especially when the
thing being bound only forwards to something that legitimately doesn't exist yet
(no SSE client) at construction but WILL exist later.

## Related side-finding (not a gotcha, but a real Node.js correctness detail)

`res.writeHead(200, sseHeaders)` alone does NOT flush headers to the client —
Node buffers them until the first `write()`/`end()`. An SSE route that may sit
idle after a successful connect (waiting for the next token) must call
`res.flushHeaders()` right after `writeHead()`, or an `EventSource`/`fetch` client
sees no response at all — not even a "connected" signal — until data actually
arrives, which may be a long wait if the operator hasn't typed anything yet.

## Related

- `docs/gotchas/claude-cli-stream-json-multiturn.md` — the underlying wire
  mechanism (`--input-format stream-json`/multi-turn) this whole feature is built on.
- `docs/superpowers/plans/2026-07-08-orchestrator-chat.md` — Task 5/7 (`ChatSessionManager`, HTTP chat routes).
