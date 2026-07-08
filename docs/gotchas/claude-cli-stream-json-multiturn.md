# `[cli/claude-stream-json-multiturn]` — a live-verified `claude -p` multi-turn chat session

**Found:** s33 (2026-07-08), live-probing the mechanism for the orchestrator-chat design
(`docs/superpowers/specs/2026-07-08-orchestrator-chat-design.md`).

`claude -p --input-format stream-json --output-format stream-json --include-partial-messages
--replay-user-messages --verbose --model <model>` starts ONE process that accepts
**multiple sequential user turns** written to its stdin (one JSON line per turn:
`{"type":"user","message":{"role":"user","content":"..."}}\n`) and keeps the SAME
`session_id` across all of them — verified by feeding two turns with a 3-second delay
between them and observing identical `session_id` on both.

**Per-turn event shapes (verbatim from a real transcript, not inferred from docs):**
- `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}`
  — one per streamed token.
- `{"type":"result","subtype":"success"|"...","is_error":bool,"result":"<full reply text>"}`
  — terminal event for the turn; this is the reliable "turn done" signal, not the
  streamed deltas (which are cosmetic/live-typing only).
- `{"type":"user",...,"isReplay":true}` — an echo of what you sent, `--replay-user-messages`
  causes this; safe to ignore.

**Gotchas found alongside:**
1. `--print` + `--output-format=stream-json` REQUIRES `--verbose` or the CLI errors
   immediately (`"When using --print, --output-format=stream-json requires --verbose"`).
2. `--bare` mode (used elsewhere in this project for worker isolation, gotcha
   `[detect/isolation-flags-not-orthogonal]`) strictly requires an explicit
   `ANTHROPIC_API_KEY` (or `apiKeyHelper` via `--settings`) — OAuth and keychain auth are
   NEVER read in `--bare` mode. A chat adapter spawned with `--bare` in an environment
   that only has interactive OAuth login will fail with `"Not logged in · Please run
   /login"` even though the SAME spawn without `--bare` works fine. Don't assume
   isolation flags are auth-neutral.
3. The process only terminates when stdin is closed (or killed) — it will sit open
   indefinitely waiting for more turns otherwise. A long-lived chat session's teardown
   MUST explicitly end/close stdin (or SIGTERM/SIGKILL), never rely on the child
   exiting on its own.

## Related

- `[detect/isolation-flags-not-orthogonal]` — the isolation-flag matrix this session's
  `--bare` finding extends.
- `docs/superpowers/specs/2026-07-08-orchestrator-chat-design.md` and
  `docs/superpowers/plans/2026-07-08-orchestrator-chat.md` — the feature this mechanism
  backs (`ClaudeChatProcess`, `chat-wire.ts`).
